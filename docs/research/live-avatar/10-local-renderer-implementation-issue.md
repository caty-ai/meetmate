# GitHub issue draft

Posted as:
https://github.com/caty-ai/meetmate/issues/173

## Title

実験: Attendee Hybrid Hを検証し、合格時のみL1ローカル口パクへ進む

## Labels

`enhancement`

## Body

Parent: #69

Related audio baseline: #62

### 目的

現在のMeetmateの高品質なAttendee realtime audio + Fish Audioを唯一の
会議音声経路として維持したまま、`voice_agent_settings.url` の無音ページを
Bot映像として同時利用できるかを検証する。成立した場合だけ、同じFish PCMの
短時間エネルギーから、ローカルCanvas上のclosed/half/open 3状態を動かす。

これはproduction rolloutではなく、途中停止を成功結果として認める
段階制の実験Issue。static-imageは既定かつ唯一のproduction-qualified経路の
まま変えない。

### 5者レビューの合意

- 5/5: このIssueを1本起票する
- 5/5: M0 → H0 → 条件付きL1の順に進める
- 5/5: H0承認前にL1を作らない
- 5/5: L2/WebGL、Full-page A、Caty画像、LiveAvatar、Recallを含めない
- 5/5: 全工程11ファイルを上限とする

詳細: `docs/research/live-avatar/09-local-renderer-council-decision.md`

### 構成

```text
Google Meet
  ├─ audio (唯一): 既存 Attendee realtime WebSocket
  │                  ↕ 既存 Soniox / Agent Core / Fish Audio
  └─ video only: Attendee voice_agent_settings.url
                    └─ local 1280×720 Canvas page
```

映像側は音声を生成・再生・転送しない。Agent Core、人格、記憶、スキル、
ツール、OpenClaw/Hermes/Claude等のgateway、Soniox、Fish Audioを変更しない。

### Milestone M0 — 現行挙動固定と出力epoch

- [ ] staticのAttendee payloadを正規化値と直列化byteの両方で固定する
- [ ] Fish 24 kHz S16LEのbyte/send countと既存`bot_output`を固定する
- [ ] mixed input、echo gate、挨拶、turn、barge-in/cancel、reconnect、exit、
      leave、遅延cleanupを固定する
- [ ] static時にlive module/capability/page/socket/timer/networkが一切作られない
      ことを固定する
- [ ] 既存PCM callbackへauthoritativeな`outputEpoch`と連続sample indexを
      additiveに観測できるようにする
- [ ] 全authoritative abort pathから
      `playback_cancelled({ outputEpoch, reason, monotonicTime })`相当を
      synchronous/exactly-onceで観測できるようにする
- [ ] observerの不在・例外がaudio/turn/cancel順序を変えないことを証明する

M0で既存挙動を変えずにepochを得られない場合は停止する。

### Milestone H0 — hosted Hybrid H + audio-free L0

- [ ] 明示的・非既定のexperiment選択時だけ、既存
      `websocket_settings.audio`を変更せず
      `voice_agent_settings.url`を追加する
- [ ] 1280×720のdependency-free Canvas pageでsample-index markerを表示する
- [ ] pageに`AudioContext`、audio/media element、audio track、service worker、
      storage、third-party egressがないことを証明する
- [ ] 256-bit短命・単一session capability、exact route allowlist、strict CSP、
      `Cache-Control: no-store`、constant-time比較、log redaction、bounded
      message/queue/retryを実装・試験する
- [ ] generation/epoch/sequence/cancelが古いstateを拒否し、cancel/reload/
      reconnect後に履歴を再生しないことを証明する
- [ ] hosted Attendeeが両settingsを受理し、page failureが既存realtime audioを
      stop/replace/delay/backpressure/duplicate/replayしないことを証明する
- [ ] 独立observerでBot 1体・waveform 1本と、marker↔audible transientの
      p50/p95/max skew・variance・30分driftを測る

PCM生成時刻、WebSocket送信時刻、page `performance.now()`、muted browser
clockだけでA/V同期合格にしない。実際のMeet observer記録を必須にする。

H0失敗時は証拠を添えて本Issueを完了する。Full-page Aへfallbackせず、
L1ファイルを作らない。

