# azure-connector

A zero-dependency Node.js CLI for Azure DevOps — pull requests (create, describe, comment, edit), work items (PBI/Bug/Task reading, commenting, editing, state, tasks), attachment download, wiki, and pipeline builds. Multi-org via profiles; a raw REST passthrough for anything not yet wrapped.

Built as a fallback for when the MCP azure-devops integration is unavailable or unreliable.

---

## ⚠️ Formatting: work items and pull requests are different surfaces

Work-item content and pull-request content render with **different engines** and live at
**different URLs** — treat them as independent artifacts. Do **not** reuse one body for the other,
and do not let an edit on one side propagate to the other unless explicitly intended.

| Surface | Renders as | Write | Edit with |
|---|---|---|---|
| **WI custom fields** (`Custom.CausaRaiz`, `Custom.RequisitosFuncionaisImplementados`, `Microsoft.VSTS.TCM.ReproSteps`, …) | **HTML** | HTML | `wi set-field` |
| **WI comments** | HTML (rendered by Azure) | **Markdown only** — this CLI runs the `--body-file` through a Markdown→HTML converter | `wi comment` / `wi edit-comment` |
| **PR description** | **Markdown** | Markdown | `pr create` / `pr set-desc` |
| **PR comments** | **Markdown** | Markdown | `pr comment` / `pr edit-comment` |

- WI **fields** and WI **comments** take **opposite** input formats — don't mix them up:
  - **WI field** = write real **HTML** tags (`<strong>`, `<code>`, `<ul>`, `<pre>`, `<a href>`, `<br>`).
    Markdown written into an HTML field is stored literally and its special chars are escaped
    (e.g. `"` → `&quot;`, `**bold**` stays as asterisks) — it renders as raw text.
  - **WI comment** = write **Markdown**. Raw HTML fed to `wi comment`/`wi edit-comment` is
    HTML-escaped by the converter and shows literally (`<strong>` → `&lt;strong&gt;`, and any
    `&entity;` double-escapes to `&amp;entity;`). Use `**bold**`, `` `inline code` ``, `-` lists,
    and fenced code blocks (```` ``` ````) — the converter emits a proper `<pre><code>` block and
    drops the opening-fence info string (e.g. ```` ```ts ````).
- HTML written into a **Markdown** PR body can render as raw tags. Write Markdown there.
- Keep a separate body file per surface (e.g. `causa-raiz.html` for a WI field vs `pr-body.md` for a PR).
- Verify a field's engine before writing: `GET /_apis/wit/fields/<ref>` → `type` (`html` / `plainText` / …),
  or `wi layout` / inspect an existing value with `wi field`.

> **Escalation policy (comment formatting/styling).** WI-comment formatting is produced by the
> hand-rolled `markdownToHtml` in `lib/workitem.js` (Markdown → HTML; used **only** by
> `wi comment`/`wi edit-comment` — the PR path sends raw Markdown and must stay untouched).
> On the **next** formatting/styling failure, do **not** add more regex to that converter —
> swap in a maintained library instead:
> - **Write path (author MD → send HTML):** replace `markdownToHtml` with **`marked`** or
>   **`markdown-it`** behind the same function signature (drop-in). This is the fix for garbled
>   **outgoing** comments (bold/code/lists/tables/links).
> - **Read/display path (fetched HTML → terminal MD):** use **`turndown`**
>   (<https://github.com/mixmark-io/turndown>) to render `wi comments`/`pr comments` output —
>   turndown is HTML→Markdown, so it does **not** help the write path.
> Trade-off to accept: either library adds the tool's **first runtime dependency** (today it is
> zero-dep, Node built-ins only — see Requirements). That's the deliberate cost of retiring the
> regex converter; take it rather than patching regex again.

---

## Requirements

- Node.js 18+
- No `npm install` needed — uses only Node built-ins (`https`, `fs`, `path`, `url`)

---

## Setup

```bash
# Make the script executable (Linux/macOS/Git Bash)
chmod +x D:/fontes/claude-tools/azure-connector/index.js

# Optional: alias for convenience
alias azure-connector="node D:/fontes/claude-tools/azure-connector/index.js"
```

### Configure a PAT

An Azure DevOps Personal Access Token (scopes: *Code* Read/Write, *Work Items* Read/Write) is
required. Set it any one of these ways:

