#!/usr/bin/env node
'use strict';

/**
 * azure-connector — Azure DevOps CLI tool
 *
 * Usage: azure-connector <command> [subcommand] [options] [args]
 *
 * Commands:
 *   config                         Show or set configuration
 *   pr get      <pr-url>           Get PR metadata
 *   pr create   <repo-url> --title <t> [--source <b>] [--target <b>] [--desc <t>|--desc-file <p>|--body-file <p>] [--work-items <ids>] [--draft]  Create a PR
 *   pr comments <pr-url>           List PR comment threads
 *   pr comment  <pr-url> --body-file <path> [--file <path> --line <n>]   Add a PR comment (markdown file)
 *   pr reply        <pr-url> <threadId> --body-file <path> [--comment <n>]  Reply inside an existing thread (markdown file)
 *   pr edit-comment <pr-url> <threadId> --body-file <path> [--comment <n>]  Edit a comment in place (markdown file)
 *   pr delete-thread <pr-url> <threadId> [--comment <n>]  Delete comment + close thread
 *   pr close-thread  <pr-url> <threadId>                  Close/resolve a thread
 *   wi get      <wi-url>           Get work item data
 *   wi comments <wi-url>           List work item comments
 *   wi comment  <wi-url> --body-file <path> [--field <ref>] [--as-comment]  Add a comment; if the WI has long-form custom fields, lists them and stops unless --field/--as-comment
 *   wi edit-comment <wi-url> <commentId> --body-file <path>   Edit a comment in place (Markdown file)
 *   wi delete-comment <wi-url> <commentId>   Delete a work item comment (get id via `wi comments --ids`)
 *   wi set-state <wi-url> <state>  Change a work item's state (System.State)
 *   wi link-pr  <wi-url> <pr-url>  Link an existing pull request to a work item
 *   wi create-task <parent-url> <title> [--estimate <h>] [--desc <t>] [--assignee <email>]
 *   wi attachments <wi-url>        List attachments
 *   wi download <wi-url>  <n|name>  Download attachment (by index or name)
 *   wiki list --project <project> [--org <org>]  List wikis in a project
 *   wiki pages --project <project> --wiki <wikiIdOrName> [--org <org>]  List wiki pages
 *   wiki get --project <project> --wiki <wikiIdOrName> --page <path> [--org <org>]  Get page content (markdown)
 *
 * Comment file formats:
 *   PR comments  — write the body in Markdown (headers, lists, bold, code blocks work).
 *   WI comments  — write the body in HTML (<br>, <b>, <ul><li>, <pre> work; Markdown is not rendered).
 */


const path = require('path');
const fs = require('fs');
const { loadConfig, saveConfig, requirePat, parseUrl, patExpiry, warnIfExpiring } = require('./lib/config');
const { request, validatePat } = require('./lib/api');
const pr = require('./lib/pr');
const wi = require('./lib/workitem');
const fmt = require('./lib/format');
const build = require('./lib/build');
// Suffixed: `repo` and `iteration` are already local variable names in several
// handlers, and a shadowed module reference fails at call time, not at load.
const iterationLib = require('./lib/iteration');
const repoLib = require('./lib/repo');
const links = require('./lib/links');
const verify = require('./lib/verify');

// ── helpers ────────────────────────────────────────────────────────────────

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

// Azure repo paths look like "/SCH/Foo.cs". When this CLI is called from Git
// Bash, the MSYS layer rewrites a leading-slash argument into a Windows path
// before Node sees it (e.g. "/SCH/Foo.cs" -> "C:/Program Files/Git/SCH/Foo.cs"),
// which breaks the inline-comment anchor. Undo that mangling so --file works
// from any shell (and accept a slash-less path, which MSYS leaves untouched).
function normalizeAzureRepoPath(p) {
  // null/undefined/'' or a valueless flag (true) → no path (PR-level, not "/true").
  if (!p || p === true) return null;
  let s = String(p).replace(/\\/g, '/');

  // Clean repo-style path (typical when called from PowerShell/cmd).
  if (s.startsWith('/') && !/^\/[A-Za-z]:\//.test(s)) return s;

  // Strip the Git install root that MSYS prepended. EXEPATH points at the
  // bin dir (".../Git/bin" or ".../Git/usr/bin"); its parent is the root.
  const exe = (process.env.EXEPATH || '').replace(/\\/g, '/');
  const root = exe.replace(/\/(?:usr\/)?bin\/?$/i, '');
  if (root && s.toLowerCase().startsWith(root.toLowerCase() + '/')) {
    s = s.slice(root.length);
  }

  // If it still looks like a Windows drive path we couldn't recover, hand back
  // the original so the failure is visible rather than silently corrupted.
  if (/^[A-Za-z]:\//.test(s)) return p;

  return s.startsWith('/') ? s : '/' + s;
}

function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      flags[key] = val;
    } else {
      args.push(argv[i]);
    }
  }
  return { args, flags };
}

// Every flag any command reads. parseArgs accepts anything that starts with `--`,
// so a typo (`--jsn`, `--porject`) used to be absorbed in silence and the command
// ran with the flag simply not applied — `wi get --json` printing human text and
// exiting 0 is the shape of that bug.
//
// This FAILS rather than warning, because the caller is usually an agent.
//
// A human sees a warning scroll past and reacts. An agent reads the exit code and
// the last line of output: a warning on stderr followed by exit 0 reads as success,
// so it records "I set --json" / "I passed --yes" and carries the wrong belief into
// every later step. The failure mode is silent and compounding.
//
// A hard error is the opposite: it is unmissable, it names the likely correction,
// and retrying with the fix costs one call. The usual argument against — breaking
// existing scripted callers — barely applies here, because those callers are agents
// that read the error and correct themselves. `--no-strict-flags` is the escape
// hatch for a genuinely unattended pipeline.
const KNOWN_FLAGS = new Set([
  'activity', 'all', 'all-fields', 'allow-duplicate', 'allow-empty', 'as-comment', 'assignee',
  'base-url', 'body-file', 'branch', 'comment', 'content', 'current', 'definition', 'depth',
  'desc', 'desc-file', 'draft', 'dry-run', 'entered', 'estimate', 'expect-head', 'field',
  'fields', 'file', 'filter', 'force', 'from-markdown', 'full', 'h', 'help', 'hours', 'ids', 'json', 'line',
  'no-preflight', 'no-resolve', 'no-type', 'no-validate', 'no-wi', 'org', 'out', 'page', 'pat',
  'pat-name', 'pat-valid-to', 'pat-warn-days', 'patch', 'profile', 'project', 'raw', 'repo',
  'since', 'source', 'state', 'status', 'target', 'team', 'time-in-state', 'title',
  'title-contains', 'top', 'type', 'wi', 'wiki', 'wiql', 'work-items', 'yes',
  'against', 'batch', 'verify', 'no-strict-flags',
]);

/**
 * Pure: unknown flags, each with a spelling suggestion when one is close.
 *
 * Picks the CLOSEST candidate, not the first within the threshold — taking the first
 * makes the suggestion depend on set order, and a wrong suggestion is worse than none
 * when the caller is an agent that will act on it.
 */
function closestFlag(name, known = KNOWN_FLAGS) {
  let best = null;
  let bestDistance = 3; // more than 2 edits is not a suggestion
  for (const candidate of known) {
    const d = levenshtein(name, candidate);
    if (d < bestDistance) { best = candidate; bestDistance = d; }
  }
  return best;
}

function unknownFlags(flags, known = KNOWN_FLAGS) {
  return Object.keys(flags || {})
    .filter((k) => !known.has(k))
    .map((k) => ({ flag: k, suggestion: closestFlag(k, known) }));
}

function checkUnknownFlags(flags, known = KNOWN_FLAGS) {
  const unknown = unknownFlags(flags, known);
  if (!unknown.length) return;
  const lines = unknown.map(({ flag, suggestion }) =>
    `  --${flag}${suggestion ? `   did you mean --${suggestion}?` : '   (no close match)'}`);
  if (flags['no-strict-flags']) {
    console.error(`warning: ignoring unknown flag(s):\n${lines.join('\n')}`);
    return;
  }
  die(`Unknown flag(s) — nothing was run:\n${lines.join('\n')}\n`
    + 'An unknown flag is silently dropped, so the command would have run WITHOUT it. '
    + 'Fix the spelling, or pass --no-strict-flags to proceed anyway.');
}

// Small edit distance, capped: only used to suggest a correction in a warning.
function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

// Convert literal escape sequences like \\n, \\t, \\r into real characters when the
// description is passed inline via --desc. Shells (especially PowerShell) pass the
// backslash-n text literally, so without this the PR description is rendered as one
// cramped line. File input (--body-file / --desc-file) is already real text and is
// left untouched.
function unescapeDescription(text) {
  if (text == null || typeof text !== 'string') return text;
  return text
    .replace(/\\n/g, '\n')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
}

// Resolve a work-item argument that may be either a full Azure DevOps URL or a
// bare numeric id. When a bare id is given, the project is taken from the
// --project flag, AZURE_PROJECT env var, or the configured default project.
function needWorkItemUrlOrId(raw, config, flags) {
  if (!raw) die('Missing work item URL or id.');

  const parsed = parseUrl(raw);
  if (parsed && parsed.type === 'workitem') {
    return parsed;
  }

  const id = parseInt(raw, 10);
  if (isNaN(id)) die(`Cannot parse work item URL or id: ${raw}`);

  const project = (flags.project && flags.project !== true)
    ? flags.project
    : (config.project || null);
  if (!project) die(
    `Work item id "${raw}" requires a project. Pass --project "<project>", ` +
    `set AZURE_PROJECT, or run: azure-connector config --project "<project>"`
  );

  return { type: 'workitem', org: config.org, project, id };
}

// Resolve a PR argument that may be either a full Azure DevOps URL or a bare
// numeric id. Unlike work items, a PR id is only unique within its repository,
// so a bare id also needs a project and a repo — taken from --project/--repo,
// the AZURE_PROJECT/AZURE_REPO env vars, or the configured defaults.
function needPrUrlOrId(raw, config, flags = {}) {
  if (!raw) die('Missing PR URL or id.');

  // `pr-compare` is only meaningful to the commands that handle it explicitly
  // (pr get / pr diff); they call parseUrl themselves before reaching here.
  const parsed = parseUrl(raw);
  if (parsed && parsed.type === 'pr') return parsed;
  if (parsed) die(`Expected a pr URL but got type '${parsed.type}'.`);

  const prId = parseInt(raw, 10);
  if (isNaN(prId) || String(prId) !== String(raw).trim()) {
    die(`Cannot parse PR URL or id: ${raw}`);
  }

  const pick = (k, envK, cfgK) =>
    (flags[k] && flags[k] !== true) ? flags[k] : (process.env[envK] || config[cfgK] || null);
  const project = pick('project', 'AZURE_PROJECT', 'project');
  const repo = pick('repo', 'AZURE_REPO', 'repo');

  const missing = [];
  if (!project) missing.push('--project "<project>" (or AZURE_PROJECT)');
  if (!repo) missing.push('--repo "<repo>" (or AZURE_REPO)');
  if (missing.length) die(
    `PR id "${raw}" requires ${missing.join(' and ')}. ` +
    'Set defaults with: azure-connector config --project "<p>" --repo "<r>", ' +
    'or pass the full PR URL instead.'
  );

  return { type: 'pr', org: config.org, project, repo, prId };
}

// ── command handlers ───────────────────────────────────────────────────────

async function cmdConfig(args, flags) {
  const config = loadConfig();
  const has = (k) => flags[k] && flags[k] !== true;
  if (flags.pat || flags.org || flags.project || flags.repo || flags['base-url'] || has('pat-valid-to') || has('pat-name') || has('pat-warn-days')) {
    const patch = {};
    if (flags.pat) patch.pat = flags.pat;
    if (flags.org) patch.org = flags.org;
    if (flags.project) patch.project = flags.project;
    if (flags.repo) patch.repo = flags.repo;
    if (flags['base-url']) patch.baseUrl = flags['base-url'];
    if (has('pat-valid-to')) patch.patValidTo = flags['pat-valid-to'];
    if (has('pat-name')) patch.patName = flags['pat-name'];
    if (has('pat-warn-days')) patch.patWarnDays = parseInt(flags['pat-warn-days'], 10);
    saveConfig(patch);
    return;
  }
  // Show current config (mask PAT)
  const masked = {
    pat: config.pat ? config.pat.slice(0, 6) + '…' + config.pat.slice(-4) : '(not set)',
    org: config.org,
    project: config.project || '(not set)',
    repo: config.repo || '(not set)',
    baseUrl: config.baseUrl,
    patName: config.patName || '(unknown)',
    patValidTo: config.patValidTo || '(unknown)',
    patWarnDays: config.patWarnDays,
    profile: config.profileName,
    patSource: config.patSource,
  };
  console.log(JSON.stringify(masked, null, 2));
  const e = patExpiry(config);
  if (e.known) {
    console.log(`\nPAT expiry: ${e.validTo} — ${e.expired ? `EXPIRED ${-e.daysLeft} day(s) ago` : `${e.daysLeft} day(s) left`}`);
  }
  if (config.profilesConfigured && config.profilesConfigured.length) {
    console.log(`\nProfiles:    ${config.profilesConfigured.join(', ')}  (select with --profile <name>, AZURE_PROFILE, or a URL's org)`);
  }
  console.log(`\nConfig file: ${require('./lib/config').configPath()}`);
  console.log('Env vars:    AZURE_PAT, AZURE_ORG, AZURE_PROJECT, AZURE_REPO, AZURE_BASE_URL, AZURE_PROFILE, AZURE_PAT_VALID_TO, AZURE_PAT_NAME, AZURE_PAT_WARN_DAYS, AZURE_PREFLIGHT');
}

// ── PAT commands ─────────────────────────────────────────────────────────────

