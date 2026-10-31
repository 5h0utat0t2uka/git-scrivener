// Build a controlled benchmark baseline from current sources; never change src/ or dist/.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsdown";
import config from "../tsdown.config.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = join(root, ".benchmarks", "sdk-eager");
mkdirSync(destination, { recursive: true });
cpSync(join(root, "src"), join(destination, "src"), { recursive: true });
cpSync(join(root, "package.json"), join(destination, "package.json"));
const path = join(destination, "src", "generate.ts");
let source = readFileSync(path, "utf8");
for (const [from, to] of [
  [
    'import type { CommitCandidate } from "./candidate.ts";',
    'import { CommitCandidate } from "./candidate.ts";',
  ],
  [
    'provider === "openai" ? await import("openai") : await import("@anthropic-ai/sdk")',
    'provider === "openai" ? openaiSDK : anthropicSDK',
  ],
  ['  const { CommitCandidate } = await import("./candidate.ts");\n', ""],
  ['      const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");\n', ""],
  ['    const { zodTextFormat } = await import("openai/helpers/zod");\n', ""],
] as const) {
  assert.ok(source.includes(from), `Baseline transformation no longer matches: ${from}`);
  source = source.replace(from, to);
}
source = `import * as openaiSDK from "openai";
import * as anthropicSDK from "@anthropic-ai/sdk";
import { zodTextFormat } from "openai/helpers/zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
${source}`;
writeFileSync(path, source);
await build({
  ...config,
  config: false,
  entry: [join(destination, "src", "cli.ts")],
  outDir: join(destination, "dist"),
});
