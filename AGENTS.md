# AGENTS.md — operating contract for autonomous callers

This file is the machine-facing reference for `azure-connector`. It describes the
**complete** command surface, every flag, the exit codes, which commands write, and the
guards that can refuse a write. The [README](README.md) explains the same tool in prose
and with worked examples; this file is the contract.

Read this before the first call. Nothing here requires network access to verify.

---

## 1. Invocation

```
node <path>/index.js <group> [subcommand] [positional...] [--flag [value]...]
```

- **Runtime:** Node.js 18+. Zero dependencies — Node built-ins only. No install step.
- **Working directory is irrelevant.** The CLI resolves its own directory, so an
  absolute path to `index.js` works from anywhere.
- `--help` / `-h`, or no arguments at all, prints usage and exits **0**.

A flag with no value becomes boolean `true`. A flag followed by a non-`--` token takes
that token as its value. Consequence worth internalising: `--line --json` makes `--line`
boolean `true`, not `--line` with a missing value. Always pass a value where one is
expected.

### 1.1 Unknown flags abort the run

`parseArgs` accepts anything beginning with `--`, so an unrecognised flag would
otherwise be silently dropped and the command would run **without it**. That failure is
invisible and compounding: a dropped `--yes` becomes a dry run, a dropped `--json` yields
unparseable text, a dropped `--project` silently changes which project is addressed.

So an unknown flag is a **hard failure**:

```
ERROR: Unknown flag(s) — nothing was run:
  --porject   did you mean --project?
```

- Exit **1**, and no request is made.
- The suggestion is the *closest* known flag within an edit distance of 2, or
  `(no close match)`.
- `--no-strict-flags` downgrades this to a stderr warning and proceeds. Use it only in a
  genuinely unattended pipeline; never to work around a typo.

The accepted flag names are exactly the `KNOWN_FLAGS` set in `index.js` — treat that set as
the source of truth rather than this document. Passing a flag that some *other* command
reads is accepted and ignored: validity is global, not per-command.

---

## 2. Exit codes

| Code | Meaning |
|---:|---|
| **0** | Success. For a read, the answer is on stdout. For a write, the write happened. |
| **1** | Any error: bad arguments, unknown flag, auth failure, HTTP error, a guard refusing a write, or a state transition the board rejected. Nothing was written unless the message says otherwise. |
| **2** | **Only** `wi comment`, and only from the field-routing gate: the work item has long-form custom fields and neither `--field` nor `--as-comment` was given. Nothing was posted. This is a *decision required*, not a failure — see §7.3. |

Two cases set exit **1** after partial work, and both say so explicitly on stderr:

- `wi set-state` when the rule engine rejects the transition — nothing was written.
- `pr comment --batch` when a post fails *after* validation passed — the thread ids that
  already landed are printed. Do not re-run the whole batch.

---

## 3. stdout / stderr discipline

**stdout carries the answer. stderr carries everything else.** This holds across every
command, so `--json` output is always safe to parse without filtering.

On stderr, and never on stdout:

- the PAT-expiry warning (printed on *every* invocation inside the warning window)
- retry notices (`azure-connector: GET got HTTP 429; retrying (1/3) in 512ms...`)
- anchor-correction notes (`note: path corrected: ...`)
- batch validation progress and per-item notes
- the `--verify` verdict
- the `wi comment` field-routing gate listing
- bulk-mode row counts and per-id skip warnings

A non-empty stderr therefore does **not** mean failure. Read the exit code.

---

## 4. Configuration and identity

### 4.1 Resolution order

Effective value = **environment variable** → **resolved profile** → **top-level config**.

Profile selection, in precedence order, never interactive:

