'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function configPath() {
  return process.env.AZURE_CONFIG_FILE || path.join(os.homedir(), '.azure-connector.json');
}

function readFileConfig() {
  const file = configPath();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // ignore malformed config file
    return {};
  }
}

// Resolve a profile's PAT: literal `pat`, else the env var named by `patEnv`
// (so no secret need sit on disk — inject it at runtime, e.g. from a vault).
function profilePat(p) {
  if (!p) return '';
  if (p.pat) return p.pat;
  if (p.patEnv) return (process.env[p.patEnv] || '').trim();
  return '';
}

/**
 * Load configuration and resolve the ACTIVE profile.
 *
 * A single-PAT setup uses only the top-level fields. Multi-org setups add an
 * optional `profiles` map — a PAT is scoped to one Azure DevOps org, so it's one
 * profile per org.
 *
 *   ~/.azure-connector.json = {
 *     // top-level single profile (used when no `profiles` map is present):
 *     "pat": "...", "org": "evuptec", "project": "EVUP",
 *     "patName": "...", "patValidTo": "YYYY-MM-DD", "patWarnDays": 30,
 *     // optional multi-org:
 *     "defaultProfile": "<name>",
 *     "profiles": {
 *       "<name>": { "org": "...", "project": "...", "pat": "..." | "patEnv": "ENV_VAR",
 *                   "patName": "...", "patValidTo": "YYYY-MM-DD", "baseUrl": "..." }
 *     }
 *   }
 *
 * Profile selection precedence (non-interactive — never prompts):
 *   1. opts.flagProfile          (--profile <name>)
 *   2. opts.urlOrg               (org parsed from a PR/WI URL) → profile whose org matches
 *   3. process.env.AZURE_PROFILE
 *   4. defaultProfile
 *   5. the top-level single profile
 * Env vars (AZURE_PAT/AZURE_ORG/…) override the resolved profile's fields.
 */
function loadConfig(opts = {}) {
  const file = readFileConfig();
  const profiles = (file.profiles && typeof file.profiles === 'object') ? file.profiles : {};

  // The top-level config is itself a profile — the fallback when nothing else selects one.
  const topLevel = {
    name: '(default)',
    org: file.org || '',
    project: file.project || '',
    pat: file.pat || '',
    patName: file.patName || null,
    patValidTo: file.patValidTo || null,
    baseUrl: file.baseUrl || '',
  };

  // Index configured profiles by org for URL auto-selection.
  const byOrg = {};
  for (const [name, p] of Object.entries(profiles)) {
    if (p && p.org) byOrg[String(p.org).toLowerCase()] = { name, ...p };
  }
  if (topLevel.org && !byOrg[topLevel.org.toLowerCase()]) {
    byOrg[topLevel.org.toLowerCase()] = topLevel;
  }

  const { flagProfile, urlOrg } = opts;
  let active;
  let source;

  if (flagProfile && flagProfile !== true && profiles[flagProfile]) {
    active = { name: flagProfile, ...profiles[flagProfile] };
    source = `profile:${flagProfile}`;
  } else if (urlOrg && byOrg[String(urlOrg).toLowerCase()]) {
    active = byOrg[String(urlOrg).toLowerCase()];
    source = active.name === '(default)' ? 'config' : `profile(url-org):${active.name}`;
  } else if (process.env.AZURE_PROFILE && profiles[process.env.AZURE_PROFILE]) {
    active = { name: process.env.AZURE_PROFILE, ...profiles[process.env.AZURE_PROFILE] };
    source = `profile(env):${process.env.AZURE_PROFILE}`;
  } else if (file.defaultProfile && profiles[file.defaultProfile]) {
    active = { name: file.defaultProfile, ...profiles[file.defaultProfile] };
    source = `profile(default):${file.defaultProfile}`;
  } else {
    active = topLevel;
    source = 'config';
  }

  // Env vars override the resolved profile's fields (highest priority).
  const pat = process.env.AZURE_PAT || profilePat(active) || topLevel.pat || '';
  if (process.env.AZURE_PAT) source = 'env';

  const warnDaysRaw = process.env.AZURE_PAT_WARN_DAYS != null
    ? process.env.AZURE_PAT_WARN_DAYS : file.patWarnDays;
  const patWarnDays = warnDaysRaw != null && !isNaN(parseInt(warnDaysRaw, 10))
    ? parseInt(warnDaysRaw, 10) : 30;

  return {
    pat,
    org: process.env.AZURE_ORG || active.org || topLevel.org || '',
    project: process.env.AZURE_PROJECT || active.project || topLevel.project || null,
    baseUrl: process.env.AZURE_BASE_URL || active.baseUrl || topLevel.baseUrl || 'https://dev.azure.com',
    patValidTo: process.env.AZURE_PAT_VALID_TO || active.patValidTo || null,
    patName: process.env.AZURE_PAT_NAME || active.patName || null,
    patWarnDays,
    profileName: active.name,
    patSource: source,
    profilesConfigured: Object.keys(profiles),
  };
}

