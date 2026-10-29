1. 対象のDependabot PRのブランチで、プロジェクトのルートから実行
```sh
gh pr checkout <PR番号>
```

2. 更新後のNode.js・pnpmの版を確認する
```sh
nix eval --impure --json --expr '
  let
    flake = builtins.getFlake (toString ./.);
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
  in {
    nodejs = pkgs.nodejs.version;
    pnpm = pkgs.pnpm.version;
  }
'
```

- `package.json` の `packageManager` を、確認した `pnpm@バージョン` に変更
- Node.jsも `engines.node`（現在 `>=24 <25`）の範囲内か確認する

3. 開発環境とlockfileを更新する
```sh
direnv reload
```
```sh
pnpm --version
pnpm install --ignore-scripts
```

`pnpm --version` が手順1の版と一致することを確認します。

4. 依存ハッシュを取得する
`nix/package.nix` の `pnpmDeps` 内を、一時的に次へ変更します。

```nix
hash = "";
```

```sh
nix build --no-link --no-write-lock-file --print-build-logs '.#git-scrivener.pnpmDeps'
```

想定される `hash mismatch` の **`got: sha256-...`** を、先ほどの `hash` に設定します。それ以外のエラーなら、先にその原因を解消します。[公式手順](https://github.com/NixOS/nixpkgs/blob/master/pkgs/build-support/node/fetch-pnpm-deps/pnpm-config-hook.sh)

5. パッケージ全体を検証する
```sh
nix fmt
nix build --no-write-lock-file --print-build-logs .#git-scrivener
```

型検査・Lint・テスト・起動確認がビルド内で実行されます。

6. 同じPRへ変更を追加する
```sh
git diff --check
git diff -- package.json pnpm-lock.yaml nix/package.nix
git add package.json pnpm-lock.yaml nix/package.nix
git commit -m "chore: align pnpm with updated nixpkgs"
git push
```

GitHub上でPR全体を確認してからマージします。