1. `--profile <name>`
2. the org parsed from a PR/WI **URL argument** (so any org's URL auto-selects its PAT)
3. `AZURE_PROFILE`
4. `defaultProfile`
5. the top-level `{ pat, org, ... }` block, which is itself a profile

A PAT is scoped to one Azure DevOps org, so multi-org support is one profile per org.

### 4.2 Environment variables

| Variable | Effect |
|---|---|
| `AZURE_PAT` | PAT. Highest precedence; overrides any profile. |
| `AZURE_ORG` | Organisation. |
| `AZURE_PROJECT` | Default project for bare ids and `--project`-requiring commands. |
| `AZURE_REPO` | Default repo, used when resolving a bare PR id. |
| `AZURE_BASE_URL` | Defaults to `https://dev.azure.com`. |
| `AZURE_PROFILE` | Profile name. |
| `AZURE_PAT_VALID_TO` / `AZURE_PAT_NAME` / `AZURE_PAT_WARN_DAYS` | Override the locally recorded expiry, label and warning window (default 30 days). |
| `AZURE_PREFLIGHT=1` | Network-validate the PAT before every command. Off by default: it costs a round trip, and a real call already reports auth errors clearly. |
| `AZURE_MAX_RETRIES` | Retries per request. Default `3` → up to 4 attempts. `0` disables. |
| `AZURE_CONFIG_FILE` | Path to the config file. Default `~/.azure-connector.json`. |

`patEnv` in a profile names an environment variable to read the PAT from at runtime, so
no secret sits on disk. Prefer it when a secret store is available.

### 4.3 Files written

| Path | Contents |
|---|---|
| `~/.azure-connector.json` | Config, including the PAT unless `patEnv` is used. Written by `config --pat ...`. |
| `~/.azure-connector-repos.json` | Cache mapping repository GUID → `project/repo`. Written opportunistically by `wi relations`; safe to delete. |

### 4.4 PAT expiry is tracked locally

A PAT without token-management scope cannot read its own expiry through the API, so the
date lives in config and is compared offline — zero network cost, checked on every run.
Record it with `config --pat-valid-to <YYYY-MM-DD>`. `pat check` is the only expiry-related
command that touches the network.

### 4.5 Transport behaviour

Every HTTP call retries transient failures with exponential backoff (~0.5s → 1s → 2s →
4s, capped at 8s, plus jitter), honouring `Retry-After` when present.

- **Retried:** `408`, `409` (optimistic-concurrency contention on rapid work-item
  PATCHes), `429` (throttling), `500`, `502`, `503`, `504`, and the transient network
  errors `ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `EAI_AGAIN`, `EPIPE`, `ENOTFOUND`,
  `ESOCKETTIMEDOUT`.
- **Never retried:** `401` and `203`, and every other `4xx`. A bad PAT will not fix
  itself, and `203` matters because it is below 400 and would otherwise parse as success.

All calls use API version `7.1`.

---

## 5. Identifier resolution

Every `pr` and `wi` command accepts either a full Azure DevOps URL or a bare numeric id.

| Argument | Resolves with |
|---|---|
| **Work item URL** `.../{org}/{project}/_workitems/edit/{id}` | Self-contained. |
| **Bare work item id** | Needs a project: `--project`, `AZURE_PROJECT`, or the configured default. |
| **PR URL** `.../{org}/{project}/_git/{repo}/pullrequest/{id}` | Self-contained. |
| **Bare PR id** | Needs **both** project and repo — a PR id is unique only inside its repository. From `--project`/`--repo`, `AZURE_PROJECT`/`AZURE_REPO`, or the saved defaults. |

`parseUrl` also recognises a repo URL (`.../_git/{repo}`), a `pullrequestcreate` URL
(carrying `sourceRef`/`targetRef` in the query string, used by `pr create` and by
`pr get`/`pr diff` in branch-compare mode), and a tag URL (`?version=GT{tag}`).

> **A wrong project reads as "does not exist", never as "wrong project".** Repo names,
> pipeline definition names and bare ids are all resolved *inside* a project. Before
> concluding something was deleted, confirm which project owns it — `whoami` enumerates
> the projects the PAT can see.

---

## 6. Which commands write

This is the table to consult before any call. **A write with no dry-run support takes
effect the moment it is invoked.**

| Command | Writes? | Gate |
|---|---|---|
| `config` (with a setter flag) | local file | none |
| `config` (no flags), `pat check`, `whoami` | no | — |
| `raw` | **depends on `<METHOD>`** | none — `raw POST/PATCH/PUT/DELETE` writes immediately |
| `create-repo` | **yes** | none |
| `sprints`, `repo list|get|refs` | no | — |
| `pr get|list|diff|comments|timeline|link` | no | — |
| `pr create` | **yes** | none |
| `pr comment` | **yes** | `--dry-run`; also `--expect-head`, duplicate detection, anchor validation |
| `pr comment --batch` | **yes** | `--dry-run`; all-or-nothing validation |
| `pr reply`, `pr edit-comment`, `pr set-desc` | **yes** | none |
| `pr abandon`, `pr delete-thread`, `pr close-thread` | **yes** | none |
| `wi get|search|fields|field|layout|comments|updates|relations|missing|link` | no | — |
| `wi set-field` | **yes** | `--dry-run`, `--verify`, and the always-on render guard |
| `wi set-state` | **yes** | `--dry-run` + always-on rule preflight |
| `wi complete` | **yes** | `--dry-run` |
| `wi comment` | **yes** | field-routing gate (exit 2) |
| `wi edit-comment`, `wi delete-comment` | **yes** | none |
| `wi set-estimate`, `wi create-task`, `wi link-pr` | **yes** | none |
| `wiki list|pages|get` | no | — |
| `build list|last` | no | — |
| `build rerun` | **yes — triggers CI** | **requires `--yes`**; previews otherwise |

`build rerun` is the only command that refuses to act without `--yes`. Do not assume that
convention elsewhere.

---

## 7. Writing rich text

### 7.1 Four surfaces, three formats

Work-item content and pull-request content render with different engines at different
URLs. They are independent artifacts: never reuse one body for the other.

| Surface | Send | Written with |
|---|---|---|
| PR description | Markdown | `pr create --desc`/`--desc-file`, `pr set-desc` |
| PR comment / reply | Markdown | `pr comment`, `pr reply`, `pr edit-comment` |
| WI comment | Markdown (converted to HTML), or HTML passed through | `wi comment`, `wi edit-comment` |
| WI long-form field | **HTML** — or Markdown plus `--from-markdown` | `wi set-field` |

**Rich text must come from a file.** `pr comment`, `pr reply`, `pr edit-comment`,
`wi comment` and `wi edit-comment` refuse an inline positional body and require
`--body-file <path>`; a shell mangles backslashes, newlines and Markdown. Two deliberate
exceptions: `pr create --desc` / `pr set-desc` accept inline text and interpret literal
`\n`, `\t`, `\r`, `\\` escape sequences; and `wi set-field` takes an inline positional
value, which is the right call for a short scalar.

A body that is HTML from its first tag to its last is passed through the converter
untouched. Anything else is treated as Markdown and HTML-escaped, so raw HTML mixed into
prose renders as visible `&lt;tags&gt;`.

### 7.2 Two Markdown → HTML profiles

`lib/workitem.js` exposes one converter with two output profiles, because the two
surfaces sanitize differently:

| Profile | Used by | Behaviour |
|---|---|---|
| `comment` (default) | `wi comment`, `wi edit-comment` | Keeps `<table>` with the inline `style=` attributes that make it readable. |
| `field` | `wi set-field --from-markdown`, and `wi comment --field <ref>` | Emits **no** `style=` anywhere and renders every pipe table as a `<ul>`, one `<li>` per row, because the form strips inline styles and renders tables inconsistently. |

Supported Markdown: `##`/`###`/`####` headings, `**bold**` (may span one newline, never a
blank line), `` `inline code` ``, `-` and `1.` lists, `>` quotes, `---` rules, fenced code
blocks, and GFM pipe tables. Tables require a leading and trailing `|` on every row plus a
delimiter row (`|---|:--:|---:|`, which also sets alignment) — so prose containing a stray
`|` is never mistaken for a table. A `|` inside inline code is content; elsewhere in a
cell escape it as `\|`.

