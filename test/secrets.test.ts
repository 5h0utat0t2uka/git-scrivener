import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import test from "node:test";
import { assertNoSecrets } from "../src/secrets.ts";
import { fixture } from "./fixture.ts";

test("scanner startup failure does not leave a timer keeping the process alive", (t) => {
  const repo = fixture(t, false);
  const source = new URL("../src/secrets.ts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import assert from 'node:assert/strict';
    import { assertNoSecrets } from ${JSON.stringify(source)};
    await assert.rejects(
      assertNoSecrets('ordinary text', { temporaryDirectory: process.cwd() }),
      /Could not run Betterleaks/
    );
  `,
    ],
    {
      cwd: repo.cwd,
      env: { ...repo.env, PATH: repo.cwd },
      encoding: "utf8",
      timeout: 5_000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(repo.cwd), []);
});

test("accepts ordinary text and removes its temporary directory", async (t) => {
  const repo = fixture(t, false);
  await assertNoSecrets("+add a staged-diff reader\n", {
    env: repo.env,
    temporaryDirectory: repo.cwd,
  });
  assert.deepEqual(readdirSync(repo.cwd), []);
});

test("does not pass either provider's API key to the scanner", async (t) => {
  const repo = fixture(t);
  const shell = repo.git(["var", "GIT_SHELL_PATH"]).trim();
  repo.write(
    "betterleaks",
    `#!${shell}
[ -z "\${OPENAI_API_KEY+x}" ] || exit 2
[ -z "\${ANTHROPIC_API_KEY+x}" ] || exit 2
cat > /dev/null
`,
  );
  chmodSync(join(repo.cwd, "betterleaks"), 0o700);
  const env = {
    ...repo.env,
    OPENAI_API_KEY: "test-openai-key",
    ANTHROPIC_API_KEY: "test-anthropic-key",
    PATH: `${repo.cwd}${delimiter}${repo.env.PATH ?? ""}`,
  };
  await assertNoSecrets("ordinary text\n", { env, temporaryDirectory: repo.cwd });
  assert.equal(env.OPENAI_API_KEY, "test-openai-key");
  assert.equal(env.ANTHROPIC_API_KEY, "test-anthropic-key");
});

test("uses embedded rules despite configuration overrides and inline allow comments", async (t) => {
  const repo = fixture(t, false);
  const bypass = "[allowlist]\nregexes = ['.*']\n";
  repo.write(".betterleaks.toml", bypass);
  repo.write(".gitleaks.toml", bypass);
  const token = "ghp_" + "aB3dE5gH7jK9mN2pQ4sT6vW8xY0zA1bC3dE5";
  await assert.rejects(
    assertNoSecrets(`token = "${token}" # betterleaks:allow\n`, {
      env: {
        ...repo.env,
        BETTERLEAKS_CONFIG: "/nonexistent-config",
        GITLEAKS_CONFIG: "/nonexistent-config",
        BETTERLEAKS_CONFIG_TOML: bypass,
        GITLEAKS_CONFIG_TOML: bypass,
      },
      temporaryDirectory: repo.cwd,
    }),
    /Potential secrets detected/,
  );
  assert.deepEqual(readdirSync(repo.cwd).sort(), [".betterleaks.toml", ".gitleaks.toml"]);
});
