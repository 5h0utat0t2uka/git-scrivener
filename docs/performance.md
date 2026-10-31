# Performance measurements

## Initial bundling comparison

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

### Reproduce

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

## Lazy SDK loading

Implemented and verified on 2026-10-31. `generateCandidate` imports only the selected SDK, its structured-output helper, and the candidate schema after the input checks and Betterleaks scan succeed. Error classification uses the selected SDK's exception classes. `--help`, `--version`, and `--check` load neither SDK nor the schema runtime. Node caches imported modules during regeneration.

The ESM build explicitly enables Rolldown's [automatic code splitting](https://rolldown.rs/reference/OutputOptions.codeSplitting). `bundle-load-map.json` records chunk membership, imports, and byte counts. Tests use Node's [module loading hooks](https://nodejs.org/api/module.html#moduleregisterhooksoptions) to observe actual module loads, including in the installed Nix bundle. They check both successful generation and HTTP failures, and confirm that a failed secret scan loads neither SDK. They do not infer lazy loading solely from source-level `import()` calls or the presence of multiple files.

Measurements below use Node.js 24.21.0 on an Apple M4 / macOS arm64, with tsdown 0.23.2, Rolldown 1.2.15, OpenAI SDK 7.42.0, Anthropic SDK 1.2.0, and Zod 4.6.7. Results were recorded at 16:57 JST. The eager baseline was rebuilt from the same current sources with static SDK/helper/schema imports; an older saved `dist` was rejected because its Anthropic defaults differed.

| Operation, mean ± sample standard deviation | Eager SDK imports | Lazy SDK imports |
| --- | ---: | ---: |
| `--help` | 65.95 ± 1.00 ms | 38.40 ± 1.07 ms |
| `--version` | 63.57 ± 1.41 ms | 38.37 ± 0.79 ms |
| `--check` | 118.22 ± 1.18 ms | 90.72 ± 1.00 ms |
| OpenAI generation → cancel, mocked API | 173.97 ± 1.49 ms | 170.50 ± 0.82 ms |
| Anthropic generation → cancel, mocked API | 173.68 ± 2.02 ms | 166.60 ± 1.51 ms |
| All emitted JavaScript | 2,468,687 bytes | 2,471,114 bytes |

Help startup improves by 41.8% and staged-diff inspection by 23.3%. Generation still needs one SDK and the schema, so its improvement is smaller. Both SDKs remain in the distribution; splitting adds 2,427 JavaScript bytes (0.10%) instead of reducing total JavaScript size.

These timings come from `test/benchmark.ts`, not the earlier Hyperfine run. Each case uses three warmups and 20 fresh Node processes per variant, alternating variant order. Node's compile cache is disabled; filesystem caches are warm. The runner measures wall time around `spawnSync`, including process startup and output collection. It invokes the emitted CLI with the same Node executable for both variants, without the Nix shell wrapper.

Generation measurements include staged-diff inspection, real Betterleaks scanning, SDK and schema initialization, JSON Schema conversion, a mocked `fetch` response, candidate validation/assembly, and cancellation through the plain UI. They exclude network/API latency, human input time, editing, hooks, and signing. The mock also records requests to a local file. Timings describe this small, fixed staged fixture, not arbitrary repository size or real model latency.

Source tests, bundle tests, and the Nix build passed in the user's development shell. Existing tests for partial staging, HEAD/index changes, explicit confirmation, hooks, and signing failure remain enabled. API responses are mocked; no real credentials or YubiKey are used. The implementation does not change those operations or the runtime dependency set.

### Reproduce

From the development shell after installing the locked dependencies:

```sh
pnpm build
pnpm test
pnpm test:bundle
node test/build-eager.ts
SCRIVENER_TEST_CLI=.benchmarks/sdk-eager/dist/cli.js node --test test/cli.test.ts test/bundle.integration.ts
node test/benchmark.ts .benchmarks/sdk-runtime.json eager=.benchmarks/sdk-eager/dist/cli.js lazy=dist/cli.js
```

`test/build-eager.ts` copies current sources to `.benchmarks/sdk-eager/` and changes only their import strategy. It fails if its source transformations no longer match. It leaves `src/` and `dist/` untouched. Both benchmark variants cancel without committing and use an isolated temporary repository. Raw samples are stored in `.benchmarks/sdk-runtime.json`.

## Valibot investigation

This is an experiment, not a production migration. The application still uses Zod. The comparison copy and its independent pnpm lockfile live under the ignored `.benchmarks/valibot-probe/`, with the same seven-day release-age and dependency trust policies as the application. It uses Valibot 1.5.0 and `@valibot/to-json-schema` 1.8.0; SDK, Node, bundler, target, minification settings, and the rest of the CLI are unchanged.

### Compatibility and integration

The current schema uses strict objects, strings, nullable strings, booleans, arrays, and a two-value enum. Valibot's `strictObject`, `string`, `nullable`, `boolean`, `array`, and `picklist` can express these constraints. Its official [JSON Schema converter](https://valibot.dev/guides/json-schema/) supports the required schema types, and [strictObject](https://valibot.dev/api/strictObject/) rejects unknown fields.

The complete comparison includes the SDK helpers and schema conversion code:

| Component | Production Zod variant | Experimental Valibot variant |
| --- | --- | --- |
| Runtime validator | Zod 4.6.7 | Valibot 1.5.0 |
| JSON Schema conversion | Zod conversion inside SDK helpers | `@valibot/to-json-schema` 1.8.0, at runtime |
| OpenAI Responses | `zodTextFormat` + `responses.parse` | `standardTextFormat` + explicit converted schema + `responses.parse` |
| Anthropic Messages | `zodOutputFormat` + its parser | `jsonSchemaOutputFormat` + explicit Valibot validation after parsing |

The OpenAI SDK's [Standard Schema helper](https://github.com/openai/openai-node/blob/main/src/helpers/standard-schema.ts) accepts a validator and explicit JSON Schema while retaining parsed output validation. This keeps the existing strict [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) request flow. Anthropic's [JSON Schema helper](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/helpers/json-schema.ts) parses JSON but does not replace application validation, so the experiment calls Valibot's parser afterward.

An initial direct-schema experiment failed equivalence checks: Anthropic SDK 1.2.0's [schema transformation](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/lib/transform-json-schema.ts) moves some keywords, including the footer separator enum in this schema, into descriptions. The final comparison retains that same SDK transformation instead of changing the API-facing constraints. The original validator still enforces the enum locally in both variants. Conversion targets match the original helpers: draft-07 for OpenAI, draft-2020-12 for Anthropic. The Anthropic helper's JSON Schema TypeScript types also differ from the converter's optional-keyword types under `exactOptionalPropertyTypes`; the probe contains a localized type assertion for this generated schema, followed by the same runtime validation. This integration detail would need to be retained or resolved during a migration.

Compatibility checks passed for required/missing fields, wrong types, nullability, empty strings, arrays, nested footers, unknown keys (including `__proto__` and `constructor`), inferred output types, and message assembly. Provider schemas compare equal after normalizing nullable representations, ordering of set-valued keywords, and the JSON Schema dialect annotation. The comparison preserves all other schema content, including Anthropic's generated descriptions. Existing source tests and both-provider bundle integration tests passed, including refusals, incomplete/malformed responses, English/Japanese generation, regeneration, secret scanning, commit confirmation, hook failures, and signing failure. The bundle load map contains no Zod modules in the Valibot variant. No real API request was made; these results establish local compatibility, not a live provider acceptance test.

### Measured effect

Recorded at 17:05 JST using the same interleaved benchmark method. Both variants already use lazy SDK loading. This is a separate run from the eager/lazy comparison above.

| Metric | Zod | Valibot |
| --- | ---: | ---: |
| All emitted JavaScript | 2,471,114 bytes | 2,186,272 bytes |
| Sum of individually gzipped JavaScript files | 487,321 bytes | 425,871 bytes |
| Complete `dist`, including notices and load map | 2,563,803 bytes | 2,276,161 bytes |
| `--help` | 37.58 ± 0.52 ms | 38.17 ± 0.94 ms |
| `--version` | 37.85 ± 0.63 ms | 38.01 ± 0.68 ms |
| `--check` | 89.92 ± 1.43 ms | 89.97 ± 1.23 ms |
| OpenAI generation → cancel, mocked API | 171.50 ± 1.55 ms | 164.36 ± 1.34 ms |
| Anthropic generation → cancel, mocked API | 167.13 ± 1.23 ms | 160.75 ± 1.06 ms |

Valibot reduces total emitted JavaScript by 284,842 bytes (278.2 KiB, 11.5%), including the replacement helpers and converter. The gzip sum decreases by 61,450 bytes (12.6%); gzip is a distribution-size estimate, not how Node executes these files or a Nix closure measurement. Generation improves by approximately 7.1 ms for OpenAI and 6.4 ms for Anthropic. There is no observed startup benefit for help/version/check, which already avoid both validators. No experimental Nix closure or live API latency was measured.

Recommendation: retain the implemented lazy loading and keep Zod for now. A Valibot migration is feasible and measurably smaller, but the current gain is about 278 KiB and 6–7 ms per fresh generation process, in exchange for another conversion dependency and additional provider-integration maintenance. It is a reasonable optional change if reducing JavaScript distribution size takes priority; it is not needed to obtain the larger startup improvement. Production dependencies and the Nix dependency hash were not changed for this experiment.

The local probe can be rechecked and measured while its directory is retained:

```sh
node --test .benchmarks/valibot-probe/compatibility.test.ts
node --test ".benchmarks/valibot-probe/test/*.test.ts"
pnpm exec tsdown --config .benchmarks/valibot-probe/tsdown.config.ts
SCRIVENER_TEST_CLI=.benchmarks/valibot-probe/dist/cli.js node --test .benchmarks/valibot-probe/test/cli.test.ts .benchmarks/valibot-probe/test/lazy-loading.test.ts .benchmarks/valibot-probe/test/bundle.integration.ts
node test/benchmark.ts .benchmarks/valibot-runtime.json zod=dist/cli.js valibot=.benchmarks/valibot-probe/dist/cli.js
```

The experiment is deliberately not included in the production Nix package or its dependency lockfile. The measured candidate contains the whole CLI, both SDKs, selected-provider lazy imports, runtime schema conversion/validation, and third-party license texts. Raw timings and converted provider schemas remain in `.benchmarks/valibot-runtime.json` and `.benchmarks/valibot-probe/schemas.json`.