> The converter is hand-rolled and has grown past the point where more regex is wise. Do
> not extend it; see the debt note in the README.

### 7.3 The field-routing gate (`wi comment`, exit 2)

Analysis — root cause, solution, requirements — belongs in a work item's dedicated
long-form fields, not in a loose comment. So `wi comment` first reads the work item type's
**form layout** and, if the type declares long-form `Custom.*` controls, lists them on
stderr and **exits 2 without posting**:

```
Work item #1234 (Bug) has content fields that may be the right home for this text:

  "Root Cause"            ->  Custom.RootCause            [empty]
  "Implemented Solution"  ->  Custom.ImplementedSolution  [empty]
```

Resolve it by choosing, explicitly:

- `--field <ref>` — route the body into that field instead. The body is converted with
  the **`field`** profile, because a Markdown comment body written raw into an HTML field
  is exactly how asterisks end up visible on the board.
- `--as-comment` (alias `--force`) — post it as a comment anyway. Correct for progress
  notes, QA instructions and discussion.

A work item type with no long-form custom fields posts with no friction. If the layout
cannot be fetched the gate is skipped rather than blocking a legitimate comment.

> **If `wi layout` shows the field is not on that work item type, do not try to set it**
> — the write will fail. Post a comment instead and say the field was absent. Work item
> *types* differ: a "Bug" may carry fields a "Task" does not.

---

## 8. Guards that can refuse a write

Six independent checks. Each one exists because the failure it prevents is silent.

### 8.1 Always on: the render guard

`assertRenderableFieldValue` refuses a **multi-line** field value carrying markup the form
will not render: inline `style=`, `<table>`, raw Markdown headings/bold/bullets, code
fences, emoji. Each rejection names a remedy.

It lives in `lib/workitem.js`, not in the CLI, and runs inside `setField()`. A one-off
script calling the library directly is therefore covered too — a guard that exists only
one layer above the API is a guard that scripts skip. Single-line values are never
inspected, since a scalar is not a formatting question.

Bypass: `--force` (CLI) or `{ force: true }` (library).

### 8.2 `wi set-field --verify [--against <file>]`

Refuses a rewrite that **drops a fact** or carries forbidden markup. Facts are compared as
a **multiset** over four categories, with HTML stripped from both sides so a pure markup
change does not read as a content change:

| Category | Matched |
|---|---|
| `numbers` | ids, counts, versions, money |
| `references` | `!123` (PR) and `#123` (work item) |
| `links` | `http(s)://…` |
| `quoted` | `"…"` and `«…»` spans of 2–80 characters |

Losing one of three identical numbers still fails. The baseline is the **live field value**
by default, or a local file with `--against` (for an offline report or wiki page).

> **The truncation trap.** Azure silently truncates a long field value at exactly 8192
> bytes. A baseline that comes back at exactly that length is almost certainly cut, so
> fact-loss checking is **skipped** and called out loudly on stderr — comparing against a
> cut value would invent losses and the check would lie with confidence. Read the field in
> a browser before overwriting it.

A failed verdict writes nothing; `--force` proceeds anyway.

