import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { applyHash, findArtifact, parseReport } from "./apply-pnpm-hash.mjs";
import { hashFromFailure, isHash, replaceHash, updateHash } from "./update-pnpm-hash.mjs";

const source = readFileSync(new URL("../../nix/package.nix", import.meta.url), "utf8");
const hash = `sha256-${Buffer.alloc(32, 1).toString("base64")}`;
const oldHash = `sha256-${Buffer.alloc(32, 2).toString("base64")}`;
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const mismatch = (value = hash, derivation = "git-scrivener-pnpm-deps") => ({
  status: 1,
  signal: null,
  stderr:
    `error: hash mismatch in fixed-output derivation '/nix/store/abc-${derivation}.drv':\n` +
    `         specified: sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n` +
    `            got:    ${value}\n`,
});

test("only the literal pnpmDeps hash is replaced, preserving all other bytes", () => {
  const updated = replaceHash(source, hash);
  assert.equal(replaceHash(updated, ""), replaceHash(source, ""));
  assert.ok(updated.includes(`hash = "${hash}";`));
  assert.equal(replaceHash(updated, hash), updated);
  assert.throws(() => replaceHash(source + source, hash));
  assert.throws(() => replaceHash(source.replace("pkgs.fetchPnpmDeps", "pkgs.other"), hash));
  assert.throws(() => replaceHash(source, '"; builtins.abort "unexpected'));
});

test("only a canonical SHA-256 and the expected Nix failure are accepted", () => {
  assert.ok(isHash(hash));
  assert.equal(hashFromFailure(mismatch()), hash);
  for (const value of [null, "", "sha256-Zg==", `${hash}\n`, `sha256-${"B".repeat(43)}=`]) {
    assert.equal(isHash(value), false);
  }
  for (const result of [
    { status: 1, stderr: "download failed\ngot: " + hash },
    { ...mismatch(), status: 0 },
    { ...mismatch(), status: null, signal: "SIGTERM" },
    { ...mismatch(), error: new Error("ENOENT") },
    mismatch(hash, "unrelated-dependency"),
    { ...mismatch(), stderr: mismatch().stderr.repeat(2) },
    { ...mismatch(), stderr: mismatch().stderr.replace("AAAAAAAA", "BBBBBBBB") },
  ])
    assert.throws(() => hashFromFailure(result));
});

test("the updater refreshes only the hash and restores the source on failure", (t) => {
  const parent = new URL("../../.test-tmp/", import.meta.url);
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent.pathname, "dependency-hash-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, "nix"));
  const path = join(cwd, "nix/package.nix");
  writeFileSync(path, source);
  const result = updateHash({
    cwd,
    run: (command, args, options) => {
      assert.equal(command, "nix");
      assert.ok(args.includes("--no-write-lock-file"));
      assert.equal(options.cwd, cwd);
      assert.equal(readFileSync(path, "utf8"), replaceHash(source, ""));
      return mismatch();
    },
  });
  assert.deepEqual(result, { hash, changed: true });
  const updated = readFileSync(path, "utf8");
  assert.equal(updated, replaceHash(source, hash));
  assert.deepEqual(updateHash({ cwd, run: () => mismatch() }), { hash, changed: false });
  assert.throws(() => updateHash({ cwd, run: () => ({ status: 1, stderr: "Network failure" }) }));
  assert.equal(readFileSync(path, "utf8"), updated);
  assert.throws(() =>
    updateHash({
      cwd,
      run: () => {
        throw new Error("Cannot start Nix");
      },
    }),
  );
  assert.equal(readFileSync(path, "utf8"), updated);
});

function fixture() {
  const repository = { full_name: "owner/git-scrivener", default_branch: "main" };
  const pr = {
    number: 5,
    state: "open",
    user: { login: "dependabot[bot]" },
    head: { repo: repository, sha: headSha, ref: "dependabot/npm_and_yarn/group-123" },
    base: { repo: repository, sha: baseSha, ref: "main" },
  };
  const context = {
    repo: { owner: "owner", repo: "git-scrivener" },
    payload: {
      repository,
      workflow_run: {
        id: 100,
        run_attempt: 2,
        event: "pull_request",
        conclusion: "success",
        path: ".github/workflows/update-dependency-hash.yml",
        head_repository: repository,
        head_sha: headSha,
        head_branch: pr.head.ref,
      },
    },
  };
  const state = {
    context,
    pr,
    files: [{ filename: "pnpm-lock.yaml", status: "modified" }],
    base: source,
    current: replaceHash(source, oldHash),
    artifacts: [{ id: 10, name: "pnpm-dependency-hash-2", expired: false, size_in_bytes: 250 }],
    commits: [],
    report: JSON.stringify({ schemaVersion: 1, headSha, hash }),
  };
  const github = {
    rest: {
      repos: {
        listPullRequestsAssociatedWithCommit: () => {},
        getContent: async ({ path, ref }) => {
          assert.equal(path, "nix/package.nix");
          const content = ref === headSha ? state.current : state.base;
          return {
            data: {
              type: "file",
              encoding: "base64",
              size: content.length,
              content: Buffer.from(content).toString("base64"),
            },
          };
        },
      },
      pulls: { listFiles: () => {} },
      actions: { listWorkflowRunArtifacts: () => {} },
    },
    paginate: async (method, args) => {
      if (method === github.rest.repos.listPullRequestsAssociatedWithCommit) {
        assert.equal(args.commit_sha, headSha);
        return [state.pr];
      }
      if (method === github.rest.pulls.listFiles) return state.files;
      if (method === github.rest.actions.listWorkflowRunArtifacts) return state.artifacts;
      throw new Error("Unexpected API call");
    },
  };
  const writer = {
    graphql: async (query, { input }) => {
      assert.match(query, /createCommitOnBranch/);
      state.commits.push(input);
    },
  };
  return { ...state, state, github, writer };
}

