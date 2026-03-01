# Task: Multi-Agent Support (Phase 3)

## Overview

Enable multiple AI agents (Caty, Alec, Zoe, Eidra) to participate in meetings simultaneously.
Each agent uses its own OpenClaw Gateway and has independent conversation history.

**Architecture**: Single pipeline with routing switch (Option A).
- 1 Deepgram STT stream shared across all agents
- Wake word detection determines which agent is addressed
- Gateway URL + TTS voice ID switched per agent
- Session IDs are per-agent: `meet-${sessionId}-${agentId}`

## Files to Create

### `agents.json` (project root)

```json
{
  "caty": {
    "name": "Caty",
    "displayName": "ケイティ",
    "gatewayUrl": "http://localhost:18788",
    "gatewayToken": "${OPENCLAW_GATEWAY_TOKEN}",
    "voiceId": "your-fish-audio-voice-id",
    "wakeWords": ["ケイティ", "けいてぃ", "caty", "katie", "ケイケイ"],
    "keyterms": ["ケイティ", "けいてぃ", "Caty", "Katie"],
    "greeting": "(happy) こんにちは！ケイティです。よろしくお願いします！",
    "model": "anthropic/claude-sonnet-4-6",
    "default": true,
    "openclawSystemAddendum": null
  },
  "alec": {
    "name": "Alec",
    "displayName": "アレク",
    "gatewayUrl": "http://localhost:19009",
    "gatewayToken": "${ALEC_GATEWAY_TOKEN}",
    "voiceId": null,
    "wakeWords": ["アレク", "あれく", "alec"],
    "keyterms": ["アレク", "あれく", "Alec"],
    "greeting": "(calm) …アレクだ。よろ。",
    "model": "openai-codex/gpt-5.3-codex",
    "default": false,
    "openclawSystemAddendum": null
  },
  "zoe": {
    "name": "Zoe",
    "displayName": "ゾーイ",
    "gatewayUrl": "http://localhost:19100",
    "gatewayToken": "${ZOE_GATEWAY_TOKEN}",
    "voiceId": null,
    "wakeWords": ["ゾーイ", "ぞーい", "zoe", "ゾエ"],
    "keyterms": ["ゾーイ", "ぞーい", "Zoe"],
    "greeting": "(excited) ゾーイだよ〜！よろしくね！",
    "model": "anthropic/claude-opus-4-6",
    "default": false,
    "openclawSystemAddendum": null
  },
  "eidra": {
    "name": "Eidra",
    "displayName": "アイドラ",
    "gatewayUrl": "http://localhost:19200",
    "gatewayToken": "${EIDRA_GATEWAY_TOKEN}",
    "voiceId": null,
    "wakeWords": ["アイドラ", "あいどら", "eidra"],
    "keyterms": ["アイドラ", "あいどら", "Eidra"],
    "greeting": "(soft tone) アイドラです。よろしくね。",
    "model": "anthropic/claude-sonnet-4-6",
    "default": false,
    "openclawSystemAddendum": null
  }
}
```

**Token resolution**: Tokens like `${OPENCLAW_GATEWAY_TOKEN}` MUST be resolved from `process.env` at load time. Do NOT hardcode actual tokens. If a token value starts with `${` and ends with `}`, extract the env var name and do `process.env[envVarName]`. If that env var is not set, log a warning and skip the agent.

## Files to Modify

### 1. `src/config.js` — Agent Registry

Add:
```js
const AGENTS_PATH = path.join(__dirname, '..', 'agents.json');

function loadAgents() {
  if (!fs.existsSync(AGENTS_PATH)) return {};
  const raw = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf-8'));
  const resolved = {};
  for (const [id, agent] of Object.entries(raw)) {
    // Resolve env var tokens
    const token = resolveEnvToken(agent.gatewayToken);
    if (!token) {
      console.warn(`⚠️  Agent "${id}" skipped: gateway token not available`);
      continue;
    }
    resolved[id] = { ...agent, id, gatewayToken: token };
  }
  return resolved;
}

function resolveEnvToken(value) {
  if (!value) return null;
  const match = value.match(/^\$\{(.+)\}$/);
  if (match) return process.env[match[1]] || null;
  return value;
}

function getDefaultAgent(agents) {
  const entries = Object.values(agents);
  return entries.find(a => a.default) || entries[0] || null;
}

function getAgentById(agents, id) {
  return agents[id] || null;
}
```

Export: `loadAgents`, `getDefaultAgent`, `getAgentById`

Also update `getPipelineConfig()` to accept an optional `agent` parameter. When provided, override:
- `openclawUrl` → `agent.gatewayUrl`
- `openclawToken` → `agent.gatewayToken`
- `tts.referenceId` → `agent.voiceId`
- `llm.model` → `agent.model`
- `greeting` → `agent.greeting`
- `llm.openclawSystemAddendum` → `agent.openclawSystemAddendum`

### 2. `src/pipeline.js` — Multi-Agent Routing