### Milestone L1 — H0合格時のみ3状態口パク

開始条件: H0の全証拠をlinkした承認コメントがあること。

- [ ] 既存送信と同じFish PCMのcopyを使い、音声を二重生成しない
- [ ] 24 kHz S16LE、480 samples/20 ms window、240 samples/10 ms hop、
      window mean除去、RMS→dBFS、epoch内連続sample indexを固定する
- [ ] Fish/WebSocketのchunk境界を変えても同一traceになることをfixtureで
      証明する
- [ ] normalization、noise/silence threshold、hysteresis、attack/decayを
      hashed corpusで校正し、candidate結果を見る前に固定する
- [ ] original/non-personal Canvas geometryのclosed/half/openのみ描画する
- [ ] cancelで即closed、旧epochの遅着PCM/stateで再openしない
- [ ] frozen baselineに対するaudio、A/V、resource、lifecycle、securityの
      非劣化と、blindedなusefulness/distraction floorを確認する

Caty Phoneからは短時間energy→mouth stateという考え方だけを参考にする。
Caty画像、Swift/SwiftUI、WebRig、random blink/syllable、外部artはコピーしない。

### ファイル上限

M0/H0で最大10 path:

1. `src/transport-meet/local-avatar-session.js`
2. `public/local-avatar/index.html`
3. `public/local-avatar/local-avatar.js`
4. `src/transport-meet/meet-routes.js`
5. `src/ui-routes.js`
6. `src/pipeline.js`
7. `test/local-avatar-session.test.js`
8. `test/local-avatar-page-contract.test.js`
9. `test/local-avatar-static-regression.test.js`
10. `test/fixtures/local-avatar-timeline.json`

H0承認後のL1で追加可能なのは1 pathだけ:

11. `src/transport-meet/local-avatar-calibration.json`

`test/`はpackage artifactに含まれないため、runtime calibrationは11へ置き、
fixtureからruntime importしない。画像assetや別renderer moduleは作らない。

### 数値gateの固定方法

先に#62のstatic baselineを同一script/会議/observerで反復し、candidate結果を
開く前に閾値とwaiver ownerを記録する。少なくとも次を保存する:

- source PCM hash、byte/send count、sample gap、clipping、queue age
- start/mid-response cut incidence
- response→first audible p50/p95、cancel→last audible p50/p95/max
- marker↔audible transientのsigned/absolute p50/p95/max、variance、drift
- duplicate/echo/one-waveform、barge-in、reconnect、exit/leave
- page FPS/long frame、CPU、memory slope、event-loop、thermal、queue/retry
- 30分Google Meet runの切断、resource leak、orphan bot/socket/timer/listener

### Hard stop

次のいずれかで停止し、scopeを広げない:

- 両Attendee settingsのhosted受理が失敗または挙動不明
- Bot/audio owner/waveformが2つになる
- pageにaudio graph/trackまたは意図しないegressが生じる
- static payload、audio byte/send count、echo/cancel/turn/lifecycleが変わる
- page障害がrealtime audioへ影響する
- observerでA/V関係を測れない、またはfrozen baselineを悪化させる
- stale epoch再open、capability leak、unbounded queue/retry/resource
- result確認後のDSP tuning、nondeterminism、silence false-open
- 12個目のpath、dependency、config schema、generic interfaceが必要になる

### Out of scope

- production default/rollout、release、main merge
- Full-page A、page audio、AudioWorklet、第二のTTS/STT/Bot
- L2 pseudo-2.5D、WebGL/WebRig、LiveAvatar、Recall.ai
- Caty画像/likeness、vendor provider、renderer selector/factory/DI/plugin framework
- `package.json`/lockfile、`src/server.js`、config schema、README
- Agent Core、Fish、Soniox、gateway、profile、memory、skill、tool
- Zoom E2E（Google Meet H0合格後に別Issueで判断）

### 完了条件

以下のどちらか:

1. M0/H0/L1を順に通過し、全証拠と11-path以内の差分を提示した
2. いずれかのhard gateで停止し、再現手順・観測値・棄却理由を提示した

失敗を隠して別構成へ進むより、成立しない境界を早く確定することを
本Issueの成功とする。