/**
 * Compute PAT expiry status from the locally-recorded validTo date.
 * (An Azure PAT that lacks token-management scope can't read its own expiry via
 * the API, so this is a local, zero-network date comparison.)
 */
function patExpiry(config) {
  if (!config.patValidTo) return { known: false };
  const exp = new Date(`${config.patValidTo}T23:59:59`);
  if (isNaN(exp.getTime())) return { known: false, invalid: true, raw: config.patValidTo };
  const daysLeft = Math.floor((exp.getTime() - Date.now()) / 86400000);
  const warnDays = config.patWarnDays != null ? config.patWarnDays : 30;
  return {
    known: true,
    validTo: config.patValidTo,
    name: config.patName,
    daysLeft,
    expired: daysLeft < 0,
    warn: daysLeft <= warnDays,
  };
}

/**
 * Print a PAT-expiry warning to stderr when within the warning window (or past
 * expiry). Cheap to call on every invocation — it never touches the network.
 */
function warnIfExpiring(config) {
  const e = patExpiry(config);
  if (!e.known || !e.warn) return;
  const who = e.name ? `"${e.name}" ` : '';
  if (e.expired) {
    console.error(`⚠️  Azure PAT ${who}EXPIRED on ${e.validTo} (${-e.daysLeft} day(s) ago). `
      + `Calls will fail — create a new PAT and run: azure-connector config --pat <token> --pat-valid-to <YYYY-MM-DD>`);
  } else {
    console.error(`⚠️  Azure PAT ${who}expires on ${e.validTo} (${e.daysLeft} day(s) left). `
      + `Rotate it soon: azure-connector config --pat <token> --pat-valid-to <YYYY-MM-DD>`);
  }
}

function saveConfig(patch) {
  const existing = readFileConfig();
  const merged = { ...existing, ...patch };
  const file = configPath();
  fs.writeFileSync(file, JSON.stringify(merged, null, 2), 'utf8');
  console.log(`Config saved to ${file}`);
}

function requirePat(config) {
  if (!config.pat) {
    console.error('ERROR: No PAT configured.\n'
      + 'Set the AZURE_PAT env var, run: azure-connector config --pat <token>,\n'
      + 'or add a profile with a "pat"/"patEnv" to ~/.azure-connector.json.');
    process.exit(1);
  }
}

/**
 * Parse Azure DevOps URLs into their components.
 *
 * Supported patterns:
 *   PR:        https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{prId}
 *   Work item: https://dev.azure.com/{org}/{project}/_workitems/edit/{id}
 *   Tag:       https://dev.azure.com/{org}/{project}/_git/{repo}?version=GT{tagName}
 */
function parseUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }

  const segments = u.pathname.replace(/^\//, '').split('/');
  // segments[0] = org, segments[1] = project (may be URL-encoded with %20)
  const org = segments[0];
  const project = decodeURIComponent(segments[1] || '');

  // Work item: /{org}/{project}/_workitems/edit/{id}
  if (segments[2] === '_workitems' && segments[3] === 'edit') {
    return { type: 'workitem', org, project, id: parseInt(segments[4], 10) };
  }

  // PR or tag: /{org}/{project}/_git/{repo}/pullrequest/{prId}
  if (segments[2] === '_git') {
    const repo = decodeURIComponent(segments[3] || '');
    if (segments[4] === 'pullrequest') {
      return { type: 'pr', org, project, repo, prId: parseInt(segments[5], 10) };
    }
    // PR creation URL: pullrequestcreate?sourceRef=...&targetRef=...
    if (segments[4] === 'pullrequestcreate') {
      const sourceRef = u.searchParams.get('sourceRef') || '';
      const targetRef = u.searchParams.get('targetRef') || '';
      return { type: 'pr-compare', org, project, repo, sourceRef, targetRef };
    }
    // Tag via query string: ?version=GT{tagName}
    const version = u.searchParams.get('version');
    if (version && version.startsWith('GT')) {
      return { type: 'tag', org, project, repo, tagName: version.slice(2) };
    }
    return { type: 'repo', org, project, repo };
  }

  return null;
}

module.exports = { loadConfig, saveConfig, requirePat, parseUrl, patExpiry, warnIfExpiring, profilePat, configPath };
