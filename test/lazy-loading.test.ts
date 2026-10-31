import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fixture } from "./fixture.ts";

const cli = process.env.SCRIVENER_TEST_CLI
  ? resolve(process.env.SCRIVENER_TEST_CLI)
  : fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const trace = fileURLToPath(new URL("./module-load-preload.ts", import.meta.url));
const mock = fileURLToPath(new URL("./bundle-preload.ts", import.meta.url));
const bundleMap = process.env.SCRIVENER_TEST_CLI
  ? (JSON.parse(readFileSync(join(dirname(cli), "bundle-load-map.json"), "utf8")) as {
      file: string;
      modules: string[];
    }[])
  : undefined;

function loadedModules(path: string) {
  const urls = JSON.parse(readFileSync(path, "utf8")) as string[];
  assert.ok(urls.length > 0, "The module tracer must observe the CLI");
  const files = urls.filter((url) => url.startsWith("file:")).map((url) => fileURLToPath(url));
  if (!bundleMap) return files;
  const chunks = files.map((file) => relative(dirname(cli), file));
  assert.ok(chunks.includes("cli.js"));
  return bundleMap.filter((chunk) => chunks.includes(chunk.file)).flatMap((chunk) => chunk.modules);
}

function assertLoaded(modules: string[], provider?: "openai" | "anthropic") {
  for (const [name, marker] of [
    ["openai", "node_modules/openai/"],
    ["anthropic", "node_modules/@anthropic-ai/sdk/"],
  ] as const) {
    assert.equal(
      modules.some((id) => id.includes(marker)),
      provider === name,
      `${name} SDK`,
    );
    assert.equal(
      modules.some((id) => id.includes(`${marker}helpers/zod.`)),
      provider === name,
      `${name} helper`,
    );
  }
  assert.equal(
    modules.some((id) => id.includes("node_modules/zod/")),
    provider !== undefined,
  );
}

for (const flag of ["--help", "--version", "--check"]) {
  test(`${flag} loads neither SDK, provider helper, nor schema runtime`, (t) => {
    const repo = fixture(t);
    repo.write("file.txt", "staged content\n");
    repo.git(["add", "file.txt"]);
    for (const provider of ["openai", "anthropic"]) {
      const log = join(repo.cwd, "modules.json");
      const result = spawnSync(
        process.execPath,
        ["--import", trace, cli, flag, "--provider", provider],
        {
          cwd: repo.cwd,
          env: { ...repo.env, SCRIVENER_TEST_MODULE_LOG: log },
          encoding: "utf8",
          timeout: 20_000,
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assertLoaded(loadedModules(log));
    }
  });
}

for (const provider of ["openai", "anthropic"] as const) {
  for (const scenario of ["generate", "http-error", "secret"] as const) {
    test(`${provider}/${scenario} loads only the required SDK after secret scanning`, (t) => {
      const repo = fixture(t);
      const token = "ghp_" + "aB3dE5gH7jK9mN2pQ4sT6vW8xY0zA1bC3dE5";
      repo.write("file.txt", scenario === "secret" ? `token = "${token}"\n` : "staged content\n");
      repo.git(["add", "file.txt"]);
      const index = repo.git(["ls-files", "--stage", "-z"]);
      const log = join(repo.cwd, "modules.json");
      const result = spawnSync(
        process.execPath,
        ["--import", trace, "--import", mock, cli, "--plain", "--provider", provider],
        {
          cwd: repo.cwd,
          env: {
            ...repo.env,
            TMPDIR: repo.cwd,
            SCRIVENER_TEST_MODULE_LOG: log,
            SCRIVENER_TEST_HTTP_STATUS: scenario === "http-error" ? "401" : "200",
            OPENAI_API_KEY: "test-openai-key",
            ANTHROPIC_API_KEY: "test-anthropic-key",
          },
          input: "q\n",
          encoding: "utf8",
          timeout: 20_000,
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, scenario === "generate" ? 0 : 1, result.stdout + result.stderr);
      assertLoaded(loadedModules(log), scenario === "secret" ? undefined : provider);
      if (scenario === "generate") assert.match(result.stdout, /Cancelled/);
      if (scenario === "http-error") assert.match(result.stdout + result.stderr, /HTTP 401/);
      if (scenario === "secret") assert.match(result.stdout + result.stderr, /secret/i);
      assert.equal(repo.git(["ls-files", "--stage", "-z"]), index);
      repo.git(["rev-parse", "--verify", "--quiet", "HEAD"], { status: 1 });
    });
  }
}
