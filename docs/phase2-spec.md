# Phase 2: Slack UI + Call Summary — Implementation Spec

## Overview

Phase 2 adds real-time Slack status updates and automatic conversation summaries for both Twilio calls and Google Meet sessions.

## Architecture

### New Modules

```
src/
├── session-events.js     # Session lifecycle state machine (shared)
├── slack-notifier.js     # Slack message management (create/update/summary)
├── summarizer.js         # LLM-based conversation summarizer
```

### Modified Modules

```
src/
├── transport-twilio/
│   ├── twilio-bridge.js  # Integrate session events + Slack notifications
│   └── call-manager.js   # Emit structured status events
├── index.js              # Meet: integrate session events + exit detection
├── pipeline.js           # Add exit command detection for Meet
├── config.js             # Add Slack + summarizer config
```

### Environment Variables (new)

```bash
# Slack integration
SLACK_BOT_TOKEN=xoxb-...           # Bot token with chat:write scope
SLACK_NOTIFY_CHANNEL=C0XXXXXXXXX   # Channel ID for status/summary posts

# Optional
SLACK_NOTIFY_ENABLED=true          # Enable/disable Slack notifications
SUMMARY_ENABLED=true               # Enable/disable auto-summaries
```

---

## Module 1: Session Events (`src/session-events.js`)

EventEmitter-based state machine for session lifecycle.

### States

```
idle → initiating → ringing → in-progress → ending → completed
                                                   → failed
```

### Valid Transitions

```javascript
const VALID_TRANSITIONS = {
  idle:        ['initiating'],
  initiating:  ['ringing', 'in-progress', 'failed'],
  ringing:     ['in-progress', 'failed'],
  'in-progress': ['ending', 'completed', 'failed'],
  ending:      ['completed', 'failed'],
  completed:   [],
  failed:      [],
};
```

### Events

- `state_change` — `{ sessionId, from, to, transport, meta, timestamp }`
- `session_start` — `{ sessionId, transport, to, from, timestamp }`
- `session_end` — `{ sessionId, transport, state, duration, conversationLog, timestamp }`

### API

```javascript
class SessionLifecycle extends EventEmitter {
  constructor(sessionId, transport) // transport: 'twilio' | 'meet'
  get state()
  get startedAt()
  get duration() // seconds elapsed since in-progress
  transition(newState, meta = {})
  toJSON() // serializable snapshot
}
```

---

## Module 2: Slack Notifier (`src/slack-notifier.js`)

Manages Slack message posting and updating. Uses raw HTTPS (no SDK dependency).

### Status Message (1-message update pattern)

A single Slack message is created per session and updated in-place as the call/meeting progresses.

#### Status Format

```
📞 通話ステータス
━━━━━━━━━━━━━━━
📱 発信先: +66XXXXXXXXX
📊 状態: 🟡 発信中...
⏱️ 経過: --
🤖 トランスポート: Twilio
```

Updated to:

```
📞 通話ステータス
━━━━━━━━━━━━━━━
📱 発信先: +66XXXXXXXXX
📊 状態: 🟢 通話中
⏱️ 経過: 2:34
🤖 トランスポート: Twilio
```

Final:

```
📞 通話完了
━━━━━━━━━━━━━━━
📱 発信先: +66XXXXXXXXX
📊 状態: ✅ 完了
⏱️ 通話時間: 7:34
🤖 トランスポート: Twilio
```

#### State → Emoji Mapping

```javascript
const STATE_EMOJI = {
  initiating:    '⏳ 受付',
  ringing:       '🔔 発信中',
  'in-progress': '🟢 通話中',
  ending:        '🔄 終了処理中',
  completed:     '✅ 完了',
  failed:        '❌ 失敗',
};
```

### Summary Message

Posted as a separate message after session ends:

```
📋 通話サマリー
━━━━━━━━━━━━━━━
⏱️ 通話時間: 7分34秒

📝 要約
• Caty のスキル一覧について確認
• 音声通話機能のテスト成功を報告

✅ 決定事項
• Phase 1 を正式クローズ

📌 TODO
• Phase 2 の Slack UI 実装開始

💬 発話数: 12（ユーザー: 6, Caty: 6）
```

### API

```javascript
class SlackNotifier {
  constructor(botToken, channelId)
  get enabled() // returns false if botToken/channelId missing
  async postStatus(lifecycle) // creates or updates status message
  async postSummary(lifecycle, summary) // posts summary after session end
  destroy() // cleanup any intervals
}
```

### Implementation Notes

- Use Slack Web API via raw HTTPS:
  - `chat.postMessage` to create initial status message
  - `chat.update` to update the same message (using saved `ts`)
- Track `messageTs` per session for updates
- If Slack API fails, log warning but don't crash the call
- Update interval during in-progress: every 30 seconds (for elapsed time)

---

