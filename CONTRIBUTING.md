# Contributing Guide

このプロジェクトへのコントリビュートに興味を持っていただきありがとうございます。以下のフローに沿って進めてください。

## 開発フロー（Issue-First）

1. **Issue を立てる** — 作業はすべて GitHub Issue 起点です。本文には以下を含めてください。
   - **Why**: なぜこの変更が必要か
   - **Done when**: 何ができたら完了か（受け入れ条件）
   - **触るファイル予測**: 変更しそうなファイル・モジュールの一覧
2. **重複確認** — 着手前に `gh issue list` / `gh pr list` で同じ領域を触る作業がないか確認してください。ファイル集合が交差する場合は直列で進めます。
3. **ブランチを切る** — `main` へ直接コミットしないでください。`main` はマージ専用です。
   - 命名例: `feat/<issue番号>-<短い説明>`、`fix/<issue番号>-<短い説明>`、`docs/<短い説明>`
4. **実装 + 検証** — 変更後は `npm test`（ある場合）と実機での動作確認を行ってください。
5. **PR を出す** — 本文に Issue 番号（`Closes #NN`）と**触ったファイル一覧**を記載してください。
6. **マージ** — レビュー通過後、`fetch → rebase → 再検証` してから 1 本ずつマージします。

## コミットメッセージ

[Conventional Commits](https://www.conventionalcommits.org/) に準拠します。

```
feat(#79): add delegation harness circuit breaker
fix(#98): default PARENT_COMPACT_MAX_LINES to 0
docs: restructure README for public release
```

- prefix: `feat` / `fix` / `docs` / `refactor` / `test` / `chore`
- 対応 Issue がある場合は `(#NN)` を含める

## コードスタイル

- Node.js 22+ / CommonJS
- 既存コードのスタイル（命名・コメント密度・エラーハンドリング）に合わせてください
- 設定値の真実は code の default 1 箇所に置き、env は escape hatch として扱います

## 質問・提案

バグ報告・機能提案は [Issues](https://github.com/caty-ai/meetmate/issues) へお願いします。
