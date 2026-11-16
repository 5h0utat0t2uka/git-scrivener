import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

export const packagePath = "nix/package.nix";

export function isHash(value) {
  return (
    typeof value === "string" &&
    /^sha256-[A-Za-z0-9+/]{43}=$/.test(value) &&
    Buffer.from(value.slice(7), "base64").toString("base64") === value.slice(7)
  );
}

// Intentionally require the current, unambiguous package layout. A layout change
// needs a review of this updater instead of editing an arbitrary Nix hash.
export function replaceHash(source, hash) {
  if (hash !== "" && !isHash(hash)) throw new Error("Invalid SHA-256 SRI hash.");
  const blocks = [...source.matchAll(/^  pnpmDeps = pkgs\.fetchPnpmDeps \{\n[\s\S]*?^  \};/gm)];
  if (blocks.length !== 1) throw new Error("Expected one pnpmDeps definition.");
  const block = blocks[0];
  const hashes = [...block[0].matchAll(/^    hash = "([^"]*)";$/gm)];
  if (hashes.length !== 1) throw new Error("Expected one literal pnpmDeps.hash.");
  const previous = hashes[0][1];
  if (previous !== "" && !isHash(previous)) throw new Error("Invalid existing hash.");
  const offset = block.index + hashes[0].index;
  return (
    source.slice(0, offset) + `    hash = "${hash}";` + source.slice(offset + hashes[0][0].length)
  );
}

export function hashFromFailure(result) {
  if (result.error || result.signal || result.status === 0 || result.status === null) {
    throw new Error("Expected a completed Nix hash-mismatch failure.");
  }
  const log = stripVTControlCharacters(result.stderr ?? "");
  const mismatches = [
    ...log.matchAll(
      /error: hash mismatch in fixed-output derivation '([^'\n]+)':\s+specified:\s+(sha256-[A-Za-z0-9+/=]+)\s+got:\s+(sha256-[A-Za-z0-9+/=]+)/g,
    ),
  ];
  if (
    mismatches.length !== 1 ||
    !/^\/nix\/store\/[^/]+-git-scrivener-pnpm-deps\.drv$/.test(mismatches[0][1]) ||
    mismatches[0][2] !== "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" ||
    !isHash(mismatches[0][3])
  ) {
    throw new Error("Nix failed without the expected pnpmDeps hash mismatch; see the build log.");
  }
  return mismatches[0][3];
}

export function updateHash({ cwd = process.cwd(), run = spawnSync } = {}) {
  const file = resolve(cwd, packagePath);
  const original = readFileSync(file, "utf8");
  let updated;
  try {
    writeFileSync(file, replaceHash(original, ""));
    const result = run(
      "nix",
      [
        "build",
        "--no-link",
        "--no-write-lock-file",
        "--print-build-logs",
        ".#git-scrivener.pnpmDeps",
      ],
      {
        cwd,
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
        maxBuffer: 32 * 1024 * 1024,
        timeout: 25 * 60 * 1000,
      },
    );
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    const hash = hashFromFailure(result);
    updated = replaceHash(original, hash);
    return { hash, changed: updated !== original };
  } finally {
    writeFileSync(file, updated ?? original);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const reportPath = process.argv[2];
    const headSha = process.env.SCRIVENER_HEAD_SHA;
    if (reportPath && !/^[a-f0-9]{40}$/.test(headSha ?? "")) {
      throw new Error("A report requires SCRIVENER_HEAD_SHA.");
    }
    const { hash, changed } = updateHash();
    if (reportPath) {
      writeFileSync(reportPath, JSON.stringify({ schemaVersion: 1, headSha, hash }) + "\n");
    }
    const message = `${changed ? "Updated" : "Unchanged"} pnpmDeps.hash: ${hash}\n`;
    process.stdout.write(message);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, message);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
