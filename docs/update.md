# 依存関係の更新

Dependabotのnpm・Nix更新PRは、依存ハッシュの更新とビルド検証を自動化します。マージは手動です。初回のみ、下記のGitHub Appとリポジトリ設定が必要です。

## 通常の流れ

1. Dependabotが更新PRを作成する。
2. `Update dependency hash`がPRのHEADを取得し、`pnpmDeps.hash`を再計算する。
3. `Apply dependency hash`が、変更がある場合だけ同じPRへハッシュ更新をコミットする。
4. 新しいコミットで`Nix build`が実行される。`Nix checks`の成功を確認して、手動でマージする。

ハッシュ反映前のビルドが`ERR_PNPM_NO_OFFLINE_TARBALL`で失敗する場合があります。反映後の最新コミットのチェックを確認してください。ハッシュが同じなら追加コミットは作りません。

ハッシュ更新コミットには`[dependabot skip]`を付けます。これはCIをスキップする指定ではなく、Dependabotが再ベース時にこの自動生成コミットを置き換えるための指定です。再ベース後はハッシュを再計算します。[Dependabotの追加コミットの扱い](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/manage-your-dependency-security/manage-dependabot-prs#allowing-dependabot-to-rebase-and-force-push-over-extra-commits)

検証対象は、`aarch64-darwin`・`x86_64-darwin`・`aarch64-linux`・`x86_64-linux`です。各環境でパッケージ本体とHome Managerモジュールをビルドします。本体のビルドには型検査・Lint・ソーステスト・バンドルの結合テストが含まれます。実APIやYubiKey、Home Managerのswitchは使いません。

GitHub Actions自体の更新もDependabotが提案します。Actions更新PRではハッシュ再計算は行わず、ビルドを検証して手動でマージします。


## 自動化の権限と停止条件

- 計算・ビルドは書き込みトークンとApp秘密鍵を持たないGitHub-hosted runnerで実行する。
- 書き戻しジョブはデフォルトブランチのスクリプトだけを使い、PRのコードやNix定義を実行しない。ビルド側とのキャッシュ共有も行わない。
- 受け取るartifactは、該当run・run attemptのハッシュとHEADを含む小さなJSONだけ。書き込み先や実行コードをartifactで指定できない。
- 同じリポジトリの、main向けの開いているDependabot PRだけを対象にする。
- 変更可能なPRのファイルは`package.json`・`pnpm-lock.yaml`・`pnpm-workspace.yaml`・`flake.lock`・`nix/package.nix`に限定する。`nix/package.nix`はハッシュ以外が変更されていないことも確認する。
- コミット直前にGitHub側でHEADの一致を検証する。別の更新が入っていれば上書きせず失敗する。
- ハッシュ不一致以外のNixエラー、待機・信頼ポリシーによる停止、ビルドエラーは自動で回避しない。

`workflow_run`は権限を分離するために使用しています。このトリガーを一律に指摘するzizmorの`dangerous-triggers`は、上記の境界を確認したうえで該当行だけ例外指定しています。PR checkoutや実行処理をこのジョブに追加しないでください。[GitHubの指針](https://docs.github.com/en/actions/reference/security/secure-use)、[zizmorの監査ルール](https://docs.zizmor.sh/audits/#dangerous-triggers)、[HEAD一致を要求するAPI](https://docs.github.com/en/graphql/reference/commits#createcommitonbranchinput)

## 自動更新が失敗した場合

`Update dependency hash`が失敗した場合はそのNixログ、`Apply dependency hash`が失敗した場合はApp設定とPRの変更内容を確認します。ネットワークなど一時的な失敗なら、該当workflowを再実行できます。PRのHEADが進んだ場合は古いrunではなく、最新コミットのrunを確認してください。

必要に応じて、`git-scrivener`リポジトリのルートに移動し、同じPRのブランチで手動修正できます。

```sh
gh pr checkout <PR番号>
direnv reload
node .github/scripts/update-pnpm-hash.mjs
nix build --no-link --no-write-lock-file --print-build-logs .#git-scrivener
nix build --no-link --no-write-lock-file --print-build-logs ".#checks.$(nix eval --impure --raw --expr builtins.currentSystem).home-manager"
git diff --check
git diff -- nix/package.nix
```

スクリプトは一時的にハッシュを空にして再取得し、期待した`pnpmDeps`のハッシュ不一致だけを採用します。それ以外の失敗では元のファイルに戻します。[Nixpkgsの取得手順](https://github.com/NixOS/nixpkgs/blob/master/pkgs/build-support/node/fetch-pnpm-deps/pnpm-config-hook.sh)

成功したらハッシュ変更を同じPRへcommit・pushし、最新コミットの`Nix checks`を待って手動でマージします。パッケージ定義自体の修正が必要な場合も、通常のPRとして検証します。
