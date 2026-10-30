# Bundle measurements

Measured on macOS arm64 on 2026-10-31 (JST), using Node.js 24.21.0 and Hyperfine 2.0.0 from the pinned Nixpkgs input. Git and Betterleaks remain runtime dependencies. The comparison changes JavaScript bundling and installation only; it does not add minification or lazy SDK imports.

| Metric | Before bundling | After bundling | Reduction |
| --- | ---: | ---: | ---: |
| Package NAR size | 47,668,584 bytes (45.46 MiB) | 2,445,440 bytes (2.33 MiB) | 94.87% |
| Runtime closure NAR size | 1,788,676,712 bytes (1,705.82 MiB) | 1,743,453,568 bytes (1,662.69 MiB) | 2.53% |
| `--help` wall time, mean ± sample standard deviation | 138.76 ± 1.48 ms | 69.41 ± 1.04 ms | 49.97% |
| Peak resident memory, mean | 87.01 MiB | 68.37 MiB | 21.42% |

The baseline package is `/nix/store/fyvdngwci5plmhgn0vp3xf3nayv1rjyg-git-scrivener-0.1.0`; the bundled package is `/nix/store/ngpwv33v0xrp1gvfcy2506s59xxp8yni-git-scrivener-0.1.0`. Their Node.js, Git, Bash, and Betterleaks store references are identical. The package and closure both shrink by 45,223,144 bytes (43.13 MiB); the smaller percentage change in the closure reflects the unchanged runtime dependencies.

Measurements use 3 warmup runs followed by 20 measured runs. Both sets of measured runs exited successfully. Baseline timing started at 08:20 JST; bundled timing started at 08:33 JST. These are separate runs, not an interleaved comparison. Raw results are kept locally under the ignored `.benchmarks/` directory.

NAR sizes measure serialized store contents, not compressed download sizes or additional disk space after sharing existing store paths. The closure includes Node.js, Git, Betterleaks, and their dependencies. See [`nix path-info`](https://nix.dev/manual/nix/latest/command-ref/new-cli/nix3-path-info).

The timing measures starting the packaged CLI and printing help with warm filesystem caches. It does not measure a cold boot, API latency, secret scanning, hooks, or signing. These results describe this machine and invocation, not a general speed guarantee.

The bundled package uses tsdown 0.23.2 / Rolldown 1.2.15 and installs generated JavaScript chunks, dependency license texts, and package metadata without `node_modules`. It passed type checking, lint, the source tests, and the installed-bundle integration tests in the user's Nix build. Integration tests mock provider responses and cover both providers, English/Japanese output, explicit confirmation, cancellation, regeneration, and partially staged files.

## Reproduce

Before changing the build, with `result` pointing to the existing package:

```sh
mkdir -p .benchmarks
nix path-info --json --closure-size ./result > .benchmarks/size-before.json
nix run --no-write-lock-file --inputs-from . nixpkgs#hyperfine -- --warmup 3 --runs 20 --export-json .benchmarks/before.json './result/bin/git-scrivener --help'
```

After updating the dependency hash and successfully building the new package:

```sh
nix build --no-write-lock-file --print-build-logs .#git-scrivener
nix path-info --json --closure-size ./result > .benchmarks/size-after.json
nix run --no-write-lock-file --inputs-from . nixpkgs#hyperfine -- --warmup 3 --runs 20 --export-json .benchmarks/after.json './result/bin/git-scrivener --help'
```

Keep the Nixpkgs input, hardware, shell, power settings, and background load consistent. [Hyperfine](https://github.com/sharkdp/hyperfine) records the individual samples and summary statistics in JSON. These invocations do not send API requests or create commits.
