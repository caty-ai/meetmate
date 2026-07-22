# Pipeline Decomposition: Fish Audio TTS Integration

## Goal
Replace the Deepgram Voice Agent (all-in-one STT+LLM+TTS) with a decomposed pipeline:
```
Attendee (Google Meet audio) 
  → Deepgram STT (Nova 3, streaming)
  → Claude LLM (via OpenRouter, streaming)
  → Fish Audio TTS (WebSocket streaming, PCM output)
  → Attendee (audio back to Meet)
```

## Architecture

### Current (Voice Agent - all-in-one)
```
server.js → transport-meet/meet-routes.js → createAgent() → deepgram.agent() → configure(settings)
  - Audio in: agent.send(buffer)
  - Audio out: AgentEvents.Audio → callback
  - Text events: AgentEvents.ConversationText
```

### New (Decomposed Pipeline)
```
server.js → transport-meet/meet-routes.js → createPipeline(session, turnState, onAudio)
  ├── stt.js: Deepgram Live STT (Nova 3)
  │   - Input: PCM audio buffers from Attendee
  │   - Output: transcript text (on speech_final)
  │
  ├── llm.js: Claude via OpenRouter (streaming)
  │   - Input: user text + conversation history
  │   - Output: streaming text chunks
  │
  └── tts-fish.js: Fish Audio TTS (REST streaming with chunked transfer)
      - Input: complete response text
      - Output: PCM audio buffers → onAudio callback
```

## File Structure

### New files to create:
- `src/stt.js` — Deepgram STT streaming wrapper
- `src/llm.js` — Claude LLM streaming wrapper (OpenRouter)
- `src/tts-fish.js` — Fish Audio TTS (HTTP streaming, NOT WebSocket SDK)
- `src/pipeline.js` — Orchestrates STT → LLM → TTS

### Files to modify:
- `src/transport-meet/meet-routes.js` — Replace `createAgent()` with `createPipeline()`
- `src/config.js` — Update config for new pipeline
- `.env.example` — Add new env vars

## Detailed Specs

### src/stt.js — Deepgram STT Streaming

```js
// Uses @deepgram/sdk live transcription (already installed)
// createClient(DG_KEY).listen.live(options)

exports.createSTT = function(dgKey, options) {
  // Returns an object with:
  //   .send(audioBuffer) — feed audio
  //   .on('transcript', (text, isFinal) => {}) — interim/final transcripts
  //   .on('utterance_end', () => {}) — user stopped speaking
  //   .on('error', (err) => {})
  //   .close()
  
  // Options:
  //   model: "nova-3"
  //   language: "ja" or "en"
  //   sample_rate: 16000
  //   encoding: "linear16"
  //   smart_format: true
  //   interim_results: true
  //   utterance_end_ms: 1200
  //   endpointing: 400
  //   vad_events: true
}
```

### src/llm.js — Claude via OpenRouter

```js
// Uses fetch to call OpenRouter API (OpenAI-compatible)
// Streaming via Server-Sent Events

exports.createLLMStream = async function*(systemPrompt, messages, options) {
  // Yields text chunks as they arrive
  // 
  // API: POST https://openrouter.ai/api/v1/chat/completions
  // Headers: Authorization: Bearer <OPENROUTER_API_KEY>
  // Body: { model: "anthropic/claude-sonnet-4-5", stream: true, messages: [...] }
  //
  // Options:
  //   apiKey: OPENROUTER_API_KEY (from env)
  //   model: "anthropic/claude-sonnet-4-5"
  //   temperature: 0.5
  //   max_tokens: 300 (keep responses short for voice)
}
```

### src/tts-fish.js — Fish Audio TTS

```js
// Uses Fish Audio REST API with chunked transfer encoding
// POST https://api.fish.audio/v1/tts
// Header: model: s1
// Header: Authorization: Bearer <FISH_AUDIO_API_KEY>
// Body: { text, reference_id, format: "pcm", sample_rate: 16000, latency: "balanced" }
// Response: chunked PCM audio stream

exports.synthesize = async function(text, options) {
  // Returns a ReadableStream of PCM audio buffers
  // 
  // Options:
  //   apiKey: FISH_AUDIO_API_KEY
  //   referenceId: voice model ID (or null for default)
  //   sampleRate: 16000
  //   format: "pcm"
  //   latency: "balanced" (or "normal" for better quality)
}
```

### src/pipeline.js — Orchestrator