**Key changes:**

a) `createPipeline()` signature change:
```js
function createPipeline(session, turnState, onAudio, config, options = {})
```
Where `options`:
```js
{
  agents: { caty: {...}, alec: {...} },           // all participating agents
  selectedAgentIds: ['caty', 'alec'],             // which agents are in this meeting
  defaultAgentId: 'caty',                         // who greets + handles no-wake-word
  onAgentSwitch: (fromId, toId) => {},            // callback for UI/logging
}
```

b) **Agent state tracking**:
```js
let currentAgentId = options.defaultAgentId || 'caty';
let lastActiveAgentId = currentAgentId;
```

c) **Wake word detection update** — `containsWakeWord()` should return `{ detected: boolean, agentId: string | null }`:
- Check wake words for ALL selected agents (not just a global list)
- Return which agent was addressed
- Keep existing `EXTENDED_WAKE_VARIANTS` for backward compat (maps to default agent)

d) **Agent switching in `utterance_end` handler**:
```js
// In wake mode
if (wakeMode === 'wake') {
  const wakeResult = detectWakeAgent(cleanedText, options.agents, options.selectedAgentIds);
  if (!wakeResult.detected) {
    // No wake word — check stickyMode (future). For now, ignore.
    return;
  }
  if (wakeResult.agentId !== currentAgentId) {
    switchAgent(wakeResult.agentId);
  }
}
```

e) **`switchAgent(agentId)` function**:
- Update `currentAgentId` and `lastActiveAgentId`
- Get the agent config from `options.agents[agentId]`
- Update the Gateway URL/token used by `streamChat()` for subsequent calls
- Update the TTS voice reference ID
- Log the switch
- Call `options.onAgentSwitch?.(oldId, newId)`

f) **Per-agent session user IDs**: When calling `streamChat()`, use `meet-${session.id}-${currentAgentId}` as the `sessionUser` (not just `meet-${session.id}`)

g) **Greeting logic**:
- Only the default agent greets
- If multiple agents are selected, default agent's greeting should mention others:
  ```
  "(happy) こんにちは！ケイティです。今日はアレクとゾーイも一緒だよ！"
  ```
- Build this dynamically from `selectedAgentIds`

h) **`speakSentence` needs to use current agent's voice**:
- Pass the current agent's `voiceId` to `synthesize()` 
- This means `speakSentence` should read `currentAgentId` and look up the voice

### 3. `src/stt.js` — Dynamic Keyterms

Modify `buildKeyterms()` to accept an optional parameter for additional terms:
```js
function buildKeyterms(extraKeyterms = []) {
  // ... existing logic ...
  const all = [...new Set([...baseTerms, ...extraTerms, ...extraKeyterms])];
  return all;
}
```

Also export `buildKeyterms` so the pipeline can pass agent keyterms.

Actually, a simpler approach: the `createSTT()` function should accept `options.keyterms` (array of strings) and use those as additional keyterms alongside the wake words. The pipeline will pass all selected agents' keyterms at STT creation time.

### 4. `src/llm.js` — Per-Agent Gateway Routing

No structural changes needed. The `streamChat()` function already accepts `openclawUrl`, `openclawToken`, and `openclawSystemAddendum` as options. The pipeline will just pass the current agent's values.

BUT: the pipeline needs to be able to switch these values mid-session. Currently they're captured at pipeline creation time. Solution: instead of capturing config at creation, read from a mutable state object:

```js
// In pipeline, maintain mutable agent config
const agentState = {
  openclawUrl: config.openclawUrl,
  openclawToken: config.openclawToken,
  voiceId: config.tts.referenceId,
  model: config.llm.model,
  openclawSystemAddendum: config.llm.openclawSystemAddendum,
  sessionUser: `meet-${session.id}-${currentAgentId}`,
};
```

When `switchAgent()` is called, update `agentState`. When calling `streamChat()` and `synthesize()`, read from `agentState`.

### 5. `src/tts-fish.js` — No Changes

Already accepts `referenceId` per call. The pipeline just needs to pass the right one.

### 6. `src/gateway-warmup.js` — Multi-Agent Warm-Up

Add:
```js
function warmUpMultipleAgents(sessionId, agents, selectedAgentIds, baseConfig, briefing) {
  const promises = selectedAgentIds.map(agentId => {
    const agent = agents[agentId];
    if (!agent) return Promise.resolve('skipped_unknown');
    
    const agentConfig = {
      ...baseConfig,
      openclawUrl: agent.gatewayUrl,
      openclawToken: agent.gatewayToken,
      llm: {
        ...baseConfig.llm,
        model: agent.model || baseConfig.llm.model,
      },
    };
    
    return warmUpGatewaySession(`meet-${sessionId}-${agentId}`, agentConfig, briefing);
  });
  
  // Fire-and-forget — don't await all
  Promise.all(promises).catch(err => {
    console.error('⚠️  Multi-agent warm-up partial failure:', err.message);
  });
}
```

