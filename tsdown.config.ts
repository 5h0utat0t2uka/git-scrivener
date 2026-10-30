import { readFile, readdir } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { isAbsolute, join, relative } from "node:path";
import { defineConfig } from "tsdown";

// Versioned upstream notices for packages whose npm archive omits its license file.
const supplementalLicenses: Record<string, URL> = {
  "standardwebhooks@1.1.1": new URL("./licenses/standardwebhooks-1.1.1.txt", import.meta.url),
};

export default defineConfig({
  entry: ["src/cli.ts"],
  platform: "node",
  target: "node24",
  format: "esm",
  fixedExtension: false,
  dts: false,
  clean: true,
  minify: false,
  sourcemap: false,
  deps: {
    alwaysBundle: (id) => !isBuiltin(id),
    onlyBundle: false,
    // The installed CLI has no node_modules; only Node built-ins may remain external.
    onlyImport: [],
  },
  plugins: [
    {
      name: "third-party-notices",
      async generateBundle(_options, bundle) {
        const roots = new Set<string>();
        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== "chunk") continue;
          for (const id of chunk.moduleIds) {
            if (!isAbsolute(id)) continue;
            const marker = "/node_modules/";
            const index = id.lastIndexOf(marker);
            if (index < 0) continue;
            const start = index + marker.length;
            const parts = id.slice(start).split("/");
            const name = parts.slice(0, id[start] === "@" ? 2 : 1).join("/");
            roots.add(id.slice(0, start) + name);
          }
        }

        const notices: string[] = [];
        for (const root of roots) {
          const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
            name: string;
            version: string;
          };
          // SDKs also ship license texts for vendored code below their package root.
          const files = (await readdir(root, { withFileTypes: true, recursive: true }))
            .filter(
              (file) => file.isFile() && /^(?:licen[cs]e|notice)(?:[.-].*)?$/i.test(file.name),
            )
            .map((file) => relative(root, join(file.parentPath, file.name)))
            .sort();
          if (files.length === 0) {
            const dependency = `${metadata.name}@${metadata.version}`;
            const supplemental = supplementalLicenses[dependency];
            if (!supplemental)
              this.error(`No license file found for bundled dependency ${dependency}.`);
            notices.push(`${dependency}\n\n${await readFile(supplemental, "utf8")}`);
          }
          for (const file of files) {
            notices.push(
              `${metadata.name}@${metadata.version} — ${file}\n\n${await readFile(join(root, file), "utf8")}`,
            );
          }
        }
        this.emitFile({
          type: "asset",
          fileName: "THIRD_PARTY_NOTICES.txt",
          source: `${notices.sort().join("\n\n----------------------------------------\n\n")}\n`,
        });
      },
    },
  ],
});
