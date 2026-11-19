'use strict';

const { request } = require('./api');

// ── pure helpers (no network — unit-tested) ─────────────────────────────────

// Accept a short branch ("features/x", "main") or a full ref
// ("refs/heads/features/x") and always return the full ref form the Build API
// expects. Passing through undefined/'' lets callers treat "no branch" as
// "any branch".
function normalizeBranchRef(branch) {
  if (!branch || branch === true) return undefined;
  const b = String(branch);
  if (b.startsWith('refs/')) return b;
  return `refs/heads/${b}`;
}

// Build the POST body that re-queues an existing build with the SAME
// configuration. This is what makes the command generic across every Platform
// pipeline: `parameters` (runtime variables) and `templateParameters` are
// simply carried over verbatim — a pipeline with no variables has neither, and
// the payload just omits them. Optionally override the branch to re-run the
// same config against a different ref.
function buildRerunPayload(build, { branch } = {}) {
  if (!build || !build.definition || build.definition.id == null) {
    throw new Error('Cannot re-run: source build has no definition id.');
  }
  const payload = {
    definition: { id: build.definition.id },
    sourceBranch: normalizeBranchRef(branch) || build.sourceBranch,
    reason: 'manual',
  };
  // parameters is a JSON *string* on the build object; templateParameters is an
  // object. Only include them when the source build actually had them.
  if (build.parameters) payload.parameters = build.parameters;
  // An empty string comes back for a string parameter that was left blank, but queueing it again is
  // refused ("The 'x' parameter is not a valid String."). Leaving it out falls back to the pipeline's
  // default, which is what the source build got for a blank value.
  const template = Object.fromEntries(
    Object.entries(build.templateParameters || {}).filter(([, v]) => v !== ''),
  );
  if (Object.keys(template).length) payload.templateParameters = template;
  return payload;
}

// Build the POST body that queues a FRESH run of a pipeline on a branch. Unlike
// buildRerunPayload it needs no earlier build on that branch: the pipeline runs
// with its own defaults, the way the "Run pipeline" button does.
function buildQueuePayload({ definitionId, branch } = {}) {
  if (definitionId == null || !/^\d+$/.test(String(definitionId))) {
    throw new Error('Cannot queue: a pipeline definition (--definition <id|name>) is required.');
  }
  const sourceBranch = normalizeBranchRef(branch);
  if (!sourceBranch) throw new Error('Cannot queue: a branch (--branch <name>) is required.');
  return { definition: { id: Number(definitionId) }, sourceBranch, reason: 'manual' };
}

// A build is finished when Azure reports status "completed"; only result
// "succeeded" counts as success (partiallySucceeded, failed and canceled do not).
function isBuildDone(b) {
  return !!b && b.status === 'completed';
}

function buildSucceeded(b) {
  return isBuildDone(b) && b.result === 'succeeded';
}

// Flatten a build into a stable, log-friendly shape.
function summarizeBuild(b, webBase) {
  return {
    id: b.id,
    buildNumber: b.buildNumber,
    definition: b.definition && b.definition.name,
    definitionId: b.definition && b.definition.id,
    status: b.status,
    result: b.result,
    branch: b.sourceBranch,
    sourceVersion: b.sourceVersion && b.sourceVersion.slice(0, 8),
    queueTime: b.queueTime,
    finishTime: b.finishTime,
    reason: b.reason,
    requestedFor: b.requestedFor && b.requestedFor.displayName,
    repository: b.repository && b.repository.name,
    parameters: b.parameters ? JSON.parse(b.parameters) : undefined,
    templateParameters: b.templateParameters,
    url: webBase ? `${webBase}/_build/results?buildId=${b.id}` : undefined,
  };
}

// ── network functions ───────────────────────────────────────────────────────

function projBase(config, project, org) {
  return `${config.baseUrl}/${org || config.org}/${encodeURIComponent(project)}`;
}

// Resolve a pipeline definition given by numeric id (returned as-is) or by
// name (looked up). Returns the numeric id, or null when `def` is falsy.
async function resolveDefinitionId(config, project, def, org) {
  if (!def || def === true) return null;
  if (/^\d+$/.test(String(def))) return parseInt(def, 10);
  const url = `${projBase(config, project, org)}/_apis/build/definitions?name=${encodeURIComponent(def)}&api-version=7.1`;
  const res = await request(url, { pat: config.pat });
  const defs = (res && res.value) || [];
  if (!defs.length) throw new Error(`No pipeline definition named "${def}" in project ${project}.`);
  return defs[0].id;
}

async function listBuilds(config, project, { branch, definitionId, top = 10, org } = {}) {
  const params = new URLSearchParams({
    $top: String(top),
    queryOrder: 'queueTimeDescending',
    'api-version': '7.1',
  });
  const ref = normalizeBranchRef(branch);
  if (ref) params.set('branchName', ref);
  if (definitionId) params.set('definitions', String(definitionId));
  const url = `${projBase(config, project, org)}/_apis/build/builds?${params.toString()}`;
  const res = await request(url, { pat: config.pat });
  return (res && res.value) || [];
}

async function getBuild(config, project, id, org) {
  const url = `${projBase(config, project, org)}/_apis/build/builds/${id}?api-version=7.1`;
  return request(url, { pat: config.pat });
}

async function queueBuild(config, project, payload, org) {
  const url = `${projBase(config, project, org)}/_apis/build/builds?api-version=7.1`;
  return request(url, { method: 'POST', pat: config.pat, body: payload });
}

// Poll a build until it completes or the timeout passes. `get` and `sleep` are
// injectable so the loop is unit-tested without the network. Returns
// { build, timedOut }; `build` is the last state read.
async function waitForBuild(id, {
  get, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  intervalMs = 20000, timeoutMs = 60 * 60000, onTick = () => {}, now = () => Date.now(),
} = {}) {
  if (typeof get !== 'function') throw new Error('waitForBuild needs a get(id) function.');
  const deadline = now() + timeoutMs;
  let b = await get(id);
  while (!isBuildDone(b)) {
    onTick(b);
    if (now() >= deadline) return { build: b, timedOut: true };
    await sleep(intervalMs);
    b = await get(id);
  }
  return { build: b, timedOut: false };
}

module.exports = {
  normalizeBranchRef,
  buildRerunPayload,
  buildQueuePayload,
  isBuildDone,
  buildSucceeded,
  waitForBuild,
  summarizeBuild,
  resolveDefinitionId,
  listBuilds,
  getBuild,
  queueBuild,
  projBase,
};