### 8.3 `pr comment --expect-head <sha>`

Refuses to post when the PR head moved since the diff was read. This is the guard
`--dry-run` cannot give you: **a shifted anchor still validates**, so the comment lands
quietly on whatever now occupies that line.

Pass the commit you reviewed. 7–40 hex characters; a short sha matches by prefix. A
malformed value is rejected rather than ignored.

### 8.4 Inline anchor resolution (on by default)

Before posting an inline comment, the anchor is resolved against the PR's **latest
iteration**:

- the file path is corrected to Azure's canonical casing and leading slash
- the side is chosen — **right** for added/edited lines, **left** for a deleted file
- the line is confirmed to exist; **a non-existent line is rejected**
- if the file is not among the iteration's changed files, the error lists the files that are

Skip with `--no-validate` to post blindly. Preview with `--dry-run`.

### 8.5 Duplicate-thread detection (on by default)

A second thread on a file:line that already has one is nearly always a repeat of a
finding. The command stops, lists the existing threads, and posts nothing. Override with
`--allow-duplicate`.

### 8.6 `wi set-state` rule preflight (on by default)

The transition is first sent with `validateOnly=true` — the real rule engine, writing
nothing. On rejection the command names the **blocking field** and prints its
`allowedValues`, instead of surfacing a bare `TF401320`. Skip with `--no-preflight`.

> Two traps this exists to cover: the field metadata endpoint *does* return
> `allowedValues` via `$expand`, and a gating field commonly reports
> `alwaysRequired: false` — so field metadata alone never predicts the failure.

---

## 9. Command reference

Flags are listed per command. `--json` always means "machine-readable on stdout".

### 9.1 Configuration and identity

| Command | Purpose |
|---|---|
| `config` | With no flags, prints the effective config as JSON with the PAT masked, plus expiry status, configured profiles and the config file path. |
| `config --pat <t> --org <o> --project <p> --repo <r> --base-url <u> --pat-valid-to <YYYY-MM-DD> --pat-name "<n>" --pat-warn-days <d>` | Persists any subset to the config file. |
| `pat check` | Validates the PAT over the network via `connectionData` and reports the authenticated identity plus the recorded name, expiry and days left. An invalid PAT resolves to the *anonymous* identity and is reported as a failure. |
| `whoami [--profile <n>]` | Confirms auth and lists every project the PAT can see. Use it to discover project names. |

### 9.2 Escape hatch

| Command | Notes |
|---|---|
| `raw <METHOD> <path\|url> [<json>\|@<file>]` | Any endpoint not yet wrapped. A `path` is appended to the org base; a full `https://` URL is used as-is. `api-version=7.1` is added unless already present. Body is inline JSON or `@file`. Shares auth, retry and profile selection with every other command. **Writes if the method writes.** |

> From Git Bash (MSYS) a leading-slash path is rewritten to a Windows path before Node
> sees it. Pass a full URL, or run from PowerShell.

### 9.3 Repositories

| Command | Flags | Notes |
|---|---|---|
| `repo list` | `--project`, `--json` | **Sweeps the whole org only when no default project is configured.** It falls back to the configured project, so on a configured machine it silently lists one project and a repo elsewhere looks missing. Enumerate with `whoami`, then list per project. |
| `repo get <name\|url>` | `--project`, `--json` | Prints id, defaultBranch, size, disabled, remoteUrl, webUrl. Accepts a **name or a GUID**; a GUID needs no project. |
| `repo refs <name\|url>` | `--filter heads/<b>`, `--project`, `--json` | **Does a branch exist?** Read the count — an empty result is the answer. |
| `create-repo <name>` | `--project`, `--json` | Creates an empty repo. **Writes.** |

### 9.4 Pull requests

