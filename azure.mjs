#!/usr/bin/env node
// Azure DevOps connector — read pull requests, list changes, post review comments.
//
// Auth: HTTP Basic = base64(":" + PAT). Azure DevOps ignores the username, so the
//       PAT goes in the password slot. The .env in this folder (AZDO_ORG,
//       AZDO_PROJECT, AZDO_PAT, AZDO_DEFAULT_REPO) is the default profile; extra
//       orgs — each with its own PAT — go in azdo-profiles.json. A PR URL
//       auto-selects the profile by org. Never commit .env / azdo-profiles.json.
//
// REST API 7.1. Zero dependencies — Node 18+ native fetch.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_VERSION = "7.1";

// --- minimal .env loader (no dep) ---
function loadEnv() {
  let txt;
  try {
    txt = readFileSync(join(HERE, ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
loadEnv();

// --- profiles: one per Azure DevOps org (a PAT is org-scoped) --------------
// The .env (AZDO_ORG/PROJECT/PAT/DEFAULT_REPO) is the default profile. Extra
// orgs live in a git-ignored azdo-profiles.json next to this file:
//   { "default": "name",
//     "profiles": {
//       "name": { "org": "...", "project": "...", "defaultRepo": "...",
//                 "pat": "..."  |  "patEnv": "ENV_VAR_HOLDING_THE_PAT" } } }
// Use "patEnv" to keep no secret on disk — inject the PAT from an env var at
// runtime (e.g. a secrets manager: `<vault> run pat=ENV -- node azure.mjs ...`).
// A PR URL carries its org, so URL commands auto-select the matching profile;
// non-URL commands (whoami, create-pr, create-repo, raw) use
// --profile / AZDO_PROFILE / the default.
function loadProfiles() {
  const profiles = {};
  let defaultName;
  const envOrg = (process.env.AZDO_ORG || "").trim();
  if (envOrg) {
    profiles[envOrg] = {
      name: envOrg,
      org: envOrg,
      project: (process.env.AZDO_PROJECT || "").trim(),
      defaultRepo: (process.env.AZDO_DEFAULT_REPO || "").trim(),
      pat: (process.env.AZDO_PAT || "").trim(),
      patEnv: "",
    };
    defaultName = envOrg;
  }
  try {
    const file = process.env.AZDO_PROFILES_FILE || join(HERE, "azdo-profiles.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    for (const [name, p] of Object.entries(raw.profiles || {})) {
      profiles[name] = {
        name,
        org: (p.org || "").trim(),
        project: (p.project || "").trim(),
        defaultRepo: (p.defaultRepo || "").trim(),
        pat: (p.pat || "").trim(),
        patEnv: (p.patEnv || "").trim(),
      };
    }
    if (raw.default) defaultName = String(raw.default);
  } catch {
    /* no azdo-profiles.json — .env profile only */
  }
  return { profiles, defaultName };
}

const { profiles: PROFILES, defaultName: DEFAULT_PROFILE } = loadProfiles();
const BY_ORG = {};
for (const p of Object.values(PROFILES)) if (p.org) BY_ORG[p.org.toLowerCase()] = p;

// Resolve a profile's PAT: literal `pat`, else the env var named by `patEnv`.
function profilePat(p) {
  if (p.pat) return p.pat;
  if (p.patEnv) return (process.env[p.patEnv] || "").trim();
  return "";
}

// Pick the profile to use. urlOrg (parsed from a PR URL) wins — it dictates
// which PAT can talk to that org; otherwise --profile / AZDO_PROFILE / default.
function resolveProfile({ urlOrg, flagProfile } = {}) {
  let p;
  if (urlOrg) {
    p = BY_ORG[urlOrg.toLowerCase()];
    if (!p) {
      throw new Error(
        `no profile configured for org "${urlOrg}" — add it to azdo-profiles.json ` +
          `(profiles.<name>.org = "${urlOrg}") or set AZDO_ORG in .env`
      );
    }
  } else {
    const name = flagProfile || process.env.AZDO_PROFILE || DEFAULT_PROFILE;
    if (!name) {
      throw new Error("no profile selected — set AZDO_ORG/AZDO_PAT in .env or pass --profile <name>");
    }
    p = PROFILES[name] || BY_ORG[String(name).toLowerCase()];
    if (!p) {
      throw new Error(
        `unknown profile "${name}" — configured: ${Object.keys(PROFILES).join(", ") || "(none)"}`
      );
    }
  }
  const pat = profilePat(p);
  if (!p.org || !pat) {
    throw new Error(
      `profile "${p.name}" is missing org or PAT` + (p.patEnv ? ` (is env ${p.patEnv} set?)` : "")
    );
  }
  return { ...p, pat };
}

// Active profile state, set by activate() before any api() call runs.
let ORG = "";
let PROJECT = "";
let PAT = "";
let AUTH = "";
let DEFAULT_REPO = "";
function activate(p) {
  ORG = p.org;
  PROJECT = p.project;
  PAT = p.pat;
  DEFAULT_REPO = p.defaultRepo;
  // Azure DevOps: username is ignored, PAT goes in the password slot.
  AUTH = "Basic " + Buffer.from(`:${PAT}`).toString("base64");
  return p;
}

// Network-level fetch failures (TLS resets, transient DNS) are common here; retry a few times.
// HTTP error responses are NOT retried — they bubble up immediately.
async function fetchRetry(url, opts, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, opts);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

async function api(method, url, body) {
  const sep = url.includes("?") ? "&" : "?";
  const res = await fetchRetry(`${url}${sep}api-version=${API_VERSION}`, {
    method,
    headers: {
      Authorization: AUTH,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = typeof data === "object" ? JSON.stringify(data, null, 2) : data;
    throw new Error(`HTTP ${res.status} on ${method} ${url}\n${msg}`);
  }
  return data;
}

const orgBase = () => `https://dev.azure.com/${encodeURIComponent(ORG)}`;
const projBase = (project) => `${orgBase()}/${encodeURIComponent(project)}`;
const prBase = (project, repo, id) =>
  `${projBase(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullRequests/${id}`;

// "@path" → file contents; otherwise the literal string.
function bodyArg(arg) {
  if (typeof arg === "string" && arg.startsWith("@")) return readFileSync(arg.slice(1), "utf8");
  return arg;
}

// Pull --flag / --flag value out of an argv array; returns { flags, positionals }.
// --comment is repeatable (collected into an array); unknown tokens stay positional.
function parseArgs(rest) {
  const flags = { comment: [] };
  const positionals = [];
  const VALUE = new Set(["repo", "title", "desc", "source", "target", "profile", "project"]);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--json") flags.json = true;
    else if (a === "--draft") flags.draft = true;
    else if (a === "--force") flags.force = true;
    else if (a === "--comment") flags.comment.push(rest[++i]);
    else if (a.startsWith("--") && VALUE.has(a.slice(2))) flags[a.slice(2)] = rest[++i];
    else positionals.push(a);
  }
  return { flags, positionals };
}

// Azure DevOps rejects PR descriptions longer than this; the detail belongs in comments.
const MAX_DESC = 4000;
function assertDescLen(desc) {
  if (desc && desc.length > MAX_DESC) {
    throw new Error(
      `description is ${desc.length} chars — Azure DevOps caps PR descriptions at ${MAX_DESC}. ` +
        `Trim --desc to a summary and move the detail into --comment (comments explain the feature).`
    );
  }
}

// Post each --comment (literal text or @file) as its own PR-level thread.
async function postComments(project, repo, id, comments) {
  for (const c of comments || []) {
    const text = bodyArg(c);
    if (!text) continue;
    await api("POST", `${prBase(project, repo, id)}/threads`, {
      comments: [{ parentCommentId: 0, content: text, commentType: 1 }],
      status: 1, // active
    });
    console.log(`Posted comment on PR #${id}`);
  }
}

// Find the change entry for `filePath` in the PR's latest iteration. Azure accepts
// an inline comment on ANY path (returns 200) but silently ORPHANS it in the UI when
// the path isn't part of the diff — and even for added files it only renders reliably
// when the thread is bound to the diff iteration via pullRequestThreadContext. This
// resolves both: the changeTrackingId + iteration ids needed to anchor, or {missing}.
async function resolveInlineAnchor(project, repo, id, filePath) {
  const iters = await api("GET", `${prBase(project, repo, id)}/iterations`);
  const latest = (iters.value || []).slice(-1)[0];
  if (!latest) return { missing: true, latestIterationId: null };
  const changes = await api(
    "GET",
    `${prBase(project, repo, id)}/iterations/${latest.id}/changes`
  );
  const entry = (changes.changeEntries || []).find(
    (c) => c.item?.path === filePath || c.originalPath === filePath
  );
  if (!entry) return { missing: true, latestIterationId: latest.id };
  return {
    latestIterationId: latest.id,
    changeTrackingId: entry.changeTrackingId,
    changeType: entry.changeType || "",
  };
}

const refName = (b) => (b.startsWith("refs/") ? b : `refs/heads/${b}`);

// Resolve a PR reference AND activate the profile it belongs to: a full PR URL
// (org parsed from it selects the profile/PAT), or a bare numeric id (uses the
// --profile / default profile, plus --repo / the profile's defaultRepo).
function resolvePr(ref, flags) {
  if (/^\d+$/.test(ref)) {
    const p = activate(resolveProfile({ flagProfile: flags.profile }));
    const repo = flags.repo || p.defaultRepo;
    if (!repo) throw new Error("bare PR id needs --repo <name> (or defaultRepo in the profile)");
    if (!p.project) {
      throw new Error("bare PR id needs a project — set it in the profile/.env, or pass a full PR URL");
    }
    return { project: p.project, repo, id: Number(ref) };
  }
  const m = ref.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/i);
  if (!m) throw new Error(`could not parse PR reference "${ref}" — pass a PR URL or a numeric id`);
  activate(resolveProfile({ urlOrg: decodeURIComponent(m[1]) }));
  return {
    project: decodeURIComponent(m[2]),
    repo: decodeURIComponent(m[3]),
    id: Number(m[4]),
  };
}

const shortRef = (ref) => (ref || "").replace(/^refs\/heads\//, "");

const commands = {
  async whoami(_positionals, flags) {
    activate(resolveProfile({ flagProfile: flags.profile }));
    // connectionData is preview-only at 7.1; projects is GA and proves auth + reachability.
    const d = await api("GET", `${orgBase()}/_apis/projects`);
    const names = (d.value || []).map((p) => p.name);
    console.log(`auth OK  org=${ORG}  project=${PROJECT || "(none)"}`);
    console.log(`projects: ${names.join(", ") || "—"}`);
  },

  // List configured profiles (never prints PAT values — only whether one is set).
  async profiles() {
    const names = Object.keys(PROFILES);
    if (!names.length) {
      console.log("no profiles configured — set AZDO_ORG/AZDO_PAT in .env or add azdo-profiles.json");
      return;
    }
    for (const name of names) {
      const p = PROFILES[name];
      const mark = name === DEFAULT_PROFILE ? "  (default)" : "";
      const pat = profilePat(p) ? (p.patEnv ? `from env ${p.patEnv}` : "set") : "MISSING";
      console.log(
        `${name}${mark}\n    org=${p.org}  project=${p.project || "—"}  ` +
          `defaultRepo=${p.defaultRepo || "—"}  pat=${pat}`
      );
    }
  },

  // Create a new empty git repository in the profile's (or --project's) project.
  async "create-repo"([name], flags) {
    activate(resolveProfile({ flagProfile: flags.profile }));
    const repoName = name || flags.repo;
    const project = flags.project || PROJECT;
    if (!repoName) throw new Error("usage: create-repo <name> [--project p] [--profile n]");
    if (!project) {
      throw new Error("create-repo needs a project — pass --project or set it in the profile/.env");
    }
    const created = await api("POST", `${projBase(project)}/_apis/git/repositories`, {
      name: repoName,
    });
    console.log(`Created repo "${created.name}"  id=${created.id}`);
    console.log(`Remote: ${created.remoteUrl || created.webUrl || "—"}`);
    if (flags.json) console.log(JSON.stringify(created, null, 2));
  },

  async pr([ref], flags) {
    if (!ref) throw new Error("usage: pr <url|id> [--repo r] [--json]");
    const { project, repo, id } = resolvePr(ref, flags);
    const d = await api("GET", prBase(project, repo, id));
    if (flags.json) {
      console.log(
        JSON.stringify(
          {
            id,
            project,
            repo,
            title: d.title,
            status: d.status,
            isDraft: d.isDraft,
            author: d.createdBy?.displayName,
            sourceBranch: shortRef(d.sourceRefName),
            targetBranch: shortRef(d.targetRefName),
            sourceRefName: d.sourceRefName,
            targetRefName: d.targetRefName,
            lastMergeSourceCommit: d.lastMergeSourceCommit?.commitId,
            lastMergeTargetCommit: d.lastMergeTargetCommit?.commitId,
            description: d.description || "",
          },
          null,
          2
        )
      );
      return;
    }
    console.log(`PR #${id}  [${d.status}${d.isDraft ? ", draft" : ""}]  ${repo}`);
    console.log(`Title : ${d.title}`);
    console.log(`Author: ${d.createdBy?.displayName || "—"}`);
    console.log(`Source: ${shortRef(d.sourceRefName)}  →  Target: ${shortRef(d.targetRefName)}`);
    console.log(`\nDescription:\n${d.description || "—"}`);
  },

  async files([ref], flags) {
    if (!ref) throw new Error("usage: files <url|id> [--repo r]");
    const { project, repo, id } = resolvePr(ref, flags);
    const iters = await api("GET", `${prBase(project, repo, id)}/iterations`);
    const last = (iters.value || []).slice(-1)[0];
    if (!last) {
      console.log("(no iterations / no changes)");
      return;
    }
    const changes = await api(
      "GET",
      `${prBase(project, repo, id)}/iterations/${last.id}/changes`
    );
    for (const c of changes.changeEntries || []) {
      const p = c.item?.path || c.originalPath || "?";
      console.log(`${(c.changeType || "?").padEnd(12)} ${p}`);
    }
  },

  async threads([ref], flags) {
    if (!ref) throw new Error("usage: threads <url|id> [--repo r]");
    const { project, repo, id } = resolvePr(ref, flags);
    const d = await api("GET", `${prBase(project, repo, id)}/threads`);
    for (const t of d.value || []) {
      if (t.isDeleted) continue;
      const ctx = t.threadContext?.filePath
        ? `  @ ${t.threadContext.filePath}:${t.threadContext.rightFileStart?.line ?? "?"}`
        : "";
      console.log(`— thread ${t.id} [${t.status || "—"}]${ctx}`);
      for (const c of t.comments || []) {
        if (c.commentType === "system") continue;
        const oneLine = String(c.content || "").replace(/\s+/g, " ").slice(0, 100);
        console.log(`    comment ${c.id} by ${c.author?.displayName}: ${oneLine}`);
      }
    }
  },

  async "del-thread"([ref, threadId], flags) {
    if (!ref || !threadId) throw new Error("usage: del-thread <url|id> <threadId> [--repo r]");
    const { project, repo, id } = resolvePr(ref, flags);
    const t = await api("GET", `${prBase(project, repo, id)}/threads/${threadId}`);
    const comments = (t.comments || []).filter((c) => c.commentType !== "system");
    if (!comments.length) {
      console.log(`thread ${threadId}: no deletable comments`);
      return;
    }
    for (const c of comments) {
      await api(
        "DELETE",
        `${prBase(project, repo, id)}/threads/${threadId}/comments/${c.id}`
      );
      console.log(`Deleted comment ${c.id} in thread ${threadId} (PR #${id})`);
    }
  },

  async comment([ref, ...body], flags) {
    if (!ref) throw new Error("usage: comment <url|id> <text|@file> [--repo r]");
    const text = bodyArg(body.join(" "));
    if (!text) throw new Error("comment text is empty");
    const { project, repo, id } = resolvePr(ref, flags);
    await api("POST", `${prBase(project, repo, id)}/threads`, {
      comments: [{ parentCommentId: 0, content: text, commentType: 1 }],
      status: 1, // active
    });
    console.log(`Posted comment on PR #${id}`);
  },

  async "comment-file"([ref, path, line, ...body], flags) {
    if (!ref || !path || !line) {
      throw new Error("usage: comment-file <url|id> <path> <line> <text|@file> [--repo r] [--force]");
    }
    const text = bodyArg(body.join(" "));
    if (!text) throw new Error("comment text is empty");
    const { project, repo, id } = resolvePr(ref, flags);
    const filePath = path.startsWith("/") ? path : `/${path}`;
    const ln = Number(line);
    if (!Number.isInteger(ln) || ln < 1) {
      throw new Error(`line must be a positive integer, got "${line}"`);
    }

    // Guard against silent orphaning: the file must be part of the PR's diff.
    const anchor = await resolveInlineAnchor(project, repo, id, filePath);
    if (anchor.missing) {
      if (!flags.force) {
        throw new Error(
          `"${filePath}" is not in PR #${id}'s changed files — an inline comment there would ` +
            `orphan (Azure returns 200 but the UI won't render it). Run \`files ${ref}\` to see ` +
            `the valid paths and anchor to a file that IS in the diff, or pass --force to post anyway.`
        );
      }
      console.warn(`⚠ "${filePath}" is not in the diff — posting with --force (may not render).`);
    }

    // Deleted files only exist on the left (original) side; everything else on the right.
    const onLeft = /delete/i.test(anchor.changeType || "");
    const startKey = onLeft ? "leftFileStart" : "rightFileStart";
    const endKey = onLeft ? "leftFileEnd" : "rightFileEnd";
    const payload = {
      comments: [{ parentCommentId: 0, content: text, commentType: 1 }],
      status: 1,
      threadContext: {
        filePath,
        [startKey]: { line: ln, offset: 1 },
        [endKey]: { line: ln, offset: 1 },
      },
    };
    // Bind the thread to the diff iteration — this is what makes the comment render
    // reliably, especially on added files (where the right-side anchor alone is flaky).
    if (anchor.changeTrackingId != null) {
      payload.pullRequestThreadContext = {
        changeTrackingId: anchor.changeTrackingId,
        iterationContext: {
          firstComparingIteration: 1,
          secondComparingIteration: anchor.latestIterationId,
        },
      };
    }
    await api("POST", `${prBase(project, repo, id)}/threads`, payload);
    console.log(`Posted comment on PR #${id} @ ${filePath}:${ln}${onLeft ? " (left)" : ""}`);
  },

  async "create-pr"(positionals, flags) {
    activate(resolveProfile({ flagProfile: flags.profile }));
    const repo = flags.repo || positionals[0] || DEFAULT_REPO;
    if (!repo || !flags.source || !flags.title) {
      throw new Error(
        "usage: create-pr --repo <name> --source <branch> [--target <branch>] " +
          "--title <t> [--desc <text|@file>] [--comment <text|@file> ...] [--draft]"
      );
    }
    const target = flags.target || "main";
    const description = flags.desc !== undefined ? bodyArg(flags.desc) : "";
    assertDescLen(description);
    const created = await api(
      "POST",
      `${projBase(PROJECT)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests`,
      {
        sourceRefName: refName(flags.source),
        targetRefName: refName(target),
        title: flags.title,
        description,
        isDraft: !!flags.draft,
      }
    );
    const id = created.pullRequestId;
    console.log(
      `Created PR #${id}  ${shortRef(created.sourceRefName)} → ${shortRef(created.targetRefName)}` +
        `  [${created.isDraft ? "draft" : created.status}]`
    );
    await postComments(PROJECT, repo, id, flags.comment);
    console.log(`URL: ${projBase(PROJECT)}/_git/${encodeURIComponent(repo)}/pullrequest/${id}`);
  },

  async "update-pr"([ref], flags) {
    if (!ref) {
      throw new Error(
        "usage: update-pr <url|id> [--repo r] [--title t] [--desc <text|@file>] " +
          "[--comment <text|@file> ...]"
      );
    }
    const { project, repo, id } = resolvePr(ref, flags);
    const patch = {};
    if (flags.title) patch.title = flags.title;
    if (flags.desc !== undefined) {
      const description = bodyArg(flags.desc);
      assertDescLen(description);
      patch.description = description;
    }
    if (Object.keys(patch).length) {
      await api("PATCH", prBase(project, repo, id), patch);
      const what = [patch.title && "title", patch.description !== undefined && "description"]
        .filter(Boolean)
        .join(" + ");
      console.log(`Updated PR #${id} (${what})`);
    } else if (!flags.comment.length) {
      throw new Error("nothing to do: pass --title, --desc, and/or --comment");
    }
    await postComments(project, repo, id, flags.comment);
  },

  async raw([method, path, body], flags) {
    activate(resolveProfile({ flagProfile: flags.profile }));
    if (!method || !path) {
      throw new Error("usage: raw <METHOD> <path|url> [json|@file] [--profile n]");
    }
    const url = /^https?:\/\//.test(path) ? path : `${orgBase()}${path}`;
    const d = await api(method.toUpperCase(), url, body ? JSON.parse(bodyArg(body)) : undefined);
    console.log(JSON.stringify(d, null, 2));
  },
};

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || !commands[cmd]) {
  console.log(`azure <command> ...

  whoami [--profile n]                         verify auth (prints the org + visible projects)
  profiles                                     list configured profiles (PAT values never shown)
  create-repo <name> [--project p] [--profile n]   create an empty git repo in a project
  pr <url|id> [--repo r] [--json]              show a pull request (--json for machine output)
  files <url|id> [--repo r]                    list changed files (latest iteration)
  threads <url|id> [--repo r]                  list comment threads (with thread + comment ids)
  del-thread <url|id> <threadId> [--repo r]    delete the (non-system) comments in a thread
  comment <url|id> <text|@file> [--repo r]     post a PR-level comment
  comment-file <url|id> <path> <line> <text|@file> [--repo r] [--force]
                                               post an inline comment on a file/line (the file must
                                               be in the PR diff, else it orphans; --force overrides)
  create-pr --repo r --source b [--target b] --title t [--desc <text|@file>]
            [--comment <text|@file> ...] [--draft]
                                               create a PR (desc capped at ${MAX_DESC} chars;
                                               use --comment, repeatable, to explain the feature)
  update-pr <url|id> [--repo r] [--title t] [--desc <text|@file>] [--comment <text|@file> ...]
                                               update title/description and/or add comments
  raw <METHOD> <path|url> [json|@file]         raw REST call (path is appended to the org base)

  A PR <url> is the full browser URL ending in /pullrequest/<id>; a bare <id> needs --repo
  (or AZDO_DEFAULT_REPO in .env). Use @path to pass a file as a comment body.

  Multiple orgs: the .env is the default profile; add more (each with its own PAT) to a
  git-ignored azdo-profiles.json. A PR URL auto-selects its org's profile; other commands
  take --profile <name> (or AZDO_PROFILE). \`profiles\` lists them.

  Convention: keep the PR description a tight summary (≤ ${MAX_DESC} chars) and put the
  detailed explanation of the feature in --comment threads.`);
  process.exit(cmd ? 1 : 0);
}

const { flags, positionals } = parseArgs(rest);

commands[cmd](positionals, flags).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
