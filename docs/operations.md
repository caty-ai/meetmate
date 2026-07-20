# 運用ガイド（Operations Guide)

README から移設した、運用・チューニング系の詳細リファレンスです。初回セットアップは [README のクイックスタート](../README.md#クイックスタート) を参照してください。

## 目次

- [LLM プロバイダ](#llm-プロバイダ)
- [STT プロバイダ切替・Soniox チューニング](#stt-プロバイダ切替soniox-チューニング)
- [音声プロファイル（TTS）](#音声プロファイルtts)
- [緊急 rollback 用 env](#緊急-rollback-用-env)
- [委譲強制ハーネス（#79）](#委譲強制ハーネス79)
- [実収録テイクのシード（#72 / #75）](#実収録テイクのシード72--75)
- [LCM（Lossless Context Management）](#lcmlossless-context-management)

## LLM プロバイダ

| 変数 | 既定 | 用途 |
|---|---|---|
| `LLM_PROVIDER` | `openclaw` | LLM プロバイダを選択 |
| `OPENAI_COMPATIBLE_BASE_URL` | | OpenAI 互換 API のベース URL |
| `OPENAI_COMPATIBLE_API_KEY` | | OpenAI 互換 API キー |
| `AGENT_TEMPERATURE` | `0.5` | LLM の temperature |
| `AGENT_MAX_TOKENS` | `300` | LLM 応答の最大トークン数 |

## STT プロバイダ切替・Soniox チューニング

| 変数 | 既定 | 用途 |
|---|---|---|
| `STT_PROVIDER` | `soniox` | `soniox` または `deepgram`。**Deepgram へ即戻す**には `deepgram` にして再起動 |
| `SONIOX_API_KEY` | | Soniox APIキー |
| `SONIOX_MODEL` | `stt-rt-v5` | Soniox リアルタイムモデル |
| `SONIOX_ENDPOINT_SENSITIVITY` | `0.2`※ | 発話終端の出やすさ（-1.0〜1.0／高いほど早く「話し終わり」判定） |
| `SONIOX_MAX_ENDPOINT_DELAY_MS` | `1500`※ | 無音後に必ず確定するまでの最大ms（500〜3000） |
| `SONIOX_ENDPOINT_LATENCY_LEVEL` | （未設定=0） | 0〜3。上げるほど終端を早める |
| `SONIOX_CONTEXT_TERMS` | | カンマ区切りの重要語（人名・専門用語）。認識補正に使用 |
| `SONIOX_KEEPALIVE_INTERVAL_MS` | `8000` | 無音時に接続維持のため送る keepalive フレームの間隔(ms) |
| `SONIOX_PENDING_MAX` | `200` | 再接続待ち中にバッファする音声チャンク数の上限（超過分は古い順に破棄） |

※ `0.2` / `1500` は 2026-06-23 のライブ調整で決めた会話向けベースライン（`.env` に設定済み）。

**⚡ 応答の戻りを"もっと速く"したいとき**：`SONIOX_MAX_ENDPOINT_DELAY_MS` を `1500` → `1000`（必要なら `800`）に下げると、こちらが話し終えてから応答が始まるまでの待ちが短くなり、体感が速くなる。下げすぎると、ゆっくり話す/言い淀むときに途中で区切られやすくなるので、その場合は `SONIOX_ENDPOINT_SENSITIVITY` を `0.0〜-0.2` に下げて調整する。変更後は meet-server 再起動で反映。

## 音声プロファイル（TTS）

v7.5.0 以降、Fish Audio **S2-Pro** をデフォルトモデルにしています。S2-Pro は `[bracket]` + 自然言語タグ syntax を使い、タグなしの発話だと声質が暴走しやすいので、**全発話に必ず 1 個タグを入れる「アンカー方式」** で安定化しています。

### 既定タグ運用

- 通常の固定文言: `[soft voice]`（優しい声、デフォルトアンカー）
- 謝罪場面: `[empathetic, unhurried]`
- お別れ場面: `[warm]`
- LLM addendum でも「必ず 1 個」「迷ったら `[soft voice]`」を指示

## 緊急 rollback 用 env

真実は code の default 1 箇所、env はあくまで escape hatch。既定運用では不要です。

| env | 効果 |
|---|---|
| `FISH_AUDIO_MODEL=s1` | S1 model に戻す |
| `TTS_SAMPLE_RATE=16000` | 出力を旧 16kHz に戻す |
| `FISH_AUDIO_SPEED=0.9` | speech rate を 0.9 に（既定 1.0） |
| `ENABLE_IMMEDIATE_ACK=false` | always-ack を OFF |
| `LLM_RESPONSE_TIMEOUT_MS=0` | first-audio timeout を OFF |
| `FISH_AUDIO_RETRY_MAX=0` | Fish Audio 429/5xx retry を OFF |
| `TTS_GAP_MS=0` | TTS 息継ぎ gap を OFF |
| `COMFORT_NOISE_AMPLITUDE=0` | 無音を完全ゼロに戻す |
| `TTS_LEAD_MS=0` | 先頭パッド無効化 |
| `STT_ACCUMULATED_MAX_CHARS=120` | STT 蓄積テキストの強制区切り文字数 |
| `PENDING_QUEUE_MAX=3` | gate CLOSED 中の pending wake 最大数 |
| `ECHO_GATE_CLOSED_BYPASS=true` | 旧 cancel-word 用 echo gate bypass を ON。⚠️ v7.7 で既定 OFF に変更（発話中の音声キャンセルが必要なら true に） |

## 委譲強制ハーネス（#79）

**フロントは対話専念、重作業は強制バックグラウンド委譲**。`GATEWAY_EVENTS_ENABLED=true` で有効化（既定 `false`＝旧挙動を bit-for-bit 維持）。実機スモーク2回（2026-07-05 / 07-07）で全機能実証済み。詳細スペックは [deep-interview-79-delegation-harness.md](deep-interview-79-delegation-harness.md)。

仕組み（すべて OpenClaw Gateway control-plane WS `sessions.changed` 購読ベース）:

1. **強制委譲**: first-token が閾値（Timer A）を超えたら server-side `chat.abort` → 専用 delegate セッション `<sessionUser>-delegate` へ handoff（in-flight 上限2＋cooldown＋pending FIFO）
2. **完了報告**: subagent 完了を検知 → Meet チャット即時投稿＋沈黙ギャップ待ち音声＋会議後ログ「委譲タスク結果」
3. **delegate 応答 relay**: delegate が spawn せず会話で答えた場合もチャット＋音声で中継（runId dedupe・spawn との相互排他・鮮度窓・NO_REPLY 抑制）
4. **announce 浄化**: Gateway auto-announce（`announce:v1:*`）の親コンテキスト注入を検知 → best-effort `sessions.compact`（※実圧縮は #98 調整中）
5. **circuit breaker**: Timer A 連続発火で open（親 compact＋復旧告知1回）→ 親 first-token 成功で close
6. **短発話 skip**: 短文・会話 ping は委譲せず即答（breaker open 中は例外的に委譲）

| env | 既定 | 用途 |
|---|---|---|
| `GATEWAY_EVENTS_ENABLED` | `false` | ハーネス全体の有効化 |
| `FIRST_TOKEN_DELEGATE_MS` | `15000` | Timer A しきい値。`0` で無効。実運用では `25000` へ緩める例あり（実機スモークの帰結） |
| `DELEGATE_REPLY_FRESH_MS` | `90000` | delegate no-spawn reply を音声でも返す鮮度窓 |
| `PARENT_COMPACT_DELAY_MS` | `5000` | auto-announce / breaker 後の parent `sessions.compact` 遅延 |
| `PARENT_COMPACT_MAX_LINES` | `40` | parent `sessions.compact` の `maxLines`（#98 で調整予定） |
| `SHORT_UTTERANCE_SKIP_CHARS` | `24` | 短文・ping の Timer A skip しきい値。`0` で skip 無効 |
| `CIRCUIT_BREAKER_TIMEOUTS` | `2` | 連続 Timer A 発火で breaker open する回数。`0` で無効 |

metrics は `logs/metrics.jsonl` に JSONL 追記、集計は `node scripts/aggregate-metrics.js logs/metrics.jsonl`（`handoff_received` / `subagent_spawned` / `delegate_replied_no_spawn` / `auto_announce_injected` / `circuit_breaker` / `forced_delegation_skipped` 等）。

接続要件: `sessions.compact` は **operator.admin** スコープ必須（abort は operator.write。#97 で CONNECT_SCOPES に追加済み）。

## 実収録テイクのシード（#72 / #75）

運用マシン上で `node scripts/seed-tts-cache-from-fillers.js` を実行すると、`assets/fillers/manifest.json` の実収録 mp3（相槌 ack 7種＋progress ping 3種＋退出 farewell＋greeting＋timeout の計13ユニーク文言）から `assets/tts-cache/*.pcm` を事前生成します。`.env` は `src/server.js` と同じ方法で自動ロードされます。`config.json` がない環境では、誤った cache key を作らないため `--voice-id <id>` を明示してください。

cache key は `voiceId` / `FISH_AUDIO_SPEED` / `FISH_AUDIO_MODEL` / `TTS_SAMPLE_RATE` の影響を受けます。いずれかを変えた後は再実行しないと古い seeded PCM はヒットせず、Fish Audio の live synthesis へ静かに戻ります。`config.json` の `agent.ackVariants` / `progressPings` / `exitFarewell` / `greeting` / `timeoutFallback` には、manifest 内のテキストを文字・句読点まで完全一致（感情タグなしのプレーン文言）で入れてください。

## LCM（Lossless Context Management）

Meet セッションは OpenClaw の LCM で自動記録。セッション終了時に ingest され、長期記憶に保存されます。

推奨設定: `ingestMode: "auto"`

## Meet チャット投稿の注意点（#68）

- LLM 応答内の `[[[chat: ...]]]` タグを抽出し、読み上げずに Meet チャットへ投稿（URL・長い詳細の共有用）
- Attendee `send_chat_message` 使用、Meet は everyone 宛のみ
- 絵文字は Attendee サーバー側で 400 拒否（"Message cannot contain emojis or rare script characters."、フォールバック=#81）
- リアクション/挙手は Attendee に API なし
- 送信失敗の warn は `logs/meet-server.stderr.log` 側に出る