async function cmdPatCheck(config) {
  const mask = config.pat ? config.pat.slice(0, 6) + '…' + config.pat.slice(-4) : '(not set)';
  console.log(`Org:      ${config.org}`);
  console.log(`Profile:  ${config.profileName}`);
  console.log(`PAT:      ${mask}  (source: ${config.patSource})`);
  console.log(`Name:     ${config.patName || '(unknown — record with: azure-connector config --pat-name "<name>")'}`);
  const e = patExpiry(config);
  if (e.known) {
    console.log(`Expires:  ${e.validTo}  (${e.expired ? `EXPIRED ${-e.daysLeft}d ago` : `${e.daysLeft}d left`})`);
  } else {
    console.log('Expires:  (unknown — record with: azure-connector config --pat-valid-to <YYYY-MM-DD>)');
  }
  process.stdout.write('Auth:     testing connectionData… ');
  try {
    const v = await validatePat(config);
    console.log(`OK — authenticated as ${v.user}`);
  } catch (err) {
    console.log('FAILED');
    die(err.message);
  }
  warnIfExpiring(config);
}

// ── PR commands ────────────────────────────────────────────────────────────

async function cmdPrGet(rawUrl, config, flags = {}) {
  const compare = parseUrl(rawUrl);
  if (compare && compare.type === 'pr-compare') {
    const { org, project, repo, sourceRef, targetRef } = compare;
    const result = await pr.findPullRequestsByBranch({ config, org, project, repo, sourceRef, targetRef });
    const prs = result.value || [];
    if (prs.length > 0) {
      prs.forEach((prData) => fmt.printPullRequest(prData));
    } else {
      console.log(`No PR found for ${sourceRef} → ${targetRef}. Showing branch diff:`);
      const diff = await pr.getBranchDiff({ config, org, project, repo, sourceRef, targetRef });
      fmt.printBranchDiff(diff, sourceRef, targetRef);
    }
    return;
  }

  const p = needPrUrlOrId(rawUrl, config, flags);
  const data = await pr.getPullRequest({ config, ...p });

  // Linked work items are what a reviewer needs first, and "(none)" is itself a
  // finding — so this is always fetched, not hidden behind a flag.
  const workItems = await pr.getPullRequestWorkItems({ config, ...p });

  // --full adds the review state: votes per reviewer and the thread counts.
  let extras = null;
  if (flags.full) {
    const threads = await pr.getComments({ config, ...p });
    extras = { threads: threads.value || [] };
  }

  if (flags.json) {
    console.log(JSON.stringify({ ...data, workItems, ...(extras || {}) }, null, 2));
    return;
  }

  fmt.printPullRequest(data, { workItems, ...(extras || {}) });
}

