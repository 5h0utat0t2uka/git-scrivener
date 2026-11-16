import { isHash, packagePath, replaceHash } from "./update-pnpm-hash.mjs";

const workflowPath = ".github/workflows/update-dependency-hash.yml";
const allowedFiles = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "flake.lock",
  packagePath,
]);

export function parseReport(text, headSha) {
  if (Buffer.byteLength(text) > 1024) throw new Error("Hash report is too large.");
  const report = JSON.parse(text);
  if (
    !report ||
    Object.keys(report).sort().join(",") !== "hash,headSha,schemaVersion" ||
    report.schemaVersion !== 1 ||
    report.headSha !== headSha ||
    !isHash(report.hash)
  )
    throw new Error("Invalid hash report or unexpected source commit.");
  return report;
}

export async function findPullRequest(github, context) {
  const run = context.payload.workflow_run;
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  if (
    run.event !== "pull_request" ||
    run.conclusion !== "success" ||
    run.path !== workflowPath ||
    run.head_repository?.full_name !== repository ||
    !/^[a-f0-9]{40}$/.test(run.head_sha) ||
    !run.head_branch?.startsWith("dependabot/")
  )
    return null;

  const prs = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, {
    ...context.repo,
    commit_sha: run.head_sha,
    per_page: 100,
  });
  const matches = prs.filter(
    (pr) =>
      pr.state === "open" &&
      pr.user.login === "dependabot[bot]" &&
      pr.head.repo?.full_name === repository &&
      pr.base.repo?.full_name === repository &&
      pr.head.sha === run.head_sha &&
      pr.head.ref === run.head_branch &&
      pr.base.ref === context.payload.repository.default_branch,
  );
  if (matches.length !== 1) return null;
  return matches[0];
}

export async function findArtifact(github, context) {
  if (!(await findPullRequest(github, context))) return null;
  const run = context.payload.workflow_run;
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
    ...context.repo,
    run_id: run.id,
    per_page: 100,
  });
  const matches = artifacts.filter(
    (artifact) => artifact.name === `pnpm-dependency-hash-${run.run_attempt}` && !artifact.expired,
  );
  if (matches.length !== 1 || matches[0].size_in_bytes > 65536) {
    throw new Error("Expected one small hash report from this run attempt.");
  }
  return matches[0].id;
}

async function readPackage(github, repo, ref) {
  const { data } = await github.rest.repos.getContent({ ...repo, path: packagePath, ref });
  if (data.type !== "file" || data.encoding !== "base64" || data.size > 65536) {
    throw new Error("Expected a small, regular Nix package definition.");
  }
  return Buffer.from(data.content, "base64").toString("utf8");
}

export async function applyHash(github, writer, context, text) {
  const pr = await findPullRequest(github, context);
  if (!pr) return "Skipped: PR was closed, changed, or is not an eligible Dependabot PR.";
  const report = parseReport(text, pr.head.sha);
  const files = await github.paginate(github.rest.pulls.listFiles, {
    ...context.repo,
    pull_number: pr.number,
    per_page: 100,
  });
  if (
    !files.length ||
    files.some((file) => !allowedFiles.has(file.filename) || file.status !== "modified")
  ) {
    throw new Error("Refusing to update a PR that changes files outside the dependency allowlist.");
  }
  const source = await readPackage(github, context.repo, pr.head.sha);
  const base = await readPackage(github, context.repo, pr.base.sha);
  if (replaceHash(source, "") !== replaceHash(base, "")) {
    throw new Error("The PR changes package logic, not just pnpmDeps.hash; review it manually.");
  }
  const updated = replaceHash(source, report.hash);
  if (updated === source) return "pnpmDeps.hash is already up to date.";

  // The server checks the complete branch head atomically. A file SHA alone
  // would miss concurrent changes to package.json or either lockfile.
  await writer.graphql(
    `
    mutation($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) { commit { oid } }
    }
  `,
    {
      input: {
        branch: {
          repositoryNameWithOwner: `${context.repo.owner}/${context.repo.repo}`,
          branchName: pr.head.ref,
        },
        expectedHeadOid: pr.head.sha,
        message: {
          headline: "chore(nix): refresh pnpm dependency hash",
          // This derived file can be regenerated after Dependabot rebases.
          // Without this marker, our commit blocks its automatic rebases.
          body: "[dependabot skip]",
        },
        fileChanges: {
          additions: [{ path: packagePath, contents: Buffer.from(updated).toString("base64") }],
        },
      },
    },
  );
  return `Updated pnpmDeps.hash in PR #${pr.number}. Build checks will run on the new commit.`;
}
