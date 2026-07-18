// Offline self-test — no network, no credentials, no real config touched.
// Drives the CLI as a subprocess with a throwaway profiles file (via
// AZDO_PROFILES_FILE) and a fully-specified fake env, so nothing reads the
// developer's real .env / azdo-profiles.json. Every case here fails BEFORE any
// HTTP call, so the suite is hermetic.
//
//   npm test   (Node 18+, built-in test runner — zero dependencies)

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "azure.mjs");

// A throwaway profiles file: 'work' (inline pat), 'personal' (pat via env var).
const PROFILES = {
  default: "work",
  profiles: {
    work: { org: "work-org", project: "Platform", defaultRepo: "api", pat: "WORK-SECRET" },
    personal: { org: "me-org", patEnv: "AZDO_PAT_PERSONAL" },
  },
};
const dir = mkdtempSync(join(tmpdir(), "azure-selftest-"));
const profilesFile = join(dir, "azdo-profiles.json");
writeFileSync(profilesFile, JSON.stringify(PROFILES));

// Base env fully pins the default (.env) profile so the real .env is never used.
function run(args, extraEnv = {}) {
  const env = {
    ...process.env,
    AZDO_ORG: "env-org",
    AZDO_PROJECT: "Env Project",
    AZDO_PAT: "ENV-SECRET",
    AZDO_DEFAULT_REPO: "env-repo",
    AZDO_PROFILES_FILE: profilesFile,
    AZDO_PROFILE: "", // don't inherit a real one
    ...extraEnv,
  };
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout || "", stderr: e.stderr || "" };
  }
}

test("profiles: lists all profiles, json 'default' wins over the .env one", () => {
  const { code, stdout } = run(["profiles"], { AZDO_PAT_PERSONAL: "PERSONAL-SECRET" });
  assert.equal(code, 0);
  assert.match(stdout, /work {2}\(default\)/); // json default overrides .env
  assert.match(stdout, /org=work-org/);
  assert.match(stdout, /org=me-org/);
  assert.match(stdout, /org=env-org/); // .env profile still listed
  assert.match(stdout, /pat=set/); // inline pat present
  assert.match(stdout, /pat=from env AZDO_PAT_PERSONAL/); // env-backed pat resolved
});

test("profiles: never prints PAT values", () => {
  const { stdout } = run(["profiles"], { AZDO_PAT_PERSONAL: "PERSONAL-SECRET" });
  assert.doesNotMatch(stdout, /WORK-SECRET|ENV-SECRET|PERSONAL-SECRET/);
});

test("profiles: patEnv unset reads as MISSING (no crash)", () => {
  const { code, stdout } = run(["profiles"]); // AZDO_PAT_PERSONAL not set
  assert.equal(code, 0);
  assert.match(stdout, /org=me-org.*pat=MISSING/s);
});

test("unknown --profile errors with the configured names", () => {
  const { code, stderr } = run(["whoami", "--profile", "nope"]);
  assert.notEqual(code, 0);
  assert.match(stderr, /unknown profile "nope"/);
});

test("a PR URL for an unconfigured org errors before any network call", () => {
  const url = "https://dev.azure.com/ghost-org/Proj/_git/repo/pullrequest/5";
  const { code, stderr } = run(["pr", url]);
  assert.notEqual(code, 0);
  assert.match(stderr, /no profile configured for org "ghost-org"/);
});

test("create-repo without a project (profile has none) errors clearly", () => {
  const { code, stderr } = run(["create-repo", "foo", "--profile", "personal"], {
    AZDO_PAT_PERSONAL: "PERSONAL-SECRET",
  });
  assert.notEqual(code, 0);
  assert.match(stderr, /create-repo needs a project/);
});

test("bare PR id with no repo (profile has none) errors for --repo", () => {
  const { code, stderr } = run(["pr", "5", "--profile", "personal"], {
    AZDO_PAT_PERSONAL: "PERSONAL-SECRET",
  });
  assert.notEqual(code, 0);
  assert.match(stderr, /bare PR id needs --repo/);
});

test("bare PR id with a repo but no project errors for the project", () => {
  const { code, stderr } = run(["pr", "5", "--repo", "web", "--profile", "personal"], {
    AZDO_PAT_PERSONAL: "PERSONAL-SECRET",
  });
  assert.notEqual(code, 0);
  assert.match(stderr, /bare PR id needs a project/);
});