```bash
# Persist a PAT + org in ~/.azure-connector.json
node index.js config --pat <your-token> --org <your-org> --pat-valid-to 2027-04-16

# Set a default project so bare work item ids work
node index.js config --project "Kanban EL"

# Or use environment variables (highest priority)
export AZURE_PAT=<token>
export AZURE_ORG=<org>
export AZURE_PROJECT="Kanban EL"
export AZURE_BASE_URL=https://dev.azure.com
```

Config is saved to `~/.azure-connector.json` (override the path with `AZURE_CONFIG_FILE`).
Priority order: env vars → resolved profile → top-level config. Verify with `whoami`.

### Profiles (multiple orgs)

A PAT is scoped to a single Azure DevOps org, so multi-org support is one profile per org. Add a
`profiles` map (and an optional `defaultProfile`) to `~/.azure-connector.json`:

```jsonc
{
  "defaultProfile": "evuptec",
  "profiles": {
    "evuptec": { "org": "evuptec", "project": "EVUP", "pat": "...", "patValidTo": "2027-04-16" },
    "other":   { "org": "other-org", "patEnv": "AZURE_PAT_OTHER" }
  }
}
```

- A **PR/WI URL carries its org**, so `pr`/`wi`/… auto-select the matching profile — paste any org's
  URL and the right PAT is used, no flag.
- Other commands pick the profile from `--profile <name>`, `AZURE_PROFILE`, or `defaultProfile`.
- `pat` stores the token inline; **`patEnv` names an env var instead**, so no secret sits on disk —
  inject it at runtime (e.g. `vault run azure-pat=AZURE_PAT_OTHER -- node index.js ...`).
- A single top-level `{ pat, org, … }` with no `profiles` behaves exactly as one profile.

### Transient-failure retries

Every HTTP call retries transient failures with exponential backoff (~0.5s → 1s → 2s → 4s,
capped at 8s, plus jitter), so bursts of writes no longer fail on the first hiccup:

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
node index.js config --pat <new-token> --pat-valid-to 2028-01-31 --pat-name "PR analizer v2"
```

Expiry overrides via env: `AZURE_PAT_VALID_TO`, `AZURE_PAT_NAME`, `AZURE_PAT_WARN_DAYS`.

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
node index.js raw GET "/EVUP/_apis/git/repositories"
node index.js raw PATCH "/EVUP/_apis/git/repositories/<repo>" '{"defaultBranch":"refs/heads/main"}'
```

For any endpoint not yet wrapped. A `path` is appended to the org base (`https://dev.azure.com/<org>`); a full `https://` URL is used as-is. `api-version=7.1` is added unless the URL already has one. The body is inline JSON or `@file`. Auth, retry/backoff, and profile selection are shared with every other command.

> From Git Bash (MSYS), a leading-slash path like `/EVUP/...` is rewritten to a Windows path before Node sees it. Use a full URL, or run from PowerShell.

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
node index.js pr get <pr-url>
```

Example:
```bash
node index.js pr get https://dev.azure.com/evuptec/EVUP/_git/EVUP%20-%20ELOS/pullrequest/20687
```

Output: title, status, author, source/target branch, creation date.

---

#### Create a pull request

```bash
# Branches via flags, body from a file, link a work item
node index.js pr create "<repo-url>" \
  --source users/me/my-branch --target releases/rc/202606_1 \
  --title "[BUG 65019] Fix ..." --desc-file ./pr-body.md --work-items 65019

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
> the repo's `defaultBranch`, and beware: the default branch is not always `main` (e.g.
> `ELOS-SVC-COSTUMER` had its default pointing at a feature branch). Resolve it via the repo
> API before creating — see **Repo-level reads not exposed as commands** below.

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
node index.js pr list --project ELOS --repo ELOS-SVC-CRM --status completed --since 2026-06-01
node index.js pr list --project ELOS --repo ELOS-UI-CRM --status active --target releases/rc/202607_1 --top 20 --json
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
> Line numbers are the **new (right-hand) file** line numbers — pair this with `git-diff-analysis --output lines`, which emits exactly those.

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
node index.js pr set-desc <pr-url> "New description" --title "[BUG 65019] New title"
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
if needed. Used by the review-simulation harness to tear down throwaway PRs.

---

#### Show changed files / diff

```bash
# List changed files + stats (default)
node index.js pr diff <pr-url>

# Emit unified diffs instead of full source file contents
node index.js pr diff <pr-url> --patch
```