| Command | Flags | Notes |
|---|---|---|
| `pr get <url\|id>` | `--project`, `--repo`, `--full`, `--json` | Always prints the linked work items as `Work items: #1, #2` or `(none)` — a PR with no work item is a finding, so the line is never omitted. `--full` adds reviewer votes and thread counts. `--json` emits the raw payload with `workItems` merged in (and `threads` under `--full`). Given a `pullrequestcreate` URL it switches to branch-compare mode. |
| `pr list <repo-url>` | `--project`, `--repo`, `--status active\|completed\|abandoned\|all` (default `completed`), `--target <branch>`, `--top <n>` (50), `--since <YYYY-MM-DD>`, `--json` | `--since` filters client-side on closed-or-creation date. |
| `pr create <repo-url\|pullrequestcreate-url>` | `--title` (**required**), `--source`, `--target` (**required**), `--desc`, `--desc-file`, `--body-file`, `--work-items <ids>`, `--draft` | Branches may come from a `pullrequestcreate` URL instead of flags. `--work-items` is a comma list, linked as ArtifactLink. **`--target` has no default** — the repo's default branch is deliberately not used as a fallback, and it is not always `main`. Description is capped at **4000 characters**, validated before the call. **Writes.** |
| `pr diff <url\|id>` | `--project`, `--repo`, `--full` (alias `--content`), `--patch` (no-op) | Prints the changed-file list, then a unified diff per file. `--full` dumps each changed file's whole contents from the source branch instead. Line numbers in the diff are the right-hand ones `pr comment --line` expects. |
| `pr comments <url\|id>` | `--project`, `--repo` | Lists active threads with author, date, file location and content. Source of `<threadId>`. |
| `pr comment <url\|id>` | `--body-file` (**required**), `--file`, `--line`, `--dry-run`, `--expect-head <sha>`, `--allow-duplicate`, `--no-validate`, `--batch <manifest>` | See §8.3–8.5. Markdown body. `--line` is a right-hand file line number. **Writes.** |
| `pr reply <url\|id> <threadId>` | `--body-file` (**required**), `--comment <n>` (parent, default 1) | Replies inside an existing thread. **Writes, no dry-run.** |
| `pr edit-comment <url\|id> <threadId>` | `--body-file` (**required**), `--comment <n>` (default 1) | Edits in place. **Writes, no dry-run.** |
| `pr set-desc <url\|id> ["<text>"]` | `--body-file`, `--title` | Replaces description and/or renames. Use it to resync a description after later commits change the implementation. Same 4000-character cap. **Writes, no dry-run.** |
| `pr abandon <url\|id>` | `--project`, `--repo` | Soft close. Branches remain. **Writes, no dry-run.** |
| `pr delete-thread <url\|id> <threadId>` | `--comment <n>` (default 1) | Deletes the comment, then closes the thread. A failed delete is a warning; the close still runs. **Writes, no dry-run.** |
| `pr close-thread <url\|id> <threadId>` | — | Marks the thread closed. **Writes, no dry-run.** |
| `pr link <url\|id>` | `--wi <id>`, `--no-wi` | Prints the canonical reference line, with the **project resolved from the PR's own repository object** rather than assumed. Read-only. |
| `pr timeline <url\|id>` | `--json` | created → published → every vote → completed, with day deltas. |
| `pr timeline --repo <r>` | `--project` (**required**), `--status` (default `all`), `--top <n>` (50), `--json` | Review health across a repo. |

#### `pr comment --batch <manifest.json>`

Validates **every** anchor, the head, and duplicates before posting **anything**. Together
with `--expect-head` this gives the property a shell loop cannot: either the whole review
lands against the head that was reviewed, or nothing does.

Manifest — an array, or an object carrying an expected head:

```json
{
  "expectHead": "b31b63dc89",
  "comments": [
    { "file": "/src/Service.cs", "line": 42, "bodyFile": "findings/01-null-deref.md" },
    { "bodyFile": "findings/00-summary.md" }
  ]
}
```

- `bodyFile` is **required** per item and resolves relative to the manifest's own
  directory (absolute paths also work). Rich text stays out of the shell, as everywhere else.
- Omit `file`/`line` for a PR-level comment.
- `--expect-head` on the command line overrides `expectHead` in the manifest.
- Validation failure: exit **1**, every problem listed, nothing posted.
- Post failure *after* validation: exit **1**, and the already-posted thread ids are
  printed. **Do not re-run the whole batch** — you would duplicate them.
- `--dry-run` prints what would be posted and where.

#### Azure's vote scale

Not ordered the way you would guess, and `0` is not neutral:

| Code | Meaning |
|---:|---|
| `10` | approved |
| `5` | approved with suggestions |
| `0` | **no vote** — a reviewer who *cleared* their vote |
| `-5` | waiting for author |
| `-10` | rejected |

A `0` appears in the event list but never counts as the first review and never rescues a
PR from the no-vote tally. Votes are reconstructed from **system** comments, so a human
comment reading "Bob voted 10" is correctly ignored.

### 9.5 Work items

