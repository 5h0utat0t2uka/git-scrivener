{ pkgs, fixedNode }:

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
      ../package.json
      ../pnpm-lock.yaml
      ../pnpm-workspace.yaml
      ../tsconfig.json
      ../tsconfig.build.json
      ../.oxlintrc.json
    ];
  };

  pnpmDeps = pkgs.fetchPnpmDeps {
    inherit (finalAttrs) pname version;
    src = dependencySource;
    pnpm = fixedNode.pnpm;
    fetcherVersion = 5;
    hash = "sha256-qUohcb6SsAOBL8PKD+3Eg4CQyhQxKEe6hhU/vodmWoE=";
  };

  nativeBuildInputs = [
    fixedNode.nodejs
    fixedNode.pnpm
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

    # Install only runtime dependencies into a fresh directory, using the same lockfile.
    mkdir production
    cp package.json pnpm-lock.yaml pnpm-workspace.yaml production/
    pnpm --dir production install --offline --prod --frozen-lockfile --ignore-scripts \
      --store-dir "$STORE_PATH" --package-import-method=copy

    mkdir -p "$out/lib/git-scrivener" "$out/bin"
    cp -R dist package.json production/node_modules "$out/lib/git-scrivener/"
    makeWrapper "${fixedNode.nodejs}/bin/node" "$out/bin/git-scrivener" \
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
    test ! -e "$out/lib/git-scrivener/node_modules/typescript"
    test ! -e "$out/lib/git-scrivener/node_modules/@types/node"
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
