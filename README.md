# Nepomuk — Azure DevOps CLI

Tiny zero-dependency CLI to read pull requests and post review comments on Azure DevOps
over REST API 7.1.

Built for a PR-review workflow, but usable standalone.

## Requirements

- **Node.js 18+** (uses native `fetch` — no dependencies, no `npm install`).

## Setup

Copy `.env.example` to `.env` and fill in your values (`.env` is git-ignored — never commit it):

```
AZDO_ORG=your-org
AZDO_PROJECT=Your Project
AZDO_PAT=...                       # Azure DevOps Personal Access Token (Code: Read & Write)
AZDO_DEFAULT_REPO=your-repo        # used when you pass a bare PR id instead of a URL
```

Auth is HTTP Basic with the PAT in the **password** slot (`base64(":" + PAT)`) — Azure DevOps
ignores the username. If `whoami` returns 401, the PAT is wrong or expired; a 403 means the PAT
lacks the needed scope.

## Usage

```sh
node azure.mjs whoami                       # verify auth, list visible projects
node azure.mjs pr <url>                      # show a PR (title, branches, description)
node azure.mjs pr <url> --json              # machine-readable
node azure.mjs pr 19 --repo your-repo       # bare id + repo instead of a URL
node azure.mjs files <url>                  # changed files in the latest iteration
node azure.mjs threads <url>                # review threads (with thread + comment ids)
node azure.mjs del-thread <url> 45          # delete the (non-system) comments in a thread
node azure.mjs comment <url> "looks good"   # post a PR-level comment
node azure.mjs comment <url> @review.md     # ...body from a file
node azure.mjs comment-file <url> src/foo.js 42 @note.md   # inline comment on a file/line

# create a PR: description is a tight summary (≤ 4000 chars); the feature is
# explained in --comment threads (repeatable). Errors if --desc is over the cap.
node azure.mjs create-pr --repo your-repo --source feature/your-branch \
  --title "Short title" --desc @pr-summary.md \
  --comment @architecture.md --comment @files-and-verification.md

# update an existing PR's title/description and/or append comments
node azure.mjs update-pr <url|id> --desc @pr-summary.md --comment @more-context.md

node azure.mjs raw GET "/Your%20Project/_apis/git/repositories"    # raw REST call
```

### PR description + comments convention

Azure DevOps **rejects PR descriptions longer than 4000 characters**. So the recommended style is:
**keep `--desc` a tight summary (what + why + acceptance), and put the detailed explanation of
the feature into `--comment` threads** (architecture/rationale, file-by-file, review notes).
`create-pr` / `update-pr` enforce the cap — an over-long `--desc` fails *before* any network call,
telling you to move detail into `--comment`. `--comment` is repeatable and each `@file` becomes its
own thread; `--target` defaults to `main`.

A PR `<url>` is the full browser URL ending in `/pullrequest/<id>`, e.g.
`https://dev.azure.com/your-org/Your%20Project/_git/your-repo/pullrequest/19`.
The org/project/repo/id are parsed from it. A bare numeric id needs `--repo` (or
`AZDO_DEFAULT_REPO`). `@path` anywhere a comment body is expected reads that file as the body.

## Notes

- **Posting comments writes to a shared PR your teammates see** — confirm the content before
  running `comment` / `comment-file` / `del-thread` unless you've already decided to go ahead.
- **Inline comments need a line in the NEW (right-side) file.** Get accurate line numbers from the
  PR's source branch, not the local working tree (which is usually on `main`):
  `git -C <repo> grep -n "<anchor>" origin/<sourceBranch> -- <path>`. The `filePath` is the path as
  shown by `files` (leading `/` added automatically).
- **To redo a comment:** `threads` to find the thread id, `del-thread <url> <id>` to remove it,
  then re-post. `del-thread` re-reads the thread first, so it's safe to retry after a `fetch failed`.
- `@path` works for `comment-file` bodies too (`comment-file <url> <path> <line> @note.md`) — handy
  for multi-line / accented / backtick-heavy review text that would be awkward to quote in a shell.
- `raw` paths are appended to the org base (`https://dev.azure.com/<org>`); pass a full
  `https://` URL to override. Every call appends `api-version=7.1` automatically.
- Network-level `fetch failed` errors (transient TLS resets) are retried up to 4× inside the
  tool; HTTP error responses are surfaced immediately.
- This tool handles PR **metadata and comments**. If you review diffs, clone the target repos
  locally and read the diff from git — point your review workflow at wherever you cloned them.

## License

MIT — see [LICENSE](LICENSE).
