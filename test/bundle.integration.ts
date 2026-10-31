import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fixture } from "./fixture.ts";

const cli = resolve(process.env.SCRIVENER_TEST_CLI ?? "dist/cli.js");
const preload = fileURLToPath(new URL("./bundle-preload.ts", import.meta.url));

test("the bundle includes third-party license texts", () => {
  const notices = readFileSync(join(dirname(cli), "THIRD_PARTY_NOTICES.txt"), "utf8");
  for (const name of ["openai", "@anthropic-ai/sdk", "@clack/core", "@clack/prompts", "zod"]) {
    assert.ok(notices.includes(`${name}@`), `Missing notice for ${name}`);
  }
  assert.match(notices, /Apache License/);
  assert.match(notices, /Permission is hereby granted/);
  assert.match(notices, /standardwebhooks@/);
  assert.ok(notices.includes("Copyright (c) 2023 Svix"));
});

for (const provider of ["openai", "anthropic"] as const) {
  for (const language of ["en", "ja"] as const) {
    for (const action of ["c", "q", "r"] as const) {
      test(`bundled ${provider}/${language}: ${action} preserves staging and explicit confirmation`, (t) => {
        const repo = fixture(t);
        repo.write("file.txt", "staged content\n");
        repo.git(["add", "file.txt"]);
        repo.write("file.txt", "later unstaged content\n");
        const index = repo.git(["ls-files", "--stage", "-z"]);
        const result = spawnSync(
          process.execPath,
          ["--import", preload, cli, "--plain", "--provider", provider, "--language", language],
          {
            cwd: repo.cwd,
            env: {
              ...repo.env,
              TMPDIR: repo.cwd,
              ...(provider === "openai"
                ? { OPENAI_API_KEY: "test-openai-key" }
                : { ANTHROPIC_API_KEY: "test-anthropic-key" }),
            },
            input: `${action}\n`,
            encoding: "utf8",
            timeout: 20_000,
          },
        );
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const subject = `feat(cli): ${language === "ja" ? "ステージ済みの変更を追加" : "add staged changes"}`;
        assert.ok(result.stdout.includes(subject), result.stdout);
        const requests = JSON.parse(readFileSync(join(repo.cwd, "requests.json"), "utf8")) as {
          url: string;
          body: {
            model: string;
            input?: { content: string }[];
            messages?: { content: string }[];
          };
        }[];
        assert.equal(requests.length, action === "r" ? 2 : 1);
        for (const request of requests) {
          assert.equal(
            request.body.model,
            provider === "openai" ? "gpt-6-luna" : "claude-haiku-5-5",
          );
          assert.equal(
            request.url,
            provider === "openai"
              ? "https://api.openai.com/v1/responses"
              : "https://api.anthropic.com/v1/messages",
          );
          const input = request.body.input ?? request.body.messages;
          assert.ok(input?.[0]);
          const data = JSON.parse(input[0].content) as { diff: string; previousCandidate?: string };
          assert.match(data.diff, /\+staged content/);
          assert.doesNotMatch(data.diff, /later unstaged content/);
          if (request === requests[1]) assert.equal(data.previousCandidate, subject);
        }
        assert.equal(readFileSync(join(repo.cwd, "file.txt"), "utf8"), "later unstaged content\n");
        assert.equal(repo.git(["ls-files", "--stage", "-z"]), index);
        if (action === "c") {
          assert.match(result.stdout, /Commit created/);
          assert.equal(repo.git(["log", "-1", "--format=%B"]).trim(), subject);
          assert.equal(repo.git(["show", "HEAD:file.txt"]), "staged content\n");
        } else {
          assert.match(result.stdout, /Cancelled\. No commit was created/);
          repo.git(["rev-parse", "--verify", "--quiet", "HEAD"], { status: 1 });
          if (action === "r") assert.match(result.stdout, /Regenerated candidate\./);
        }
      });
    }
  }
}
