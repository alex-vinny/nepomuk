# azure-connector

A zero-dependency Node.js CLI for Azure DevOps — pull requests (create, describe, comment, edit), work items (PBI/Bug/Task reading, commenting, editing, state, tasks), attachment upload and download, repositories, iterations, wiki, and pipeline builds. Multi-org via profiles; a raw REST passthrough for anything not yet wrapped.

Built as a fallback for when the MCP azure-devops integration is unavailable or unreliable.

> **Calling this from an agent or a script?** Read **[AGENTS.md](AGENTS.md)** instead — it is
> the operating contract: the complete command × flag matrix, exit codes, stdout/stderr
> discipline, which commands write, and every guard that can refuse a write. This README is
> the narrative guide with worked examples.

**Measuring a team's process?** Four commands answer the questions the board cannot:
[`wi updates`](#wi-updates--how-the-item-moved-state-history) (how an item actually moved),
[`sprints`](#sprints--iterations-and-their-dates) (the sprint window),
[`pr timeline`](#pr-timeline--when-the-review-actually-happened) (whether a repo is really being
reviewed), and [`repo`](#repo--repository-metadata-and-refs) (default branch, ids, does-this-branch-exist). Worked pipelines in
[Agent recipes](#agent-recipes--measuring-a-team-from-the-board).

---

## ⚠️ Formatting: work items and pull requests are different surfaces

Work-item content and pull-request content render with **different engines** and live at
**different URLs** — treat them as independent artifacts. Do **not** reuse one body for the other,
and do not let an edit on one side propagate to the other unless explicitly intended.

| Surface | Renders as | Write | Edit with |
|---|---|---|---|
| **WI long-form fields** (`System.Description`, `Microsoft.VSTS.TCM.ReproSteps`, any long-form `Custom.*`, …) | **HTML**, and a restricted subset: `style=` is stripped and `<table>` renders inconsistently | HTML — or Markdown with `--from-markdown`, which converts using the `field` profile | `wi set-field` |
| **WI comments** | HTML (rendered by Azure) | **Markdown only** — this CLI runs the `--body-file` through a Markdown→HTML converter | `wi comment` / `wi edit-comment` |
| **PR description** | **Markdown** | Markdown | `pr create` / `pr set-desc` |
| **PR comments** | **Markdown** | Markdown | `pr comment` / `pr edit-comment` |

- WI **fields** and WI **comments** take **opposite** input formats — don't mix them up:
  - **WI field** = write real **HTML** tags (`<strong>`, `<code>`, `<ul>`, `<pre>`, `<a href>`, `<br>`).
    Markdown written into an HTML field is stored literally and its special chars are escaped
    (e.g. `"` → `&quot;`, `**bold**` stays as asterisks) — it renders as raw text.
  - **WI comment** = write **Markdown**. Raw HTML fed to `wi comment`/`wi edit-comment` is
    HTML-escaped by the converter and shows literally (`<strong>` → `&lt;strong&gt;`, and any
    `&entity;` double-escapes to `&amp;entity;`) — the one exception is a body that is HTML from
    its first tag to its last, which is passed through untouched.
    Supported constructs: `##`/`###`/`####` headings, `**bold**`, `` `inline code` ``, `-` lists,
    `1.` numbered lists, `>` block quotes, `---` rules, GFM pipe tables, and fenced code blocks
    (```` ``` ````) — the converter emits a proper `<pre><code>` block and drops the opening-fence
    info string (e.g. ```` ```ts ````).
    Tables need the **leading and trailing `|`** on every row (`| a | b |`) plus a delimiter row
    (`|---|:--:|---:|`, which also sets column alignment); outer-pipe-less GFM tables are not
    recognised, so prose containing a stray `|` is never mistaken for a table. A `|` inside inline
    code is content, not a separator; elsewhere in a cell, escape it as `\|`.
- HTML written into a **Markdown** PR body can render as raw tags. Write Markdown there.
- Keep a separate body file per surface (e.g. `root-cause.html` for a WI field vs `pr-body.md` for a PR).
- Verify a field's engine before writing: `GET /_apis/wit/fields/<ref>` → `type` (`html` / `plainText` / …),
  or `wi layout` / inspect an existing value with `wi field`.

> **Known debt: the Markdown converter.** Work-item formatting is produced by the hand-rolled
> `markdownToHtml` in `lib/workitem.js` (Markdown → HTML; used **only** by the work-item paths —
> the PR path sends raw Markdown and must stay untouched). It has grown by regex past the point
> where that is a good idea. **Do not add more regex to it** — the intended next change to that
> file is to swap it for a maintained library:
>
> - **Write path (author MD → send HTML):** replace `markdownToHtml` with **`marked`** or
>   **`markdown-it`** behind the same function signature. This is the fix for garbled **outgoing**
>   content (bold/code/lists/tables/links).
> - **Read/display path (fetched HTML → terminal MD):** use **`turndown`**
>   (<https://github.com/mixmark-io/turndown>) to render `wi comments`/`pr comments` output —
>   turndown is HTML→Markdown, so it does **not** help the write path.
>
> Two costs to accept going in. Either library adds the tool's **first runtime dependency** (today
> it is zero-dep, Node built-ins only — see Requirements). And neither is a pure drop-in: Azure
> renders this HTML without any stylesheet of ours, so a bare `<table>` comes out borderless, and
> the inline `style=` attributes are the part that makes it readable. Both output profiles
> therefore need **custom renderer overrides**, not just default output.

---

## Requirements

- Node.js 18+
- No `npm install` needed — uses only Node built-ins (`https`, `fs`, `path`, `url`)

---

## Setup

Put the folder anywhere — the CLI resolves its own directory, so you can invoke it
by absolute path from any working directory (no `cd` required). In the examples
below, `<AZC>` stands for the path to your `azure-connector` folder; substitute
your own (e.g. `~/tools/azure-connector`, `C:\tools\azure-connector`).

```bash
# POSIX (Linux / macOS / Git Bash / WSL) — optional: mark executable + alias
chmod +x "<AZC>/index.js"
alias azure-connector='node "<AZC>/index.js"'
```

```powershell
# Windows PowerShell — define a function (add to $PROFILE to persist)
function azure-connector { node "<AZC>\index.js" @args }
```

> All examples in this README write `node index.js …` for brevity — that assumes
> the current directory is the folder, or that `index.js` is replaced by
> `<AZC>/index.js` (or your `azure-connector` alias).

### Configure a PAT

An Azure DevOps Personal Access Token (scopes: *Code* Read/Write, *Work Items* Read/Write) is
required. Set it any one of these ways:

```bash
# Persist a PAT + org in ~/.azure-connector.json
node index.js config --pat <your-token> --org <your-org> --pat-valid-to <YYYY-MM-DD>

# Set a default project so bare work item ids work
node index.js config --project "MyBoard"

# Or use environment variables (highest priority)
export AZURE_PAT=<token>
export AZURE_ORG=<org>
export AZURE_PROJECT="MyBoard"
export AZURE_BASE_URL=https://dev.azure.com
```

Config is saved to `~/.azure-connector.json` (override the path with `AZURE_CONFIG_FILE`).
Priority order: env vars → resolved profile → top-level config. Verify with `whoami`.

### Profiles (multiple orgs)

A PAT is scoped to a single Azure DevOps org, so multi-org support is one profile per org. Add a
`profiles` map (and an optional `defaultProfile`) to `~/.azure-connector.json`:

```jsonc
{
  "defaultProfile": "contoso",
  "profiles": {
    "contoso": { "org": "contoso", "project": "Platform", "pat": "...", "patValidTo": "2030-01-31" },
    "other":   { "org": "other-org", "patEnv": "AZURE_PAT_OTHER" }
  }
}
```

- A **PR/WI URL carries its org**, so `pr`/`wi`/… auto-select the matching profile — paste any org's
  URL and the right PAT is used, no flag.
- Other commands pick the profile from `--profile <name>`, `AZURE_PROFILE`, or `defaultProfile`.
- `pat` stores the token inline; **`patEnv` names an env var instead**, so no secret sits on disk —
  inject it at runtime from whatever secret store you use (`AZURE_PAT_OTHER=$(...) node index.js …`).
- A single top-level `{ pat, org, … }` with no `profiles` behaves exactly as one profile.

### Transient-failure retries

Every HTTP call retries transient failures with exponential backoff (~0.5s → 1s → 2s → 4s,
capped at 8s, plus jitter), so a burst of writes survives a single hiccup:

- **Retried:** `429` (Azure throttling — the usual cause of "had to try several times"), `500/502/503/504`
  (transient server errors, common on preview endpoints like the WI-comments API `7.1-preview.3`),
  `409` (optimistic-concurrency contention on rapid work-item PATCHes), and transient network errors
  (`ECONNRESET`, `ETIMEDOUT`, …). A `Retry-After` header is honoured when present.
- **Never retried:** auth failures (`401/203`) and other `4xx` — those won't fix themselves.
- Each retry prints a one-line note to **stderr**; the final failure surfaces the real error.
- Attempt count is `1 + AZURE_MAX_RETRIES` (default **3** → up to 4 tries). Set `AZURE_MAX_RETRIES=0`
  to disable retries, or higher for flakier networks.

### PAT identity & expiry

A PAT without token-management scope can't read its own expiry from the API, so the expiry date is tracked locally in config and checked offline (record it with `--pat-valid-to`).

- A warning is printed to **stderr** on every run within `--pat-warn-days` (default 30) of expiry — and a louder one once it has expired. This never touches the network, so it adds no latency.
- `pat check` validates the PAT over the network (see below).
- Set `AZURE_PREFLIGHT=1` to network-validate the PAT before *every* command (off by default — a failed real call already reports auth errors clearly).

When you rotate the PAT, record the new expiry so the warnings stay accurate:

```bash
node index.js config --pat <new-token> --pat-valid-to <YYYY-MM-DD> --pat-name "<label>"
```

Expiry overrides via env: `AZURE_PAT_VALID_TO`, `AZURE_PAT_NAME`, `AZURE_PAT_WARN_DAYS`.

### Unknown flags abort the run

`parseArgs` accepts anything starting with `--`, so an unrecognised flag would otherwise be
dropped in silence and the command would run **without it** — a dropped `--yes` becomes a
dry run, a dropped `--project` changes which project is addressed. So an unknown flag is a
hard failure:

```
$ node index.js wi get 1234 --porject Platform
ERROR: Unknown flag(s) — nothing was run:
  --porject   did you mean --project?
```

Exit 1, and no request is made. The suggestion is the closest known flag within two edits,
or `(no close match)`. `--no-strict-flags` downgrades this to a warning for an unattended
pipeline — don't reach for it to get past a typo.

Flag validity is **global, not per-command**: passing a flag some other command reads is
accepted and ignored.

### Exit codes

| Code | Meaning |
|---:|---|
| `0` | Success. |
| `1` | Any error — bad arguments, unknown flag, auth failure, HTTP error, or a guard refusing a write. |
| `2` | Only from `wi comment`: the work item has long-form custom fields and neither `--field` nor `--as-comment` was given. Nothing was posted; see [Field-routing gate](#field-routing-gate). |

**stdout carries the answer; stderr carries everything else** — PAT-expiry warnings, retry
notices, anchor corrections, progress and verdicts. A non-empty stderr does not mean
failure, so read the exit code. `--json` output is therefore always safe to parse.

---

## Commands

### `config` — Show or set configuration

```bash
node index.js config                              # show current config (PAT masked) + expiry status
node index.js config --pat <token>                # set PAT
node index.js config --org <org>                  # set organization
node index.js config --project "<project>"        # set default project for bare work item ids
node index.js config --base-url <url>             # set base URL
node index.js config --pat-valid-to <YYYY-MM-DD>  # record PAT expiry (drives the warning)
node index.js config --pat-name "<name>"          # label the PAT (shown in warnings / pat check)
node index.js config --pat-warn-days <n>          # warning window in days (default 30)
```

---

### `pat check` — Validate the PAT

```bash
node index.js pat check
```

Tests the PAT with a cheap, low-scope call (`connectionData`) and reports the authenticated identity, plus the configured name, expiry date, and days remaining. A valid PAT resolves to a real identity; an invalid/expired/revoked one resolves to the anonymous identity and is reported as a failure. Run this whenever a command starts returning auth errors, or to confirm a freshly-rotated PAT.

---

### `whoami` — Verify auth and list projects

```bash
node index.js whoami [--profile <name>]
```

Confirms the active profile's PAT works and prints the org plus every project it can see. Use it to check reachability and to discover project names for `--project`.

---

### `raw` — Raw REST passthrough

```bash
node index.js raw <METHOD> <path|url> [<json>|@<file>]
node index.js raw GET "/Platform/_apis/git/repositories"
node index.js raw PATCH "/Platform/_apis/git/repositories/<repo>" '{"defaultBranch":"refs/heads/main"}'
```

For any endpoint not yet wrapped. A `path` is appended to the org base (`https://dev.azure.com/<org>`); a full `https://` URL is used as-is. `api-version=7.1` is added unless the URL already has one. The body is inline JSON or `@file`. Auth, retry/backoff, and profile selection are shared with every other command.

> From Git Bash (MSYS), a leading-slash path like `/Platform/...` is rewritten to a Windows path before Node sees it. Use a full URL, or run from PowerShell.

---

### `create-repo` — Create an empty git repository

```bash
node index.js create-repo <name> [--project <p>]
```

Creates an empty git repo in the given (or configured default) project and prints its id and remote URL.

---

### `pr` — Pull Request operations

#### Get PR metadata

```bash
node index.js pr get <pr-url|pr-id> [--project <p>] [--repo <r>] [--full] [--json]
```

Example:
```bash
node index.js pr get https://dev.azure.com/contoso/Platform/_git/my-repo/pullrequest/20687

# A bare PR id needs a project + repo: from flags, AZURE_PROJECT/AZURE_REPO,
# or the defaults saved with `config --project <p> --repo <r>`.
node index.js pr get 20687 --project Platform --repo my-repo
```

Output: title, status, author, source/target branch, creation date, and the **linked
work items** (`Work items: #123, #456`, or `(none)` — a PR with no work item is a
finding, so the line is always printed rather than silently omitted).

`--full` adds the review state: each reviewer's vote and the thread counts
(`total (open, anchored to a file)`). `--json` emits the raw PR payload with
`workItems` — and, under `--full`, `threads` — merged in.

---

#### Create a pull request

```bash
# Branches via flags, body from a file, link a work item
node index.js pr create "<repo-url>" \
  --source users/me/my-branch --target releases/rc/202606_1 \
  --title "[BUG 1234] Fix ..." --desc-file ./pr-body.md --work-items 1234

# Branches taken from a pullrequestcreate URL (sourceRef/targetRef in the query)
node index.js pr create "<pullrequestcreate-url>" --title "..." --desc "short text"
```

> The description can come from `--desc "<text>"`, `--desc-file <path>`, or `--body-file <path>`
> (the latter is an alias so the same flag works as in `pr comment`/`pr set-desc`). The
> **4000-character** limit is enforced before the call.

Accepts a repo URL (`.../_git/{repo}`) or a `pullrequestcreate` URL. `--source`/`--target`
take a bare branch or a full `refs/heads/...` ref; if omitted, they are read from a
`pullrequestcreate` URL. `--work-items` is a comma-separated list of IDs linked to the new PR
(ArtifactLink). `--draft` opens it as a draft. Prints the new PR id and web URL.

> ⚠️ **`--target` is required (no default to the repo's default branch).** When creating a
> "PR → main/master" you must know the target branch first. The CLI does **not** fall back to
> the repo's `defaultBranch`, and beware: the default branch is not always `main` — a repo can
> have it pointing at a long-lived feature branch. Resolve it with `repo get` before creating.

> ⚠️ Azure DevOps limits the PR **description to 4000 characters**. The CLI validates this
> before calling the API and fails with a clear message (instead of an opaque HTTP 400). If
> your body is longer, keep the summary in the description and post the rest as a PR comment
> (`pr comment`) after creation.

> 📌 **Reference PRs and work items by id, not by URL.** In any prose body (PR description, PR
> comment, WI comment) Azure DevOps auto-links its own artifacts when you write the reference
> form — render them as inline cards/links:
> - **Work item** → `#<id>` (e.g. `#64891`)
> - **Pull request** → `!<id>` (e.g. `!21217`)
>
> Use these instead of pasting full `https://dev.azure.com/...` URLs — the reference form is
> shorter, renders natively, and stays valid. A URL is only warranted for an artifact **outside**
> Azure DevOps, or when you must point across orgs where `#`/`!` won't resolve. Note: `--work-items`
> creates the hard **ArtifactLink** relation (the linked-items panel); the `#id`/`!id` in the prose
> is the separate **textual reference** — you typically want both.

---

#### List PR comment threads

```bash
node index.js pr comments <pr-url>
```

Shows all active threads with author, date, file location (if inline), and content.

---

#### List pull requests

```bash
# By repo URL, or --project/--repo; filter by status/target/date; --json for machine output
node index.js pr list <repo-url>
node index.js pr list --project Platform --repo svc-crm --status completed --since 2026-06-01
node index.js pr list --project Platform --repo ui-crm --status active --target releases/rc/202607_1 --top 20 --json
```

`--status` = `active|completed|abandoned|all` (default `completed`). `--since <YYYY-MM-DD>` filters
client-side by closed/creation date. Useful for finding a PR by branch/date or harvesting recent PRs.

---

#### Add a PR comment

```bash
# PR-level comment from a Markdown file (recommended)
node index.js pr comment <pr-url> --body-file ./review.md

# Inline comment on a specific file and line, body still from a file
node index.js pr comment <pr-url> --body-file ./inline-comment.md --file /src/Service.cs --line 42

# Preview the inline anchor without posting (validates path + line first)
node index.js pr comment <pr-url> --body-file ./inline-comment.md --file /src/Service.cs --line 42 --dry-run
```

> **PR comments require `--body-file`.** Inline text arguments are not supported because shells mangle markdown, backslashes, and newlines. The file must contain **Markdown**; Azure DevOps PR discussion threads render Markdown natively (headers, lists, bold, inline code, code blocks).
>
> **Self-correcting inline anchor.** For inline comments, the tool validates the anchor against the PR's **latest iteration** before posting: it auto-corrects the file path's casing/leading slash, picks the correct side (**right** for added/edited lines, **left** for deleted lines), and **refuses a line that doesn't exist** with a clear message (re-run your diff with `--force` and try again). Use `--dry-run` to preview where a comment would land without posting. Pass `--no-validate` to skip validation and post blindly (legacy behavior).
>
> Line numbers are the **new (right-hand) file** line numbers — the same ones `pr diff` prints.

##### Guards on an inline comment

Three checks run before a post, each because the failure it prevents is silent:

```bash
# Refuse to post if the PR head moved since the diff was read
node index.js pr comment <pr-url> --body-file ./f.md --file /src/S.cs --line 42 \
  --expect-head b31b63dc89

# Post a second thread on a line that already has one
node index.js pr comment <pr-url> --body-file ./f.md --file /src/S.cs --line 42 --allow-duplicate
```

- **`--expect-head <sha>`** is the guard `--dry-run` cannot give you: a shifted anchor
  still validates, so without it the comment lands quietly on whatever now occupies that
  line. Pass the commit you reviewed — 7–40 hex characters, matched by prefix.
- **Duplicate detection** stops and lists the existing threads when one is already
  anchored at that `file:line`, since a second thread there is nearly always a repeat of a
  finding. `--allow-duplicate` overrides.
- **Anchor resolution** corrects the path's casing, picks the side, and rejects a
  non-existent line. `--no-validate` posts blindly.

##### Post a whole review atomically (`--batch`)

```bash
node index.js pr comment <pr-url> --batch ./review/manifest.json
node index.js pr comment <pr-url> --batch ./review/manifest.json --dry-run
```

Validates **every** anchor, the head and duplicates before posting **anything**. Together
with an expected head that gives the property a shell loop cannot: either the whole review
lands against the head that was reviewed, or nothing does.

```json
{
  "expectHead": "b31b63dc89",
  "comments": [
    { "bodyFile": "00-summary.md" },
    { "file": "/src/Service.cs", "line": 42, "bodyFile": "01-null-deref.md" }
  ]
}
```

`bodyFile` is required per item and resolves relative to the manifest's own directory.
Omit `file`/`line` for a PR-level comment. A bare array works too, in which case pass
`--expect-head` on the command line.

If validation fails, every problem is listed and nothing is posted. If a post fails
*after* validation passed, the thread ids that already landed are printed — **do not
re-run the whole batch**, you would duplicate them.

---

#### Reply inside an existing thread

```bash
node index.js pr reply <pr-url> <threadId> --body-file ./reply.md
node index.js pr reply <pr-url> <threadId> --body-file ./reply.md --comment 2
```

Adds a comment inside thread `<threadId>` rather than starting a new one — the right call
when answering a reviewer. Thread ids come from `pr comments`. `--comment <n>` sets the
parent comment (default 1). Markdown body, `--body-file` only.

---

#### Edit a PR comment in place

```bash
node index.js pr edit-comment <pr-url> <threadId> --body-file ./review.md
node index.js pr edit-comment <pr-url> <threadId> --body-file ./review.md --comment 2
```

Edits require `--body-file` with a Markdown body. Inline text arguments are not supported.
Thread IDs come from `pr comments`. `--comment <n>` targets a comment other than the first in the thread.

---

#### Update a PR's description or title

```bash
# Replace the description from a file
node index.js pr set-desc <pr-url> --body-file ./pr-body.md

# Inline text, and/or rename the PR
node index.js pr set-desc <pr-url> "New description" --title "[BUG 1234] New title"
```

PATCHes the live PR. Use it to **sync a PR description after later commits change the
implementation**, instead of leaving the original (now-stale) text. Pass the new description
inline or via `--body-file`, and/or `--title` to rename. The same **4000-character** limit as
`pr create` is enforced before the call.

---

#### Abandon a pull request

```bash
node index.js pr abandon <pr-url>
```

Sets the PR status to `abandoned` (soft close). Branches are left in place — delete them separately
if needed. Handy for tearing down throwaway PRs created while testing a review flow.

---

#### Show changed files / diff

```bash
# List changed files + stats, then a unified diff per file (default)
node index.js pr diff <pr-url|pr-id>

# Dump the whole contents of each changed file instead of a diff
node index.js pr diff <pr-url|pr-id> --full
```

By default the command prints the file list and then, for each changed file, fetches both
the old (target branch) and new (source branch) versions and emits a compact **unified
diff** — what a code review needs. `--full` (alias `--content`) instead dumps each changed
file's whole contents from the source branch; use it when you need the surrounding code, not
just the change.

> `--patch` is accepted as a no-op, since the unified diff is already the default.

---

#### `pr link` / `wi link` — the canonical reference line

```bash
node index.js pr link <pr-url|id>            # resolves the linked work item too
node index.js pr link <pr-url|id> --wi 1234  # name the work item explicitly
node index.js pr link <pr-url|id> --no-wi    # omit the [PBI ...] tag
node index.js wi link <wi-url|id>            # work item counterpart
node index.js wi link <wi-url|id> --no-type  # omit the [Bug] tag
```

Prints one line, ready to paste into a review or a report:

```
[Pull Request 22838](https://dev.azure.com/contoso/Platform/_git/svc-kanban/pullrequest/22838 "https://dev.azure.com/contoso/platform/_git/svc-kanban/pullrequest/22838"): [svc-kanban][PBI 67209] Fix chat ordering
```

Both are **read-only**. The point is that the project is *resolved*, never assumed: for a
PR from its own `repository.project` object, for a work item from the **root segment of
its Area path**, which is always the project name. An org can hold repos across several
projects and work items split across more than one board, so a hand-built link is one
wrong segment away from pointing nowhere. `wi link` warns on stderr when the resolved
project disagrees with a `--project` you passed.

The link title is the same URL lowercased — what Azure DevOps itself produces when you
paste a link. `[<Repo>]` is the real repository from the PR, not the service name that
sounds like it matches the subject. With no linked work item the `[PBI ...]` group is
omitted rather than printed empty, because a PR with no work item is a finding.

---

#### `pr timeline` — when the review actually happened

```bash
# One PR: created → published → every vote → completed, with day deltas
node index.js pr timeline <pr-url> [--json]

# A whole repo: review health across its PRs
node index.js pr timeline --repo <r> --project <p> [--status all|active|completed] [--top <n>] [--json]
```

| Flag | Meaning |
|---|---|
| `--repo <r>` | Switches to repo mode. Without it, the first argument is a PR URL. |
| `--project <p>` | Required in repo mode unless a default project is configured. |
| `--status` | `all` (default in repo mode), `active`, `completed`, `abandoned`. |
| `--top <n>` | How many PRs to pull. Default 50. |
| `--json` | `{ health, prs: [...] }` in repo mode; the single summary otherwise. |

**Why this exists and `pr get` is not enough.** The PR object carries each reviewer's *current*
vote but never *when* it was cast, and nothing in the API says "this PR was completed with no
review at all". Both are reconstructed from the system comments in the thread feed.

Azure's vote scale is not intuitive — the numbers are not ordered the way you would guess, and
`0` means *no vote*, not *neutral*:

| Code | Meaning |
|---:|---|
| `10` | approved |
| `5` | approved with suggestions |
| `0` | no vote (a reviewer who **cleared** their vote — not a review) |
| `-5` | waiting for author |
| `-10` | rejected |

A vote of `0` is shown in the event list but never counts as the first review, and never rescues a
PR from the no-vote tally.

Repo mode prints a row per PR, then the aggregate:

```
median age 2.5 d   max 42 d   median days-to-first-vote 0.1
merged/closed with NO vote: 12 of 18 (67%)  #1204 #1198 #1187 ...

by author:
  A. Reviewer              n= 10  median    1.6 d  max   36.8 d  no-vote 10
```

Reach for it when the question is *"is this repo actually being reviewed?"* — the no-vote count is
the answer, and no per-PR view can show it.

---

### `wi` — Work Item (PBI / Bug) operations

All commands accept a standard Azure DevOps work item URL:
`https://dev.azure.com/{org}/{project}/_workitems/edit/{id}`

---

#### Get work item data

```bash
node index.js wi get <wi-url>
node index.js wi get <id> [--project "<project>"]
```

Output: ID, type, state, title, assigned to, area, iteration, priority, description, acceptance criteria, tags.

Examples:
```bash
node index.js wi get https://dev.azure.com/contoso/Platform/_workitems/edit/62576
node index.js wi get 64891 --project "MyBoard"
# if a default project is configured (config --project or AZURE_PROJECT):
node index.js wi get 64891
```

> Work item commands accept either a **full Azure DevOps URL** or a **bare numeric id**. When using a bare id, the project is resolved from `--project`, `AZURE_PROJECT`, or the configured `project` default.

---

#### Search work items (`search`)

Run a [WIQL](https://learn.microsoft.com/azure/devops/boards/queries/wiql-syntax) query and
print the matching work items. WIQL only returns ids, so the command hydrates them with the
requested fields in batches of **200** (the `workitemsbatch` page-size limit) — you never hit
the *"you requested N work items which exceeds the limit of 200"* error, even for large
result sets.

```bash
node index.js wi search [<title-term>] --project <p> [--type <t>] [--state <s>] \
  [--wiql "<query>"] [--fields <a,b,c>] [--json]
```

- `<title-term>` — the positional argument is the **title search term**, not the project.
  Optional; omit it to list everything matching the other filters.
- `--project <p>` — the team project (e.g. `"MyBoard"`). Required, but falls back to
  `AZURE_PROJECT` or the default saved with `config --project`.
- `--title-contains <t>` — explicit alias for the positional term (passing both is an error
  unless they are identical).
- `--type <t>` / `--state <s>` — convenience filters; the command builds the WIQL `WHERE`
  clause from them (single quotes are escaped for WIQL).
- `--wiql "<query>"` — supply a full WIQL query instead, overriding the filters above.
- `--fields <a,b,c>` — comma-separated field reference names to hydrate
  (default: `System.Id,System.Title,System.State,System.WorkItemType`).
- `--json` — machine-readable output (`[{ id, ...fields }]`); otherwise prints `id [state] title`.

Examples:
```bash
# All Features whose title contains "PN1" in the MyBoard project
node index.js wi search "PN1" --project "MyBoard" --type Feature

# Same, as JSON, pulling description + acceptance criteria too
node index.js wi search "PN1" --project "MyBoard" --type Feature \
  --fields System.Id,System.Title,System.Description,Microsoft.VSTS.Common.AcceptanceCriteria --json

# Full control via raw WIQL
node index.js wi search --project "Platform" --wiql "SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'Active'"
```

> Programmatic use: the underlying `searchWorkItems({ config, org, project, wiql, fields })`
> in `lib/workitem.js` is reusable from other Node scripts (returns the raw work item
> objects with the requested fields).

---

#### Discover & edit custom fields (`layout`, `fields`, `field`, `set-field`)

A custom process relabels and adds fields, so the label on the form is not the name the API
wants — a section shown as "Root Cause" may be backed by `Custom.RootCause`, and one shown
under a localized label may be a built-in like `Microsoft.VSTS.TCM.ReproSteps`. **Empty fields
are not returned by the API**, so you cannot discover an empty custom field from
`wi get`/`wi fields` — use `wi layout`, which reads the work item form definition.

> Rule of thumb: before editing or commenting on a work item, run `wi layout` to learn the
> real field reference names instead of guessing.

> **Fallback when the field doesn't exist (work items only):** work item *types* differ — a
> "Bug" may carry `Custom.RootCause` / `Custom.ImplementedSolution` while a
> "Bug Task" (or Task/PBI) does **not**. If `wi layout` shows the requested custom field is
> **not on that WIT**, do **not** try to `set-field` it (it will fail) and do **not** silently
> retarget another item — post the content as a **`wi comment`** instead, and tell the user the
> field was absent so it went to a comment. This fallback is specific to **work items**; it does
> not apply to pull requests (PRs have descriptions + inline/thread comments, no custom fields).

```bash
# Map form labels -> field reference names (the reliable way to find custom fields)
node index.js wi layout <wi-url> [--type <wit>]

# List the fields that currently have a value (ref name = value; HTML stripped)
node index.js wi fields <wi-url> [--all] [--filter <substr>]

# Print one field's raw value (use for an edit round-trip)
node index.js wi field <wi-url> <fieldRef>

# Set ANY field by reference name (HTML/plain). Prefer --body-file for HTML.
node index.js wi set-field <wi-url> <fieldRef> ["<value>"]
node index.js wi set-field <wi-url> <fieldRef> --body-file <path>
node index.js wi set-field <wi-url> <fieldRef> --body-file <path> --from-markdown
node index.js wi set-field <wi-url> <fieldRef> --body-file <path> --verify [--against <path>]
node index.js wi set-field <wi-url> <fieldRef> --body-file <path> --dry-run
node index.js wi set-field <wi-url> <fieldRef> --allow-empty       # clear a field
```

> **`--from-markdown` — author in Markdown, store field HTML.** Converts the body with the
> **`field` profile**: no `style=` attribute anywhere and every pipe table rendered as a `<ul>`,
> because the work-item form strips inline styles and renders tables inconsistently. This is a
> *different* profile from the one `wi comment` uses (which keeps a styled `<table>` — the
> discussion pane renders that fine). Same source, two surfaces, two outputs.
>
> **A multi-line field write that still carries raw Markdown is refused**, before the request is
> sent and before a `--dry-run` preview claims success. The check runs in `lib/workitem.js`
> (`assertRenderableFieldValue`), not in the CLI, so a one-off script calling `setField` /
> `createWorkItem` directly is covered too — a guard that only exists one layer above the API is
> a guard that scripts skip. It rejects inline `style=`, `<table>`, raw Markdown
> headings/bold/bullets, code fences and emoji, and each rejection names a remedy. Single-line
> values are never inspected. Override with `--force` (CLI) or `{ force: true }` (lib) once you
> have decided the body is right as-is.

##### `--verify` — refuse a rewrite that loses a fact

```bash
# Compare the draft against the field's CURRENT live value
node index.js wi set-field <wi-url> Custom.RootCause --body-file ./draft.html --verify

# Compare against a local baseline instead (an offline report, a wiki page)
node index.js wi set-field <wi-url> Custom.RootCause --body-file ./draft.html \
  --against ./previous.html
```

A rewrite that reads better can silently drop a number, a quoted value, a link or a
`!id`/`#id` reference. Prose review does not catch that; a machine comparison does. Facts
are compared as a **multiset** over four categories — numbers, `!id`/`#id` references,
links, and `"quoted"` spans — with HTML stripped from both sides, so a pure markup change
is not read as a content change. Losing one of three identical numbers still fails.

The verdict goes to stderr:

```
verify "Custom.RootCause": 4120 -> 3980 chars
  ✗ numbers present now and missing from the draft: 500, 22838
  ✗ table — tables render inconsistently — use a <ul> list.
```

Nothing is written on a failed verdict; `--force` proceeds anyway.

> ⚠️ **The truncation trap.** Azure silently truncates a long field value at exactly 8192
> bytes. A baseline that comes back at exactly that length is almost certainly cut, so
> fact-loss checking is **skipped** and said so loudly — comparing against a cut value would
> invent losses and the check would lie with confidence. Read the field in the browser
> before overwriting it.

Examples:
```bash
node index.js wi layout https://dev.azure.com/contoso/MyBoard/_workitems/edit/65130
#   "Root Cause"  ->  Custom.RootCause
#   "Test Reproduction Steps"  ->  Microsoft.VSTS.TCM.ReproSteps
node index.js wi set-field https://dev.azure.com/contoso/MyBoard/_workitems/edit/65130 \
  Custom.RootCause --body-file root-cause.html
```

> Long-form fields like `Microsoft.VSTS.TCM.ReproSteps` and rich-text `Custom.*` controls are
> **HTML** fields — confirm with `GET /_apis/wit/fields/<ref>` → `type: html`. Write HTML for
> these: Markdown written into an HTML field is stored literally and its special chars get
> escaped (e.g. `"` → `&quot;`), so it renders as raw text.
> Check the field type (`wi layout` shows the control, or inspect an existing value with
> `wi field`) before writing, so your formatting renders instead of showing as literal text.

---

#### List work item comments

```bash
node index.js wi comments <wi-url>           # rendered, with [1]/[2] display indices
node index.js wi comments <wi-url> --ids      # one line per comment: id=<n> author date (newest first)
node index.js wi comments <wi-url> --raw      # dumps the raw HTML source of each comment
```

Lists all comments with author and date. Use `--ids` to get the real comment IDs needed by
`wi edit-comment`, and `--raw` to retrieve the exact HTML before editing it.

---

#### Add a comment to a work item

```bash
node index.js wi comment <wi-url> --body-file ./update.html
node index.js wi comment <wi-url> --body-file ./update.md
node index.js wi comment <wi-url> --body-file ./root-cause.html --field Custom.RootCause  # route into a field instead
node index.js wi comment <wi-url> --body-file ./update.html --as-comment                 # post even though fields exist
```

Work item comments require `--body-file`. Inline text arguments are not supported.

##### Field-routing gate

Analysis (root cause, solution, requirements) belongs in a work item's **dedicated
custom fields**, not in a loose comment. So `wi comment` runs a pre-flight check: if the
target WI has long-form custom fields (rich-text / multiline `Custom.*` controls such as
`Root Cause` → `Custom.RootCause` or `Implemented Solution` →
`Custom.ImplementedSolution`), it **lists them and stops without posting**:

```
Work item #1234 (Bug) has content fields that may be the right home for this text:

  "Root Cause"            ->  Custom.RootCause            [empty]
  "Implemented Solution"  ->  Custom.ImplementedSolution  [empty]

Root-cause / solution / analysis usually belongs in a field, not a comment. Choose one:
  --field <ref>    put this body into that field (e.g. --field Custom.RootCause)
  --as-comment     post it as a plain comment anyway
```

Then decide explicitly:

- **`--field <ref>`** — route the `--body-file` into that field (same as `wi set-field`, one call).
- **`--as-comment`** (alias `--force`) — post it as a plain comment anyway (progress notes, QA
  instructions, discussion — content that genuinely *is* a comment).

Work items with no long-form custom fields (most Tasks/PBIs) post with no friction. The check is
**generic** — it reads the WIT's form layout via the process API, so it works on any work item type
in any project and any process. If the layout can't be fetched, the check is skipped rather than
blocking a legitimate comment. This makes the routing decision **tool-enforced and agent-agnostic**:
every caller is confronted with the field options, instead of relying on remembering them.

Azure DevOps renders WI comments as **HTML**. The tool accepts either an HTML file or a Markdown file; Markdown is converted to HTML automatically. For polished delivery notes, write HTML directly. For quick updates, Markdown is fine.

##### HTML formatting reference

Use these tags when writing HTML directly:

- **Line breaks:** use `<br>` (not bare newlines; they collapse in the rendered view).
- **Headings:** use `<h2>` and `<h3>` instead of Markdown `##`/`###`.
- **Bold:** use `<strong>`.
- **Inline code / field names / paths:** use `<code>`.
- **Code blocks:** use `<pre><code>...</code></pre>`.
- **Lists:** use `<ul>` + `<li>`.
- **Dividers:** use `<hr>`.
- **Pull-request links:** in work items, the `!id` shorthand does **not** auto-link. Use an explicit `<a>` tag:
  ```html
  <a href="https://dev.azure.com/contoso/Contoso%20Labs/_git/my-repo/pullrequest/21412"><strong>!21412</strong></a>
  ```
- Work items and changesets *do* auto-link with `#id`, so plain `#id` is fine in prose.

##### Markdown convenience

If you pass a Markdown file via `--body-file`, it is converted to HTML automatically. The conversion supports headings, bold, inline code, fenced code blocks, lists and horizontal rules. It is intended for quick updates; for polished delivery notes, prefer writing HTML directly.

> **Note:** Markdown files and inline Markdown are converted to HTML. Files that already contain HTML tags are detected and passed through unchanged (newlines are normalized).

---

#### Edit a work item comment in place

```bash
# find the comment id first
node index.js wi comments <wi-url> --ids
node index.js wi edit-comment <wi-url> <commentId> --body-file ./update.html
node index.js wi edit-comment <wi-url> <commentId> --body-file ./update.md
```

Edits require `--body-file` with HTML or Markdown. Inline text arguments are not supported. Get `<commentId>` from `wi comments --ids`, and grab the current HTML with `wi comments --raw` so you can edit it minimally. Preserve the same HTML tags listed above.

---

#### Delete a work item comment

```bash
node index.js wi delete-comment <wi-url> <commentId>
```

Removes a comment (Azure soft-deletes it — it disappears from the thread view). Get
`<commentId>` from `wi comments --ids`. Useful when content was moved into a structured
custom field (e.g. `Root Cause` / `Implemented Solution` via `wi set-field`) and the loose
comment is now redundant. Prefer custom fields over comments when the work item type exposes
them — run `wi layout` first to discover the field reference names.

---

#### Change a work item's state

```bash
node index.js wi set-state <wi-url> "Code Review"
```

Sets `System.State`. The value must be one of the states that work item type actually defines
(a custom process can name them anything — `To Do`, `In Progress`, `Code Review`, `Done`, …)
or the API rejects it. A rejected transition is preflighted and reports the blocking field
and its allowed values rather than a bare rule error.

---

#### Link a pull request to a work item

```bash
node index.js wi link-pr <wi-url> <pr-url>
```

Adds an ArtifactLink relation from the work item to an existing PR (the same link
`pr create --work-items` creates at creation time). Resolves the PR's project/repo ids
automatically. Works across projects in the same org.

---

#### Create a child Task

```bash
node index.js wi create-task <parent-url> "<title>" \
  [--estimate <hours>] [--desc "<text>"] [--assignee <email>] [--activity <name>]
```

Creates a `Task` linked as a child (`System.LinkTypes.Hierarchy-Reverse`) of the
parent work item (PBI/Bug). The new Task **inherits the parent's Area Path,
Iteration Path, and Assignee** unless `--assignee` overrides it.

- `--estimate <hours>` sets both `OriginalEstimate` and `RemainingWork` (hours).
- `--desc "<text>"` sets `System.Description`.
- `--activity <name>` sets `Microsoft.VSTS.Common.Activity`. **Defaults to `Development`**
  because some processes have a rule that makes Activity required —
  creating a Task without it fails with `TF401320: Rule Error for field Activity`.

Example — break a PBI into child tasks:
```bash
node index.js wi create-task https://dev.azure.com/contoso/MyBoard/_workitems/edit/64898 \
  "[A] CrmJobService: TimerTrigger" --estimate 4 --desc "Create the TimerTrigger function..."
```

---

#### Set / update an estimate

```bash
node index.js wi set-estimate <wi-url> <hours>
```

Sets `OriginalEstimate` and `RemainingWork` (hours) on an existing work item.
Use this instead of an inline `node -e` PATCH — the PAT stays inside the tool and is
never exposed on the command line (inline PATs get blocked as credential leaks).

> ⚠️ **This is the *opening* move, not the closing one.** `set-estimate` writes
> `OriginalEstimate` + `RemainingWork` — it never touches `CompletedWork`, despite a name that
> reads like it might. To **close** a task use `wi complete <wi-url|id> --hours N`, which sets
> `CompletedWork = N` and `RemainingWork = 0`. Boards that require `CompletedWork` to reach
> `Done` (`Task`, and `Bug Task`) will reject the transition if you only ran `set-estimate`.

---

#### `wi complete` — close a task with the work it took

```bash
node index.js wi complete <wi-url|id> --hours 6
node index.js wi complete <wi-url|id> --hours 6 --dry-run
```

Sets `CompletedWork = n` and `RemainingWork = 0` — the closing move to `set-estimate`'s
opening one. A board that gates `Done` on `CompletedWork` rejects the transition until this
has run.

> Pass `--hours 0` when the task was closed without delivery. The record should not claim
> work that did not happen.

---

#### `wi missing` — which fields the form declares but the item never answered

```bash
node index.js wi missing <wi-url|id>            # custom long-form controls (default)
node index.js wi missing <wi-url|id> --all      # every control on the form
node index.js wi missing <wi-url|id> --json
```

The API omits empty fields entirely, so `wi fields` cannot answer "what is unanswered?" —
this joins the **form layout** to the current values and reports three states:

```
#1234 (Bug) — 2 answered, 1 empty, 1 placeholder.

EMPTY:
  "Implemented Solution"  ->  Custom.ImplementedSolution

PLACEHOLDER (counts as filled on the board, says nothing):
  "Root Cause"  ->  Custom.RootCause
```

`placeholder` is reported separately on purpose: a field holding a lone `.`, `-`, `n/a`,
`tbd` or `none` reads as filled everywhere else on the board while saying nothing.

---

#### List attachments

```bash
node index.js wi attachments <wi-url>
```

Output: index, name, comment, download URL for each attachment.

---

#### Attach a file

```bash
# Preview only — nothing is uploaded
node index.js wi attach <wi-url|id> ./report.pdf

# Actually attach it, with a comment describing what it is
node index.js wi attach 66360 ./report.pdf --comment "Analysis of 2026-09-17"  --yes

# Store it under a different name on the item
node index.js wi attach 66360 ./out/final.pdf --name "Royalties-66360.pdf" --yes
```

An upload is a write everyone watching the item sees, and removing the link does not
remove the blob, so the command **previews unless `--yes`** — the preview names the
target item, the resolved project, the byte count and the attachments already there.

Two behaviours worth knowing:

- **The project comes from the work item, not from your config.** A bare id would
  otherwise resolve to whatever `config --project` was last set to, and uploading the
  blob under one project while the item lives in another fails confusingly. The command
  reads the item's `System.AreaPath` and uses its root; `projectSource` in the preview
  says which it used.
- **A name already on the item is refused.** Azure accepts duplicate attachment names
  without complaint, and then `wi download <name>` silently resolves to whichever copy
  comes first. Rename with `--name`, or pass `--allow-duplicate` when you really do
  want two.

Refused before any bytes are sent: a missing file, a directory, a 0-byte file (Azure
stores it and the item shows an attachment that downloads as nothing), a file over
**60 MB**, and an item that already holds **100** attachments. Those last two are Azure
DevOps Services limits and are not raisable, so spending the upload first only buys a
rejection. (The 130 MB in the REST reference is the chunked-upload threshold, not the
attachment cap — it applies to an on-prem Server whose limit was raised.)

Also refused: `--name` on `wi download`, where the selector is positional. Left
accepted-and-ignored it would silently fetch a different file.

| Flag | Effect |
|---|---|
| `--yes` | Actually upload. Without it the command previews and exits 0. |
| `--name <n>` | Name on the work item (default: the file's basename). |
| `--comment "<text>"` | Attachment comment, shown next to the name in `wi attachments`. |
| `--allow-duplicate` | Permit a name that is already attached. |
| `--json` | Print `{ id, url, name, relations }` instead of the human line. |

---

#### Download an attachment

```bash
# Download by index (1-based)
node index.js wi download <wi-url> 1

# Download by exact file name
node index.js wi download <wi-url> "screenshot.png"

# Specify output directory
node index.js wi download <wi-url> 1 --out ./downloads
```

If the work item has only one attachment, the selector can be omitted.

---

#### `wi updates` — how the item moved (state history)

```bash
# Every System.State transition on one item
node index.js wi updates <wi-url|id> [--project <p>]

# Track a different field
node index.js wi updates <wi-url|id> --field System.IterationPath

# Discovery: every field every revision touched
node index.js wi updates <wi-url|id> --all-fields

# How long it sat in each state (the open one is measured to now)
node index.js wi updates <wi-url|id> --time-in-state

# When did it first/last reach a given state?
node index.js wi updates <wi-url|id> --entered "Ready for Test"

# Bulk: one TSV row per transition, across many items
node index.js wi updates --ids 61683,62845,63049 --project <p>
node index.js wi updates --ids @sprint-ids.txt --project <p> > transitions.tsv
```

| Flag | Meaning |
|---|---|
| `--field <ref>` | Field to track. Default `System.State`. |
| `--all-fields` | Every changed field, every revision. Use to find which field carries the signal. |
| `--time-in-state` | Spans per value, in days. The final span is open and measured against now. |
| `--entered "<v>"` | Just the first and last time the field took that value. |
| `--ids <a,b,c\|@file>` | Bulk mode. `@file` accepts ids separated by newlines, spaces or commas. Needs `--project`. |
| `--json` | Machine output for every mode above. |

**Why this exists.** A work item carries only its *current* state. Every question about the path it
took — cycle time, how often it bounced back, when it reached QA, whether it arrived before the
sprint ended — has to come from the revision feed, and there is no other way to get it.

Bulk output is a TSV (`id · at · from · to · by`) designed to be piped straight into `awk`/`sort`:

```bash
node index.js wi updates --ids @ids.txt --project <p> \
  | awk -F'\t' '$3=="Ready for Test" && $4=="In Test"' | wc -l
```

Two things the raw feed will trip you on, both handled here: a revision that rewrites a field with
the **same value** is not a transition (counting those inflates every total), and Azure stamps the
newest revision with a **year-9999** date meaning "still current", which is reported as no date
rather than making every open item look 8000 years old.

> Scope the call to the project the item lives in. The org-level `workItems/{id}/updates` endpoint
> can return a truncated history for an item that moved between projects — `--project` (or a
> configured default) avoids it.

#### `wi relations` — typed links on a work item (the ticket→code bridge)

Lists a work item's relations with the `vstfs:///` artifact URLs **decoded**: linked PRs,
commits and branches come back as usable ids (`pr 21308  repo=<repoId>`), not opaque URIs.
This is the first step of any ticket→code measurement — from here, `pr get` / `pr diff`
take over.

```bash
# One item, human-readable
node index.js wi relations 64891 --project Platform

# Only the PR links
node index.js wi relations 64891 --project Platform --type pr

# Bulk: one TSV row per relation (id, kind, target, repoId, name).
# Uses workitemsbatch ($expand=relations, errorPolicy omit): 200 ids per API call.
node index.js wi search --project Platform --json --wiql "SELECT [System.Id] FROM WorkItems WHERE …" \
  | jq -r '.[].id' > ids.txt
node index.js wi relations --ids @ids.txt --project Platform --type pr > links.tsv
```

Kinds: `pr`, `commit`, `branch`, `build`, `parent`, `child`, `related`, `duplicate`,
`duplicate-of`, `successor`, `predecessor`, `attachment`, `hyperlink`; an unknown `rel`
passes through verbatim rather than being dropped. `--type` takes a comma list of kinds.
Ids missing from the batch response (deleted, or living in another project) are reported
on stderr, never silently dropped — the same lesson as `wi updates --project`.

---

---

### `sprints` — Iterations and their dates

```bash
node index.js sprints <project> [--team <t>] [--filter <pattern>] [--depth <n>] [--current] [--json]

# Every iteration whose path matches
node index.js sprints Fabrikam --filter "Sprint Corp"

# Only the ones containing today
node index.js sprints Fabrikam --current

# One team's subscribed sprints, rather than everything defined in the project
node index.js sprints Fabrikam --team "Fabrikam Team"
```

| Flag | Meaning |
|---|---|
| `--team <t>` | Switch source: the flat list one team subscribed to, instead of the project tree. |
| `--filter <p>` | Case-insensitive regex; retried as a literal substring if it matches nothing. |
| `--depth <n>` | Tree depth. Default 4 (project → release → sprint → sub). |
| `--current` | Keep only iterations whose window contains today, boundaries inclusive. |
| `--json` | `[{ path, name, start, finish }]`. |

Alias: `iterations`.

Sprint **dates live here and nowhere else** — a work item carries only its `IterationPath` string,
so any "was this delivered inside the sprint?" question needs this command to supply the window.
Paths are printed backslash-separated exactly as `System.IterationPath` stores them, so a row can be
pasted straight into a WIQL `UNDER` clause.

> `--filter` tries regex first and falls back to a literal substring. That matters because a pasted
> path like `Fabrikam\2026\Sprint 1` is *valid* regex that silently matches nothing (`\2` is a
> backreference, `\S` is non-whitespace) — the fallback is what makes pasting a path work.

An undated node is normal, not an error: folders exist purely to group sprints and print as
`(undated)`.

---

### `build` — Pipeline build operations

List, inspect, and **re-run** pipeline builds. Generic across every project pipeline: a
re-run replays the source build's runtime variables (`parameters`) and `templateParameters`
verbatim — a pipeline **with** variables (e.g. `ui-customer`: `clientName`, `platformName`,
`deployMode`…) is replayed with those exact values; a pipeline **without** variables just
re-queues with none. Requires `--project` (or a configured default / `AZURE_PROJECT`).

```bash
# Recent builds on a branch (newest first)
node index.js build list --project Platform --branch features/1234-new-widget --top 10

# Filter by pipeline (name or numeric id) and/or repo; --json for raw objects
node index.js build list --project Platform --definition web-ui --repo web-ui --json

# Most-recent build matching the filters — full detail incl. its variables
node index.js build last --project Platform --branch features/1234-new-widget --definition web-ui

# Re-run the latest build on a branch with the SAME config/variables.
# Previews by default (dry run); add --yes to actually queue.
node index.js build rerun --project Platform --branch features/1234-new-widget --definition web-ui
node index.js build rerun --project Platform --branch features/1234-new-widget --definition web-ui --yes

# Re-run one specific build id
node index.js build rerun 40587 --project Platform --yes

# Re-run the same config against a different ref
node index.js build rerun 40587 --project Platform --branch releases/rc/202606_1 --yes
```

Notes:
- **`rerun` is a write** (it triggers CI). It previews the payload and does nothing unless you pass
  `--yes`.
- Without a `<buildId>`, `rerun` resolves the latest build matching `--branch`/`--definition`/`--repo`,
  fetches its full config, and re-queues it — so the new run picks up the branch's current HEAD.
- `--branch` accepts a short name (`features/x`) or a full ref (`refs/heads/features/x`).
- The Build REST API has no repo filter, so `--repo` narrows results client-side by repository name.

---

### `repo` — Repository metadata and refs

```bash
node index.js repo list [--project <p>] [--json]                        # omit --project only if no default is configured
node index.js repo get  <name|repo-url> [--project <p>] [--json]
node index.js repo refs <name|repo-url> [--filter heads/<b>] [--json]
```

These come up constantly in promotion and merge-back flows — resolve a repo's default branch before
targeting a PR, confirm a source branch exists before creating one, get the repo **id** (several
repo-property writes reject the name and only accept the id).

`repo get` prints exactly the fields callers use:

```
Web  (Fabrikam)
  id             abc-1234-…
  defaultBranch  main
  size           12286251 bytes
  disabled       false
  remoteUrl      https://…/_git/Web
  webUrl         https://…/_git/Web
```

**Does a branch exist?** Ask `repo refs` and read the count — an empty result is the answer:

```bash
node index.js repo refs Web --project Fabrikam --filter heads/release/2026-06
# 0 ref(s) …  → the branch does not exist
```

Gotchas:
- **`repo list` without `--project` sweeps the org only when no default project is set.** It falls
  back to the configured `project` (or `AZURE_PROJECT`), so on a configured machine it silently lists
  one project and a repo that lives elsewhere looks like it does not exist. Enumerate projects with
  `whoami`, then `repo list --project "<p>"` for each.
- **A wrong `--project` reads as "does not exist", never as "wrong project".** Repo names, pipeline
  definition names and bare PR/WI ids are all resolved *inside* a project:
  `repo get "<r>" --project <wrong>` → `HTTP 404 … TF401019: The Git repository with name or
  identifier <r> does not exist or you do not have permissions…`, and
  `build last --definition "<d>" --project <wrong>` → `No pipeline definition named "<d>" in project
  <wrong>`. Before concluding something was deleted, confirm which project owns it.
- **Changing a repo's default branch is a repo-property PATCH and needs the repo *id* in the URL,
  not the name** — by name the API returns a misleading `HTTP 400 "The request is invalid."` (not a
  404). Body: `{ "defaultBranch": "refs/heads/main" }`. Get the id from `repo get`. It also requires
  the Git **`RenameRepository`** ("Edit repository properties") permission on that repo — the *Code
  Full* PAT scope is not enough if the identity lacks the ACL (fails `403 TF401027`).
- **Bulk creation/linking** (`pr create`, `wi link-pr`) is one-at-a-time. For fan-out — one PR per
  repo across a sprint's release branches — script over `lib/`, reusing the transport and the
  configured PAT so the secret never reaches a command line:

```js
// require by absolute path to your azure-connector folder (<AZC>), or a path relative to your script
const { request } = require('<AZC>/lib/api.js');
const { loadConfig } = require('<AZC>/lib/config.js');
const cfg = loadConfig(); const base = `${cfg.baseUrl}/${cfg.org}`;
const enc = encodeURIComponent;

// active PRs source->target (dedup before creating)
const prs = await request(`${base}/${enc(project)}/_apis/git/repositories/${enc(repoName)}/pullrequests?searchCriteria.status=active&searchCriteria.sourceRefName=${enc('refs/heads/'+src)}&searchCriteria.targetRefName=${enc('refs/heads/'+tgt)}&api-version=7.1`, { pat: cfg.pat });
```

---

## Agent recipes — measuring a team from the board

Three end-to-end pipelines. Every step is a **read**; nothing here writes to Azure DevOps. Measure
per sprint and per demand — the numbers below are about a *process*, and none of them are a
per-person productivity metric.

**1. Throughput by month and work-item type.** Did the queue actually grow, and of what?

```bash
node index.js wi search --project "<project>" --json --fields System.WorkItemType,System.State,Microsoft.VSTS.Common.ClosedDate \
  --wiql "SELECT [System.Id] FROM WorkItems
          WHERE [System.AreaPath] UNDER '<project>\\<area>'
            AND [System.State] = 'Done'
            AND [Microsoft.VSTS.Common.ClosedDate] >= '2025-09-01'" \
  > done.json
# then group by month × type
```

A field trap worth knowing: the closed date lives in `Microsoft.VSTS.Common.ClosedDate`.
`System.ClosedDate` does **not** exist in the stock processes, and a WIQL naming it fails — so
don't "simplify" the example above, and don't substitute `System.ChangedDate`, which moves on
any edit. Custom fields go by their reference name, which `wi layout` discovers.

Watch for a **taxonomy change** mid-window: if the team started filing "Support Request" where it
used to file "Bug", a bug count that falls is not quality improving. Group by type before concluding
anything.

**2. When work actually reached the next stage.** The sprint window comes from `sprints`, the
arrival moment from `wi updates`.

```bash
node index.js sprints "<project>" --filter "<sprint prefix>" --json > sprints.json
node index.js wi search --project "<project>" --json --wiql "…" | jq -r '.[].id' > ids.txt
node index.js wi updates --ids @ids.txt --project "<project>" > transitions.tsv

# how many items reached test in the last 2 days of the sprint, or after it closed?
awk -F'\t' '$4=="<ready-for-test state>"' transitions.tsv
```

`--entered "<state>"` gives the same answer for a single item.

**3. Is the repo actually being reviewed?**

```bash
node index.js pr timeline --repo <r> --project <p> --status all --top 100
```

Read the `NO vote` line first. A high count means merges are not being reviewed at all, which is a
different problem from *slow* review and needs a different fix — and it is invisible in any per-PR
view.

**4. Release cadence that survives history cleanup.** Build **records** may be retained for as
little as 30 days (the org maximum is 731), so counting build records months back silently
undercounts. The build **number** (`AAAAMMDD.N`) encodes the date and a daily sequence and is
carried by whatever records survive retention — measure cadence from the numbers (max `N` per
date), never from the record count:

```bash
node index.js build list --project "<p>" --definition "<pipeline>" --top 200 --json \
  | jq -r '.[].buildNumber'
# 20260830.2 = at least 2 packages generated on 2026-08-30.
# This measures packages BUILT, not production deployments.
```

> **A caution that belongs with the numbers.** Commit counts, PR counts and transition counts
> measure activity, not value. They are sound for spotting a *process* failure (no reviewers, work
> arriving after the sprint closed, a state nobody uses) and unsound as a measure of an individual.
> If a metric here is about to be attached to a person's name, that is the moment to stop.

---

## URL formats

| Resource | URL pattern |
|---|---|
| Pull Request | `https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{prId}` |
| Work Item | `https://dev.azure.com/{org}/{project}/_workitems/edit/{id}` |

URL-encoded project/repo names are handled automatically (e.g. `Contoso%20Labs`).

> **PowerShell note:** `%20` and other `%xx` sequences in URLs are expanded by PowerShell before
> reaching this native tool. Double the percent signs (`%%20`) or put the command in a `.bat` file.
> If calls fail with HTTP 400 / "project does not exist", the URL was likely mangled.

---

## Azure DevOps API reference

All calls use API version `7.1`. Key endpoints used:

| Operation | Method | Endpoint |
|---|---|---|
| Validate PAT / identity | GET | `/_apis/connectionData` (returns `authenticatedUser`; anonymous = bad PAT) |
| Get PR | GET | `/_apis/git/repositories/{repo}/pullRequests/{prId}` |
| Update PR (desc/title) | PATCH | `/_apis/git/repositories/{repo}/pullRequests/{prId}` |
| List PR threads | GET | `/_apis/git/repositories/{repo}/pullRequests/{prId}/threads` |
| Add PR thread | POST | `/_apis/git/repositories/{repo}/pullRequests/{prId}/threads` |
| Edit PR comment | PATCH | `/_apis/git/repositories/{repo}/pullRequests/{prId}/threads/{threadId}/comments/{commentId}` |
| Get work item | GET | `/_apis/wit/workItems/{id}?$expand=all` |
| List WI comments | GET | `/_apis/wit/workItems/{id}/comments` |
| Add WI comment | POST | `/_apis/wit/workItems/{id}/comments` |
| Edit WI comment | PATCH | `/_apis/wit/workItems/{id}/comments/{commentId}` |
| Create work item | POST | `/_apis/wit/workitems/${type}` (JSON Patch body) |
| Update work item | PATCH | `/_apis/wit/workItems/{id}` (JSON Patch body) |
| Upload attachment | POST | `/_apis/wit/attachments?fileName=...` (raw bytes, `application/octet-stream`) |
| Link attachment | PATCH | `/_apis/wit/workItems/{id}` (JSON Patch, `AttachedFile` relation) |
| Download attachment | GET | attachment URL from work item relations |
| Work item change history | GET | `/_apis/wit/workItems/{id}/updates` (paginated `$top`/`$skip`) |
| Iteration tree | GET | `/_apis/wit/classificationnodes/iterations?$depth=N` |
| Team iterations | GET | `/{team}/_apis/work/teamsettings/iterations` |
| List repos | GET | `/_apis/git/repositories` (project optional — omit for the whole org) |
| Repo metadata | GET | `/_apis/git/repositories/{repo}` |
| List refs | GET | `/_apis/git/repositories/{repo}/refs?filter=heads/{branch}` |

---

## File structure

```
azure-connector/
├── index.js          # CLI entry point and command router
├── package.json
├── README.md         # this guide
├── AGENTS.md         # operating contract for agents/scripts: flags, exit codes, guards
├── test/
│   ├── connector.test.js   # unit tests (node:test)
│   ├── analytics.test.js   # unit tests for the measurement helpers
│   └── guardrails.test.js  # unit tests for the pre-write guards
└── lib/
    ├── config.js     # PAT/org config, URL parser
    ├── api.js        # HTTP transport (no external deps)
    ├── pr.js         # Pull request operations + review timeline / vote events
    ├── workitem.js   # Work item operations, attachment upload/download, change history
    ├── iteration.js  # Iterations (sprints) and their date windows
    ├── repo.js       # Repository metadata and refs
    ├── build.js      # Pipeline build list/last/rerun (generic variable replay)
    ├── links.js      # Canonical Azure DevOps URLs and reference lines
    ├── verify.js     # Fact-loss and unrenderable-markup checks
    └── format.js     # Pretty-print helpers
```

## Tests

```bash
npm test   # or: node --test
```

Unit tests (Node built-in `node:test`, no network, no PAT). `connector.test.js` covers `parseArgs`,
`normalizeAzureRepoPath` (MSYS path de-mangling), `parseUrl`, `buildThreadBody` (inline-anchor
threadContext, right/left side), `markdownToHtml` / `stripHtml`, `loadConfig` profile resolution,
and the `build` helpers `normalizeBranchRef` / `buildRerunPayload` (generic variable replay, incl.
pipelines with no variables) / `summarizeBuild`.

`analytics.test.js` covers the measurement helpers behind `wi updates`, `wi relations`,
`sprints`, `pr timeline` and `repo`. Anything that needs the clock takes `now` as an **argument** rather than reading it —
that is what keeps the suite deterministic and what lets an old measurement be re-run and produce
the same numbers. The cases worth knowing about are the ones asserting what must *not* count: a
same-value rewrite is not a state transition, a year-9999 date is no date, a human comment reading
"Bob voted 10" is not a vote, and a cleared vote (`0`) is not a review.

`guardrails.test.js` covers the checks that run before a write: inline-anchor duplicate
detection, head-movement detection, project resolution from an Area path, the canonical link
lines, and the field-write verifier (fact loss as a multiset, unrenderable markup, and the
8192-byte truncation signature that makes a fact-loss comparison meaningless).
