# Examples

All commands are `node azure.mjs <command>` (or `azure-connector <command>` if linked).
Placeholders like `your-org`, `Your Project`, `web` stand in for real values.

## Auth & profiles

```sh
# Verify the default profile (.env) — prints the org and visible projects.
node azure.mjs whoami

# Verify a named profile from azdo-profiles.json.
node azure.mjs whoami --profile personal

# List every configured profile. PAT values are never printed — only whether one
# is set, and whether it comes from an env var (patEnv).
node azure.mjs profiles
```

### One org, no profiles file

Just `.env` — nothing else needed:

```
AZDO_ORG=your-org
AZDO_PROJECT=Your Project
AZDO_PAT=...
AZDO_DEFAULT_REPO=web
```

### Several orgs

`.env` stays the default profile; add the others to `azdo-profiles.json`
(git-ignored — copy `azdo-profiles.example.json`):

```jsonc
{
  "default": "work",
  "profiles": {
    "work":     { "org": "work-org", "project": "Platform", "defaultRepo": "api", "pat": "..." },
    "personal": { "org": "me",        "project": "Sites",    "defaultRepo": "web", "patEnv": "AZDO_PAT_PERSONAL" }
  }
}
```

A **PR URL contains its org**, so read/comment commands pick the right profile
automatically — no `--profile` needed:

```sh
node azure.mjs pr    https://dev.azure.com/work-org/Platform/_git/api/pullrequest/42
node azure.mjs files https://dev.azure.com/me/Sites/_git/web/pullrequest/7
```

### Keep the PAT off disk (patEnv)

`patEnv` names an environment variable the PAT lives in, so nothing sensitive is
written to `azdo-profiles.json`. Inject it at runtime — for example from a
secrets manager that can run a command with the secret in the environment:

```sh
# The secret is only ever an env var of the child process, never on disk / in argv.
<secrets-manager> run azure-pat=AZDO_PAT_PERSONAL -- \
  node azure.mjs whoami --profile personal
```

## Repositories

```sh
# Create an empty git repo in the profile's project.
node azure.mjs create-repo web --profile personal

# ...or in an explicit project.
node azure.mjs create-repo web --project Sites --profile personal
```

## Pull requests

```sh
# Show a PR (full URL, or a bare id + --repo / the profile's defaultRepo).
node azure.mjs pr https://dev.azure.com/your-org/Your%20Project/_git/web/pullrequest/19
node azure.mjs pr 19 --repo web
node azure.mjs pr 19 --json                 # machine-readable

node azure.mjs files   19 --repo web        # changed files (latest iteration)
node azure.mjs threads 19 --repo web        # review threads (with thread + comment ids)
```

### Create / update a PR

Keep `--desc` a tight summary (Azure caps it at 4000 chars) and put the detail in
repeatable `--comment` threads:

```sh
node azure.mjs create-pr --repo web --source feature/hero --title "New hero" \
  --desc @pr-summary.md \
  --comment @architecture.md --comment @files-and-verification.md

node azure.mjs update-pr 19 --repo web --desc @pr-summary.md --comment @more.md
```

### Comments

```sh
node azure.mjs comment 19 --repo web "looks good"
node azure.mjs comment 19 --repo web @review.md          # body from a file

# Inline comment — the file must be in the PR diff (else it orphans; --force overrides).
node azure.mjs comment-file 19 web src/hero.astro 12 @note.md

# Redo a comment: find the thread, delete it, re-post.
node azure.mjs threads    19 --repo web
node azure.mjs del-thread 19 45 --repo web
```

## Raw REST

```sh
# Any REST 7.1 call; the path is appended to the org base, api-version added.
node azure.mjs raw GET "/Your%20Project/_apis/git/repositories"
node azure.mjs raw GET "/_apis/projects" --profile personal
```