## Module 3: Summarizer (`src/summarizer.js`)

Uses LLM to generate structured conversation summaries.

### Prompt

```
以下の音声通話の会話ログから、簡潔なサマリーを生成してください。

フォーマット:
1. 要約（箇条書き、最大3項目）
2. 決定事項（あれば）
3. TODO（あれば）

会話ログ:
{conversationLog}
```

### API

```javascript
async function summarizeConversation(conversationLog, options = {})
// Returns: { summary: string[], decisions: string[], todos: string[] }
```

### Implementation Notes

- Use OpenClaw Gateway if configured (OPENCLAW_GATEWAY_URL + TOKEN)
- Fallback to OpenRouter
- Non-streaming (one-shot completion)
- Max tokens: 500
- If summarization fails, return empty summary (don't block session end)

---

## Module 4: Integration — Twilio Bridge

### Changes to `twilio-bridge.js`

1. **On `/call-me` success:**
   - Create `SessionLifecycle('twilio')`
   - Transition: `idle → initiating`
   - Call `slackNotifier.postStatus(lifecycle)`

2. **On `/twilio/status` callbacks:**
   - Map Twilio `CallStatus` to lifecycle states:
     - `initiated` → `initiating`
     - `ringing` → `ringing`
     - `in-progress` → `in-progress`
     - `completed` / `busy` / `no-answer` / `canceled` / `failed` → `completed` or `failed`
   - Call `slackNotifier.postStatus(lifecycle)`

3. **On WS stream `start` event:**
   - Ensure lifecycle is in `in-progress`
   - Start elapsed time counter for Slack updates

4. **On WS stream `stop` / `close`:**
   - Transition to `completed`
   - Generate summary via `summarizer`
   - Post summary via `slackNotifier`
   - Save conversation log (existing behavior)

5. **Elapsed time updater:**
   - During `in-progress`, update Slack message every 30s with elapsed time

### Changes to `call-manager.js`

- Add `onStatusChange` callback option
- Expose lifecycle binding: `bindLifecycle(callSid, lifecycle)`

---

## Module 5: Integration — Meet Bridge

### Changes to `index.js`

1. **On `/join-meeting` success:**
   - Create `SessionLifecycle('meet')`
   - Transition: `idle → initiating`
   - Post status to Slack

2. **On Attendee WS connect:**
   - Transition: `in-progress`
   - Post status update

3. **On session end (WS close / exit command):**
   - Transition to `completed`
   - Generate summary
   - Post summary

### Exit Detection (changes to `pipeline.js`)

Add exit command detection to the pipeline:

```javascript
const EXIT_COMMANDS = [
  '退出して', '退出していいよ', '今日はここまで',
  'もういいよ', '終わりにして', '退出', '終了',
];

// In utterance_end handler:
if (isExitCommand(userText)) {
  // Confirm before exiting
  speak("退出しますね。お疲れさまでした！");
  emitter.emit('exit_requested', { sessionId });
}
```

Add exit confirmation flow:
- User says exit command → Caty confirms "退出しますね" → emit `exit_requested`
- Parent (index.js) listens for `exit_requested` → close Attendee bot → end session

---

## Module 6: Config Changes (`src/config.js`)

Add to `getPipelineConfig()`:

```javascript
slack: {
  botToken: process.env.SLACK_BOT_TOKEN || null,
  channelId: process.env.SLACK_NOTIFY_CHANNEL || null,
  enabled: String(process.env.SLACK_NOTIFY_ENABLED || 'true') !== 'false',
},
summary: {
  enabled: String(process.env.SUMMARY_ENABLED || 'true') !== 'false',
},
```

---

## File-by-File Change Summary

| File | Action | Description |
|------|--------|-------------|
| `src/session-events.js` | **NEW** | Session lifecycle state machine |
| `src/slack-notifier.js` | **NEW** | Slack message posting/updating |
| `src/summarizer.js` | **NEW** | Conversation summarizer |
| `src/config.js` | MODIFY | Add slack/summary config |
| `src/pipeline.js` | MODIFY | Add exit command detection, emit exit_requested |
| `src/transport-twilio/twilio-bridge.js` | MODIFY | Wire lifecycle + Slack + summary |
| `src/transport-twilio/call-manager.js` | MODIFY | Minor: expose status change hook |
| `src/index.js` | MODIFY | Wire lifecycle + Slack + summary + exit handler |

---

## Testing Checklist

- [ ] Twilio call: status message appears in Slack, updates through states
- [ ] Twilio call: summary posted after call ends
- [ ] Meet session: status message appears and updates
- [ ] Meet session: exit command detected and bot exits
- [ ] Meet session: summary posted after session ends
- [ ] Slack API failure doesn't crash the call
- [ ] Missing SLACK_BOT_TOKEN gracefully disables notifications
- [ ] Summary generation failure doesn't block session end
