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
  if (build.templateParameters && Object.keys(build.templateParameters).length) {
    payload.templateParameters = build.templateParameters;
  }
  return payload;
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

module.exports = {
  normalizeBranchRef,
  buildRerunPayload,
  summarizeBuild,
  resolveDefinitionId,
  listBuilds,
  getBuild,
  queueBuild,
  projBase,
};
