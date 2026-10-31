// Run manually: node test/benchmark.ts .benchmarks/runtime.json label=path/to/dist/cli.js [...]
// Fresh processes, warm filesystem caches, real Git/Betterleaks, mocked API, always cancel.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { arch, cpus, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const [output, ...inputs] = process.argv.slice(2);
assert.ok(output && inputs.length > 0, "Specify an output JSON file and label=CLI pairs.");
const variants = inputs.map((input) => {
  const separator = input.indexOf("=");
  assert.ok(separator > 0 && separator < input.length - 1);
  return { label: input.slice(0, separator), cli: resolve(input.slice(separator + 1)) };
});
assert.equal(new Set(variants.map(({ label }) => label)).size, variants.length);
const parent = fileURLToPath(new URL("../.benchmarks/", import.meta.url));
mkdirSync(parent, { recursive: true, mode: 0o700 });
const cwd = mkdtempSync(join(parent, "runtime-"));
const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(?:GIT_|OPENAI_|ANTHROPIC_|SCRIVENER_TEST_|NODE_OPTIONS$|NODE_PATH$|NODE_COMPILE_CACHE$)/.test(
          key,
        ),
    ),
  ),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CEILING_DIRECTORIES: parent,
  GIT_TERMINAL_PROMPT: "0",
  NODE_DISABLE_COMPILE_CACHE: "1",
  TMPDIR: cwd,
  OPENAI_API_KEY: "test-openai-key",
  ANTHROPIC_API_KEY: "test-anthropic-key",
};
const preload = fileURLToPath(new URL("./bundle-preload.ts", import.meta.url));
const warmup = 3;
const runs = 20;
const cases = [
  { name: "help", args: ["--help"], mock: false, expected: /Usage: git scrivener/ },
  { name: "version", args: ["--version"], mock: false, expected: /^\d+\.\d+\.\d+/ },
  { name: "check", args: ["--check"], mock: false, expected: /Staged diff ready/ },
  ...["openai", "anthropic"].map((provider) => ({
    name: `${provider}-generate-cancel`,
    args: ["--plain", "--provider", provider],
    mock: true,
    expected: /Cancelled\. No commit was created/,
  })),
];
const samples: Record<string, Record<string, number[]>> = Object.fromEntries(
  variants.map(({ label }) => [label, Object.fromEntries(cases.map(({ name }) => [name, []]))]),
);

function git(args: string[]) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

try {
  git(["init", "--initial-branch=main", "--template="]);
  const hooks = join(cwd, "empty-hooks");
  mkdirSync(hooks);
  git(["config", "core.hooksPath", hooks]);
  writeFileSync(join(cwd, "file.txt"), "staged content\n");
  git(["add", "file.txt"]);
  const index = git(["ls-files", "--stage", "-z"]);
  for (const scenario of cases) {
    for (let round = -warmup; round < runs; round++) {
      // Alternate variant order to reduce systematic thermal/background-load bias.
      const order = round % 2 === 0 ? variants : [...variants].reverse();
      for (const variant of order) {
        const args = [
          ...(scenario.mock ? ["--import", preload] : []),
          variant.cli,
          ...scenario.args,
        ];
        const start = performance.now();
        const result = spawnSync(process.execPath, args, {
          cwd,
          env,
          input: "q\n",
          encoding: "utf8",
          timeout: 20_000,
        });
        const milliseconds = performance.now() - start;
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, scenario.expected);
        if (round >= 0) samples[variant.label]![scenario.name]!.push(milliseconds);
      }
    }
    console.log(`Measured ${scenario.name}`);
  }
  assert.equal(git(["ls-files", "--stage", "-z"]), index);
  assert.equal(git(["rev-list", "--all", "--count"]).trim(), "0");
  const results = variants.map(({ label, cli }) => {
    const dir = dirname(cli);
    const files = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((file) => file.isFile())
      .map((file) => ({ name: file.name, data: readFileSync(join(file.parentPath, file.name)) }));
    const javascript = files.filter((file) => /\.[cm]?js$/.test(file.name));
    return {
      label,
      cli,
      javascriptBytes: javascript.reduce((sum, file) => sum + file.data.length, 0),
      javascriptGzipBytes: javascript.reduce((sum, file) => sum + gzipSync(file.data).length, 0),
      distBytes: files.reduce((sum, file) => sum + file.data.length, 0),
      cases: Object.entries(samples[label]!).map(([name, milliseconds]) => {
        const mean = milliseconds.reduce((sum, value) => sum + value, 0) / milliseconds.length;
        return {
          name,
          meanMs: mean,
          stddevMs: Math.sqrt(
            milliseconds.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
              (milliseconds.length - 1),
          ),
          minMs: Math.min(...milliseconds),
          maxMs: Math.max(...milliseconds),
          samplesMs: milliseconds,
        };
      }),
    };
  });
  writeFileSync(
    output,
    `${JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        node: process.version,
        platform: platform(),
        arch: arch(),
        cpu: cpus()[0]?.model,
        warmup,
        runs,
        compileCache: false,
        network: "mocked",
        results,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Saved ${output}`);
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
