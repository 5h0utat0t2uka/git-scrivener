import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class SecretScanError extends Error {}
export class SecretFindingError extends SecretScanError {}

export interface SecretAllowance {
  rule: string;
  path: string;
}

export function parseSecretAllowances(values: readonly string[]): SecretAllowance[] {
  return values.map((value) => {
    const separator = value.indexOf(":");
    const rule = value.slice(0, separator);
    const path = value.slice(separator + 1);
    if (
      separator < 1 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(rule) ||
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path) ||
      path.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new SecretScanError(
        "--allow-secret requires RULE:PATH with an exact repository-relative file path.",
      );
    }
    return { rule, path };
  });
}

interface Finding {
  rule: string;
  start: number;
  end: number;
}

interface Location {
  path: string;
  file: Buffer | undefined;
  line: number;
  kind: string;
}

const detectionMessage = "Potential secrets detected in the data to send. No request was made.";
const reportLimit = 256 * 1024;
const displayLimit = 20;

function parseFindings(report: string, lineCount: number): Finding[] | undefined {
  // The fixed template terminates every record; a missing terminator may indicate truncation.
  if (!report.endsWith("\n")) return undefined;
  const findings: Finding[] = [];
  for (const line of report.slice(0, -1).split("\n")) {
    const match = /^([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})\t([0-9]+)\t([0-9]+)$/.exec(line);
    if (!match) return undefined;
    const start = Number(match[2]);
    const end = Number(match[3]);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 1 ||
      end < start ||
      end > lineCount
    ) {
      return undefined;
    }
    findings.push({ rule: match[1]!, start, end });
  }
  return findings;
}

