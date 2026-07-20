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

function needUrl(raw, expectedType) {
  if (!raw) die(`Missing URL argument. Expected an Azure DevOps ${expectedType} URL.`);
  const parsed = parseUrl(raw);
  if (!parsed) die(`Cannot parse URL: ${raw}`);
  if (parsed.type !== expectedType) die(`Expected a ${expectedType} URL but got type '${parsed.type}'.`);
  return parsed;
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

// ── command handlers ───────────────────────────────────────────────────────

async function cmdConfig(args, flags) {
  const config = loadConfig();
  const has = (k) => flags[k] && flags[k] !== true;
  if (flags.pat || flags.org || flags.project || flags['base-url'] || has('pat-valid-to') || has('pat-name') || has('pat-warn-days')) {
    const patch = {};
    if (flags.pat) patch.pat = flags.pat;
    if (flags.org) patch.org = flags.org;
    if (flags.project) patch.project = flags.project;
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
  console.log('Env vars:    AZURE_PAT, AZURE_ORG, AZURE_PROJECT, AZURE_BASE_URL, AZURE_PROFILE, AZURE_PAT_VALID_TO, AZURE_PAT_NAME, AZURE_PAT_WARN_DAYS, AZURE_PREFLIGHT');
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

async function cmdPrGet(rawUrl, config) {
  const parsed = parseUrl(rawUrl);
  if (!parsed) die(`Cannot parse URL: ${rawUrl}`);

  if (parsed.type === 'pr-compare') {
    const { org, project, repo, sourceRef, targetRef } = parsed;
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

  if (parsed.type !== 'pr') die(`Expected a pr URL but got type '${parsed.type}'.`);
  const data = await pr.getPullRequest({ config, ...parsed });
  fmt.printPullRequest(data);
}

async function cmdPrDiff(rawUrl, config, flags = {}) {
  const parsed = parseUrl(rawUrl);
  if (!parsed) die(`Cannot parse URL: ${rawUrl}`);

  let org, project, repo, sourceRef, targetRef;

  if (parsed.type === 'pr-compare') {
    ({ org, project, repo, sourceRef, targetRef } = parsed);
    // Strip refs/heads/ prefix if present
    sourceRef = sourceRef.replace(/^refs\/heads\//, '');
    targetRef = targetRef.replace(/^refs\/heads\//, '');
  } else if (parsed.type === 'pr') {
    const prData = await pr.getPullRequest({ config, ...parsed });
    ({ org, project, repo } = parsed);
    sourceRef = prData.sourceRefName.replace(/^refs\/heads\//, '');
    targetRef = prData.targetRefName.replace(/^refs\/heads\//, '');
  } else {
    die(`Expected a pr or pr-compare URL but got type '${parsed.type}'.`);
  }

  const diff = await pr.getBranchDiff({ config, org, project, repo, sourceRef, targetRef });
  const changes = (diff.changes || []).filter((c) => !c.item?.isFolder);

  fmt.printBranchDiff(diff, sourceRef, targetRef);

  if (!changes.length) return;

  const patchMode = flags.patch === true;

  if (patchMode) {
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

async function cmdPrComments(rawUrl, config) {
  const p = needUrl(rawUrl, 'pr');
  const data = await pr.getComments({ config, ...p });
  fmt.printCommentThreads(data);
}

async function cmdPrAbandon(rawUrl, config) {
  const p = needUrl(rawUrl, 'pr');
  await pr.abandonPullRequest({ config, ...p });
  console.log(`PR #${p.prId} abandoned. (Branches remain — delete them separately if needed.)`);
}

// Resolve an inline-comment anchor against the PR's LATEST iteration so a comment
// never lands on a phantom line. Auto-corrects file-path casing/leading-slash,
// picks the correct side (right for add/edit, left for delete), and verifies the
// line exists on that side. Throws a clear, actionable error when it can't.
async function resolveInlineAnchor({ config, p, filePath, lineNumber }) {
  const warnings = [];
  const its = await pr.getIterations({ config, ...p });
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
            + `The diff used to pick this line is stale — re-run git-diff-analysis with --force and use --output lines.`
          );
        }
      }
    }
  }

  return { path: canonicalPath, line: lineNumber, side, warnings };
}

async function cmdPrComment(rawUrl, text, flags, config) {
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
  const p = needUrl(rawUrl, 'pr');
  let filePath = normalizeAzureRepoPath(flags.file);
  const lineNumber = flags.line ? parseInt(flags.line, 10) : null;
  let side = 'right';

  // Self-correcting anchor: validate/repair the file+line against the PR's latest
  // iteration before posting (skip with --no-validate for the old blind behavior).
  if (filePath && !flags['no-validate']) {
    const anchor = await resolveInlineAnchor({ config, p, filePath, lineNumber });
    filePath = anchor.path;
    side = anchor.side;
    anchor.warnings.forEach((w) => console.error(`  note: ${w}`));
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

async function cmdPrSetDesc(rawUrl, text, flags, config) {
  const p = needUrl(rawUrl, 'pr');
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
  const p = needUrl(rawUrl, 'pr');
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
  const p = needUrl(rawUrl, 'pr');
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
  const p = needUrl(rawUrl, 'pr');
  const commentId = flags.comment ? parseInt(flags.comment, 10) : 1;
  await pr.editComment({ config, ...p, threadId, commentId, content });
  console.log(`Comment ${commentId} in thread ${threadId} updated.`);
}

async function cmdPrCloseThread(rawUrl, threadIdStr, config) {
  if (!threadIdStr) die('Missing threadId argument.');
  const threadId = parseInt(threadIdStr, 10);
  if (isNaN(threadId)) die(`Invalid threadId: ${threadIdStr}`);
  const p = needUrl(rawUrl, 'pr');
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
  // Aceita --desc-file (documentado) ou --body-file (alias, igual aos demais comandos)
  // para não ignorar silenciosamente a descrição passada por arquivo.
  const descFile = flags['desc-file'] || flags['body-file'];
  if (descFile) {
    try { description = require('fs').readFileSync(descFile, 'utf8'); }
    catch (e) { die(`Could not read description file "${descFile}": ${e.message}`); }
  }

  // Azure DevOps limita a descrição da PR a 4000 caracteres (a API devolve HTTP 400
  // "A description for a pull request must not be longer than 4000 characters").
  // Validamos antes da chamada para falhar com mensagem clara em vez do 400 cru.
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
  fmt.printWorkItem(data);
}

// Escape a single quote for WIQL (WIQL doubles the quote: O'Brien -> O''Brien).
function wiqlEscape(s) {
  return String(s).replace(/'/g, "''");
}

async function cmdWiSearch(project, flags, config) {
  if (!project) die('Usage: wi search <project> [--title-contains <t>] [--type <t>] [--state <s>] [--wiql "<query>"] [--fields a,b,c] [--json]');

  let wiql = (flags.wiql && flags.wiql !== true) ? flags.wiql : null;
  if (!wiql) {
    const conds = [`[System.TeamProject] = '${wiqlEscape(project)}'`];
    if (flags.type && flags.type !== true) conds.push(`[System.WorkItemType] = '${wiqlEscape(flags.type)}'`);
    if (flags.state && flags.state !== true) conds.push(`[System.State] = '${wiqlEscape(flags.state)}'`);
    if (flags['title-contains'] && flags['title-contains'] !== true) {
      conds.push(`[System.Title] CONTAINS '${wiqlEscape(flags['title-contains'])}'`);
    }
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
  if (!field) die('Missing field reference name. e.g. "Custom.CausaRaiz", "Microsoft.VSTS.TCM.ReproSteps". Run `wi layout <wi-url|id>` to list them.');
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
  const p = needWorkItemUrlOrId(rawUrl, config, flags);
  const res = await wi.setField({ config, ...p, field, value: content });
  console.log(`Work item ${p.id} field "${field}" updated (rev ${res.rev}).`);
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
    const res = await wi.setField({ config, ...p, field: flags.field, value: content });
    console.log(`Work item ${p.id} field "${flags.field}" updated (rev ${res.rev}) — routed from --body-file instead of a comment.`);
    return;
  }

  // Field-routing gate: if the work item has long-form custom fields (Causa
  // Raiz, Solução Implementada, ...), don't silently post a comment — surface
  // them and force an explicit choice. Agent-agnostic: the decision fires for
  // every caller, not just those who happen to know the field layout.
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

async function cmdWiSetState(rawUrl, state, config, flags) {
  if (!state) die('Missing state argument. e.g. "In Progress", "Aguardando CodeReview", "Done".');
  const p = needWorkItemUrlOrId(rawUrl, config, flags);
  await wi.setState({ config, ...p, state });
  console.log(`Work item ${p.id} set to "${state}".`);
}

async function cmdWiLinkPr(rawWiUrl, rawPrUrl, config, flags) {
  const w = needWorkItemUrlOrId(rawWiUrl, config, flags);
  const pp = needUrl(rawPrUrl, 'pr');
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
    'This command requires a project. Pass --project "<project>" (e.g. ELOS), ' +
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

// Raw REST passthrough. A path (e.g. "/EVUP/_apis/git/repositories") is appended
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

function printHelp() {
  console.log(`
azure-connector — Azure DevOps CLI

Usage:
  azure-connector config [--pat <token>] [--org <org>] [--base-url <url>] [--pat-valid-to <YYYY-MM-DD>] [--pat-name "<name>"] [--pat-warn-days <n>]
  azure-connector pat check        # validate the PAT (connectionData) + show name/expiry/days-left
  azure-connector whoami [--profile <name>]                       # verify auth; print the org + visible projects
  azure-connector raw <METHOD> <path|url> [<json>|@<file>]        # raw REST call (path appended to the org base; api-version added)
  azure-connector create-repo <name> [--project <p>]              # create an empty git repository

  azure-connector pr get           <pr-url|pr-create-url>
  azure-connector pr list          <repo-url> | --project <p> --repo <r> [--status active|completed|abandoned|all] [--target <branch>] [--top <n>] [--since <YYYY-MM-DD>] [--json]
  azure-connector pr create        <repo-url|pr-create-url> --title "<t>" [--source <branch>] [--target <branch>] [--desc "<text>"|--desc-file <path>|--body-file <path>] [--work-items 65019,123] [--draft]
                                   (note: Azure DevOps limits the PR description to 4000 chars)
  azure-connector pr diff          <pr-url|pr-create-url> [--patch]      Show changed files; --patch emits unified diffs
  azure-connector pr comments      <pr-url>
  azure-connector pr comment       <pr-url> --body-file <path> [--file <path> --line <n>] [--dry-run] [--no-validate]   # Markdown file; inline text is not supported
                                   # inline anchor is validated against the PR's latest iteration (path casing auto-corrected, phantom lines rejected); --dry-run previews without posting
  azure-connector pr reply         <pr-url> <threadId> --body-file <path> [--comment <n>]  # Markdown file; inline text is not supported
  azure-connector pr edit-comment  <pr-url> <threadId> --body-file <path> [--comment <n>]  # Markdown file; inline text is not supported
  azure-connector pr set-desc      <pr-url> [--body-file <path>] [--title "<text>"]   # update PR description/title in place
  azure-connector pr abandon       <pr-url>                                          # set PR status to abandoned (branches remain)
  azure-connector pr delete-thread <pr-url> <threadId> [--comment <n>]
  azure-connector pr close-thread  <pr-url> <threadId>

  azure-connector wi get         <wi-url>
  azure-connector wi search      <project> [--title-contains <t>] [--type <t>] [--state <s>] [--wiql "<q>"] [--fields a,b] [--json]   # WIQL search; auto-paginates batch fetch
  azure-connector wi layout      <wi-url> [--type <wit>]                   # map form labels -> field reference names (discover custom fields, incl. empty ones)
  azure-connector wi fields      <wi-url> [--all] [--filter <substr>]      # list field reference names + values (empty fields are omitted by the API)
  azure-connector wi field       <wi-url> <fieldRef>                       # print one field's raw value (e.g. for an edit round-trip)
  azure-connector wi set-field   <wi-url> <fieldRef> [--body-file <path>] [--allow-empty]   # set ANY field from a file (HTML/markdown/plain)
  azure-connector wi comments    <wi-url> [--ids] [--raw]                  # --ids lists comment IDs (newest first); --raw dumps raw HTML
  azure-connector wi comment     <wi-url> --body-file <path> [--field <ref>] [--as-comment]   # if the WI has long-form custom fields (Causa Raiz, etc.) it lists them and stops; --field <ref> routes the body into that field, --as-comment posts anyway
  azure-connector wi edit-comment <wi-url> <commentId> --body-file <path> # Markdown file (converted to HTML); inline text is not supported
  azure-connector wi delete-comment <wi-url> <commentId>    # delete a comment (get id via wi comments --ids)
  azure-connector wi set-state   <wi-url> "<state>"          # e.g. "Aguardando CodeReview", "Done"
  azure-connector wi link-pr     <wi-url> <pr-url>           # link an existing PR to the work item
  azure-connector wi create-task <parent-url> "<title>" [--estimate <hours>] [--desc "<text>"] [--assignee <email>]
   azure-connector wi attachments <wi-url>
   azure-connector wi download    <wi-url> [<index|name>] [--out <dir>]

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
    { "defaultProfile": "evuptec",
      "profiles": {
        "evuptec":  { "org": "evuptec", "project": "EVUP", "pat": "..." },
        "other":    { "org": "other-org", "patEnv": "AZURE_PAT_OTHER" } } }
  A single top-level { pat, org, ... } (no "profiles") behaves exactly as one profile.
  Selection: --profile <name>  >  a URL's org  >  AZURE_PROFILE  >  defaultProfile  >  the top-level config.
  "patEnv" names an env var to read the PAT from at runtime, so no secret sits on disk.

PAT expiry:
  A warning is printed (stderr) on every run within --pat-warn-days (default 30) of expiry.
  The built-in PAT can't read its own expiry via the API, so the date is tracked locally;
  when you rotate the PAT, update it: azure-connector config --pat <new> --pat-valid-to <YYYY-MM-DD>
  Set AZURE_PREFLIGHT=1 to network-validate the PAT before each command.

Examples:
  azure-connector config --pat <token> --org <org> --pat-valid-to 2027-04-16
  azure-connector whoami
  azure-connector pr get https://dev.azure.com/evuptec/EVUP/_git/ELOS/pullrequest/123
  azure-connector pr comment https://dev.azure.com/.../pullrequest/123 --body-file ./review.md
  azure-connector pr reply https://dev.azure.com/.../pullrequest/123 42 --body-file ./reply.md
  azure-connector pr edit-comment https://dev.azure.com/.../pullrequest/123 42 --body-file ./review.md
  azure-connector wi get https://dev.azure.com/evuptec/EVUP/_workitems/edit/62576
  azure-connector wi comment https://dev.azure.com/.../edit/62576 --body-file ./comment.html
  azure-connector wi attachments https://dev.azure.com/.../edit/62576
  azure-connector wi download https://dev.azure.com/.../edit/62576 1 --out /tmp
  azure-connector build last  --project ELOS --branch features/65373_midia --definition APP-UI-CUSTOMER
  azure-connector build rerun --project ELOS --branch features/65373_midia --definition APP-UI-CUSTOMER          # preview
  azure-connector build rerun --project ELOS --branch features/65373_midia --definition APP-UI-CUSTOMER --yes    # queue it
  azure-connector build rerun 40587 --project ELOS --yes                                                          # re-run a specific build id

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
    if (sub === 'get')           return cmdPrGet(arg1, config);
    if (sub === 'list')          return cmdPrList(arg1, flags, config);
    if (sub === 'create')        return cmdPrCreate(arg1, flags, config);
    if (sub === 'diff')          return cmdPrDiff(arg1, config, flags);
    if (sub === 'comments')      return cmdPrComments(arg1, config);
    if (sub === 'comment')       return cmdPrComment(arg1, arg2, flags, config);
    if (sub === 'reply')         return cmdPrReply(arg1, arg2, arg3, flags, config);
    if (sub === 'edit-comment')  return cmdPrEditComment(arg1, arg2, arg3, flags, config);
    if (sub === 'set-desc')      return cmdPrSetDesc(arg1, arg2, flags, config);
    if (sub === 'abandon')       return cmdPrAbandon(arg1, config);
    if (sub === 'delete-thread') return cmdPrDeleteThread(arg1, arg2, flags, config);
    if (sub === 'close-thread')  return cmdPrCloseThread(arg1, arg2, config);
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

module.exports = { parseArgs, normalizeAzureRepoPath, unescapeDescription };