Without `--patch`, the command prints the file list and then the **full contents** of each changed
file from the source branch. With `--patch`, it fetches both the old (target branch) and new
(source branch) versions and emits a compact unified diff. Prefer `--patch` for code review.

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
node index.js wi get https://dev.azure.com/evuptec/EVUP/_workitems/edit/62576
node index.js wi get 64891 --project "Kanban EL"
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
node index.js wi search <project> [--title-contains <t>] [--type <t>] [--state <s>] \
  [--wiql "<query>"] [--fields <a,b,c>] [--json]
```

- `<project>` — the team project name (e.g. `"Kanban EL"`). Required.
- `--title-contains <t>` / `--type <t>` / `--state <s>` — convenience filters; the command
  builds the WIQL `WHERE` clause from them (single quotes are escaped for WIQL).
- `--wiql "<query>"` — supply a full WIQL query instead, overriding the filters above.
- `--fields <a,b,c>` — comma-separated field reference names to hydrate
  (default: `System.Id,System.Title,System.State,System.WorkItemType`).
- `--json` — machine-readable output (`[{ id, ...fields }]`); otherwise prints `id [state] title`.

Examples:
```bash
# All Features whose title contains "PN1" in the Kanban EL project
node index.js wi search "Kanban EL" --title-contains "PN1" --type Feature

# Same, as JSON, pulling description + acceptance criteria too
node index.js wi search "Kanban EL" --title-contains "PN1" --type Feature \
  --fields System.Id,System.Title,System.Description,Microsoft.VSTS.Common.AcceptanceCriteria --json

# Full control via raw WIQL
node index.js wi search "EVUP" --wiql "SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'Active'"
```

> Programmatic use: the underlying `searchWorkItems({ config, org, project, wiql, fields })`
> in `lib/workitem.js` is reusable from other Node scripts (returns the raw work item
> objects with the requested fields).

---

#### Discover & edit custom fields (`layout`, `fields`, `field`, `set-field`)

Custom processes (e.g. `ScrumAppEL` on `Kanban EL`) relabel and add fields — the UI
section "Causa Raiz" is backed by `Custom.CausaRaiz`, "Passo a Passo para Reprodução do
Teste" is `Microsoft.VSTS.TCM.ReproSteps`, etc. **Empty fields are not returned by the
API**, so you cannot discover an empty custom field from `wi get`/`wi fields` — use
`wi layout`, which reads the work item form definition.

> Rule of thumb: before editing or commenting on a work item, run `wi layout` to learn the
> real field reference names instead of guessing.

> **Fallback when the field doesn't exist (work items only):** work item *types* differ — a
> "Bug" may carry `Custom.CausaRaiz` / `Custom.RequisitosFuncionaisImplementados` while a
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

# Set ANY field by reference name (HTML/markdown/plain). Prefer --body-file for HTML.
node index.js wi set-field <wi-url> <fieldRef> ["<value>"]
node index.js wi set-field <wi-url> <fieldRef> --body-file <path>
node index.js wi set-field <wi-url> <fieldRef> --allow-empty       # clear a field
```

Examples:
```bash
node index.js wi layout https://dev.azure.com/evuptec/Kanban%20EL/_workitems/edit/65130
#   "Causa Raiz"  ->  Custom.CausaRaiz
#   "Passo a Passo para Reprodução do Teste"  ->  Microsoft.VSTS.TCM.ReproSteps
node index.js wi set-field https://dev.azure.com/evuptec/Kanban%20EL/_workitems/edit/65130 \
  Custom.CausaRaiz --body-file causa-raiz.html
```

> `Custom.CausaRaiz`, `Custom.RequisitosFuncionaisImplementados` ("Solução Implementada") and
> `Microsoft.VSTS.TCM.ReproSteps` are all **HTML** fields (verified via
> `GET /_apis/wit/fields/<ref>` → `type: html` on the ScrumAppEL process). Write HTML for these —
> Markdown written into an HTML field is stored literally and its special chars get escaped
> (e.g. `"` → `&quot;`), so it renders as raw text.
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
node index.js wi comment <wi-url> --body-file ./causa-raiz.html --field Custom.CausaRaiz  # route into a field instead
node index.js wi comment <wi-url> --body-file ./update.html --as-comment                 # post even though fields exist
```

Work item comments require `--body-file`. Inline text arguments are not supported.

##### Field-routing gate

Analysis (root cause, solution, requirements) belongs in a work item's **dedicated
custom fields**, not in a loose comment. So `wi comment` runs a pre-flight check: if the
target WI has long-form custom fields (rich-text / multiline `Custom.*` controls such as
`Causa Raiz` → `Custom.CausaRaiz` or `Solução Implementada` →
`Custom.RequisitosFuncionaisImplementados`), it **lists them and stops without posting**:

```
Work item #65488 (Bug) has content fields that may be the right home for this text:

  "Causa Raiz"            ->  Custom.CausaRaiz                          [empty]
  "Solução Implementada"  ->  Custom.RequisitosFuncionaisImplementados  [empty]

