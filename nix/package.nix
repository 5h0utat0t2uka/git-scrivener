{ pkgs }:

let
  inherit (pkgs) lib;
  metadata = lib.importJSON ../package.json;
  dependencySource = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../pnpm-lock.yaml
      ../pnpm-workspace.yaml
    ];
  };
in
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = metadata.name;
  version = metadata.version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      (lib.fileset.fileFilter (file: file.hasExt "ts") ../src)
      (lib.fileset.fileFilter (file: file.hasExt "ts") ../test)
      ../licenses
      ../package.json
      ../pnpm-lock.yaml
      ../pnpm-workspace.yaml
      ../tsconfig.json
      ../tsdown.config.ts
      ../.oxlintrc.json
    ];
  };

  pnpmDeps = pkgs.fetchPnpmDeps {
    inherit (finalAttrs) pname version;
    src = dependencySource;
    pnpm = pkgs.pnpm;
    fetcherVersion = 5;
    hash = "sha256-e2WZ4DE2JqF02VMvvk+tEfgNRPO9COZ+gCfz5KBFBlg=";
  };

  nativeBuildInputs = [
    pkgs.nodejs
    pkgs.pnpm
    pkgs.pnpmConfigHook
    pkgs.makeWrapper
  ];
  nativeCheckInputs = [
    pkgs.git
    pkgs.betterleaks
    pkgs.oxlint
  ];
  strictDeps = true;
  CI = "true";

  buildPhase = ''
    runHook preBuild
    pnpm run build
    runHook postBuild
  '';

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    pnpm run typecheck
    pnpm run lint
    pnpm test
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/lib/git-scrivener" "$out/bin"
    cp -R dist package.json "$out/lib/git-scrivener/"
    makeWrapper "${pkgs.nodejs}/bin/node" "$out/bin/git-scrivener" \
      --add-flags "$out/lib/git-scrivener/dist/cli.js" \
      --prefix PATH : "${
        lib.makeBinPath [
          pkgs.git
          pkgs.betterleaks
        ]
      }"

    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    "$out/bin/git-scrivener" --help
    test "$("$out/bin/git-scrivener" --version)" = "${finalAttrs.version}"
    test ! -e "$out/lib/git-scrivener/node_modules"
    test -s "$out/lib/git-scrivener/dist/THIRD_PARTY_NOTICES.txt"
    SCRIVENER_TEST_CLI="$out/lib/git-scrivener/dist/cli.js" \
      node --test test/cli.test.ts test/lazy-loading.test.ts test/bundle.integration.ts
    runHook postInstallCheck
  '';

  meta = {
    description = metadata.description;
    homepage = "https://github.com/5h0utat0t2uka/git-scrivener";
    mainProgram = "git-scrivener";
    platforms = [
      "aarch64-darwin"
      "x86_64-darwin"
      "aarch64-linux"
      "x86_64-linux"
    ];
  };
})