function patchPath(
  header: string,
  prefix: "a/" | "b/",
): { path: string; file: Buffer } | undefined {
  let path = header.replace(/\t$/, "");
  let file: Buffer;
  if (path.startsWith(prefix)) {
    path = path.slice(prefix.length);
    file = Buffer.from(path);
  } else if (path.startsWith(`"${prefix}`) && path.endsWith('"')) {
    path = `"${path.slice(3)}`;
    // Decode Git's byte-oriented C quoting for exact matching, while keeping it for display.
    const quoted = path.slice(1, -1);
    const parts = quoted.match(/\\(?:[0-3][0-7]{2}|[abfnrtv\\"])|[^\\]+/g) ?? [];
    if (parts.join("") !== quoted) return undefined;
    const escapes: Record<string, string> = {
      a: "\x07",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      "\\": "\\",
      '"': '"',
    };
    file = Buffer.concat(
      parts.map((part) => {
        if (!part.startsWith("\\")) return Buffer.from(part);
        if (part.length === 4) return Buffer.from([Number.parseInt(part.slice(1), 8)]);
        return Buffer.from(escapes[part[1]!]!);
      }),
    );
  } else return undefined;
  const display = path.replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (character) => `\\u{${character.codePointAt(0)!.toString(16)}}`,
  );
  return { path: display, file };
}

function diffLocations(lines: string[]): Location[] {
  let oldPath: ReturnType<typeof patchPath>;
  let newPath: ReturnType<typeof patchPath>;
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  return lines.map((line, index) => {
    const fallback = { path: "staged diff", file: undefined, line: index + 1, kind: "patch line" };
    if (line.startsWith("diff --git ")) {
      oldPath = newPath = undefined;
      oldRemaining = newRemaining = 0;
    } else if (oldRemaining > 0 || newRemaining > 0) {
      // Inspect hunk prefixes before headers: a deleted line may itself begin with --.
      if (line.startsWith("-") && oldRemaining > 0) {
        oldRemaining--;
        oldLine++;
        return oldPath ? { ...oldPath, line: oldLine - 1, kind: "removed, HEAD" } : fallback;
      }
      if (line.startsWith("+") && newRemaining > 0) {
        newRemaining--;
        newLine++;
        return newPath ? { ...newPath, line: newLine - 1, kind: "added, staged" } : fallback;
      }
      if (line.startsWith(" ") && oldRemaining > 0 && newRemaining > 0) {
        oldRemaining--;
        newRemaining--;
        oldLine++;
        newLine++;
        return newPath ? { ...newPath, line: newLine - 1, kind: "context, staged" } : fallback;
      }
      if (line.startsWith("\\")) return fallback; // No newline at end of file.
      oldRemaining = newRemaining = 0;
    } else if (line.startsWith("--- ")) {
      oldPath = patchPath(line.slice(4), "a/");
    } else if (line.startsWith("+++ ")) {
      newPath = patchPath(line.slice(4), "b/");
    } else {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hunk) {
        oldLine = Number(hunk[1]);
        oldRemaining = Number(hunk[2] ?? 1);
        newLine = Number(hunk[3]);
        newRemaining = Number(hunk[4] ?? 1);
      }
    }
    return fallback;
  });
}

function scanLocations(diffLines: string[], previousLines: string[]): Location[] {
  const patchLocations = diffLocations(diffLines);
  return [
    ...patchLocations,
    ...previousLines.map((_line, index) => ({
      path: "previous candidate",
      file: undefined,
      line: index + 1,
      kind: "message line",
    })),
    ...patchLocations,
  ];
}

function findingMessage(findings: Finding[], locations: Location[]): string {
  const groups = new Map<string, { rule: string; location: Location; lines: Set<number> }>();
  for (const finding of findings) {
    for (let index = finding.start - 1; index < finding.end; index++) {
      const location = locations[index]!;
      const key = JSON.stringify([finding.rule, location.path, location.kind]);
      let group = groups.get(key);
      if (!group) {
        group = { rule: finding.rule, location, lines: new Set() };
        groups.set(key, group);
      }
      group.lines.add(location.line);
    }
  }
  const details: string[] = [];
  for (const { rule, location, lines } of groups.values()) {
    const sorted = [...lines].sort((a, b) => a - b);
    for (let index = 0; index < sorted.length; index++) {
      const start = sorted[index]!;
      let end = start;
      while (sorted[index + 1] === end + 1) end = sorted[++index]!;
      const range = start === end ? String(start) : `${start}-${end}`;
      details.push(`${rule} — ${location.path}:${range} (${location.kind})`);
    }
  }
  const visible = details.slice(0, displayLimit);
  if (details.length > displayLimit) {
    visible.push(`${details.length - displayLimit} more locations omitted.`);
  }
  return [
    detectionMessage,
    ...visible,
    "Locations use staged-file, HEAD, or previous-candidate line numbers.",
  ].join("\n");
}

export async function assertNoSecrets(
  diff: string,
  {
    env = process.env,
    temporaryDirectory = tmpdir(),
    previousCandidate = "",
    allowSecrets = [],
  }: {
    env?: NodeJS.ProcessEnv;
    temporaryDirectory?: string;
    previousCandidate?: string;
    allowSecrets?: readonly SecretAllowance[];
  } = {},
): Promise<void> {
  const diffLines = diff.split("\n");
  const previousLines = previousCandidate.split("\n");
  const allowances = allowSecrets.map(({ rule, path }) => ({ rule, file: Buffer.from(path) }));
  // Removing patch prefixes also detects multiline secrets. Preserve line counts for diagnostics.
  const normalizedDiff = diffLines.map((line) => line.replace(/^[ +-]/, "")).join("\n");
  const text = [diff, previousCandidate, normalizedDiff].join("\n");
  const directory = await mkdtemp(join(temporaryDirectory, "git-scrivener-scan-"));
  try {
    const template = join(directory, "locations.tmpl");
    // Only these metadata fields cross the pipe. Source lines, matches, and secrets are excluded.
    await writeFile(
      template,
      '{{range .}}{{printf "%s\\t%d\\t%d\\n" .RuleID .StartLine .EndLine}}{{end}}',
      { mode: 0o600 },
    );
    // Ignore target-repository policy and never give the scanner our API credentials.
    const scanEnv = Object.fromEntries(
      Object.entries(env).filter(
        ([key]) => !/^(?:BETTERLEAKS_|GITLEAKS_|OPENAI_|ANTHROPIC_)/.test(key),
      ),
    );
    scanEnv.BETTERLEAKS_CONFIG_TOML = "[extend]\nuseDefault = true\n";

    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "betterleaks",
        [
          "stdin",
          "--no-banner",
          "--no-color",
          "--redact=100",
          "--report-format=template",
          `--report-template=${template}`,
          "--report-path=-",
          "--log-level=error",
          "--exit-code=42",
          "--ignore-gitleaks-allow",
          "--gitleaks-ignore-path=/dev/null",
          "--validation=false",
          "--max-target-megabytes=0",
          "--timeout=30",
        ],
        {
          cwd: directory,
          env: scanEnv,
          stdio: ["pipe", "pipe", "ignore"],
          // Unlike spawn's timeout, this does not keep Node alive after an ENOENT error.
          signal: AbortSignal.timeout(35_000),
          killSignal: "SIGKILL",
        },
      );
      let inputFailed = false;
      let reportBytes = 0;
      const chunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => {
        reportBytes += chunk.length;
        if (reportBytes <= reportLimit) chunks.push(chunk);
      });
      child.stdin.on("error", () => {
        inputFailed = true;
      });
      child.once("error", () => {
        reject(new SecretScanError("Could not run Betterleaks. No request was made."));
      });
      child.once("close", (code, signal) => {
        if (code === 42) {
          const findings =
            reportBytes <= reportLimit && signal === null && !inputFailed
              ? parseFindings(
                  Buffer.concat(chunks).toString("utf8"),
                  diffLines.length * 2 + previousLines.length,
                )
              : undefined;
          if (!findings) {
            reject(
              new SecretScanError(
                `${detectionMessage}\nFinding locations are unavailable because the scanner report was incomplete or invalid.`,
              ),
            );
            return;
          }
          const locations = scanLocations(diffLines, previousLines);
          const remaining = findings.filter(
            (finding) =>
              !allowances.some(
                (allowance) =>
                  allowance.rule === finding.rule &&
                  locations
                    .slice(finding.start - 1, finding.end)
                    .every((location) => location.file?.equals(allowance.file)),
              ),
          );
          if (remaining.length === 0) resolve();
          else reject(new SecretFindingError(findingMessage(remaining, locations)));
        } else if (code !== 0 || signal !== null || inputFailed || reportBytes > 0) {
          reject(
            new SecretScanError(
              "The secret scan did not complete successfully. No request was made.",
            ),
          );
        } else {
          resolve();
        }
      });
      child.stdin.end(text, "utf8");
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