async function cmdPrDiff(rawUrl, config, flags = {}) {
  const compare = parseUrl(rawUrl);

  let org, project, repo, sourceRef, targetRef;

  if (compare && compare.type === 'pr-compare') {
    ({ org, project, repo, sourceRef, targetRef } = compare);
    // Strip refs/heads/ prefix if present
    sourceRef = sourceRef.replace(/^refs\/heads\//, '');
    targetRef = targetRef.replace(/^refs\/heads\//, '');
  } else {
    const parsed = needPrUrlOrId(rawUrl, config, flags);
    const prData = await pr.getPullRequest({ config, ...parsed });
    ({ org, project, repo } = parsed);
    sourceRef = prData.sourceRefName.replace(/^refs\/heads\//, '');
    targetRef = prData.targetRefName.replace(/^refs\/heads\//, '');
  }

  const diff = await pr.getBranchDiff({ config, org, project, repo, sourceRef, targetRef });
  const changes = (diff.changes || []).filter((c) => !c.item?.isFolder);

  fmt.printBranchDiff(diff, sourceRef, targetRef);

  if (!changes.length) return;

  // Unified diff is the default (that is what a review needs); --full / --content
  // restores the whole-file dump of every changed file from the source branch.
  const contentMode = flags.full === true || flags.content === true;

  if (!contentMode) {
    console.log('\nFetching unified diffs...');
    const results = [];
    for (const c of changes) {
      const filePath = c.item?.path;
      const changeType = c.changeType || 'edit';
      if (!filePath) {
        results.push({ path: filePath, changeType, patch: null });
        continue;
      }
      let oldContent = null;
      let newContent = null;
      if (changeType !== 'add') {
        try {
          oldContent = await pr.getFileContent({ config, org, project, repo, path: filePath, branch: targetRef });
        } catch (e) {
          oldContent = `(error fetching old content: ${e.message})`;
        }
      }
      if (changeType !== 'delete') {
        try {
          newContent = await pr.getFileContent({ config, org, project, repo, path: filePath, branch: sourceRef });
        } catch (e) {
          newContent = `(error fetching new content: ${e.message})`;
        }
      }
      const patch = fmt.computeUnifiedDiff(filePath, oldContent, newContent);
      results.push({ path: filePath, changeType, patch });
    }
    fmt.printPatches(results);
  } else {
    console.log('\nFetching file contents...');
    const results = [];
    for (const c of changes) {
      const filePath = c.item?.path;
      const changeType = c.changeType || 'edit';
      if (!filePath || changeType === 'delete') {
        results.push({ path: filePath, changeType, content: null });
        continue;
      }
      try {
        const content = await pr.getFileContent({ config, org, project, repo, path: filePath, branch: sourceRef });
        results.push({ path: filePath, changeType, content: typeof content === 'string' ? content : JSON.stringify(content, null, 2) });
      } catch (e) {
        results.push({ path: filePath, changeType, content: `(error fetching: ${e.message})` });
      }
    }
    fmt.printFileContents(results);
  }
}

async function cmdPrList(rawRepo, flags, config) {
  let org, project, repo;
  const parsed = rawRepo && rawRepo !== true ? parseUrl(rawRepo) : null;
  if (parsed && (parsed.type === 'repo' || parsed.type === 'pr' || parsed.type === 'tag')) {
    ({ org, project, repo } = parsed);
  } else {
    org = (flags.org && flags.org !== true) ? flags.org : config.org;
    project = (flags.project && flags.project !== true) ? flags.project : config.project;
    repo = (flags.repo && flags.repo !== true) ? flags.repo
      : (rawRepo && rawRepo !== true && !/^https?:/i.test(rawRepo) ? rawRepo : null);
  }
  if (!org || !project || !repo) {
    die('Usage: pr list <repo-url> | --project <p> --repo <r> [--status active|completed|abandoned|all] [--target <branch>] [--top <n>] [--since <YYYY-MM-DD>] [--json]');
  }
  const status = (flags.status && flags.status !== true) ? flags.status : 'completed';
  const top = (flags.top && flags.top !== true) ? parseInt(flags.top, 10) : 50;
  const targetRef = (flags.target && flags.target !== true) ? flags.target : undefined;
  const data = await pr.listPullRequests({ config, org, project, repo, status, top, targetRef });
  let prs = (data && data.value) || [];
  if (flags.since && flags.since !== true) {
    const since = new Date(`${flags.since}T00:00:00`);
    if (isNaN(since.getTime())) die(`Invalid --since date: ${flags.since} (use YYYY-MM-DD).`);
    prs = prs.filter((p) => new Date(p.closedDate || p.creationDate) >= since);
  }
  if (flags.json) { console.log(JSON.stringify(prs, null, 2)); return; }
  console.log(`${prs.length} PR(s) [${status}] in ${project}/${repo}${targetRef ? ` -> ${targetRef}` : ''}`);
  for (const p of prs) {
    const date = String(p.closedDate || p.creationDate || '').slice(0, 10);
    const author = String(p.createdBy?.displayName || '').slice(0, 22).padEnd(22);
    console.log(`#${p.pullRequestId}\t${date}\t${String(p.status).padEnd(9)}\t${author}\t${p.title}`);
  }
}

async function cmdPrComments(rawUrl, config, flags = {}) {
  const p = needPrUrlOrId(rawUrl, config, flags);
  const data = await pr.getComments({ config, ...p });
  fmt.printCommentThreads(data);
}

async function cmdPrAbandon(rawUrl, config, flags = {}) {
  const p = needPrUrlOrId(rawUrl, config, flags);
  await pr.abandonPullRequest({ config, ...p });
  console.log(`PR #${p.prId} abandoned. (Branches remain — delete them separately if needed.)`);
}

// Thin network wrapper around pr.threadsAnchoredAt — kept separate so the matching
// rule itself stays pure and unit-tested.
async function findThreadsAt({ config, p, filePath, lineNumber }) {
  try {
    const data = await pr.getComments({ config, ...p });
    return pr.threadsAnchoredAt(data, filePath, lineNumber);
  } catch (e) {
    console.error(`  note: could not check for duplicate threads (${e.message}); posting anyway.`);
    return [];
  }
}

// Resolve an inline-comment anchor against the PR's LATEST iteration so a comment
// never lands on a phantom line. Auto-corrects file-path casing/leading-slash,
// picks the correct side (right for add/edit, left for delete), and verifies the
// line exists on that side. Throws a clear, actionable error when it can't.
async function resolveInlineAnchor({ config, p, filePath, lineNumber, iterationsResp }) {
  const warnings = [];
  const its = iterationsResp || await pr.getIterations({ config, ...p });
  const iterations = (its && its.value) || [];
  if (!iterations.length) {
    throw new Error(`PR #${p.prId} has no iterations (no commits?). Cannot anchor an inline comment.`);
  }
  const latest = iterations[iterations.length - 1];
  const changesResp = await pr.getIterationChanges({ config, ...p, iterationId: latest.id });
  const entries = (changesResp && changesResp.changeEntries) || [];

  const norm = (s) => String(s || '').replace(/^\/+/, '').replace(/\\/g, '/').toLowerCase();
  const want = norm(filePath);
  const match = entries.find((e) => norm(e.item && e.item.path) === want);
  if (!match) {
    const sample = entries.map((e) => e.item && e.item.path).filter(Boolean).slice(0, 25);
    throw new Error(
      `File "${filePath}" is not among the ${entries.length} changed file(s) in PR #${p.prId} `
      + `(latest iteration ${latest.id}). Check the path, or the diff is stale.\nChanged files include:\n  `
      + sample.join('\n  ')
    );
  }

  const canonicalPath = match.item.path; // Azure's canonical casing
  if (canonicalPath !== filePath) warnings.push(`path corrected: "${filePath}" -> "${canonicalPath}"`);

  const changeType = String(match.changeType || '').toLowerCase();
  let side = 'right';
  if (changeType.includes('delete') && !changeType.includes('edit') && !changeType.includes('add')) {
    side = 'left';
    warnings.push('file is deleted in this PR; anchoring on the LEFT (pre-image) side');
  }

  if (lineNumber != null) {
    const commit = side === 'right'
      ? latest.sourceRefCommit && latest.sourceRefCommit.commitId
      : latest.targetRefCommit && latest.targetRefCommit.commitId;
    if (commit) {
      let content;
      try {
        content = await pr.getFileContent({ config, ...p, path: canonicalPath, commitId: commit });
      } catch (e) {
        warnings.push(`could not fetch file to verify line (${e.message}); posting without line verification`);
      }
      if (typeof content === 'string') {
        const lineCount = content.split(/\r\n|\r|\n/).length;
        if (lineNumber > lineCount) {
          throw new Error(
            `Line ${lineNumber} does not exist in "${canonicalPath}" (${side} side has ${lineCount} line(s)). `
            + `The diff used to pick this line is stale — re-read the PR diff and use the new right-hand line numbers.`
          );
        }
      }
    }
  }

  return { path: canonicalPath, line: lineNumber, side, warnings };
}

/**
 * `pr comment --batch <manifest.json>` — validate every anchor first, then post.
 *
 * The property this buys, together with --expect-head: EITHER THE WHOLE REVIEW
 * LANDS AGAINST THE HEAD YOU REVIEWED, OR NOTHING DOES. Posting one at a time in a
 * shell loop meant a failure at item 5 of 13 left the review half-published with no
 * record of where it stopped.
 *
 * Manifest: an array of items, or { expectHead, comments: [...] }.
 * Each item: { file, line, bodyFile } — bodyFile keeps rich text out of the shell,
 * which is the same reason inline text is refused everywhere else.
 */
async function cmdPrCommentBatch(rawUrl, flags, config) {
  const manifestPath = flags.batch;
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (e) { die(`Could not read --batch "${manifestPath}": ${e.message}`); }

  const items = Array.isArray(manifest) ? manifest : (manifest.comments || []);
  if (!items.length) die(`--batch "${manifestPath}" contains no comments.`);
  const expectHead = (flags['expect-head'] && flags['expect-head'] !== true)
    ? flags['expect-head'] : (Array.isArray(manifest) ? null : manifest.expectHead);

  const p = needPrUrlOrId(rawUrl, config, flags);
  const base = path.dirname(path.resolve(manifestPath));

  // ── phase 1: validate everything, post nothing ────────────────────────────
  const iterationsResp = await pr.getIterations({ config, ...p });
  const head = pr.latestHeadCommit(iterationsResp);
  if (expectHead) {
    const v = pr.checkExpectedHead(head, expectHead);
    if (!v.ok) {
      die(`PR #${p.prId} head has MOVED since the review was written.\n`
        + `  reviewed: ${v.expected}\n  current:  ${v.actual || '(unknown)'}\n`
        + `Nothing was posted — all ${items.length} comment(s) were held back.`);
    }
  }
  console.error(`Validating ${items.length} comment(s) against head ${String(head).slice(0, 10)}…`);

  const existing = await pr.getComments({ config, ...p }).catch(() => null);
  const prepared = [];
  const problems = [];
  for (const [i, item] of items.entries()) {
    const label = `#${i + 1}`;
    try {
      if (!item.bodyFile) throw new Error('missing "bodyFile"');
      const bodyPath = path.isAbsolute(item.bodyFile) ? item.bodyFile : path.join(base, item.bodyFile);
      const content = fs.readFileSync(bodyPath, 'utf8');
      if (!content.trim()) throw new Error(`body file "${item.bodyFile}" is empty`);

      let filePath = normalizeAzureRepoPath(item.file);
      const lineNumber = item.line != null ? parseInt(item.line, 10) : null;
      let side = 'right';
      if (filePath) {
        const anchor = await resolveInlineAnchor({ config, p, filePath, lineNumber, iterationsResp });
        filePath = anchor.path;
        side = anchor.side;
        anchor.warnings.forEach((w) => console.error(`  ${label} note: ${w}`));
        if (existing && !flags['allow-duplicate']) {
          const dup = pr.threadsAnchoredAt(existing, filePath, lineNumber);
          if (dup.length) throw new Error(`a thread already exists at ${filePath}:${lineNumber} (thread ${dup[0].id})`);
        }
      }
      prepared.push({ label, content, filePath, lineNumber, side });
    } catch (e) {
      problems.push(`  ${label} ${item.file || '(PR-level)'}:${item.line ?? ''} — ${e.message}`);
    }
  }

  if (problems.length) {
    die(`${problems.length} of ${items.length} comment(s) failed validation:\n${problems.join('\n')}\n`
      + 'Nothing was posted. Fix the manifest and re-run — a half-posted review is worse than none.');
  }
  console.error(`  ✓ all ${prepared.length} anchor(s) valid.`);

  if (flags['dry-run']) {
    console.log(`DRY RUN — ${prepared.length} comment(s) would be posted to PR #${p.prId}:`);
    for (const c of prepared) {
      console.log(`  ${c.label} ${c.filePath ? `${c.filePath}:${c.lineNumber ?? '(file)'} [${c.side}]` : 'PR-level'}`
        + `  (${c.content.length} chars)`);
    }
    return;
  }

  // ── phase 2: post ─────────────────────────────────────────────────────────
  const posted = [];
  for (const c of prepared) {
    try {
      const r = await pr.addComment({ config, ...p, content: c.content, filePath: c.filePath, lineNumber: c.lineNumber, side: c.side });
      posted.push({ label: c.label, threadId: r.id, where: c.filePath ? `${c.filePath}:${c.lineNumber ?? ''}` : 'PR-level' });
      console.log(`  ${c.label} posted — thread ${r.id}`);
    } catch (e) {
      // Validation passed, so a failure here is a transport/permission problem.
      // Report exactly what did land: silence would leave a partial review untracked.
      console.error(`\n  ${c.label} FAILED after ${posted.length} comment(s) were already posted: ${e.message}`);
      console.error('  Already posted (do NOT re-run the whole batch — you would duplicate these):');
      posted.forEach((x) => console.error(`    ${x.label} thread ${x.threadId}  ${x.where}`));
      process.exitCode = 1;
      return;
    }
  }
  console.log(`\n${posted.length} comment(s) posted to PR #${p.prId}.`);
}

async function cmdPrComment(rawUrl, text, flags, config) {
  if (flags.batch) return cmdPrCommentBatch(rawUrl, flags, config);
  if (text && text !== true) {
    die('Inline text is not supported for PR comments. Write the body to a Markdown file and use --body-file <path>.');
  }
  if (!flags['body-file']) {
    die('Missing --body-file <path>. PR comments must be provided from a Markdown file.');
  }
  let content;
  try {
    content = fs.readFileSync(flags['body-file'], 'utf8');
  } catch (e) {
    die(`Could not read --body-file "${flags['body-file']}": ${e.message}`);
  }
  if (!content.trim()) die('Comment body file is empty.');
  const p = needPrUrlOrId(rawUrl, config, flags);
  let filePath = normalizeAzureRepoPath(flags.file);
  const lineNumber = flags.line ? parseInt(flags.line, 10) : null;
  let side = 'right';

  // --expect-head: refuse to post when the PR has moved since the diff was read.
  // This is the guard --dry-run cannot give you: a shifted anchor still validates,
  // so a comment lands quietly on whatever now occupies that line.
  let iterationsResp = null;
  const expectHead = (flags['expect-head'] && flags['expect-head'] !== true) ? flags['expect-head'] : null;
  if (flags['expect-head'] === true) {
    die('--expect-head needs the commit sha you reviewed, e.g. --expect-head b31b63dc89. '
      + 'Get it from `pr diff --json` or from the iteration you based the review on.');
  }
  if (expectHead) {
    iterationsResp = await pr.getIterations({ config, ...p });
    const head = pr.latestHeadCommit(iterationsResp);
    const verdict = pr.checkExpectedHead(head, expectHead);
    if (!verdict.ok && verdict.reason === 'malformed') {
      die(`--expect-head "${expectHead}" is not a commit sha (expected 7-40 hex characters).`);
    }
    if (!verdict.ok) {
      die(`PR #${p.prId} head has MOVED since you read the diff.\n`
        + `  reviewed: ${verdict.expected}\n`
        + `  current:  ${verdict.actual || '(unknown)'}\n`
        + 'Nothing was posted. Line numbers from the old diff may now point at different code — '
        + 're-read the diff, re-check the anchors, then post against the new head.');
    }
    console.error(`  note: head confirmed at ${verdict.actual} (matched ${verdict.expected}).`);
  }

  // Self-correcting anchor: validate/repair the file+line against the PR's latest
  // iteration before posting (skip with --no-validate for the old blind behavior).
  if (filePath && !flags['no-validate']) {
    const anchor = await resolveInlineAnchor({ config, p, filePath, lineNumber, iterationsResp });
    filePath = anchor.path;
    side = anchor.side;
    anchor.warnings.forEach((w) => console.error(`  note: ${w}`));
  }

  // A second thread on a line that already has one is nearly always a repeat of a
  // finding, not a new one, and nothing else in the flow surfaces it — on a PR with
  // dozens of threads the alternative is grepping `pr comments` by hand.
  if (filePath && !flags['allow-duplicate']) {
    const existing = await findThreadsAt({ config, p, filePath, lineNumber });
    if (existing.length) {
      const where = `${filePath}:${lineNumber ?? '(file-level)'}`;
      die(`${existing.length} thread(s) already anchored at ${where}:\n`
        + existing.map((t) => `  thread ${t.id}  ${t.status || 'active'}  ${t.firstLine}`).join('\n')
        + '\nNothing was posted. If this really is a separate finding, re-run with --allow-duplicate.');
    }
  }

  if (flags['dry-run']) {
    console.log('DRY RUN — nothing posted.');
    console.log(filePath ? `Would anchor at: ${filePath}:${lineNumber ?? '(file-level)'} [${side} side]` : 'Would post a PR-level comment.');
    console.log(`Body (${content.length} chars):\n${content}`);
    return;
  }

  const result = await pr.addComment({ config, ...p, content, filePath, lineNumber, side });
  console.log(`Comment posted. Thread ID: ${result.id}`);
  if (result.threadContext?.filePath) {
    const loc = result.threadContext.rightFileStart?.line || result.threadContext.leftFileStart?.line;
    console.log(`Location: ${result.threadContext.filePath}:${loc ?? ''} [${side} side]`);
  }
}

// `pr link` / `wi link` — emit the canonical reference line instead of retyping it.
// The project comes from the PR's own repository object / the work item's Area path
// root and is never assumed: an org can hold repos spread across several projects
// and work items split across more than one board, so a hand-built link is one
// wrong segment away from pointing nowhere.
async function cmdPrLink(rawUrl, flags, config) {
  const p = needPrUrlOrId(rawUrl, config, flags);
  const data = await pr.getPullRequest({ config, ...p });
  const project = data.repository?.project?.name || p.project;
  const repo = data.repository?.name || p.repo;
  let wiId = (flags.wi && flags.wi !== true) ? flags.wi : null;
  if (!wiId && !flags['no-wi']) {
    try {
      const wis = await pr.getPullRequestWorkItems({ config, ...p });
      wiId = (wis && wis[0] && wis[0].id) || null;
    } catch { /* a PR with no work item is a finding, not an error — leave the tag off */ }
  }
  const line = links.prLinkLine({ org: p.org || config.org, project, repo, prId: p.prId, title: data.title, wiId });
  console.log(line);
  if (!wiId) console.error('  note: no linked work item — the [PBI ...] tag was omitted.');
}

async function cmdWiLink(rawUrl, flags, config) {
  const p = needWorkItemUrlOrId(rawUrl, config, flags);
  const data = await wi.getWorkItem({ config, ...p });
  const f = data.fields || {};
  const project = links.projectFromAreaPath(f['System.AreaPath']) || p.project;
  if (!project) die('Could not resolve the project: the work item has no System.AreaPath. Pass --project.');
  const line = links.wiLinkLine({
    org: p.org || config.org,
    project,
    wiId: p.id,
    title: f['System.Title'],
    type: flags['no-type'] ? null : f['System.WorkItemType'],
  });
  console.log(line);
  if (p.project && project !== p.project) {
    console.error(`  note: project resolved from the Area path as "${project}" (you passed "${p.project}").`);
  }
}

async function cmdPrSetDesc(rawUrl, text, flags, config) {
  const p = needPrUrlOrId(rawUrl, config, flags);
  let description = (text && text !== true) ? unescapeDescription(text) : null;
  if (flags['body-file']) {
    try { description = require('fs').readFileSync(flags['body-file'], 'utf8'); }
    catch (e) { die(`Could not read --body-file "${flags['body-file']}": ${e.message}`); }
  }
  const newTitle = (flags.title && flags.title !== true) ? flags.title : null;
  if (description == null && newTitle == null) {
    die('Nothing to update. Provide new description text inline, via --body-file <path>, and/or --title "<text>".');
  }

  // Azure DevOps limits the PR description to 4000 characters (API returns HTTP 400 otherwise).
  const MAX_PR_DESCRIPTION = 4000;
  if (description != null && description.length > MAX_PR_DESCRIPTION) {
    die(`PR description has ${description.length} characters; Azure DevOps allows at most ${MAX_PR_DESCRIPTION}. `
      + `Trim it (e.g. keep the summary in the description and move extra detail into a PR comment).`);
  }

  await pr.updatePullRequest({ config, ...p, title: newTitle, description });
  console.log(`PR #${p.prId} updated${newTitle ? ' (title)' : ''}${description != null ? ' (description)' : ''}.`);
}

async function cmdPrDeleteThread(rawUrl, threadIdStr, flags, config) {
  if (!threadIdStr) die('Missing threadId argument.');
  const threadId = parseInt(threadIdStr, 10);
  if (isNaN(threadId)) die(`Invalid threadId: ${threadIdStr}`);
  const p = needPrUrlOrId(rawUrl, config, flags);
  const commentId = flags.comment ? parseInt(flags.comment, 10) : 1;
  try {
    await pr.deleteComment({ config, ...p, threadId, commentId });
    console.log(`Comment ${commentId} deleted from thread ${threadId}.`);
  } catch (e) {
    console.warn(`Could not delete comment ${commentId} from thread ${threadId}: ${e.message}`);
  }
  await pr.updateThread({ config, ...p, threadId, status: 'closed' });
  console.log(`Thread ${threadId} closed.`);
}

async function cmdPrReply(rawUrl, threadIdStr, text, flags, config) {
  if (!threadIdStr) die('Missing threadId argument. Get it via `pr comments`.');
  const threadId = parseInt(threadIdStr, 10);
  if (isNaN(threadId)) die(`Invalid threadId: ${threadIdStr}`);
  if (text && text !== true) {
    die('Inline text is not supported for PR replies. Write the body to a Markdown file and use --body-file <path>.');
  }
  if (!flags['body-file']) {
    die('Missing --body-file <path>. PR replies must be provided from a Markdown file.');
  }
  let content;
  try {
    content = fs.readFileSync(flags['body-file'], 'utf8');
  } catch (e) {
    die(`Could not read --body-file "${flags['body-file']}": ${e.message}`);
  }
  if (!content.trim()) die('Reply body file is empty.');
  const p = needPrUrlOrId(rawUrl, config, flags);
  const parentCommentId = flags.comment ? parseInt(flags.comment, 10) : 1;
  const result = await pr.replyToThread({ config, ...p, threadId, content, parentCommentId });
  console.log(`Reply posted in thread ${threadId} (comment id ${result.id}).`);
}

async function cmdPrEditComment(rawUrl, threadIdStr, text, flags, config) {
  if (!threadIdStr) die('Missing threadId argument.');
  const threadId = parseInt(threadIdStr, 10);
  if (isNaN(threadId)) die(`Invalid threadId: ${threadIdStr}`);
  if (text && text !== true) {
    die('Inline text is not supported for PR comment edits. Write the body to a Markdown file and use --body-file <path>.');
  }
  if (!flags['body-file']) {
    die('Missing --body-file <path>. PR comment edits must be provided from a Markdown file.');
  }
  let content;
  try {
    content = fs.readFileSync(flags['body-file'], 'utf8');
  } catch (e) {
    die(`Could not read --body-file "${flags['body-file']}": ${e.message}`);
  }
  if (!content.trim()) die('Comment body file is empty.');
  const p = needPrUrlOrId(rawUrl, config, flags);
  const commentId = flags.comment ? parseInt(flags.comment, 10) : 1;
  await pr.editComment({ config, ...p, threadId, commentId, content });
  console.log(`Comment ${commentId} in thread ${threadId} updated.`);
}

async function cmdPrCloseThread(rawUrl, threadIdStr, config, flags = {}) {
  if (!threadIdStr) die('Missing threadId argument.');
  const threadId = parseInt(threadIdStr, 10);
  if (isNaN(threadId)) die(`Invalid threadId: ${threadIdStr}`);
  const p = needPrUrlOrId(rawUrl, config, flags);
  await pr.updateThread({ config, ...p, threadId, status: 'closed' });
  console.log(`Thread ${threadId} closed.`);
}

async function cmdPrCreate(rawUrl, flags, config) {
  if (!rawUrl) die('Missing repo or pull-request-create URL.');
  const parsed = parseUrl(rawUrl);
  if (!parsed || !parsed.repo) die(`Expected a repo or PR-create URL, got: ${rawUrl}`);
  const { org, project, repo } = parsed;
  const source = (flags.source && flags.source !== true) ? flags.source : parsed.sourceRef;
  const target = (flags.target && flags.target !== true) ? flags.target : parsed.targetRef;
  if (!source) die('Missing source branch. Pass --source <branch> (or use a pullrequestcreate URL).');
  if (!target) die('Missing target branch. Pass --target <branch> (or use a pullrequestcreate URL).');
  if (!flags.title || flags.title === true) die('Missing --title "<text>".');

  let description = (flags.desc && flags.desc !== true) ? unescapeDescription(flags.desc) : '';
  // Accept --desc-file (documented) or --body-file (an alias, so the flag matches every
  // other command) rather than silently ignoring a description passed in a file.
  const descFile = flags['desc-file'] || flags['body-file'];
  if (descFile) {
    try { description = require('fs').readFileSync(descFile, 'utf8'); }
    catch (e) { die(`Could not read description file "${descFile}": ${e.message}`); }
  }

  // Azure DevOps caps a PR description at 4000 characters (the API answers HTTP 400
  // "A description for a pull request must not be longer than 4000 characters").
  // Validate before the call so the failure is a clear message, not an opaque 400.
  const MAX_PR_DESCRIPTION = 4000;
  if (description.length > MAX_PR_DESCRIPTION) {
    die(`PR description has ${description.length} characters; Azure DevOps allows at most ${MAX_PR_DESCRIPTION}. `
      + `Trim it (e.g. keep the summary in the description and move extra detail into a PR comment after creation).`);
  }

  const isDraft = !!flags.draft;

  const created = await pr.createPullRequest({ config, org, project, repo, sourceRef: source, targetRef: target, title: flags.title, description, isDraft });
  const prId = created.pullRequestId;
  const webUrl = `${config.baseUrl}/${org}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}/pullrequest/${prId}`;
  console.log(`PR created: #${prId}${isDraft ? ' (draft)' : ''}`);
  console.log(`URL: ${webUrl}`);

  if (flags['work-items'] && flags['work-items'] !== true) {
    const ids = String(flags['work-items']).split(',').map((s) => s.trim()).filter(Boolean);
    const projectId = created.repository?.project?.id;
    const repoId = created.repository?.id;
    for (const wid of ids) {
      try {
        await wi.linkPullRequest({ config, org, id: parseInt(wid, 10), projectId, repoId, prId });
        console.log(`Linked work item #${wid}.`);
      } catch (e) {
        console.warn(`Could not link work item #${wid}: ${e.message}`);
      }
    }
  }
}

// ── Work item commands ─────────────────────────────────────────────────────

async function cmdWiGet(raw, config, flags) {
  const p = needWorkItemUrlOrId(raw, config, flags);
  const data = await wi.getWorkItem({ config, ...p });
  if (flags && flags.json) { console.log(JSON.stringify(data, null, 2)); return; }
  fmt.printWorkItem(data);
}

// Escape a single quote for WIQL (WIQL doubles the quote: O'Brien -> O''Brien).
function wiqlEscape(s) {
  return String(s).replace(/'/g, "''");
}

// `wi search [<term>] --project <p>` — the positional is the title search term,
// the project comes from --project / AZURE_PROJECT / the configured default.
async function cmdWiSearch(term, flags, config) {
  const usage = 'Usage: wi search [<title-term>] --project <p> [--type <t>] [--state <s>] [--wiql "<query>"] [--fields a,b,c] [--json]';

  const project = (flags.project && flags.project !== true)
    ? flags.project
    : (config.project || null);
  if (!project) die(
    `${usage}\n\nNo project. Pass --project "<project>", set AZURE_PROJECT, ` +
    'or run: azure-connector config --project "<project>"'
  );

  // --title-contains stays as an explicit alias for the positional term.
  const titleFlag = (flags['title-contains'] && flags['title-contains'] !== true)
    ? flags['title-contains'] : null;
  const positional = (term && term !== true) ? String(term) : null;
  if (positional && titleFlag && positional !== titleFlag) {
    die(`${usage}\n\nGot both a positional term ("${positional}") and --title-contains ("${titleFlag}"). Pass one.`);
  }
  const title = positional || titleFlag;

  let wiql = (flags.wiql && flags.wiql !== true) ? flags.wiql : null;
  if (!wiql) {
    const conds = [`[System.TeamProject] = '${wiqlEscape(project)}'`];
    if (flags.type && flags.type !== true) conds.push(`[System.WorkItemType] = '${wiqlEscape(flags.type)}'`);
    if (flags.state && flags.state !== true) conds.push(`[System.State] = '${wiqlEscape(flags.state)}'`);
    if (title) conds.push(`[System.Title] CONTAINS '${wiqlEscape(title)}'`);
    wiql = `SELECT [System.Id] FROM WorkItems WHERE ${conds.join(' AND ')} ORDER BY [System.Title] ASC`;
  }

  const fields = (flags.fields && flags.fields !== true)
    ? flags.fields.split(',').map((s) => s.trim()).filter(Boolean)
    : null;

  const items = await wi.searchWorkItems({ config, org: config.org, project, wiql, fields });

  if (flags.json) {
    console.log(JSON.stringify(items.map((w) => ({ id: w.id, ...w.fields })), null, 2));
    return;
  }
  console.log(`${items.length} work item(s) in "${project}":`);
  for (const w of items) {
    const f = w.fields || {};
    console.log(`  ${w.id}  [${f['System.State'] || ''}]  ${f['System.Title'] || ''}`);
  }
}

async function cmdWiFields(rawUrl, flags, config) {
  const p = needWorkItemUrlOrId(rawUrl, config, flags);
  const data = await wi.getWorkItem({ config, ...p });
  const f = data.fields || {};
  const filter = (flags.filter && flags.filter !== true) ? String(flags.filter).toLowerCase() : null;
  const keys = Object.keys(f).sort();
  for (const k of keys) {
    if (filter && !k.toLowerCase().includes(filter)) continue;
    let v = f[k];
    if (v && typeof v === 'object') v = v.displayName || JSON.stringify(v);
    v = String(v).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!flags.all && v.length > 120) v = v.slice(0, 120) + '…';
    console.log(`${k}  =  ${v}`);
  }
  if (filter) return;
  console.log(`\n(${keys.length} fields. Empty fields are NOT returned by the API — use \`wi layout\` to discover all custom field names.)`);
}

async function cmdWiField(rawUrl, field, config, flags) {
  if (!field) die('Missing field reference name. e.g. "Custom.RootCause", "Microsoft.VSTS.TCM.ReproSteps". Run `wi layout <wi-url|id>` to list them.');
  const p = needWorkItemUrlOrId(rawUrl, config, flags);
  const data = await wi.getWorkItem({ config, ...p });
  const v = (data.fields || {})[field];
  if (v === undefined) { console.error(`(field "${field}" is empty or does not exist on this work item)`); return; }
  console.log(typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v));
}

async function cmdWiSetField(rawUrl, field, value, flags, config) {
  if (!field) die('Missing field reference name. Usage: wi set-field <wi-url|id> <fieldRef> ["<value>"] [--body-file <path>]');
  let content = (value && value !== true) ? value : '';
  if (flags['body-file']) {
    try { content = require('fs').readFileSync(flags['body-file'], 'utf8'); }
    catch (e) { die(`Could not read --body-file "${flags['body-file']}": ${e.message}`); }
  }
  if (content === '' && !flags['allow-empty']) die('Missing value. Provide it inline or via --body-file <path> (use --allow-empty to clear a field).');
  // Author in Markdown, store HTML. The form renders HTML only; markdown written into
  // it is kept literally, with asterisks and pipe rows visible on the board. The
  // 'field' profile drops inline styles and turns tables into lists, which is what
  // survives the form's sanitizer.
  if (flags['from-markdown']) content = wi.markdownToFieldHtml(content);
  const p = needWorkItemUrlOrId(rawUrl, config, flags);

  // --verify: refuse a rewrite that silently drops a fact, or that carries markup
  // the work-item form will not render. Compared against the live value by default,
  // or an offline baseline with --against (for a report or wiki page).
  if (flags.verify || flags.against) {
    let baseline = '';
    if (flags.against && flags.against !== true) {
      try { baseline = fs.readFileSync(flags.against, 'utf8'); }
      catch (e) { die(`Could not read --against "${flags.against}": ${e.message}`); }
    } else {
      const live = await wi.getWorkItem({ config, ...p });
      baseline = (live.fields || {})[field] || '';
    }
    const verdict = verify.verifyFieldWrite({ before: baseline, after: content });
    reportVerifyVerdict(verdict, field, flags);
    if (!verdict.ok && !flags.force) {
      die('Nothing was written. Fix the draft, or re-run with --force if you have decided the change is right.');
    }
  }

  // Run the render guard before the dry-run print too, so a preview that says "would
  // set" is a preview of a write that would actually succeed.
  wi.assertRenderableFieldValue(field, content, { force: flags.force });

  if (flags['dry-run']) {
    console.log(`DRY RUN — nothing written to #${p.id}.`);
    console.log(`Would set "${field}" to ${content.length} char(s).`);
    return;
  }
  const res = await wi.setField({ config, ...p, field, value: content, force: flags.force });
  console.log(`Work item ${p.id} field "${field}" updated (rev ${res.rev}).`);
}

function reportVerifyVerdict(verdict, field, flags) {
  const { lost, forbidden, truncatedBaseline, counts } = verdict;
  console.error(`verify "${field}": ${counts.beforeChars} -> ${counts.afterChars} chars`);
  if (truncatedBaseline) {
    console.error(`  ⚠  The CURRENT value is exactly ${verify.TRUNCATION_BYTES} bytes — Azure's truncation length.`);
    console.error('     It is almost certainly cut, so a comparison against it would invent losses.');
    console.error('     Fact-loss checking was SKIPPED. Read the field in the browser before overwriting it.');
  }
  for (const [kind, items] of Object.entries(lost)) {
    console.error(`  ✗ ${kind} present now and missing from the draft: ${items.join(', ')}`);
  }
  for (const f of forbidden) {
    console.error(`  ✗ ${f.name} — ${f.fix}`);
  }
  if (verdict.ok) console.error('  ✓ no facts lost, no forbidden markup.');
}

async function cmdWiLayout(rawUrl, flags, config) {
  const p = needWorkItemUrlOrId(rawUrl, config, flags);
  const type = (flags.type && flags.type !== true) ? flags.type
    : (await wi.getWorkItem({ config, ...p })).fields?.['System.WorkItemType'] || 'Bug';
  const { witRefName, controls } = await wi.getFormLayout({ config, org: p.org, project: p.project, type });
  console.log(`Form layout for "${type}" (${witRefName}) — label -> field reference name:\n`);
  for (const c of controls) {
    console.log(`  "${c.label}"  ->  ${c.referenceName}`);
  }
}

async function cmdWiComments(rawUrl, flags, config) {
  const p = needWorkItemUrlOrId(rawUrl, config, flags);
  const data = await wi.getComments({ config, ...p });
  if (flags && (flags.ids || flags.raw)) {
    const comments = (data.comments || []).slice().sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));
    for (const c of comments) {
      const who = c.createdBy?.displayName || 'unknown';
      const when = c.createdDate ? new Date(c.createdDate).toLocaleString() : '';
      if (flags.raw) {
        console.log(`\n===== id=${c.id}  ${who}  ${when} =====`);
        console.log(c.text);
      } else {
        console.log(`id=${c.id}  ${who}  ${when}`);
      }
    }
    return;
  }
  fmt.printWorkItemComments(data);
}

async function cmdWiComment(rawUrl, text, flags, config) {
  if (text && text !== true) {
    die('Inline text is not supported for work item comments. Write the body to an HTML file and use --body-file <path>.');
  }
  if (!flags['body-file']) {
    die('Missing --body-file <path>. Work item comments must be provided from an HTML file.');
  }
  let content;
  try {
    content = fs.readFileSync(flags['body-file'], 'utf8');
  } catch (e) {
    die(`Could not read --body-file "${flags['body-file']}": ${e.message}`);
  }
  if (!content.trim()) die('Comment body file is empty.');
  const p = needWorkItemUrlOrId(rawUrl, config, flags);

  // One-shot routing: --field <ref> puts the body into a form field instead of
  // posting a comment (same effect as `wi set-field`, no separate call).
  if (flags.field && flags.field !== true) {
    // A comment body is authored in Markdown; a field renders HTML. Routing one into
    // the other without converting is exactly how raw markdown ends up on the board.
    const value = wi.markdownToFieldHtml(content);
    const res = await wi.setField({ config, ...p, field: flags.field, value, force: flags.force });
    console.log(`Work item ${p.id} field "${flags.field}" updated (rev ${res.rev}) — routed from --body-file, converted to field HTML.`);
    return;
  }

  // Field-routing gate: if the work item has long-form custom fields (a "Root
  // Cause" / "Implemented Solution" control, say), don't silently post a comment —
  // surface them and force an explicit choice. Agent-agnostic: the decision fires
  // for every caller, not just those who happen to know the field layout.
  const asComment = flags['as-comment'] || flags.force;
  if (!asComment) {
    const type = (await wi.getWorkItem({ config, ...p })).fields?.['System.WorkItemType'];
    const fields = await wi.getContentFields({ config, org: p.org, project: p.project, id: p.id, type });
    if (fields.length) {
      const pad = Math.max(...fields.map((f) => (`"${f.label}"`).length));
      console.error(`Work item #${p.id}${type ? ` (${type})` : ''} has content fields that may be the right home for this text:\n`);
      for (const f of fields) {
        console.error(`  ${(`"${f.label}"`).padEnd(pad)}  ->  ${f.referenceName}  [${f.empty ? 'empty' : 'filled'}]`);
      }
      console.error(`\nRoot-cause / solution / analysis usually belongs in a field, not a comment. Choose one:`);
      console.error(`  --field <ref>    put this body into that field (e.g. --field ${fields[0].referenceName})`);
      console.error(`  --as-comment     post it as a plain comment anyway`);
      process.exit(2);
    }
  }

  const result = await wi.addComment({ config, ...p, text: content });
  console.log(`Comment added. ID: ${result.id}, created: ${result.createdDate}`);
}

async function cmdWiEditComment(rawUrl, commentIdStr, text, flags, config) {
  if (!commentIdStr) die('Missing commentId argument. Run `wi comments --ids <wi-url|id>` to list comment IDs.');
  const commentId = parseInt(commentIdStr, 10);
  if (isNaN(commentId)) die(`Invalid commentId: ${commentIdStr}`);
  if (text && text !== true) {
    die('Inline text is not supported for work item comment edits. Write the body to an HTML file and use --body-file <path>.');
  }
  if (!flags['body-file']) {
    die('Missing --body-file <path>. Work item comment edits must be provided from an HTML file.');
  }
  let content;
  try {
    content = fs.readFileSync(flags['body-file'], 'utf8');
  } catch (e) {
    die(`Could not read --body-file "${flags['body-file']}": ${e.message}`);
  }
  if (!content.trim()) die('Comment body file is empty.');
  const p = needWorkItemUrlOrId(rawUrl, config, flags);
  await wi.editComment({ config, ...p, commentId, text: content });
  console.log(`Work item ${p.id} comment ${commentId} updated.`);
}

async function cmdWiDeleteComment(rawUrl, commentIdStr, config, flags) {
  if (!commentIdStr) die('Missing commentId argument. Run `wi comments --ids <wi-url|id>` to list comment IDs.');
  const commentId = parseInt(commentIdStr, 10);
  if (isNaN(commentId)) die(`Invalid commentId: ${commentIdStr}`);
  const p = needWorkItemUrlOrId(rawUrl, config, flags);
  await wi.deleteComment({ config, ...p, commentId });
  console.log(`Work item ${p.id} comment ${commentId} deleted.`);
}

// A transition can be blocked by a field the item never had to fill before. A bare
// PATCH surfaces that as a raw TF401320 with no hint of which field or which values,
// which makes the fix guesswork. Preflight with validateOnly=true (runs the real rule
// engine, writes nothing), then name the field and print its allowed values.
async function cmdWiSetState(rawUrl, state, config, flags) {
  if (!state) die('Missing state argument. e.g. "To Do", "In Progress", "Done".');
  const p = needWorkItemUrlOrId(rawUrl, config, flags);
  const ops = [{ op: 'add', path: '/fields/System.State', value: state }];

  if (!flags['no-preflight']) {
    try {
      await wi.validateUpdate({ config, ...p, ops });
    } catch (e) {
      await explainStateRejection({ config, p, state, error: e, flags });
      return;
    }
    if (flags['dry-run']) {
      console.log(`DRY RUN — validated only. #${p.id} would move to "${state}".`);
      return;
    }
  } else if (flags['dry-run']) {
    console.log(`DRY RUN — nothing written (preflight skipped by --no-preflight).`);
    return;
  }

  await wi.setState({ config, ...p, state });
  console.log(`Work item ${p.id} set to "${state}".`);
}

// Turn a rule-validation rejection into something actionable: which field, and what
// it will accept. Falls back to the raw error whenever the scrape finds nothing —
// an unexplained error beats a confidently wrong explanation.
async function explainStateRejection({ config, p, state, error, flags }) {
  const msg = String(error && error.message ? error.message : error);
  console.error(`Cannot move #${p.id} to "${state}" — the board rejected it. Nothing was written.\n`);
  const { referenceNames, labels } = wi.parseRuleValidationErrors(msg);

  let type = (flags.type && flags.type !== true) ? flags.type : null;
  if (!type) {
    try { type = (await wi.getWorkItem({ config, ...p })).fields?.['System.WorkItemType']; } catch { /* keep going */ }
  }

  const explained = [];
  for (const ref of referenceNames) {
    if (!type || !p.project) break;
    try {
      const def = await wi.getFieldDefinition({ config, org: p.org, project: p.project, type, field: ref });
      const allowed = def.allowedValues || [];
      explained.push({ ref, name: def.name, required: def.alwaysRequired, allowed });
    } catch { /* not a field on this WIT, or no metadata — skip it */ }
  }

  if (explained.length) {
    for (const f of explained) {
      console.error(`  ${f.name || f.ref}  (${f.ref})`);
      if (f.allowed.length) {
        console.error('    accepts: ' + f.allowed.map((v) => `"${v}"`).join(', '));
        console.error(`    set it with: wi set-field ${p.id} ${f.ref} "<value>"`);
      } else {
        console.error('    free text — no picklist.');
      }
    }
    console.error('');
  } else if (labels.length) {
    console.error(`  Field(s) named in the rejection: ${labels.join(', ')}`);
    console.error(`  Find the reference name with: wi layout ${p.id}\n`);
  }

  console.error('Azure said:\n' + msg.split('\n').map((l) => '  ' + l).join('\n'));
  process.exitCode = 1;
}

async function cmdWiLinkPr(rawWiUrl, rawPrUrl, config, flags) {
  const w = needWorkItemUrlOrId(rawWiUrl, config, flags);
  const pp = needPrUrlOrId(rawPrUrl, config, flags);
  const prData = await pr.getPullRequest({ config, ...pp });
  const projectId = prData.repository?.project?.id;
  const repoId = prData.repository?.id;
  if (!projectId || !repoId) die('Could not resolve PR project/repo ids.');
  await wi.linkPullRequest({ config, org: w.org, project: w.project, id: w.id, projectId, repoId, prId: pp.prId });
  console.log(`Linked PR #${pp.prId} to work item ${w.id}.`);
}

async function cmdWiCreateTask(rawParentUrl, title, flags, config) {
  if (!title) die('Missing task title. Usage: wi create-task <parent-url|id> "<title>" [--estimate <hours>] [--desc "<text>"] [--assignee <email>]');
  const parent = needWorkItemUrlOrId(rawParentUrl, config, flags);

  // Inherit Area/Iteration (and assignee, unless overridden) from the parent work item.
  const parentWi = await wi.getWorkItem({ config, ...parent });
  const pf = parentWi.fields || {};

  const fields = { 'System.Title': title };
  if (pf['System.AreaPath']) fields['System.AreaPath'] = pf['System.AreaPath'];
  if (pf['System.IterationPath']) fields['System.IterationPath'] = pf['System.IterationPath'];

  if (flags.desc) fields['System.Description'] = flags.desc;

  // Activity is required on Tasks in some processes (picklist: Development/Design/Testing/...).
  fields['Microsoft.VSTS.Common.Activity'] =
    (flags.activity && flags.activity !== true) ? flags.activity : 'Development';

  if (flags.estimate != null && flags.estimate !== true) {
    const hours = parseFloat(flags.estimate);
    if (!isNaN(hours)) {
      fields['Microsoft.VSTS.Scheduling.OriginalEstimate'] = hours;
      fields['Microsoft.VSTS.Scheduling.RemainingWork'] = hours;
    }
  }

  const assignee = flags.assignee || pf['System.AssignedTo']?.uniqueName || pf['System.AssignedTo']?.displayName;
  if (assignee) fields['System.AssignedTo'] = assignee;

  const result = await wi.createWorkItem({
    config,
    org: parent.org,
    project: parent.project,
    type: 'Task',
    fields,
    parentId: parent.id,
  });
  const est = fields['Microsoft.VSTS.Scheduling.OriginalEstimate'];
  console.log(`Created Task #${result.id}: ${title}${est != null ? ` (${est}h)` : ''} — child of #${parent.id}`);
}

async function cmdWiSetEstimate(rawUrl, hoursStr, config, flags) {
  if (!hoursStr) die('Missing hours. Usage: wi set-estimate <wi-url|id> <hours>');
  const hours = parseFloat(hoursStr);
  if (isNaN(hours)) die(`Invalid hours: ${hoursStr}`);
  const p = needWorkItemUrlOrId(rawUrl, config, flags);
  const ops = [
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.OriginalEstimate', value: hours },
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.RemainingWork', value: hours },
  ];
  await wi.updateWorkItem({ config, ...p, ops });
  console.log(`Work item #${p.id} estimate set to ${hours}h.`);
}

// `wi complete` — the closing move that `set-estimate` is not. set-estimate opens a
// task (OriginalEstimate + RemainingWork); nothing closed it, so nine tasks were
// closed by hand. Boards that gate `Done` on CompletedWork (Task, Bug Task) reject
// the transition until this runs.
async function cmdWiComplete(rawUrl, flags, config) {
  const raw = (flags.hours != null && flags.hours !== true) ? flags.hours : null;
  if (raw == null) {
    die('Missing --hours. Usage: wi complete <wi-url|id> --hours <n>\n'
      + 'Use --hours 0 when the task was closed without delivery — the record should not claim work that did not happen.');
  }
  const hours = parseFloat(raw);
  if (isNaN(hours) || hours < 0) die(`Invalid --hours: ${raw}`);
  const p = needWorkItemUrlOrId(rawUrl, config, flags);
  const ops = [
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.CompletedWork', value: hours },
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.RemainingWork', value: 0 },
  ];
  if (flags['dry-run']) {
    console.log(`DRY RUN — nothing written to #${p.id}.`);
    console.log(`Would set CompletedWork = ${hours}, RemainingWork = 0.`);
    return;
  }
  await wi.updateWorkItem({ config, ...p, ops });
  console.log(`Work item #${p.id}: CompletedWork = ${hours}h, RemainingWork = 0.`);
}

// `wi missing` — which fields the form declares but the item does not answer.
// The API omits empty fields entirely, so `wi fields` alone cannot tell you; the
// cross-check used to be manual. Placeholders ('.', '-', 'n/a') are reported
// separately because they read as filled everywhere else.
async function cmdWiMissing(rawUrl, flags, config) {
  const p = needWorkItemUrlOrId(rawUrl, config, flags);
  const item = await wi.getWorkItem({ config, ...p });
  const type = (flags.type && flags.type !== true) ? flags.type : item.fields?.['System.WorkItemType'];
  const fields = await wi.getContentFields({
    config,
    ...p,
    type,
    onlyCustom: !flags.all,
    longFormOnly: !flags.all,
  });
  if (flags.json) { console.log(JSON.stringify(fields, null, 2)); return; }
  if (!fields.length) {
    console.log(`No ${flags.all ? '' : 'custom long-form '}fields on the "${type}" form (or the layout could not be read).`);
    return;
  }
  const missing = fields.filter((f) => f.state === 'empty');
  const placeholder = fields.filter((f) => f.state === 'placeholder');
  const filled = fields.filter((f) => f.state === 'filled');
  console.log(`#${p.id} (${type}) — ${filled.length} answered, ${missing.length} empty, ${placeholder.length} placeholder.\n`);
  if (missing.length) {
    console.log('EMPTY:');
    for (const f of missing) console.log(`  "${f.label}"  ->  ${f.referenceName}`);
  }
  if (placeholder.length) {
    console.log(`${missing.length ? '\n' : ''}PLACEHOLDER (counts as filled on the board, says nothing):`);
    for (const f of placeholder) console.log(`  "${f.label}"  ->  ${f.referenceName}`);
  }
  if (!missing.length && !placeholder.length) console.log('Nothing missing.');
  if (!flags.all) console.error('\n(Custom long-form fields only. Use --all for every control on the form.)');
}

async function cmdWiAttachments(rawUrl, config, flags) {
  const p = needWorkItemUrlOrId(rawUrl, config, flags);
  const attachments = await wi.listAttachments({ config, ...p });
  fmt.printAttachments(attachments);
}

async function cmdWiDownload(rawUrl, selector, flags, config) {
  const p = needWorkItemUrlOrId(rawUrl, config, flags);
  const attachments = await wi.listAttachments({ config, ...p });
  if (!attachments.length) die('No attachments on this work item.');

  let attachment;
  if (!selector) {
    if (attachments.length === 1) {
      attachment = attachments[0];
    } else {
      fmt.printAttachments(attachments);
      die('Multiple attachments — specify index (1-based) or name as 3rd argument.');
    }
  } else if (/^\d+$/.test(selector)) {
    const idx = parseInt(selector, 10) - 1;
    if (idx < 0 || idx >= attachments.length) die(`Index out of range. Valid: 1–${attachments.length}`);
    attachment = attachments[idx];
  } else {
    attachment = attachments.find((a) => a.name === selector);
    if (!attachment) die(`Attachment "${selector}" not found.`);
  }

  const outDir = flags.out || '.';
  const { buffer, fileName } = await wi.downloadAttachment({ config, url: attachment.url });
  const outPath = path.join(outDir, fileName !== 'attachment' ? fileName : attachment.name);
  fs.writeFileSync(outPath, buffer);
  console.log(`Downloaded: ${outPath} (${buffer.length} bytes)`);
}

// ── Wiki commands ──────────────────────────────────────────────────────────

async function cmdWikiList(flags, config) {
  const project = flags.project;
  if (!project) die('Missing --project <project> argument.');
  const org = flags.org || config.org;
  const data = await request(`${config.baseUrl}/${org}/${encodeURIComponent(project)}/_apis/wiki/wikis?api-version=7.1`, { pat: config.pat });
  const wikis = (data && data.value) || [];
  if (!wikis.length) {
    console.log(`No wikis found in project ${project}.`);
    return;
  }
  wikis.forEach((w) => {
    console.log(`${w.name} (id=${w.id}, type=${w.type})`);
    console.log(`  url: ${w.url}`);
    if (w.remoteUrl) console.log(`  remoteUrl: ${w.remoteUrl}`);
    if (w.versions && w.versions.length) console.log(`  versions: ${w.versions.map((v) => v.version).join(', ')}`);
  });
}

async function cmdWikiPages(flags, config) {
  const project = flags.project;
  const wiki = flags.wiki;
  if (!project) die('Missing --project <project> argument.');
  if (!wiki) die('Missing --wiki <wikiIdOrName> argument.');
  const org = flags.org || config.org;
  const data = await request(`${config.baseUrl}/${org}/${encodeURIComponent(project)}/_apis/wiki/wikis/${encodeURIComponent(wiki)}/pages?api-version=7.1&recursionLevel=full`, { pat: config.pat });
  const pages = (data && data.subPages) || [];
  if (!pages.length) {
    console.log(`No pages found in wiki ${wiki}.`);
    return;
  }
  function print(page, indent = '') {
    console.log(`${indent}- ${page.path} (id=${page.id}, order=${page.order || 0})`);
    (page.subPages || []).forEach((p) => print(p, indent + '  '));
  }
  pages.forEach((p) => print(p));
}

async function cmdWikiGet(flags, config) {
  const project = flags.project;
  const wiki = flags.wiki;
  const page = flags.page;
  if (!project) die('Missing --project <project> argument.');
  if (!wiki) die('Missing --wiki <wikiIdOrName> argument.');
  if (!page) die('Missing --page <pagePath> argument.');
  const org = flags.org || config.org;
  const data = await request(`${config.baseUrl}/${org}/${encodeURIComponent(project)}/_apis/wiki/wikis/${encodeURIComponent(wiki)}/pages?path=${encodeURIComponent(page)}&api-version=7.1&includeContent=true`, { pat: config.pat });
  console.log(`# ${data.path}`);
  console.log(`url: ${data.remoteUrl || data.url}`);
  console.log('---');
  console.log(data.content || '(no content)');
}

// ── build / pipeline commands ────────────────────────────────────────────────

// Resolve the project from --project, AZURE_PROJECT, or the configured default.
function needProject(flags, config) {
  const project = (flags.project && flags.project !== true)
    ? flags.project
    : (config.project || null);
  if (!project) die(
    'This command requires a project. Pass --project "<project>" (e.g. Platform), ' +
    'set AZURE_PROJECT, or run: azure-connector config --project "<project>"'
  );
  return project;
}

// Shared filter resolution for build list/last/rerun.
async function resolveBuildFilters(flags, config, project, org) {
  const definitionId = await build.resolveDefinitionId(config, project, flags.definition, org);
  const branch = flags.branch;
  const repo = (flags.repo && flags.repo !== true) ? flags.repo : null;
  const top = (flags.top && flags.top !== true) ? parseInt(flags.top, 10) : 10;
  let builds = await build.listBuilds(config, project, { branch, definitionId, top: repo ? Math.max(top, 50) : top, org });
  // The Build API has no repo filter, so narrow client-side by repository name.
  if (repo) builds = builds.filter((b) => b.repository && b.repository.name && b.repository.name.toLowerCase() === repo.toLowerCase());
  return builds.slice(0, top);
}

async function cmdBuildList(flags, config) {
  const org = flags.org || config.org;
  const project = needProject(flags, config);
  const webBase = `${config.baseUrl}/${org}/${encodeURIComponent(project)}`;
  const builds = await resolveBuildFilters(flags, config, project, org);
  if (!builds.length) { console.log('No builds found for the given filters.'); return; }
  if (flags.json) { console.log(JSON.stringify(builds.map((b) => build.summarizeBuild(b, webBase)), null, 2)); return; }
  builds.forEach((b) => {
    const s = build.summarizeBuild(b, webBase);
    console.log(`#${s.id}  ${s.buildNumber}  [${s.definition}]  ${s.status}/${s.result || '-'}  ${s.branch}  @${s.sourceVersion}  ${s.queueTime}`);
  });
}

async function cmdBuildLast(flags, config) {
  const org = flags.org || config.org;
  const project = needProject(flags, config);
  const webBase = `${config.baseUrl}/${org}/${encodeURIComponent(project)}`;
  const builds = await resolveBuildFilters(flags, config, project, org);
  if (!builds.length) { console.log('No builds found for the given filters.'); return; }
  console.log(JSON.stringify(build.summarizeBuild(builds[0], webBase), null, 2));
}

// Re-run a build with the SAME config/variables. Accepts an explicit <buildId>,
// or resolves the latest build matching --branch/--definition/--repo filters.
// Write op: previews by default; pass --yes to actually queue.
async function cmdBuildRerun(buildIdArg, flags, config) {
  const org = flags.org || config.org;
  const project = needProject(flags, config);
  const webBase = `${config.baseUrl}/${org}/${encodeURIComponent(project)}`;

  let source;
  if (buildIdArg && /^\d+$/.test(buildIdArg)) {
    source = await build.getBuild(config, project, parseInt(buildIdArg, 10), org);
  } else {
    const builds = await resolveBuildFilters(flags, config, project, org);
    if (!builds.length) die('No build found to re-run for the given filters. Pass a <buildId> or adjust --branch/--definition/--repo.');
    source = await build.getBuild(config, project, builds[0].id, org); // full object (parameters/templateParameters)
  }

  const payload = build.buildRerunPayload(source, { branch: flags.branch });
  const preview = {
    reRunningFrom: { id: source.id, buildNumber: source.buildNumber, definition: source.definition && source.definition.name },
    willQueue: payload,
  };

  if (!flags.yes) {
    console.log('DRY RUN — no build queued. Re-run with --yes to queue.\n');
    console.log(JSON.stringify(preview, null, 2));
    return;
  }

  const res = await build.queueBuild(config, project, payload, org);
  console.log('Build queued.\n');
  console.log(JSON.stringify(build.summarizeBuild(res, webBase), null, 2));
}

// ── misc / generic commands ──────────────────────────────────────────────────

// Verify auth and reachability: list the projects the PAT can see in the org.
async function cmdWhoami(config) {
  if (!config.org) die('No org configured. Pass --org, set AZURE_ORG, or configure a profile.');
  const data = await request(`${config.baseUrl}/${config.org}/_apis/projects?api-version=7.1`, { pat: config.pat });
  const names = ((data && data.value) || []).map((p) => p.name);
  console.log(`auth OK  org=${config.org}  profile=${config.profileName}  project=${config.project || '(none)'}`);
  console.log(`projects: ${names.join(', ') || '—'}`);
}

// Raw REST passthrough. A path (e.g. "/Platform/_apis/git/repositories") is appended
// to the org base; a full https:// URL is used as-is. api-version=7.1 is added
// unless the URL already carries one. Body: inline JSON or @file.
async function cmdRaw(method, apiPath, body, config) {
  if (!method || method === true) die('Usage: raw <METHOD> <path|url> [json|@file]');
  if (!apiPath || apiPath === true) die('Usage: raw <METHOD> <path|url> [json|@file]');
  const m = String(method).toUpperCase();
  let url = /^https?:\/\//i.test(apiPath)
    ? apiPath
    : `${config.baseUrl}/${config.org}${apiPath.startsWith('/') ? '' : '/'}${apiPath}`;
  if (!/[?&]api-version=/i.test(url)) url += (url.includes('?') ? '&' : '?') + 'api-version=7.1';

  let payload;
  if (body && body !== true) {
    let raw = String(body);
    if (raw.startsWith('@')) {
      try { raw = fs.readFileSync(raw.slice(1), 'utf8'); }
      catch (e) { die(`Could not read body file "${raw.slice(1)}": ${e.message}`); }
    }
    try { payload = JSON.parse(raw); }
    catch (e) { die(`Body is not valid JSON: ${e.message}`); }
  }

  const data = await request(url, { method: m, pat: config.pat, body: payload });
  console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

// Create a new empty git repository in the configured (or --project) project.
async function cmdCreateRepo(name, flags, config) {
  const repoName = (name && name !== true) ? name : ((flags.repo && flags.repo !== true) ? flags.repo : null);
  const project = (flags.project && flags.project !== true) ? flags.project : config.project;
  if (!repoName) die('Usage: create-repo <name> [--project <p>]');
  if (!project) die('create-repo needs a project. Pass --project "<p>" or configure a default project.');
  const created = await request(
    `${config.baseUrl}/${config.org}/${encodeURIComponent(project)}/_apis/git/repositories?api-version=7.1`,
    { method: 'POST', pat: config.pat, body: { name: repoName } }
  );
  console.log(`Created repo "${created.name}"  id=${created.id}`);
  console.log(`Remote: ${created.remoteUrl || created.webUrl || '—'}`);
  if (flags.json) console.log(JSON.stringify(created, null, 2));
}

// ── router ─────────────────────────────────────────────────────────────────

// ── measurement commands (read-only) ─────────────────────────────────────────

// Resolve --ids: a comma list, or @file containing ids separated by any whitespace
// or commas (so a WIQL dump, one id per line, can be piped straight in).
function readIdList(raw) {
  if (!raw || raw === true) return [];
  let text = String(raw);
  if (text.startsWith('@')) {
    const file = text.slice(1);
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (e) { die(`Could not read ids file "${file}": ${e.message}`); }
  }
  return text.split(/[\s,]+/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
}

async function cmdWiUpdates(rawUrl, flags, config) {
  const field = (flags.field && flags.field !== true) ? flags.field : 'System.State';
  const now = new Date();
  const bulkIds = readIdList(flags.ids);

  // Bulk mode: one row per transition across many items. This is the shape the
  // board-level questions need ("how many items entered state X, and when").
  if (bulkIds.length) {
    const project = (flags.project && flags.project !== true) ? flags.project : config.project;
    if (!project) die('--ids needs a project. Pass --project "<p>" or configure a default project.');

    const rows = [];
    for (const id of bulkIds) {
      let updates;
      try {
        updates = await wi.getWorkItemUpdates({ config, org: config.org, project, id });
      } catch (e) {
        process.stderr.write(`azure-connector: work item ${id} failed: ${e.message}\n`);
        continue;
      }
      for (const c of wi.extractFieldChanges(updates, field)) rows.push({ id: Number(id), ...c });
    }

    if (flags.json) { console.log(JSON.stringify(rows, null, 2)); return; }
    console.log(['id', 'at', 'from', 'to', 'by'].join('\t'));
    for (const r of rows) console.log([r.id, r.at || '', r.from, r.to, r.by].join('\t'));
    process.stderr.write(`\n${rows.length} transition(s) of ${field} across ${bulkIds.length} work item(s).\n`);
    return;
  }

  const p = needWorkItemUrlOrId(rawUrl, config, flags);
  const updates = await wi.getWorkItemUpdates({ config, ...p });

  if (flags['all-fields']) {
    // Every field every revision touched — the discovery mode, for finding which
    // field actually carries the signal before measuring it.
    const rows = [];
    for (const u of updates) {
      for (const [ref, ch] of Object.entries(u.fields || {})) {
        if (!ch || ch.oldValue === ch.newValue) continue;
        rows.push({ rev: u.rev, field: ref, from: ch.oldValue, to: ch.newValue, by: (u.revisedBy || {}).displayName || '' });
      }
    }
    if (flags.json) { console.log(JSON.stringify(rows, null, 2)); return; }
    for (const r of rows) console.log(`r${r.rev}\t${r.field}\t${String(r.from ?? '')} → ${String(r.to ?? '')}\t${r.by}`);
    return;
  }

  const changes = wi.extractFieldChanges(updates, field);

  if (flags.entered && flags.entered !== true) {
    const state = flags.entered;
    const out = { id: p.id, state, first: wi.firstEntry(changes, state), last: wi.lastEntry(changes, state) };
    if (flags.json) { console.log(JSON.stringify(out, null, 2)); return; }
    console.log(`#${out.id}  entered "${state}"  first=${out.first || '(never)'}  last=${out.last || '(never)'}`);
    return;
  }

  if (flags['time-in-state']) {
    const spans = wi.timeInState(changes, now);
    if (flags.json) { console.log(JSON.stringify(spans, null, 2)); return; }
    console.log(`Time in each ${field} value for #${p.id}:`);
    for (const s of spans) {
      console.log(`  ${String(s.state).padEnd(28)} ${String(s.days).padStart(8)} d  ${s.enteredAt.slice(0, 16)} → ${s.open ? '(still open)' : s.leftAt.slice(0, 16)}`);
    }
    return;
  }

  if (flags.json) { console.log(JSON.stringify(changes, null, 2)); return; }
  if (!changes.length) { console.log(`No ${field} transitions on #${p.id}.`); return; }
  console.log(`${changes.length} ${field} transition(s) on #${p.id}:`);
  for (const c of changes) {
    console.log(`  ${(c.at || '(undated)').slice(0, 16)}  ${String(c.from || '(new)').padEnd(24)} → ${String(c.to).padEnd(24)} ${c.by}`);
  }
}

async function cmdWiRelations(rawUrl, flags, config) {
  const wanted = (flags.type && flags.type !== true)
    ? String(flags.type).toLowerCase().split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  const keep = (rels) => (wanted ? rels.filter((r) => wanted.includes(r.kind)) : rels);

  const bulkIds = readIdList(flags.ids);

  // Bulk mode: one row per relation across many items — the first step of any
  // ticket→code measurement (work item → linked PRs → files).
  if (bulkIds.length) {
    const project = (flags.project && flags.project !== true) ? flags.project : config.project;
    if (!project) die('--ids needs a project. Pass --project "<p>" or configure a default project.');

    const items = await wi.getWorkItemsRelationsBatch({ config, org: config.org, project, ids: bulkIds });
    const returned = new Set(items.map((it) => it.id));
    for (const id of bulkIds) {
      if (!returned.has(Number(id))) {
        process.stderr.write(`azure-connector: work item ${id} not returned (deleted, or in another project).\n`);
      }
    }
    const rows = [];
    for (const it of items) {
      for (const r of keep(wi.normalizeRelations(it))) rows.push({ id: it.id, ...r });
    }

    if (flags.json) { console.log(JSON.stringify(rows, null, 2)); return; }
    console.log(['id', 'kind', 'target', 'repoId', 'name'].join('\t'));
    for (const r of rows) console.log([r.id, r.kind, r.target, r.repoId || '', r.name || ''].join('\t'));
    process.stderr.write(`\n${rows.length} relation(s) across ${items.length} work item(s).\n`);
    return;
  }

  const p = needWorkItemUrlOrId(rawUrl, config, flags);
  const item = await wi.getWorkItem({ config, ...p });
  const rels = keep(wi.normalizeRelations(item));
  if (flags.json) { console.log(JSON.stringify(rels, null, 2)); return; }
  if (!rels.length) { console.log(`No ${wanted ? wanted.join(',') + ' ' : ''}relation(s) on #${p.id}.`); return; }
  console.log(`${rels.length} relation(s) on #${p.id}:`);
  const names = await resolveRepoNames(rels, config, p, flags);
  for (const r of rels) {
    const repo = r.repoId ? (names.get(r.repoId) || r.repoId) : null;
    const extra = (repo ? `  repo=${repo}` : '') + (r.name ? `  (${r.name})` : '');
    console.log(`  ${String(r.kind).padEnd(12)} ${r.target}${extra}`);
  }
}

// An artifact link carries the repository GUID, not its name — so a PR family used
// to be unpicked by hand against repos-map, and a guessed --project turned into a
// misleading TF401019 ("does not exist") on the next call. getRepo() takes a name
// OR an id, so one lookup per distinct GUID settles it; results are cached on disk
// because these mappings never change.
async function resolveRepoNames(rels, config, p, flags = {}) {
  const out = new Map();
  const ids = [...new Set(rels.map((r) => r.repoId).filter((id) => id && /^[0-9a-f-]{36}$/i.test(id)))];
  if (!ids.length || flags['no-resolve']) return out;
  const cache = loadRepoCache();
  let dirty = false;
  for (const id of ids) {
    if (cache[id]) { out.set(id, cache[id]); continue; }
    try {
      const repo = await repoLib.getRepo({ config, org: p.org, project: p.project, repo: id });
      const label = repo.project?.name ? `${repo.project.name}/${repo.name}` : repo.name;
      if (label) { out.set(id, label); cache[id] = label; dirty = true; }
    } catch { /* foreign org, deleted repo, or no permission — show the GUID */ }
  }
  if (dirty) saveRepoCache(cache);
  return out;
}

function repoCachePath() {
  const home = process.env.USERPROFILE || process.env.HOME || '.';
  return path.join(home, '.azure-connector-repos.json');
}

function loadRepoCache() {
  try { return JSON.parse(fs.readFileSync(repoCachePath(), 'utf8')); } catch { return {}; }
}

function saveRepoCache(cache) {
  try { fs.writeFileSync(repoCachePath(), JSON.stringify(cache, null, 2)); } catch { /* cache is an optimisation */ }
}

async function cmdSprints(project, flags, config) {
  const proj = (project && project !== true) ? project
    : ((flags.project && flags.project !== true) ? flags.project : config.project);
  if (!proj) die('Usage: sprints <project> [--team <t>] [--filter <pattern>] [--depth <n>] [--current] [--json]');

  const team = (flags.team && flags.team !== true) ? flags.team : null;
  let rows;
  if (team) {
    rows = iterationLib.flattenTeamIterations(
      await iterationLib.getTeamIterations({ config, org: config.org, project: proj, team })
    );
  } else {
    const depth = (flags.depth && flags.depth !== true) ? parseInt(flags.depth, 10) : 4;
    rows = iterationLib.flattenIterationTree(
      await iterationLib.getIterationTree({ config, org: config.org, project: proj, depth })
    );
  }

  if (flags.filter) rows = iterationLib.filterIterations(rows, flags.filter);
  if (flags.current) rows = iterationLib.currentIteration(rows, new Date());

  if (flags.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  console.log(`${rows.length} iteration(s) in "${proj}"${team ? ` for team "${team}"` : ''}:`);
  for (const r of rows) {
    console.log(`  ${r.path.padEnd(48)} ${(r.start || '(undated)').padEnd(12)} ${r.finish || ''}`);
  }
}

async function cmdPrTimeline(rawUrl, flags, config) {
  const now = new Date();
  const repoFlag = (flags.repo && flags.repo !== true) ? flags.repo : null;

  // Repo mode: review health across many PRs. The per-PR view cannot show that a
  // PR was completed with nobody voting on it — only the population can.
  if (repoFlag) {
    const org = (flags.org && flags.org !== true) ? flags.org : config.org;
    const project = (flags.project && flags.project !== true) ? flags.project : config.project;
    if (!org || !project) die('pr timeline --repo needs --project "<p>" (or a configured default project).');

    const status = (flags.status && flags.status !== true) ? flags.status : 'all';
    const top = (flags.top && flags.top !== true) ? parseInt(flags.top, 10) : 50;
    const listed = await pr.listPullRequests({ config, org, project, repo: repoFlag, status, top });
    const prs = (listed && listed.value) || [];

    const summaries = [];
    for (const p of prs) {
      const threads = await pr.getComments({ config, org, project, repo: repoFlag, prId: p.pullRequestId });
      summaries.push(pr.summarizePrTimeline(p, threads, now));
    }
    const health = pr.reviewHealth(summaries);

    if (flags.json) { console.log(JSON.stringify({ health, prs: summaries }, null, 2)); return; }

    console.log(`${summaries.length} PR(s) [${status}] in ${project}/${repoFlag}\n`);
    console.log(['PR', 'AUTHOR', 'CREATED', 'AGE d', '1st VOTE d', 'STATUS', 'VOTES'].join('\t'));
    for (const s of summaries.sort((a, b) => (a.created < b.created ? 1 : -1))) {
      const votes = s.votes.length ? s.votes.map((v) => `${v.who.split(' ')[0]}:${v.vote}`).join(' ') : '— none —';
      console.log([
        `#${s.id}`, s.author.slice(0, 18), String(s.created).slice(0, 10),
        s.ageDays, s.daysToFirstVote === null ? '—' : s.daysToFirstVote,
        s.open ? 'active' : s.status, votes,
      ].join('\t'));
    }
    console.log(`\nmedian age ${health.medianAgeDays} d   max ${health.maxAgeDays} d   median days-to-first-vote ${health.medianDaysToFirstVote === null ? '—' : health.medianDaysToFirstVote}`);
    console.log(`merged/closed with NO vote: ${health.noVote.length} of ${health.total} (${Math.round(health.noVoteRatio * 100)}%)  ${health.noVote.map((id) => '#' + id).join(' ')}`);
    console.log('\nby author:');
    for (const [who, a] of Object.entries(health.byAuthor)) {
      console.log(`  ${who.padEnd(24)} n=${String(a.n).padStart(3)}  median ${String(a.medianAgeDays).padStart(6)} d  max ${String(a.maxAgeDays).padStart(6)} d  no-vote ${a.noVote}`);
    }
    return;
  }

  const p = needPrUrlOrId(rawUrl, config, flags);
  const data = await pr.getPullRequest({ config, ...p });
  const threads = await pr.getComments({ config, ...p });
  const s = pr.summarizePrTimeline(data, threads, now);

  if (flags.json) { console.log(JSON.stringify(s, null, 2)); return; }
  console.log(`PR #${s.id} — ${s.title}`);
  console.log(`author ${s.author}   status ${s.status}${s.isDraft ? ' (draft)' : ''}   age ${s.ageDays} d\n`);
  console.log(`  ${String(s.created).slice(0, 16)}  created`);
  if (s.publishedAt) console.log(`  ${String(s.publishedAt).slice(0, 16)}  published (left draft)`);
  for (const v of s.votes) {
    console.log(`  ${String(v.at).slice(0, 16)}  ${v.who} → ${v.vote} (${pr.voteLabel(v.vote)})`);
  }
  if (s.closed) console.log(`  ${String(s.closed).slice(0, 16)}  ${s.status}`);
  console.log('');
  if (s.noVote) console.log('  ⚠ no reviewer ever voted on this PR.');
  else console.log(`  first vote after ${s.daysToFirstVote} d (${s.firstVote.who})`);
}

async function cmdRepoList(flags, config) {
  const project = (flags.project && flags.project !== true) ? flags.project : config.project;
  const data = await repoLib.listRepos({ config, org: config.org, project });
  const rows = ((data && data.value) || []).map(repoLib.summarizeRepo);
  if (flags.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  console.log(`${rows.length} repo(s)${project ? ` in "${project}"` : ` in org "${config.org}"`}:`);
  for (const r of rows.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    console.log(`  ${r.name.padEnd(34)} ${String(r.defaultBranch || '—').padEnd(20)} ${r.isDisabled ? '(disabled) ' : ''}${r.id}`);
  }
}

async function cmdRepoGet(rawRepo, flags, config) {
  const parsed = rawRepo && rawRepo !== true ? parseUrl(rawRepo) : null;
  const org = parsed ? parsed.org : config.org;
  const project = parsed ? parsed.project
    : ((flags.project && flags.project !== true) ? flags.project : config.project);
  const name = parsed ? parsed.repo
    : ((rawRepo && rawRepo !== true) ? rawRepo : (flags.repo && flags.repo !== true ? flags.repo : null));
  if (!project || !name) die('Usage: repo get <name|repo-url> [--project <p>]');

  const r = repoLib.summarizeRepo(await repoLib.getRepo({ config, org, project, repo: name }));
  if (flags.json) { console.log(JSON.stringify(r, null, 2)); return; }
  console.log(`${r.name}  (${r.project})`);
  console.log(`  id             ${r.id}`);
  console.log(`  defaultBranch  ${r.defaultBranch || '—'}`);
  console.log(`  size           ${r.size === null ? '—' : r.size} bytes`);
  console.log(`  disabled       ${r.isDisabled}`);
  console.log(`  remoteUrl      ${r.remoteUrl || '—'}`);
  console.log(`  webUrl         ${r.webUrl || '—'}`);
}

async function cmdRepoRefs(rawRepo, flags, config) {
  const parsed = rawRepo && rawRepo !== true ? parseUrl(rawRepo) : null;
  const org = parsed ? parsed.org : config.org;
  const project = parsed ? parsed.project
    : ((flags.project && flags.project !== true) ? flags.project : config.project);
  const name = parsed ? parsed.repo
    : ((rawRepo && rawRepo !== true) ? rawRepo : (flags.repo && flags.repo !== true ? flags.repo : null));
  if (!project || !name) die('Usage: repo refs <name|repo-url> [--filter heads/<branch>] [--project <p>]');

  const filter = (flags.filter && flags.filter !== true) ? flags.filter : undefined;
  const data = await repoLib.listRefs({ config, org, project, repo: name, filter });
  const refs = (data && data.value) || [];
  if (flags.json) { console.log(JSON.stringify(refs, null, 2)); return; }
  console.log(`${refs.length} ref(s) in ${project}/${name}${filter ? ` matching "${filter}"` : ''}:`);
  for (const r of refs) {
    console.log(`  ${repoLib.shortBranch(r.name).padEnd(48)} ${String(r.objectId || '').slice(0, 8)}  ${(r.creator || {}).displayName || ''}`);
  }
}

function printHelp() {
  console.log(`
azure-connector — Azure DevOps CLI

Usage:
  azure-connector config [--pat <token>] [--org <org>] [--project <p>] [--repo <r>] [--base-url <url>] [--pat-valid-to <YYYY-MM-DD>] [--pat-name "<name>"] [--pat-warn-days <n>]
  azure-connector pat check        # validate the PAT (connectionData) + show name/expiry/days-left
  azure-connector whoami [--profile <name>]                       # verify auth; print the org + visible projects
  azure-connector raw <METHOD> <path|url> [<json>|@<file>]        # raw REST call (path appended to the org base; api-version added)
  azure-connector create-repo <name> [--project <p>]              # create an empty git repository
  azure-connector sprints <project> [--team <t>] [--filter <pattern>] [--depth <n>] [--current] [--json]   # iterations + their start/finish dates (alias: iterations)

  azure-connector repo list [--project <p>] [--json]                          # every repo, with id + default branch
  azure-connector repo get  <name|repo-url> [--project <p>] [--json]          # id, defaultBranch, size, clone urls
  azure-connector repo refs <name|repo-url> [--filter heads/<b>] [--json]     # list refs; empty result = branch does not exist

  azure-connector pr get           <pr-url|pr-id> [--project <p>] [--repo <r>] [--full] [--json]   # always lists linked work items; --full adds votes + thread counts
  azure-connector pr list          <repo-url> | --project <p> --repo <r> [--status active|completed|abandoned|all] [--target <branch>] [--top <n>] [--since <YYYY-MM-DD>] [--json]
  azure-connector pr create        <repo-url|pr-create-url> --title "<t>" [--source <branch>] [--target <branch>] [--desc "<text>"|--desc-file <path>|--body-file <path>] [--work-items 65019,123] [--draft]
                                   (note: Azure DevOps limits the PR description to 4000 chars)
  azure-connector pr diff          <pr-url|pr-id> [--full]               Unified diff of every changed file; --full dumps whole file contents instead
  azure-connector pr comments      <pr-url>
  azure-connector pr comment       <pr-url> --body-file <path> [--file <path> --line <n>] [--dry-run] [--no-validate]   # Markdown file; inline text is not supported
                                   # inline anchor is validated against the PR's latest iteration (path casing auto-corrected, phantom lines rejected); --dry-run previews without posting
  azure-connector pr reply         <pr-url> <threadId> --body-file <path> [--comment <n>]  # Markdown file; inline text is not supported
  azure-connector pr edit-comment  <pr-url> <threadId> --body-file <path> [--comment <n>]  # Markdown file; inline text is not supported
  azure-connector pr set-desc      <pr-url> [--body-file <path>] [--title "<text>"]   # update PR description/title in place
  azure-connector pr abandon       <pr-url>                                          # set PR status to abandoned (branches remain)
  azure-connector pr delete-thread <pr-url> <threadId> [--comment <n>]
  azure-connector pr close-thread  <pr-url> <threadId>
  azure-connector pr timeline      <pr-url> [--json]                                    # created → published → each vote → completed, with day deltas
  azure-connector pr timeline      --repo <r> [--project <p>] [--status all|active|completed] [--top <n>] [--json]
                                   # review health for a whole repo: age, days-to-first-vote, and PRs merged with NO vote

  azure-connector wi get         <wi-url>
  azure-connector wi search      [<title-term>] --project <p> [--type <t>] [--state <s>] [--wiql "<q>"] [--fields a,b] [--json]   # WIQL search; auto-paginates batch fetch
  azure-connector wi layout      <wi-url> [--type <wit>]                   # map form labels -> field reference names (discover custom fields, incl. empty ones)
  azure-connector wi fields      <wi-url> [--all] [--filter <substr>]      # list field reference names + values (empty fields are omitted by the API)
  azure-connector wi field       <wi-url> <fieldRef>                       # print one field's raw value (e.g. for an edit round-trip)
  azure-connector wi set-field   <wi-url> <fieldRef> [--body-file <path>] [--allow-empty]   # set ANY field from a file (HTML/markdown/plain)
  azure-connector wi comments    <wi-url> [--ids] [--raw]                  # --ids lists comment IDs (newest first); --raw dumps raw HTML
  azure-connector wi comment     <wi-url> --body-file <path> [--field <ref>] [--as-comment]   # if the WI has long-form custom fields (a "Root Cause" control, etc.) it lists them and stops; --field <ref> routes the body into that field, --as-comment posts anyway
  azure-connector wi edit-comment <wi-url> <commentId> --body-file <path> # Markdown file (converted to HTML); inline text is not supported
  azure-connector wi delete-comment <wi-url> <commentId>    # delete a comment (get id via wi comments --ids)
  azure-connector wi set-state   <wi-url> "<state>"          # e.g. "In Progress", "Done"
  azure-connector wi link-pr     <wi-url> <pr-url>           # link an existing PR to the work item
  azure-connector wi create-task <parent-url> "<title>" [--estimate <hours>] [--desc "<text>"] [--assignee <email>]
   azure-connector wi attachments <wi-url>
   azure-connector wi download    <wi-url> [<index|name>] [--out <dir>]
  azure-connector wi updates     <wi-url> [--field <ref>] [--all-fields] [--time-in-state] [--entered "<State>"] [--json]
                                   # how the item MOVED (default field: System.State). The work item itself only carries its current state.
  azure-connector wi updates     --ids <a,b,c|@file> --project <p> [--field <ref>] [--json]   # bulk: one TSV row per transition, across many items
  azure-connector wi relations   <wi-url|id> [--type pr,commit,parent,child,related,attachment,hyperlink,branch,build] [--json]   # typed links, vstfs URLs decoded (pr/commit ids usable directly)
  azure-connector wi relations   --ids <a,b,c|@file> --project <p> [--type pr] [--json]   # bulk: one TSV row per relation (200 ids per API call) — step 1 of ticket→code

   azure-connector wiki list --project <project> [--org <org>]          # list wikis in a project
   azure-connector wiki pages --project <project> --wiki <wikiIdOrName> [--org <org>]  # list wiki pages
   azure-connector wiki get --project <project> --wiki <wikiIdOrName> --page <path> [--org <org>]  # get page content (markdown)

  azure-connector build list  --project <p> [--branch <b>] [--definition <id|name>] [--repo <r>] [--top <n>] [--json]  # recent builds, newest first
  azure-connector build last  --project <p> [--branch <b>] [--definition <id|name>] [--repo <r>]                       # most-recent build (full detail + variables)
  azure-connector build rerun [<buildId>] --project <p> [--branch <b>] [--definition <id|name>] [--repo <r>] [--yes]   # re-queue a build with the SAME config/variables
                                   # generic across pipelines: replays the build's parameters + templateParameters (empty for pipelines without variables)
                                   # without <buildId>, re-runs the latest build matching the filters; previews by default, --yes to queue; --branch re-runs the same config on another ref


Configuration (in priority order):
  1. Env vars: AZURE_PAT, AZURE_ORG, AZURE_PROJECT, AZURE_BASE_URL, AZURE_PROFILE, AZURE_PAT_VALID_TO, AZURE_PAT_NAME, AZURE_PAT_WARN_DAYS, AZURE_PREFLIGHT
  2. Config file: ~/.azure-connector.json  (override path with AZURE_CONFIG_FILE)
  3. Default baseUrl=https://dev.azure.com

Profiles (multi-org — a PAT is scoped to one Azure DevOps org):
  Add a "profiles" map + optional "defaultProfile" to ~/.azure-connector.json:
    { "defaultProfile": "contoso",
      "profiles": {
        "contoso":  { "org": "contoso", "project": "Platform", "pat": "..." },
        "other":    { "org": "other-org", "patEnv": "AZURE_PAT_OTHER" } } }
  A single top-level { pat, org, ... } (no "profiles") behaves exactly as one profile.
  Selection: --profile <name>  >  a URL's org  >  AZURE_PROFILE  >  defaultProfile  >  the top-level config.
  "patEnv" names an env var to read the PAT from at runtime, so no secret sits on disk.

PAT expiry:
  A warning is printed (stderr) on every run within --pat-warn-days (default 30) of expiry.
  A PAT without token-management scope can't read its own expiry via the API, so the date is
  tracked locally; when you rotate the PAT, update it:
    azure-connector config --pat <new> --pat-valid-to <YYYY-MM-DD>
  Set AZURE_PREFLIGHT=1 to network-validate the PAT before each command.

Examples:
  azure-connector config --pat <token> --org <org> --pat-valid-to <YYYY-MM-DD>
  azure-connector whoami
  azure-connector pr get https://dev.azure.com/contoso/Platform/_git/Platform/pullrequest/123
  azure-connector pr comment https://dev.azure.com/.../pullrequest/123 --body-file ./review.md
  azure-connector pr reply https://dev.azure.com/.../pullrequest/123 42 --body-file ./reply.md
  azure-connector pr edit-comment https://dev.azure.com/.../pullrequest/123 42 --body-file ./review.md
  azure-connector wi get https://dev.azure.com/contoso/Platform/_workitems/edit/62576
  azure-connector wi comment https://dev.azure.com/.../edit/62576 --body-file ./comment.html
  azure-connector wi attachments https://dev.azure.com/.../edit/62576
  azure-connector wi download https://dev.azure.com/.../edit/62576 1 --out /tmp
  azure-connector build last  --project Platform --branch features/1234-new-widget --definition web-ui
  azure-connector build rerun --project Platform --branch features/1234-new-widget --definition web-ui          # preview
  azure-connector build rerun --project Platform --branch features/1234-new-widget --definition web-ui --yes    # queue it
  azure-connector build rerun 40587 --project Platform --yes                                                          # re-run a specific build id

Comment file formats:
  PR comments  — Markdown file (headers, lists, bold, code blocks work).
  WI comments  — HTML file (<br>, <b>, <ul><li>, <pre> work; Markdown is not rendered).
`);
}

async function main() {
  const { args, flags } = parseArgs(process.argv.slice(2));

  if (!args.length || flags.help || flags.h) {
    printHelp();
    process.exit(0);
  }

  checkUnknownFlags(flags);

  const [group, sub, arg1, arg2, arg3] = args;

  if (group === 'config') {
    await cmdConfig(args.slice(1), flags);
    return;
  }

  // Resolve the active profile: an explicit --profile wins, else the org parsed
  // from the command's URL argument (so any org's URL auto-selects its PAT), else
  // AZURE_PROFILE / defaultProfile / the top-level config. A single-PAT setup has
  // no `profiles` block and falls through to the top-level config.
  const urlOrg = (() => {
    for (const a of [arg1, arg2]) {
      if (a && a !== true) {
        const u = parseUrl(a);
        if (u && u.org) return u.org;
      }
    }
    return undefined;
  })();
  const flagProfile = (flags.profile && flags.profile !== true) ? flags.profile : undefined;
  const config = loadConfig({ urlOrg, flagProfile });
  requirePat(config);

  // Zero-network, always-on heads-up when the PAT is near (or past) its expiry.
  // Goes to stderr so it never pollutes JSON/stdout consumed by other tools.
  warnIfExpiring(config);

  if (group === 'pat') {
    if (sub === 'check' || !sub) return cmdPatCheck(config);
    die(`Unknown pat subcommand: ${sub}. Try: pat check`);
  }

  if (group === 'whoami') return cmdWhoami(config);
  if (group === 'raw') return cmdRaw(sub, arg1, arg2, config);
  if (group === 'create-repo') return cmdCreateRepo(sub, flags, config);
  if (group === 'sprints' || group === 'iterations') return cmdSprints(sub, flags, config);

  if (group === 'repo') {
    if (!sub) { printHelp(); die('Missing repo subcommand.'); }
    if (sub === 'list') return cmdRepoList(flags, config);
    if (sub === 'get')  return cmdRepoGet(arg1, flags, config);
    if (sub === 'refs') return cmdRepoRefs(arg1, flags, config);
    printHelp();
    die(`Unknown repo subcommand: ${sub}`);
  }

  // Opt-in network pre-flight: validate the PAT before running the real command.
  // Off by default (adds a round-trip); a failed real call already reports auth
  // errors clearly. Enable with AZURE_PREFLIGHT=1.
  if (process.env.AZURE_PREFLIGHT && !['config'].includes(group)) {
    try {
      await validatePat(config);
    } catch (err) {
      die(err.message);
    }
  }

  if (group === 'pr') {
    if (!sub) { printHelp(); die('Missing pr subcommand.'); }
    if (sub === 'get')           return cmdPrGet(arg1, config, flags);
    if (sub === 'list')          return cmdPrList(arg1, flags, config);
    if (sub === 'create')        return cmdPrCreate(arg1, flags, config);
    if (sub === 'diff')          return cmdPrDiff(arg1, config, flags);
    if (sub === 'comments')      return cmdPrComments(arg1, config, flags);
    if (sub === 'link')          return cmdPrLink(arg1, flags, config);
    if (sub === 'comment')       return cmdPrComment(arg1, arg2, flags, config);
    if (sub === 'reply')         return cmdPrReply(arg1, arg2, arg3, flags, config);
    if (sub === 'edit-comment')  return cmdPrEditComment(arg1, arg2, arg3, flags, config);
    if (sub === 'set-desc')      return cmdPrSetDesc(arg1, arg2, flags, config);
    if (sub === 'abandon')       return cmdPrAbandon(arg1, config, flags);
    if (sub === 'delete-thread') return cmdPrDeleteThread(arg1, arg2, flags, config);
    if (sub === 'close-thread')  return cmdPrCloseThread(arg1, arg2, config, flags);
    if (sub === 'timeline')      return cmdPrTimeline(arg1, flags, config);
    die(`Unknown pr subcommand: ${sub}`);
  }

  if (group === 'wi') {
    if (!sub) { printHelp(); die('Missing wi subcommand.'); }
    if (sub === 'get')         return cmdWiGet(arg1, config, flags);
    if (sub === 'search')      return cmdWiSearch(arg1, flags, config);
    if (sub === 'fields')      return cmdWiFields(arg1, flags, config);
    if (sub === 'field')       return cmdWiField(arg1, arg2, config, flags);
    if (sub === 'set-field')   return cmdWiSetField(arg1, arg2, arg3, flags, config);
    if (sub === 'layout')      return cmdWiLayout(arg1, flags, config);
    if (sub === 'comments')    return cmdWiComments(arg1, flags, config);
    if (sub === 'comment')     return cmdWiComment(arg1, arg2, flags, config);
    if (sub === 'edit-comment') return cmdWiEditComment(arg1, arg2, arg3, flags, config);
    if (sub === 'delete-comment') return cmdWiDeleteComment(arg1, arg2, config, flags);
    if (sub === 'set-state')   return cmdWiSetState(arg1, arg2, config, flags);
    if (sub === 'link-pr')     return cmdWiLinkPr(arg1, arg2, config, flags);
    if (sub === 'create-task') return cmdWiCreateTask(arg1, arg2, flags, config);
    if (sub === 'set-estimate') return cmdWiSetEstimate(arg1, arg2, config, flags);
    if (sub === 'attachments') return cmdWiAttachments(arg1, config, flags);
    if (sub === 'download')    return cmdWiDownload(arg1, arg2, flags, config);
    if (sub === 'updates' || sub === 'history') return cmdWiUpdates(arg1, flags, config);
    if (sub === 'relations') return cmdWiRelations(arg1, flags, config);
    if (sub === 'link')        return cmdWiLink(arg1, flags, config);
    if (sub === 'missing')     return cmdWiMissing(arg1, flags, config);
    if (sub === 'complete')    return cmdWiComplete(arg1, flags, config);
    die(`Unknown wi subcommand: ${sub}`);
  }

  if (group === 'wiki') {
    if (!sub) { printHelp(); die('Missing wiki subcommand.'); }
    if (sub === 'list') return cmdWikiList(flags, config);
    if (sub === 'pages') return cmdWikiPages(flags, config);
    if (sub === 'get') return cmdWikiGet(flags, config);
    die(`Unknown wiki subcommand: ${sub}`);
  }

  if (group === 'build') {
    if (!sub) { printHelp(); die('Missing build subcommand.'); }
    if (sub === 'list')  return cmdBuildList(flags, config);
    if (sub === 'last')  return cmdBuildLast(flags, config);
    if (sub === 'rerun') return cmdBuildRerun(arg1, flags, config);
    die(`Unknown build subcommand: ${sub}. Try: build list | build last | build rerun`);
  }

  die(`Unknown command: ${group}. Run azure-connector --help for usage.`);
}

// Run the CLI only when invoked directly; when required by tests, just expose the
// pure helpers below.
if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { parseArgs, normalizeAzureRepoPath, unescapeDescription, needPrUrlOrId, needWorkItemUrlOrId };