Root-cause / solution / analysis usually belongs in a field, not a comment. Choose one:
  --field <ref>    put this body into that field (e.g. --field Custom.CausaRaiz)
  --as-comment     post it as a plain comment anyway
```

Then decide explicitly:

- **`--field <ref>`** — route the `--body-file` into that field (same as `wi set-field`, one call).
- **`--as-comment`** (alias `--force`) — post it as a plain comment anyway (progress notes, QA
  instructions, discussion — content that genuinely *is* a comment).

Work items with no long-form custom fields (most Tasks/PBIs) post with no friction. The check is
**generic** — it reads the WIT's form layout via the process API, so it works on any work item type
in any project, not just EVUP Bugs. If the layout can't be fetched, the check is skipped rather than
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
  <a href="https://dev.azure.com/evuptec/VOE.IT%20-%20Espaco%20Laser/_git/EVUP%20-%20ELOS/pullrequest/21412"><strong>!21412</strong></a>
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
custom field (e.g. `Causa Raiz` / `Solução Implementada` via `wi set-field`) and the loose
comment is now redundant. Prefer custom fields over comments when the work item type exposes
them — run `wi layout` first to discover the field reference names.

---

#### Change a work item's state

```bash
node index.js wi set-state <wi-url> "Aguardando CodeReview"
```

Sets `System.State`. The value must match a valid state for the work item type
(e.g. for *Bug Task*: `To Do`, `In Progress`, `Aguardando CodeReview`, `Aguardando Terceiros`,
`Em HML`, `Done`, `Removed`) or the API rejects it.

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
  because some projects (e.g. `Kanban EL`) have a rule that makes Activity required —
  creating a Task without it fails with `TF401320: Rule Error for field Activity`.

Example — break a PBI into child tasks:
```bash
node index.js wi create-task https://dev.azure.com/evuptec/Kanban%20EL/_workitems/edit/64898 \
  "[A] CrmJobService: TimerTrigger" --estimate 4 --desc "Criar a TimerTrigger function..."
```

---

#### Set / update an estimate

```bash
node index.js wi set-estimate <wi-url> <hours>
```

Sets `OriginalEstimate` and `RemainingWork` (hours) on an existing work item.
Use this instead of an inline `node -e` PATCH — the PAT stays inside the tool and is
never exposed on the command line (inline PATs get blocked as credential leaks).

---

#### List attachments

```bash
node index.js wi attachments <wi-url>
```

Output: index, name, comment, download URL for each attachment.

---

#### Download an attachment

```bash
# Download by index (1-based)
node index.js wi download <wi-url> 1

# Download by exact file name
node index.js wi download <wi-url> "screenshot.png"

# Specify output directory
node index.js wi download <wi-url> 1 --out C:/Users/AlexZamboli/Downloads
```

If the work item has only one attachment, the selector can be omitted.

---

### `build` — Pipeline build operations

List, inspect, and **re-run** pipeline builds. Generic across every EVUP/ELOS pipeline: a
re-run replays the source build's runtime variables (`parameters`) and `templateParameters`
verbatim — a pipeline **with** variables (e.g. `APP-UI-CUSTOMER`: `clientName`, `platformName`,
`deployMode`…) is replayed with those exact values; a pipeline **without** variables just
re-queues with none. Requires `--project` (or a configured default / `AZURE_PROJECT`).

```bash
# Recent builds on a branch (newest first)
node index.js build list --project ELOS --branch features/65373_midia --top 10

# Filter by pipeline (name or numeric id) and/or repo; --json for raw objects
node index.js build list --project ELOS --definition APP-UI-CUSTOMER --repo APP-UI-CUSTOMER --json

# Most-recent build matching the filters — full detail incl. its variables
node index.js build last --project ELOS --branch features/65373_midia --definition APP-UI-CUSTOMER

# Re-run the latest build on a branch with the SAME config/variables.
# Previews by default (dry run); add --yes to actually queue.
node index.js build rerun --project ELOS --branch features/65373_midia --definition APP-UI-CUSTOMER
node index.js build rerun --project ELOS --branch features/65373_midia --definition APP-UI-CUSTOMER --yes