| Command | Flags | Notes |
|---|---|---|
| `wi get <url\|id>` | `--project`, `--json` | Id, type, state, title, assignee, area, iteration, priority, description, acceptance criteria, tags. |
| `wi search [<title-term>]` | `--project` (**required**), `--type`, `--state`, `--wiql "<q>"`, `--title-contains`, `--fields a,b,c`, `--json` | The **positional is the title term**, not the project. WIQL returns only ids, so results are hydrated in batches of **200** — the 200-item batch limit is never hit. `--wiql` overrides the built filters. Default fields: id, title, state, type. |
| `wi layout <url\|id>` | `--type <wit>`, `--project` | Maps form **label → field reference name**, including fields that are empty. This is the reliable way to discover custom field names. |
| `wi fields <url\|id>` | `--all`, `--filter <substr>`, `--project` | Reference name = value, HTML stripped, values truncated at 120 chars unless `--all`. **Empty fields are not returned by the API** — use `wi layout` or `wi missing`. |
| `wi field <url\|id> <fieldRef>` | `--project` | One field's raw value, for an edit round-trip. |
| `wi set-field <url\|id> <fieldRef> ["<value>"]` | `--body-file`, `--from-markdown`, `--allow-empty`, `--verify`, `--against <file>`, `--force`, `--dry-run` | Inline scalar or file body. See §8.1–8.2. `--allow-empty` is required to clear a field. **Writes.** |
| `wi missing <url\|id>` | `--all`, `--type`, `--json` | Form layout joined to current values, so "which fields are unanswered?" is answerable at all. Reports `empty`, `placeholder` and `filled` separately — a lone `.`, `-` or `n/a` reads as filled everywhere else but says nothing. Defaults to custom long-form controls; `--all` covers every control on the form. |
| `wi comments <url\|id>` | `--ids`, `--raw`, `--project` | Default view is rendered with `[1]`/`[2]` display indices. `--ids` lists the **real comment ids** needed to edit. `--raw` dumps the source HTML so an edit can be minimal. |
| `wi comment <url\|id>` | `--body-file` (**required**), `--field <ref>`, `--as-comment` (alias `--force`) | See §7.3. **Writes, exit 2 on the gate.** |
| `wi edit-comment <url\|id> <commentId>` | `--body-file` (**required**) | Get the id from `wi comments --ids`. **Writes, no dry-run.** |
| `wi delete-comment <url\|id> <commentId>` | — | Azure soft-deletes it. **Writes, no dry-run.** |
| `wi set-state <url\|id> "<state>"` | `--no-preflight`, `--dry-run`, `--type` | See §8.6. **Writes.** |
| `wi set-estimate <url\|id> <hours>` | — | Writes `OriginalEstimate` **and** `RemainingWork`. **Never touches `CompletedWork`**, despite the name. This is the *opening* move. **Writes, no dry-run.** |
| `wi complete <url\|id> --hours <n>` | `--dry-run` | The closing move: `CompletedWork = n`, `RemainingWork = 0`. A board that gates `Done` on `CompletedWork` rejects the transition until this runs. Pass `--hours 0` when the task closed without delivery — the record should not claim work that did not happen. **Writes.** |
| `wi create-task <parent-url\|id> "<title>"` | `--estimate <h>`, `--desc`, `--assignee <email>`, `--activity <name>` | Creates a `Task` as a child. **Inherits the parent's Area Path, Iteration Path and Assignee** unless overridden. `--activity` defaults to `Development` because some processes make Activity required, and a Task created without it fails with `TF401320`. **Writes, no dry-run.** |
| `wi link-pr <wi-url\|id> <pr-url\|id>` | — | Adds the ArtifactLink relation. Resolves the PR's project/repo ids automatically; works across projects in one org. **Writes, no dry-run.** |
| `wi link <url\|id>` | `--no-type` | Prints the canonical reference line, with the project taken from the **root segment of the Area path** — which is always the project name. Warns on stderr when that disagrees with a passed `--project`. Read-only. |
| `wi attachments <url\|id>` | — | Index, name, comment, download URL. |
| `wi attach <url\|id> <file>` | `--yes`, `--name <n>`, `--comment "<t>"`, `--allow-duplicate`, `--json` | Uploads the bytes, then links them as an `AttachedFile` relation. **Previews unless `--yes`.** The project is read from the item's Area path, not from `--project`/config — see below. **Writes.** |
| `wi download <url\|id> [<index\|name>]` | `--out <dir>` | 1-based index or exact file name. The selector may be omitted when there is exactly one attachment. Writes a local file. |
| `wi updates <url\|id>` (alias `history`) | `--field <ref>` (default `System.State`), `--all-fields`, `--time-in-state`, `--entered "<v>"`, `--ids <a,b,c\|@file>`, `--project`, `--json` | See below. |
| `wi relations <url\|id>` | `--type <kinds>`, `--ids <a,b,c\|@file>`, `--project`, `--no-resolve`, `--json` | See below. |

#### `wi attach` — putting a file on the item

Two API calls, and **the first one alone is not an attachment**: the upload returns a
blob `{ id, url }` that nothing references yet, and Azure garbage-collects it. The
`AttachedFile` relation in the second call is what makes it appear on the item.

```bash
wi attach 66360 ./report.pdf                                    # preview, exit 0
wi attach 66360 ./report.pdf --comment "Analysis 2026-09-17" --yes
```

Three things this command decides for you, each because the obvious alternative fails
quietly:

- **The project comes from the item's Area path**, not from `--project` or the configured
  default. A bare id would otherwise inherit whatever `config --project` was last set to;
  the blob then uploads under one project while the item lives in another. The preview's
  `projectSource` field says which source won.
- **A duplicate name is refused** (`--allow-duplicate` to override). Azure keeps both
  copies without complaint, and `wi download <name>` then resolves to whichever appears
  first in the relations array — a silently wrong file.
- **A 0-byte file is refused.** Azure stores it happily; the item shows an attachment
  that downloads as nothing.

Two Azure DevOps Services limits are enforced client-side, because neither is raisable
and hitting either costs the whole upload first: **60 MB per attachment** and **100
attachments per item**. Do not read the 130 MB in the REST reference as the cap — that is
the *chunked-upload threshold*, reachable only on an on-prem Server whose limit was
raised (its default is 4 MB).