test("the writer commits one hash change with an atomic expected head", async () => {
  const f = fixture();
  assert.equal(await findArtifact(f.github, f.context), 10);
  await applyHash(f.github, f.writer, f.context, f.report);
  assert.equal(f.commits.length, 1);
  const commit = f.commits[0];
  assert.equal(commit.expectedHeadOid, headSha);
  assert.equal(commit.message.body, "[dependabot skip]");
  assert.deepEqual(commit.branch, {
    repositoryNameWithOwner: "owner/git-scrivener",
    branchName: f.pr.head.ref,
  });
  assert.equal(commit.fileChanges.additions.length, 1);
  assert.equal(commit.fileChanges.additions[0].path, "nix/package.nix");
  assert.equal(
    Buffer.from(commit.fileChanges.additions[0].contents, "base64").toString(),
    replaceHash(f.state.current, hash),
  );
});

test("up-to-date hashes do not create commits or an update loop", async () => {
  const f = fixture();
  f.state.current = replaceHash(source, hash);
  assert.match(await applyHash(f.github, f.writer, f.context, f.report), /already up to date/);
  assert.equal(f.commits.length, 0);
});

test("Nix input updates use the same guarded hash update", async () => {
  const f = fixture();
  f.state.files = [{ filename: "flake.lock", status: "modified" }];
  await applyHash(f.github, f.writer, f.context, f.report);
  assert.equal(f.commits.length, 1);
});

test("forks, non-Dependabot PRs, stale or closed PRs, and other workflows cannot write", async () => {
  const changes = [
    (f) => {
      f.pr.head.repo = { full_name: "other/fork" };
    },
    (f) => {
      f.pr.user.login = "someone";
    },
    (f) => {
      f.pr.head.sha = "c".repeat(40);
    },
    (f) => {
      f.pr.state = "closed";
    },
    (f) => {
      f.pr.base.ref = "release";
    },
    (f) => {
      f.context.payload.workflow_run.path = ".github/workflows/other.yml";
    },
    (f) => {
      f.context.payload.workflow_run.event = "push";
    },
    (f) => {
      f.context.payload.workflow_run.conclusion = "failure";
    },
    (f) => {
      f.context.payload.workflow_run.head_repository = { full_name: "other/fork" };
    },
    (f) => {
      f.context.payload.workflow_run.head_branch = "main";
    },
  ];
  for (const change of changes) {
    const f = fixture();
    change(f);
    assert.equal(await findArtifact(f.github, f.context), null);
    assert.match(await applyHash(f.github, f.writer, f.context, f.report), /Skipped/);
    assert.equal(f.commits.length, 0);
  }
});

test("artifacts must belong to the current run attempt and be small and unique", async () => {
  for (const artifacts of [
    [],
    [{ id: 10, name: "pnpm-dependency-hash-1", expired: false, size_in_bytes: 250 }],
    [{ id: 10, name: "pnpm-dependency-hash-2", expired: true, size_in_bytes: 250 }],
    [{ id: 10, name: "pnpm-dependency-hash-2", expired: false, size_in_bytes: 65537 }],
  ]) {
    const f = fixture();
    f.state.artifacts = artifacts;
    await assert.rejects(findArtifact(f.github, f.context));
  }
  const f = fixture();
  f.state.artifacts.push({ ...f.state.artifacts[0], id: 11 });
  await assert.rejects(findArtifact(f.github, f.context));
});

test("untrusted reports cannot choose files, branches, scripts, or a different commit", () => {
  const valid = { schemaVersion: 1, headSha, hash };
  for (const report of [
    null,
    [],
    { ...valid, headSha: baseSha },
    { ...valid, schemaVersion: 2 },
    { ...valid, path: ".github/workflows/nix-build.yml" },
    { ...valid, hash: "$(command)" },
  ])
    assert.throws(() => parseReport(JSON.stringify(report), headSha));
  assert.throws(() => parseReport(" ".repeat(1025), headSha));
});

test("changes to automation or Nix package logic require manual review", async () => {
  for (const filename of [".github/scripts/apply-pnpm-hash.mjs", "flake.nix", "src/cli.ts"]) {
    const f = fixture();
    f.state.files.push({ filename, status: "modified" });
    await assert.rejects(applyHash(f.github, f.writer, f.context, f.report), /allowlist/);
    assert.equal(f.commits.length, 0);
  }
  const f = fixture();
  f.state.current = f.state.current.replace("doCheck = true", "doCheck = false");
  await assert.rejects(applyHash(f.github, f.writer, f.context, f.report), /package logic/);
  assert.equal(f.commits.length, 0);
});

test("a branch change at commit time fails without a forced retry", async () => {
  const f = fixture();
  let attempts = 0;
  f.writer.graphql = async () => {
    attempts++;
    throw new Error("Expected head does not match");
  };
  await assert.rejects(applyHash(f.github, f.writer, f.context, f.report), /Expected head/);
  assert.equal(attempts, 1);
});
