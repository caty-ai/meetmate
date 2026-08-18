# Copy/paste prompt for the next implementation session

```text
Issue #69 の live avatar comparison PoC を、以下のresearch decisionに厳密に従って
進めてください。

最初に必ず読むもの:
- docs/research/live-avatar/00-evidence-pack.md
- docs/research/live-avatar/01-failure-dossier.md
- docs/research/live-avatar/02-council-decision.md
- docs/research/live-avatar/03-adr-live-avatar.md
- docs/research/live-avatar/04-comparison-poc-spec.md
- docs/research/live-avatar/05-issue-69-plan.md

作業境界:
- origin/main 最新から専用の隔離worktree/branchを作る。
- main/release worktree、production deployment、READMEには触れない。
- 現行static Attendee botをdefaultかつ独立のまま維持する。
- Agent Core、personality、memory、skills、tools、turn policyは変更しない。
- Fishは現行設定のまま、1 utteranceにつき1回だけ生成する。
- 第二STT/LLM/TTS、二重音声owner、same-meeting live→static fallbackを作らない。
- 新dependencyやconfig変更が必要なら、理由と最小範囲を先に計画へ明記する。
- generic AvatarProvider、plugin registry、DI/media shell、provider failover、
  generic lifecycle frameworkを作らない。
- vendor credentialをcaptured browserへ渡さない。

このセッションの実装上限:
1. LA-02: 現行static 30分baseline protocolのfixture/manifest/metric定義
2. LA-03: PoC telemetry/correlation harness
3. LA-04: avatarなし Attendee Voice Agent carrier calibration

重要: LA-04がhard gateを通るまではlocal rendererもLiveAvatar adapterも実装しない。
LA-04が失敗した場合は、原因候補と証拠を報告して停止する。Recallへの切替は実装
せず、LA-11を開くべきかだけ判断する。

実行前:
- 現行staticのpayload、Fish PCM contract、cancel/barge-in/reconnect/exitをtestsで
  固定する。
- PoC specの30分script、fixture hash、metric semantics、observer capture、
  threshold-setting方法を確定する。
- baseline計測後、candidate結果を見る前に数値thresholdとvisual floorを記録する。
- Attendee Voice Agentのcurrent contract/account条件を公式資料で再確認する。

carrier-only実験:
- frozen mono S16LE 24k Fish-format PCM、tone、transient、silenceを使う。
- deterministic visual flash/frame markerだけを表示し、avatarは作らない。
- source→browser playback→capture→meeting observerのaudio/frame timestamp、
  actual AudioContext.sampleRate、queue、drop/replay、CPU/memory/thermalを記録する。
- cancel、rapid cancel/new utterance、page reload、websocket loss、meeting reconnect、
  network/CPU contention、exitを注入する。
- remote observerのaudio/video artifactを保存し、exactly one audible waveform、
  duplicate bot/audio zero、bounded local shutdownを検証する。
- staticはlive credential absent/invalid、DNS blackhole、vendor 5xxでも同じように動く
  regressionを実施する。

品質ゲート:
- source bytesが同じだけでFish品質維持と判定しない。
- observer recording、blind comparison、response p50/p95、cancel tail、
  A/V signed/absolute skewとdrift、underrun/overrun、resource slopeを読む。
- hard invariant違反、または事前threshold未達ならrendererへ進まない。

検証:
- lint、typecheck、unit/integration tests、git diff --checkを実行する。
- main worktreeが無変更であることを確認する。
- changed files、テスト結果、計測結果、未解決risk、gate pass/stopを報告する。
- commit/push/PRは明示依頼がない限り行わない。

完了条件:
- static baselineとcarrier probeが再現可能なmanifest/artifactを持つ。
- LA-04のpass/stopが証拠付きで一意に決まる。
- pass時も、このセッションではrenderer実装に進まず、次のLA-07/LA-08のどちらが
  prerequisitesを満たすかを報告して終了する。
```