One knock-on: `name` is a global flag now, so the strict-flag check no longer rejects
`wi download <id> --name "x.pdf"`. `cmdWiDownload` refuses it explicitly — left
accepted-and-ignored, the selector would be `undefined` and a single-attachment item
would quietly download the wrong file and exit 0.

Transport note: `lib/api.js` `request()` sends a **Buffer body as raw bytes** and anything
else as JSON. That branch is load-bearing — `JSON.stringify(buffer)` produces
`{"type":"Buffer","data":[...]}`, which Azure accepts with a `200` and stores as a
corrupt attachment. `test/connector.test.js` pins it against a loopback server.

#### `wi updates` — how an item moved

A work item carries only its *current* state. Cycle time, bounce-backs, when it reached
QA, whether it arrived before the sprint closed — all of it comes from the revision feed,
and there is no other source.

Two traps in the raw feed, both handled here:

- a revision that rewrites a field with the **same value** is not a transition (counting
  those inflates every total)
- Azure stamps the newest revision with a **year-9999** date meaning "still current",
  reported here as no date rather than making every open item look 8000 years old

Modes: default transition list · `--all-fields` (every changed field per revision, for
finding which field carries the signal) · `--time-in-state` (spans in days, the final one
open and measured against now) · `--entered "<v>"` (first and last time it took that
value) · `--ids` bulk, emitting TSV `id · at · from · to · by`.

> **Always pass `--project`.** The org-level updates endpoint can return a **truncated
> history** for an item that moved between projects.

#### `wi relations` — the ticket → code bridge

Lists relations with `vstfs:///` artifact URLs **decoded**, so linked PRs, commits and
branches come back as usable ids rather than opaque URIs. From here `pr get` / `pr diff`
take over.

Kinds: `pr`, `commit`, `branch`, `build`, `parent`, `child`, `related`, `duplicate`,
`duplicate-of`, `successor`, `predecessor`, `attachment`, `hyperlink`. An unknown `rel`
passes through verbatim rather than being dropped. `--type` takes a comma list.

An artifact link carries the repository **GUID**; it is resolved to `project/repo` with
one lookup per distinct GUID, cached in `~/.azure-connector-repos.json`. `--no-resolve`
skips that and shows raw GUIDs.

Bulk `--ids` uses `workitemsbatch` with `$expand=relations`, 200 ids per call. Ids missing
from the response — deleted, or living in another project — are reported on stderr, never
silently dropped.

### 9.6 Iterations

| Command | Flags | Notes |
|---|---|---|
| `sprints <project>` (alias `iterations`) | `--team <t>`, `--filter <pattern>`, `--depth <n>` (4), `--current`, `--json` | **Sprint dates live here and nowhere else** — a work item carries only its `IterationPath` string, so any "was this delivered inside the sprint?" question needs this command for the window. Paths print backslash-separated exactly as `System.IterationPath` stores them, so a row pastes straight into a WIQL `UNDER` clause. `--team` switches to a team's subscribed list instead of the project tree. An undated node is normal: folders group sprints and print as `(undated)`. |

> `--filter` tries regex first and falls back to a literal substring. That matters because
> a pasted path like `Contoso\2026\Sprint 1` is *valid* regex that silently matches
> nothing (`\2` is a backreference, `\S` is non-whitespace). The fallback is what makes
> pasting a path work.

### 9.7 Pipelines

| Command | Flags | Notes |
|---|---|---|
| `build list` | `--project` (**required**), `--branch`, `--definition <id\|name>`, `--repo`, `--top <n>` (10), `--json` | Newest first. The Build API has no repo filter, so `--repo` narrows client-side by repository name. |
| `build last` | same | The most recent match, in full, including its variables. |
| `build rerun [<buildId>]` | `--project` (**required**), `--branch`, `--definition`, `--repo`, `--yes` | Re-queues with the **same config**: replays the source build's `parameters` and `templateParameters` verbatim. A pipeline without variables simply re-queues with none. Without a `<buildId>` it resolves the latest build matching the filters, so the new run picks up the branch's current HEAD. `--branch` re-runs the same config on another ref. **Previews unless `--yes`.** |

`--branch` accepts a short name (`features/x`) or a full ref (`refs/heads/features/x`).

### 9.8 Wiki

| Command | Flags |
|---|---|
| `wiki list` | `--project` (**required**), `--org` |
| `wiki pages` | `--project`, `--wiki <idOrName>` (both **required**), `--org` |
| `wiki get` | `--project`, `--wiki`, `--page <path>` (all **required**), `--org` — prints the page as Markdown |

> In Git Bash, export `MSYS_NO_PATHCONV=1` or a `--page "/A/B"` value is rewritten into a
> Windows path before Node sees it.

---

## 10. Using the libraries directly

`index.js` is a thin CLI over `lib/`. Requiring a module reuses the transport, the retry
policy and the resolved PAT, so a secret never reaches a command line. Useful when the CLI
is one-at-a-time and you need fan-out.