```js
exports.createPipeline = function(session, turnState, onAudio, config) {
  // Creates the full STT → LLM → TTS pipeline
  // Returns an object with:
  //   .sendAudio(buffer) — feed audio from Attendee
  //   .close() — cleanup
  
  // Flow:
  // 1. Audio → STT.send()
  // 2. STT emits 'utterance_end' with accumulated text
  // 3. Add user text to conversation history
  // 4. Call LLM with history → get streaming response
  // 5. Buffer LLM text, split into sentences
  // 6. For each sentence → Fish Audio TTS → audio chunks → onAudio()
  // 7. Track turnState (isAgentSpeaking, etc.)
  
  // Sentence splitting for Japanese:
  //   Split on: 。！？\n
  //   Min sentence length: 10 chars (avoid tiny fragments)
  //   Flush remaining text when LLM stream ends
  
  // Greeting:
  //   On first connection, synthesize greeting text via TTS and send
  
  // Conversation history:
  //   Keep in session.conversationLog (same format as before)
  //   Pass to LLM as messages array
  //   Limit to last 20 messages to stay within context
}
```

### src/transport-meet/meet-routes.js changes

Replace `createAgent()` call with `createPipeline()`:

```js
// OLD:
const agent = createAgent(session, turnState, (buffer) => { ... });
// ...
agent.send(audio);

// NEW:
const pipeline = createPipeline(session, turnState, (buffer) => { ... }, pipelineConfig);
// ...
pipeline.sendAudio(audio);
```

The server entrypoint and the rest of the Meet route handling (HTTP server, session management, Attendee API, etc.) stay the same.

### src/config.js changes

Update to export pipeline config instead of Voice Agent config:

```js
module.exports = {
  SAMPLE_RATE: 16000,
  CATY_PROMPT,  // system prompt text
  getPipelineConfig: () => ({
    stt: {
      model: "nova-3",
      language: LANG,
      sampleRate: 16000,
    },
    llm: {
      model: "anthropic/claude-sonnet-4-5",
      temperature: 0.5,
      maxTokens: 300,
    },
    tts: {
      provider: "fish-audio",  // or "voicevox" later
      referenceId: process.env.FISH_AUDIO_VOICE_ID || null,
      sampleRate: 16000,
      latency: "balanced",
    },
    greeting: LANG === "ja"
      ? "こんにちは！ケイティです。よろしくお願いします！"
      : "Hi! I'm Caty. Nice to meet you!",
  }),
};
```

### .env additions

```
# Fish Audio TTS
FISH_AUDIO_API_KEY=your_key_here
FISH_AUDIO_VOICE_ID=          # Optional: voice model ID from fish.audio

# LLM (OpenRouter)
OPENROUTER_API_KEY=your_key_here

# TTS Provider: "fish-audio" or "deepgram-agent" (legacy)
TTS_PROVIDER=fish-audio
```

## Audio Format
- Attendee sends/receives: linear16 (PCM 16-bit signed LE), 16kHz, mono
- Deepgram STT accepts: linear16, 16kHz ✓
- Fish Audio outputs: PCM, 16kHz ✓ (set format:"pcm", sample_rate:16000)
- No conversion needed!

## Error Handling
- If Fish Audio fails → log error, skip that utterance
- If LLM fails → log error, send fallback "すみません、ちょっとエラーが…"
- If STT disconnects → attempt reconnect (Deepgram SDK handles this)
- All errors should be non-fatal (don't crash the server)

## Turn Management
1. `turnState.isAgentSpeaking = true` when first TTS audio chunk sent
2. `turnState.isAgentSpeaking = false` when TTS stream ends
3. The Meet route handler's echo gate drops audio frames while agent is speaking (same as before)
4. If user speaks while agent is speaking → interrupt: stop LLM, stop TTS, reset

## Key Constraints
- Keep it simple! This is MVP.
- No WebSocket SDK for Fish Audio (use HTTP streaming — simpler)
- Sentence-by-sentence TTS (not word-by-word)
- Conversation history limit: 20 messages
- Max LLM response tokens: 300 (keep voice responses short)
- Fish Audio latency mode: "balanced" (300ms latency, good quality)

## Dependencies
- `@deepgram/sdk` — already installed (STT)
- `fish-audio` — NOT needed (using raw HTTP API)
- No new npm packages needed! Just use built-in `https`/`fetch`

## Testing
After implementation, test with:
1. Start server: `node src/server.js`
2. Join meeting via UI or `/join-meeting`
3. Speak Japanese → verify STT transcription in logs
4. Verify LLM response in logs
5. Verify TTS audio plays in Meet