Export: `warmUpMultipleAgents`

### 7. `src/transport-meet/meet-routes.js` — Accept Agent Selection

a) **New API endpoint: `GET /agents`**
Returns available agents (from `loadAgents()`):
```json
{
  "agents": [
    { "id": "caty", "name": "Caty", "displayName": "ケイティ", "default": true, "available": true },
    { "id": "alec", "name": "Alec", "displayName": "アレク", "default": false, "available": true },
    ...
  ]
}
```
`available` = gateway token is resolved (agent was loaded successfully).

b) **Update `/join-meeting`** to accept:
- `agentIds` (comma-separated string, e.g., `"caty,alec"`) — which agents to include
- If not provided, use default agent only (backward compatible)

c) **Update `createHandler()`** to pass multi-agent options to `createPipeline()`:
```js
function createHandler(session, turnState, onAudio) {
  const agents = loadAgents(); // or cache at module level
  const selectedIds = session.config.agentIds || [getDefaultAgent(agents)?.id].filter(Boolean);
  
  const config = getPipelineConfig({ /* base config */ });
  const pipeline = createPipeline(session, turnState, onAudio, config, {
    agents,
    selectedAgentIds: selectedIds,
    defaultAgentId: selectedIds[0],
    onAgentSwitch: (from, to) => {
      console.log(`🔄  Agent switch: ${from} → ${to}`);
    },
  });
  // ...
}
```

d) **Update warm-up call** to warm up all selected agents:
```js
warmUpMultipleAgents(sessionId, agents, selectedAgentIds, baseConfig, briefing);
```

e) **Update bot name** for multi-agent: show all names in bot display name, e.g., `"Caty, Alec (AI)"` when multiple agents selected.

f) **Conversation log**: Keep separate logs per agent within the session object:
```js
session.conversationLogs = {
  caty: [],
  alec: [],
};
```
When logging, push to `session.conversationLogs[currentAgentId]`.
Keep `session.conversationLog` as a unified timeline log for the full transcript.

### 8. `public/index.html` — Agent Selection UI

a) **Add agent selection section** between the meeting URL field and conversation mode:

For 1:1 mode: **dropdown** (select one agent)
For group mode: **checkboxes** (select multiple agents)

The UI should:
- Fetch `/agents` on page load
- Show a dropdown by default (1:1 mode)
- When user switches to group mode, convert to checkboxes
- Pre-select agents with `default: true`
- Send selected agent IDs as `agentIds` form field in `/join-meeting`

b) **Dynamic greeting preview**: Show the selected agent's greeting text as a preview.

c) **Active session banner**: Show which agents are in the meeting.

### 9. `src/session-events.js` — Minor Update

Add `agents` field to lifecycle metadata so Slack notifications can show which agents are in the meeting.

## Important Rules

1. **Backward compatibility**: If `agents.json` doesn't exist OR no `agentIds` param in `/join-meeting`, behave exactly as today (single-agent Caty mode using env vars).

2. **No hardcoded tokens**: All gateway tokens come from env vars. `agents.json` uses `${ENV_VAR_NAME}` syntax.

3. **Session isolation**: Each agent MUST have its own session user ID (`meet-{sessionId}-{agentId}`) to prevent conversation history mixing.

4. **Single STT**: Only ONE Deepgram connection. Do NOT create multiple STT instances.

5. **Single Attendee bot**: Only ONE bot joins the meeting (one audio stream). The agents share the same audio input/output.

6. **TTS voice switching**: When the active agent changes, subsequent TTS calls use that agent's `voiceId`. If `voiceId` is null, use the default from `.env` (`FISH_AUDIO_VOICE_ID`).

7. **Exit detection**: Exit commands should work regardless of which agent is currently active. Any agent can be told to "退出して".

8. **Error resilience**: If an agent's Gateway is unreachable, log a warning and fall back to the default agent. Don't crash.

## Testing Checklist

- [ ] Single agent mode (no agents.json) — works exactly as before
- [ ] Single agent from agents.json (1:1 mode) — correct Gateway/voice used
- [ ] Multi-agent mode — wake word switches between agents
- [ ] Multi-agent mode — correct TTS voice per agent
- [ ] Multi-agent mode — session IDs are per-agent
- [ ] Multi-agent mode — only default agent greets (mentions others)
- [ ] Web UI — shows agent selection
- [ ] Web UI — agent selection changes with conversation mode toggle
- [ ] `/agents` API returns correct data
- [ ] Warm-up fires for all selected agents
- [ ] Exit command works from any active agent
- [ ] Backward compatible when agents.json missing

## Commit Message

```
feat: multi-agent support (Phase 3)

- agents.json configuration for multiple AI agents
- Single pipeline with wake-word-based agent routing
- Per-agent Gateway URL, TTS voice, session isolation
- Web UI: agent selection (dropdown/checkboxes)
- Multi-agent warm-up on meeting join
- GET /agents API endpoint
- Backward compatible with single-agent mode
```