# Re-run one specific build id
node index.js build rerun 40587 --project ELOS --yes

# Re-run the same config against a different ref
node index.js build rerun 40587 --project ELOS --branch releases/rc/202606_1 --yes
```

Notes:
- **`rerun` is a write** (it triggers CI). It previews the payload and does nothing unless you pass
  `--yes` — same convention as `dbq` mutations.
- Without a `<buildId>`, `rerun` resolves the latest build matching `--branch`/`--definition`/`--repo`,
  fetches its full config, and re-queues it — so the new run picks up the branch's current HEAD.
- `--branch` accepts a short name (`features/x`) or a full ref (`refs/heads/features/x`).
- The Build REST API has no repo filter, so `--repo` narrows results client-side by repository name.

---

## Repo-level reads not exposed as commands (lib workaround)

The CLI covers PRs and work items, but has **no first-class commands** for repo metadata,
git refs, or listing PRs. These come up constantly in promotion / merge-back flows (resolve a
repo's default branch, confirm a source branch exists, check for a duplicate open PR). Until
they're added, reuse the transport + configured PAT directly from `lib/` — the PAT stays inside
the tool, never on the command line:

```js
const { request } = require('D:/fontes/claude-tools/azure-connector/lib/api.js');
const { loadConfig } = require('D:/fontes/claude-tools/azure-connector/lib/config.js');
const cfg = loadConfig(); const base = `${cfg.baseUrl}/${cfg.org}`;
const enc = encodeURIComponent;

// repo metadata (id + defaultBranch)
const repo = await request(`${base}/${enc(project)}/_apis/git/repositories/${enc(repoName)}?api-version=7.1`, { pat: cfg.pat });
// does a branch exist?  refs?filter=heads/<branch>
const refs = await request(`${base}/${enc(project)}/_apis/git/repositories/${enc(repoName)}/refs?filter=${enc('heads/'+branch)}&api-version=7.1`, { pat: cfg.pat });
// active PRs source->target (dedup before creating)
const prs  = await request(`${base}/${enc(project)}/_apis/git/repositories/${enc(repoName)}/pullrequests?searchCriteria.status=active&searchCriteria.sourceRefName=${enc('refs/heads/'+src)}&searchCriteria.targetRefName=${enc('refs/heads/'+tgt)}&api-version=7.1`, { pat: cfg.pat });
```

Gotchas learned in the field:
- **Changing a repo's default branch is a repo-property PATCH and needs the repo *id* in the
  URL, not the name** — by name the API returns a misleading `HTTP 400 "The request is
  invalid."` (not a 404). Body: `{ "defaultBranch": "refs/heads/main" }`. It also requires the
  Git **`RenameRepository`** ("Edit repository properties") permission on that repo — the
  *Code Full* PAT scope is not enough if the identity lacks the ACL (fails `403
  TF401027`).
- **Bulk creation/linking** (`pr create`, `wi link-pr`) is one-at-a-time; script over the lib
  for fan-out (e.g. one PR per repo across a sprint's release branches).

## URL formats

| Resource | URL pattern |
|---|---|
| Pull Request | `https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{prId}` |
| Work Item | `https://dev.azure.com/{org}/{project}/_workitems/edit/{id}` |

URL-encoded project/repo names are handled automatically (e.g. `VOE.IT%20-%20Espaco%20Laser`).

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
| Download attachment | GET | attachment URL from work item relations |

---

## File structure

```
azure-connector/
├── index.js          # CLI entry point and command router
├── package.json
├── README.md
├── test/
│   └── connector.test.js  # unit tests (node:test)
└── lib/
    ├── config.js     # PAT/org config, URL parser
    ├── api.js        # HTTP transport (no external deps)
    ├── pr.js         # Pull request operations
    ├── workitem.js   # Work item operations + attachment download
    ├── build.js      # Pipeline build list/last/rerun (generic variable replay)
    └── format.js     # Pretty-print helpers
```

## Tests

```bash
npm test   # or: node --test
```

Unit tests (Node built-in `node:test`, no network/PAT) cover `parseArgs`, `normalizeAzureRepoPath`
(MSYS path de-mangling), `parseUrl`, `buildThreadBody` (inline-anchor threadContext, right/left side),
and the `build` helpers `normalizeBranchRef` / `buildRerunPayload` (generic variable replay, incl.
pipelines with no variables) / `summarizeBuild`.
