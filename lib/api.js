'use strict';

const https = require('https');
const http = require('http');
const url = require('url');

// Transient failures worth retrying. Azure DevOps throttles bursts of writes
// (429) and its preview endpoints (e.g. WI comments, api-version 7.1-preview.3)
// occasionally return 5xx; 409 is optimistic-concurrency contention on rapid
// consecutive work-item PATCHes. Our writes are last-write-wins field 'add' ops
// and comment posts, so replaying resolves the race. 408 is a request timeout.
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
// Node network-level errors that are transient and safe to retry.
const RETRYABLE_NET = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND', 'ESOCKETTIMEDOUT']);

function maxRetries() {
  const n = parseInt(process.env.AZURE_MAX_RETRIES, 10);
  return Number.isInteger(n) && n >= 0 ? n : 3;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Honour a Retry-After header (delta-seconds or HTTP-date). Returns ms or null.
function parseRetryAfter(headerVal) {
  if (!headerVal) return null;
  const secs = Number(headerVal);
  if (!Number.isNaN(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(headerVal);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return null;
}

// Exponential backoff with a little jitter: ~0.5s, 1s, 2s, 4s ... capped at 8s.
function backoffDelay(attempt) {
  const base = Math.min(500 * 2 ** attempt, 8000);
  return base + Math.floor(Math.random() * 250);
}

function warnRetry(method, reason, delayMs, attempt, total) {
  process.stderr.write(
    `azure-connector: ${method} got ${reason}; retrying (${attempt + 1}/${total}) in ${Math.round(delayMs)}ms...\n`
  );
}

/**
 * Single HTTP attempt. Resolves { statusCode, statusMessage, headers, text }
 * (never throws on a non-2xx — the caller decides). Rejects only on a
 * network-level error, tagging it with .code so the retry wrapper can classify it.
 */
function attempt(rawUrl, { method = 'GET', pat, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(rawUrl);
    const auth = Buffer.from(`:${pat}`).toString('base64');

    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.path,
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...headers,
      },
    };

    const bodyStr = body ? JSON.stringify(body) : null;
    if (bodyStr) {
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          statusMessage: res.statusMessage,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * Minimal fetch using built-in http/https, with retry-and-backoff for transient
 * failures. Retries 429/5xx/409 and transient network errors (honouring
 * Retry-After); never retries auth failures (401/203) or other 4xx. Attempt
 * count is 1 + AZURE_MAX_RETRIES (default 3). Each retry logs to stderr.
 */
async function request(rawUrl, opts = {}) {
  const method = opts.method || 'GET';
  const total = maxRetries();
  let lastErr;

  for (let i = 0; i <= total; i++) {
    let res;
    try {
      res = await attempt(rawUrl, opts);
    } catch (err) {
      // Network-level failure (no HTTP response).
      lastErr = err;
      if (RETRYABLE_NET.has(err.code) && i < total) {
        const delay = backoffDelay(i);
        warnRetry(method, err.code || err.message, delay, i, total);
        await sleep(delay);
        continue;
      }
      throw err;
    }

    const { statusCode, statusMessage, headers, text } = res;

    // Azure returns 401 (or 203 Non-Authoritative with a sign-in page) when the
    // PAT is missing, expired, or revoked. 203 is < 400, so without this guard it
    // would be parsed as a successful response. Surface a clear, actionable error.
    // Not retryable — a bad PAT won't fix itself.
    if (statusCode === 401 || statusCode === 203) {
      throw new Error(`Azure auth failed (HTTP ${statusCode}). The PAT is missing, expired, or revoked. `
        + `Check it with: azure-connector pat check`);
    }

    if (statusCode >= 400) {
      if (RETRYABLE_STATUS.has(statusCode) && i < total) {
        const retryAfter = parseRetryAfter(headers['retry-after']);
        const delay = retryAfter != null ? retryAfter : backoffDelay(i);
        warnRetry(method, `HTTP ${statusCode}`, delay, i, total);
        await sleep(delay);
        continue;
      }
      throw new Error(`HTTP ${statusCode} ${statusMessage}\n${text}`);
    }

    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return text;
    }
  }

  // Exhausted retries on a network error.
  throw lastErr;
}

/**
 * Single binary GET attempt. Resolves { statusCode, statusMessage, headers, buffer }
 * (never throws on non-2xx). Rejects only on a network-level error.
 */
function attemptBinary(rawUrl, { pat } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(rawUrl);
    const auth = Buffer.from(`:${pat}`).toString('base64');

    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.path,
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
      },
    };

    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        statusMessage: res.statusMessage,
        headers: res.headers,
        buffer: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Binary GET — returns { buffer, headers }. Same retry/backoff policy as request().
 */
async function requestBinary(rawUrl, opts = {}) {
  const total = maxRetries();
  let lastErr;

  for (let i = 0; i <= total; i++) {
    let res;
    try {
      res = await attemptBinary(rawUrl, opts);
    } catch (err) {
      lastErr = err;
      if (RETRYABLE_NET.has(err.code) && i < total) {
        const delay = backoffDelay(i);
        warnRetry('GET', err.code || err.message, delay, i, total);
        await sleep(delay);
        continue;
      }
      throw err;
    }

    const { statusCode, statusMessage, headers, buffer } = res;
    if (statusCode === 401 || statusCode === 203) {
      throw new Error(`Azure auth failed (HTTP ${statusCode}). The PAT is missing, expired, or revoked. `
        + `Check it with: azure-connector pat check`);
    }
    if (statusCode >= 400) {
      if (RETRYABLE_STATUS.has(statusCode) && i < total) {
        const retryAfter = parseRetryAfter(headers['retry-after']);
        const delay = retryAfter != null ? retryAfter : backoffDelay(i);
        warnRetry('GET', `HTTP ${statusCode}`, delay, i, total);
        await sleep(delay);
        continue;
      }
      throw new Error(`HTTP ${statusCode} ${statusMessage}\n${buffer.toString('utf8')}`);
    }
    return { buffer, headers };
  }

  throw lastErr;
}

function buildBase(config, org) {
  return `${config.baseUrl}/${org || config.org}`;
}

/**
 * Validate the PAT with a cheap, low-scope call (connectionData). Resolves with
 * the authenticated identity, or rejects with a clear auth error. Use as a
 * pre-flight test before other API calls.
 */
async function validatePat(config) {
  const data = await request(`${config.baseUrl}/${config.org}/_apis/connectionData`, { pat: config.pat });
  const u = (data && data.authenticatedUser) || {};
  // connectionData returns HTTP 200 even for an invalid PAT — it just resolves to
  // the anonymous identity (no id/descriptor). Treat that as an auth failure.
  if (!u.id && !u.subjectDescriptor) {
    throw new Error('Azure auth failed: PAT resolved to an anonymous identity (it is invalid, expired, or revoked). '
      + 'Create a new PAT and run: azure-connector config --pat <token> --pat-valid-to <YYYY-MM-DD>');
  }
  return {
    user: u.providerDisplayName || u.customDisplayName || u.id,
    id: u.id,
    descriptor: u.subjectDescriptor,
  };
}

module.exports = { request, requestBinary, buildBase, validatePat };