```js
const { loadConfig } = require('<path>/lib/config.js');
const { request } = require('<path>/lib/api.js');
const wi = require('<path>/lib/workitem.js');

const config = loadConfig();
await wi.setField({ config, org: config.org, project: 'Platform', id: 1234,
                    field: 'Custom.RootCause', value: '<p>…</p>' });
```

| Module | Responsibility |
|---|---|
| `lib/config.js` | Config load/save, profile resolution, PAT expiry, `parseUrl`. |
| `lib/api.js` | HTTP transport, retry/backoff, `validatePat`. No dependencies. |
| `lib/pr.js` | PR operations, plus the pure review-timeline and vote helpers. |
| `lib/workitem.js` | Work item operations, the Markdown converter, the render guard, revision-history and relation helpers. |
| `lib/iteration.js` | Iteration tree/team iterations and their date windows. |
| `lib/repo.js` | Repository metadata and refs. |
| `lib/build.js` | Pipeline list/get/queue and the generic variable replay. |
| `lib/links.js` | Canonical URLs and reference lines. Pure. |
| `lib/verify.js` | Fact-loss and forbidden-markup checks. Pure. |
| `lib/format.js` | Terminal rendering, `stripHtml`, unified-diff computation. |

**The guards are in the library, not the CLI.** `setField()` runs the render guard, and
`attachFile()` runs `checkAttachment()` for the intrinsic cases (empty file, over the size
limit, no name), so a script gets both for free. The duplicate-*attachment*-name check
needs the item's current relations and stays with the caller that already fetched them.
`--verify`, `--expect-head` and duplicate *thread* detection are CLI-level;
a script that needs them should call `verify.verifyFieldWrite()`, `pr.checkExpectedHead()`
and `pr.threadsAnchoredAt()` itself — all three are pure.

Anything time-dependent takes `now` as an **argument** rather than reading the clock. That
is what keeps the test suite deterministic and lets an old measurement be recomputed to the
same numbers.

---

## 11. Operating rules for an autonomous caller

1. **Check §6 before every call.** Most writes are not gated behind `--yes`, and most have
   no `--dry-run`. Only `build rerun` refuses to act without confirmation.
2. **Read the exit code, not the presence of stderr output.** Warnings, retries and notes
   all go to stderr on success.
3. **Treat exit 2 as a question, not a failure.** Re-issue with `--field <ref>` or
   `--as-comment`.
4. **Never work around a guard by reflex.** `--force`, `--allow-duplicate`,
   `--no-validate`, `--no-preflight` and `--no-strict-flags` each disable a check that
   exists because its failure is silent. Use one only when you can say what you verified
   instead.
5. **Rich text goes in a file.** The only inline exceptions are a PR description and a
   short scalar field value.
6. **Discover field names, never guess them.** `wi layout` first; the form label is not
   the reference name, and empty fields do not appear in `wi get`.
7. **Pass `--project` explicitly** on `wi updates`, `wi search`, `sprints` and the bulk
   modes. A wrong or missing project reads as "does not exist".
8. **Reference artifacts as `#id` and `!id`** in any prose body — Azure auto-links its own
   artifacts and the reference form stays valid. A full URL is warranted only for something
   outside Azure DevOps, or across orgs. Note that `--work-items` creates the hard
   ArtifactLink relation while `#id` in prose is a separate textual reference; you usually
   want both. In a **work item** body `!id` does *not* auto-link — use an explicit `<a>`.
9. **Re-read a diff before posting against it.** Capture the head sha and pass
   `--expect-head`; anchors from a stale diff still validate.
10. **Measure processes, not people.** `pr timeline`, `wi updates` and commit counts are
    sound for finding a broken *process* — no reviewers, work arriving after the sprint
    closed, a state nobody uses — and unsound as a measure of an individual. If a number
    here is about to be attached to a person's name, stop.

---

## 12. Tests

```bash
npm test      # or: node --test
```

152 tests, Node's built-in `node:test`. **No Azure, no PAT.** Every test is pure except
the three transport tests, which drive `request()` against a throwaway `127.0.0.1`
server on an ephemeral port — the only way to assert that a binary body leaves as bytes.

| File | Covers |
|---|---|
| `test/connector.test.js` | `parseArgs`, `normalizeAzureRepoPath` (MSYS de-mangling), `parseUrl`, `buildThreadBody` anchors, both Markdown profiles, the render guard, `loadConfig` profile resolution, the `build` helpers, the `wi attach` guards (`attachmentUploadUrl`, `attachmentRelation`, `checkAttachment`), and the binary/JSON body split in `request()`. |
| `test/analytics.test.js` | The measurement helpers behind `wi updates`, `wi relations`, `sprints`, `pr timeline` and `repo`. |
| `test/guardrails.test.js` | Duplicate detection, head-movement detection, project-from-Area-path, the canonical link lines, and the field-write verifier including the 8192-byte truncation signature. |

The cases worth knowing are the ones asserting what must **not** count: a same-value
rewrite is not a state transition, a year-9999 date is no date, a human comment reading
"Bob voted 10" is not a vote, and a cleared vote (`0`) is not a review.
