# Meetmate Transport Contract

Status: frozen from design-spec v2.2 for issue #99 on 2026-08-30.

This document is the frozen transport/session contract for EPIC #41 child #99. It separates forward-looking requirements from recorded current Attendee behavior so later transport work can add Discord and shared infrastructure without silently redefining the existing Meet/Zoom plane.

## Contract Change Policy [Normative]

- [Normative] Every statement tagged `[Normative]` is frozen for EPIC #41 and later child issues.
- [Normative] Any deviation, widening, alternate literal, fallback, or interface change that cannot satisfy this document must escalate to EPIC #41 checkpoint 4. No silent contract drift is allowed.
- [Normative] Characterization tests pin the current observed Attendee behavior where this document says "observed", "recorded", or "today".
- [Lane-note] Issue #99 implements only the owned surfaces in its file set. Several normative obligations below are deliberately frozen here for later children, especially #1.

## D0. What This Freeze Does Not Make True Today [Normative]

- [Normative] The table below is part of the contract. The "Pinned by" column names the characterization evidence. The "Who makes it true" column identifies whether the behavior already exists or is deferred.

| Statement | True for Attendee today? | Pinned by | Who makes it true |
| --- | --- | --- | --- |
| Transport literal identical across lifecycle, sessionUser, auth, and warmup | Partially. Zoom URLs collapse to `"meet"` everywhere in v1. | Session characterization: Zoom URL join -> `"meet"`. | Nobody in v1. `"zoom"` stays reserved. |
| Externally initiated disconnect reaches a terminal lifecycle state | Yes, directly as `in-progress -> completed`, skipping `ending`. | Session characterization: `ws_close`. | Already true. |
| Supersede or reconnect never resumes audio on a terminal lifecycle | No. Reconnect inside the finalize window can attach a live handler to a `completed` lifecycle. | Session characterization pins the warning plus accepted reconnect. | Future transport work, not #99/#1. |
| Authoritative stop purges queued audio on session close | No event fires on idle close after turn completion because `currentAbort` is already null. | Audio characterization: idle-close case. | The D4 two-authority rule; Discord complies from birth. |
| Capability flags exist as a runtime object | No. | Not applicable today. | Issue #1; the carrier is frozen here in D6. |
| Cross-transport mutex exists | No. Attendee still uses private `meetingSessions.size`, including delegation-retention 409 behavior. | Session characterization: exact 409 plus retention-window 409. | Issue #1; the interface is frozen here in D9. |

## D1. Canonical Transports [Normative]

- [Normative] Canonical literals are `"meet" | "zoom" | "discord"` (ADR-7.1).
- [Normative] The Attendee plane is `["meet", "zoom"]`. There is no transport named `"attendee"`.
- [Normative] V1 Attendee collapse is frozen: Meet and Zoom URLs both run as literal `"meet"` across lifecycle, sessionUser namespace, auth-gate context, and gateway-warmup keys.
- [Normative] `"zoom"` remains in the JSDoc union as a reserved literal only. Passing `"zoom"` as a live transport in v1 is a contract amendment, not a cleanup.
- [Normative] The predicate `{ transport: ["meet","zoom"] }` is satisfied by literal `"meet"` under the v1 collapse.
- [Normative] `src/session-events.js` extends only the constructor JSDoc union to `{"meet"|"zoom"|"discord"}`. The constructor does not validate literals, and the file header enum-free comment stays unchanged.
- [Normative] The transport literal used for a session must be identical across `SessionLifecycle.transport`, sessionUser prefixing, dispatch-derived transport, and auth-gate context, subject to the recorded Attendee collapse above.

## D2. Audio In Framing (Transport -> Pipeline) [Normative]

- [Normative] The frozen intake is `pipeline.sendAudio(buffer[, meta])`.
- [Normative] `buffer` is PCM s16le, 16,000 Hz, mono, arbitrary chunk sizes, and even byte length.
- [Normative] Transports must drop odd-length buffers at the boundary. The pipeline may assume even length because `stt.send` has no guard.
- [Normative] `meta` is optional and, when present, has shape:

```js
{
  speaker: {
    platform: string,
    id: string,
    displayName?: string,
    isBot: boolean
  }
}
```

- [Normative] `meta` is present whenever the second argument is not `undefined`; `null` is present, not absent.
- [Normative] A present `meta` is malformed when it is not an object, `speaker` is absent, `speaker.id` is not a non-empty string, or `speaker.isBot` is not a boolean.
- [Normative] Malformed present `meta` drops the chunk without throwing.
- [Normative] Unattributed audio must omit the argument entirely: `sendAudio(buffer)`.
- [Normative] `speaker.platform` must be the canonical transport literal.
- [Normative] `speaker.platform` is not validated by the pipeline in v1; the adapter owns it.
- [Normative] `speaker.id` is the stable platform user ID and the only identity key.
- [Normative] `"unknown"` is a reserved sentinel and must never enter any identity or authorization map as a real user ID.
- [Normative] `displayName` is presentation-only untrusted data. It is never authorization and never identity equality.
- [Normative] Malformed `meta` means the chunk is rejected fail-closed. The pipeline must not silently degrade malformed attributed audio to unattributed mixed audio.
- [Normative] Absent `meta` means unattributed mixed audio. That is the entire current Attendee plane and must remain byte-identical in v1.
- [Normative] Codec decode, per-user decoder and resampler state, downmix, and anti-aliased 16 kHz mono resample stay transport-owned. The resampler must be stateful; naive decimation is non-conforming.
- [Normative] STT utterance finalization is pipeline-owned, not transport-owned.
- [Normative] Discord-style adapters must not rely on `EndBehaviorType.AfterSilence` for boundaries. They subscribe per user with **Manual end** for session lifetime, treat `receiver.speaking` as advisory presence only, and accept DTX 3-byte frames as normal.
- [Normative] Consent gate: a Discord adapter must not call `sendAudio` and must not buffer PCM for later submission until the join announce has completed.
- [Lane-note] In issue #99 the pipeline accepts `meta` and validates the malformed speaker cases that the freeze explicitly names, but otherwise ignores it. The mux that consumes it is future pipeline work.

## D3. Audio Out Framing (Pipeline -> Transport) [Normative]

- [Normative] The frozen output callback is `onAudio(buffer, metadata)`.
- [Normative] `buffer` is PCM s16le, mono, at `config.tts.sampleRate` (default 24,000).
- [Normative] Output buffers are even-length by construction. The existing Fish Audio implementation already holds odd trailing bytes; transports may rely on sample alignment.
- [Normative] `metadata` is `{ outputEpoch, firstSampleIndex, sampleRate, envelopeSegments? }`.
- [Normative] `firstSampleIndex` is the cumulative sample offset within the current output epoch.
- [Normative] Streamed synthesis may arrive faster than real time. Cache replay is realtime paced. In either case, transport owns pacing, resampling, transcoding, and framing.
- [Normative] Discord-style adapters rely on player pacing; pre-buffering is safe and no bespoke pacer is required.
- [Normative] `tts_sample_rate` remains one global v1 setting.
- [Normative] Discord v1 resamples `24 kHz -> 48 kHz` in-adapter with a conforming stateful FIR. It must not fall back to naive resampling.
- [Normative] A fixed-wire-rate transport must reject session start with a setup issue when `tts.sampleRate` is outside its supported ratio set.
- [Normative] Discord v1 supported ratios are `{24000, 48000}` and nothing else.
- [Normative] Changing the global default is not allowed in v1 because it rewrites the Meet `bot_output` contract, invalidates the TTS cache key, and invalidates pre-rendered `audio_clips`.
- [Normative] Turn-taking constants stay global in v1, including `TTS_LEAD_MS`, `TTS_GAP_MS`, `POST_UTTERANCE_BUFFER_MS`, and the hardcoded `LIVE_USER_SPEECH_HOLD_MS = 1200`.
- [Normative] Issue #3 measures wake-to-first-audio latency against the Meet baseline rather than changing these constants in this contract lane.

## D4. Authoritative Stop Uses Two Authorities [Normative]

- [Normative] The label "stopPlayback/flush(outputEpoch)" names behavior only. It is not a callable API and issue #99 does not add one.
- [Normative] `outputEpoch` is monotonically increasing but not contiguous with cancellations.
- [Normative] `outputEpoch` advances in exactly two ways:
  - [Normative] Authoritative abort increments it synchronously and emits `playback_cancelled`.
  - [Normative] Internal envelope re-arm increments it silently and emits no event.
- [Normative] Transports must key stop, purge, and late-audio rejection exclusively off `playback_cancelled`, never off observed epoch deltas.
- [Normative] `metadata.outputEpoch` on PCM is correlation data only. It is not the stop authority.
- [Normative] Authority 1 is the observer event `playback_cancelled { outputEpoch, reason, monotonicTime }`, where `outputEpoch` is the CANCELLED epoch (pre-increment value), not the new one.
- [Normative] A `supportsFlush: true` transport must, on `playback_cancelled`, do all of the following synchronously:
  - [Normative] Stop the currently playing resource.
  - [Normative] Drop buffered but unplayed audio with epoch `<= cancelled epoch`.
  - [Normative] Reject any late audio stamped with epoch `<= cancelled epoch`.
- [Normative] The `playback_cancelled` handler must be synchronous and non-throwing. Observer exceptions are intentionally swallowed by the pipeline.
- [Normative] The stop obligation is reason-agnostic.
- [Normative] The informative v1 reasons a Discord adapter must observe and honor are `wake_cancel`, `turn_interrupted`, `greeting_preempt`, `llm_response_timeout`, `first_token_delegation`, `external_abort`, `floor_fence`, and `pipeline_close`.
- [Normative] `pipeline_close` is best-effort because it fires only when an abort controller is still live at close time.
- [Normative] `barge_in` is explicitly out of Discord v1 at the source. "Out" means no transport-initiated interrupt from speaking events and no `reason: "barge_in"` abort on Discord.
- [Normative] Authority 2 is transport-owned teardown. Session end, pipeline close, or transport leave must stop and purge the player unconditionally even if no observer event fires.
- [Normative] Authority 2 is what closes the idle-close gap where synthesis has completed and `currentAbort` is already null.
- [Normative] The two authorities cover exit commands, manual stop, session teardown, and every existing non-barge-in pipeline abort reason.
- [Lane-note] Attendee remains `supportsFlush: false`. Its local-avatar `publishMarker` and `cancelPlayback` path is visual-only and not the authoritative audio stop channel.

## D5. Session Lifecycle [Normative]

- [Normative] The allowed lifecycle graph remains exactly `VALID_TRANSITIONS` in `src/session-events.js`.
- [Normative] The current event payload key sets are frozen as part of the contract:
  - [Normative] `state_change` -> `{ sessionId, from, to, transport, meta, timestamp }`
  - [Normative] `session_start` -> `{ sessionId, transport, to, from, agents, timestamp }`
  - [Normative] `session_end` -> `{ sessionId, transport, state, duration, durationFormatted, conversationLog, agents, timestamp }`
- [Normative] Current observed Attendee path is pinned as:
  - [Normative] `idle -> initiating -> in-progress`
  - [Normative] `in-progress -> completed { reason: "leave_requested" }`
  - [Normative] `in-progress -> completed { reason: "ws_close" }`
  - [Normative] `initiating -> failed { reason: "bot_launch_failed", statusCode }`
- [Normative] `ending` has zero producers today. It remains an allowed optional intermediate state.
- [Normative] "ready" maps to `in-progress` and `session_start`. No new readiness event is introduced.
- [Normative] A transport must create the lifecycle with its canonical literal.
- [Normative] On externally initiated disconnect, a transport must reach `completed` for a clean disconnect or `failed` for an error, optionally via `ending`, and close the pipeline. It must never leave a non-terminal lifecycle behind after the voice connection is gone. Examples include Attendee bot removal or WebSocket close and Discord kick, moderator disconnect, channel deletion, or an unresumable gateway drop.
- [Normative] For new transports, supersede is a current-owner concept: a superseded connection must not terminalize or finalize the session, and close effects must be guarded by current-client ownership.
- [Normative] For new transports, reconnect to a terminal lifecycle must be rejected rather than resuming audio on that lifecycle.
- [Normative] Attendee's current reconnect-inside-finalize-window behavior violates the previous rule and is intentionally recorded, not fixed, in this issue.
- [Normative] Attendee's session-in-teardown rejection mechanism is the `leavingSessionIds` set. The observable wire effect is WebSocket close code `1000` with reason `"Session is leaving"`.
- [Normative] New transports must provide an equivalent session-in-teardown rejection mechanism. The obligation is frozen; its shape is transport-local.
- [Normative] Session IDs are adapter-minted and transport-local, but must stay unique process-wide while active because they are the mutex key.

## D6. Capability Flags and Ownership [Normative]

- [Normative] Frozen capability vocabulary is:

```js
{ chat, perSpeakerAudio, avatarStream, supportsFlush, echoesOwnOutput }
```

| Flag | v1 consumer | Attendee | Discord v1 |
| --- | --- | --- | --- |
| `chat` | Adapter output paths plus join UX | `true` | `false` |
| `perSpeakerAudio` | Whether `meta.speaker` may be non-null | `false` | `true` |
| `avatarStream` | Static support for the local-avatar stream surface | `true` | `false` |
| `supportsFlush` | D4 authority-1 obligations | `false` | `true` |
| `echoesOwnOutput` | Echo-gate policy plus pipeline barge-in suppression | `true` | `false` |

- [Normative] The capability carrier is dual-placement and mandatory for new transport registration:
  - [Normative] Immutable `capabilities` on each adapter registry entry. Registration without it is rejected fail-closed.
  - [Normative] The identical object passed into `createPipeline(..., options.capabilities)`.
- [Normative] `options.capabilities`, when present (not `undefined`), must be an object; a non-object value is a construction error (throw).
- [Normative] Within an explicitly passed capability object, an absent flag means `false`.
- [Normative] A completely absent capability object means legacy Attendee semantics and must keep Meet byte-identical.
- [Normative] Capability flags are static per transport for the lifetime of a session.
- [Normative] The capability flag vocabulary may only be extended additively; flags are never renamed, removed, or re-typed without a checkpoint-4 amendment.
- [Normative] The only pipeline-side capability consumer in v1 is barge-in suppression.
- [Normative] When `options.capabilities.echoesOwnOutput === false`, the pipeline must not run the interim-transcript barge-in branch and must not emit `abortPlayback(..., "barge_in")`.
- [Normative] Echo policy itself remains transport-owned:
  - [Normative] Attendee (`echoesOwnOutput: true`) gates inbound mixed audio while `turnState.isAgentSpeaking` or `inputCooldownUntil` is active.
  - [Normative] Discord (`echoesOwnOutput: false`) never gates human input and never subscribes any `user.bot === true`, including its own user.
- [Normative] `ENABLE_BARGE_IN` continues to govern the Attendee path unchanged.
- [Normative] In the decomposed pipeline path, the transport creates `{ isAgentSpeaking: false, lastTurnEndAt: null, inputCooldownUntil: 0, droppedEchoFrames: 0 }`; `gateState` may be absent before the first turn.
- [Normative] Pipeline writes `isAgentSpeaking`, `lastTurnEndAt`, `gateState`, and `inputCooldownUntil`; the transport reads them for echo policy and writes `droppedEchoFrames`.
- [Lane-note] The legacy non-decomposed Attendee handler also writes speaking state directly. That exception is recorded, not extended.

## D7. sessionUser Namespace [Normative]

- [Normative] Parent namespace is `${transport}-${session.id}`.
- [Normative] Agent namespace is `${transport}-${session.id}-${agentId}`.
- [Normative] Delegate namespace appends `-delegate`.
- [Normative] `src/session-user.js` is the single producer via `sessionUserFor(transport, sessionId, agentId?)`.
- [Normative] The `-delegate` form is produced by suffix concatenation at consumer sites, not by `sessionUserFor`. This concat-at-consumer exception is recorded; consumers must concatenate onto helper-produced bases only.
- [Normative] The six pre-#99 hardcode sites are part of the frozen contract surface:
  - [Normative] `src/pipeline.js:718` (converted to `sessionUserFor` in #99)
  - [Normative] `src/pipeline.js:732` (converted to `sessionUserFor` in #99)
  - [Normative] `src/gateway-warmup.js:164`
  - [Normative] `src/gateway-session-tracker.js:119`
  - [Normative] `src/transport-meet/meet-routes.js:1340`
  - [Normative] `src/transport-meet/meet-routes.js:275`
- [Normative] Gateway warm-up keys must equal the pipeline's sessionUser exactly.
- [Normative] This equality prevents the existing cold-start regression where warm-up and live pipeline work target different gateway session keys.
- [Normative] `createPipeline` accepts optional `options.transport`; default when absent is `"meet"` so the Attendee plane remains byte-identical.
- [Normative] The pipeline validates only the canonical literal when `options.transport` is explicitly provided and throws otherwise.
- [Normative] Lifecycle-to-transport equality is not enforceable inside the pipeline because it never receives the lifecycle object.
- [Normative] Adapter-side construction must therefore source both lifecycle literal and `options.transport` from one adapter constant so a missing explicit option fails loudly at the adapter boundary rather than silently minting `meet-*` keys.
- [Lane-note] Issue #99 switches only the pipeline construction sites it owns. Issue #1 must make the four remaining consumers accept a transport argument with a default that preserves `meet-`; until then they remain `meet-`-only and string-identical under the v1 collapse.

## D8. Dispatch Scheme [Normative]

- [Normative] Routing remains catch-all and server-owned:
  - [Normative] Explicit non-transport routes first: settings handler, `/health`, and `/calibrate*`.
  - [Normative] Then an ordered adapter registry by path prefix.
  - [Normative] Attendee remains the default HTTP and WebSocket fallthrough. `/join-meeting` is never reinterpreted.
- [Normative] MCP behavior is unchanged by transport dispatch.
- [Normative] Registry path matching is `pathname === prefix || pathname.startsWith(prefix + "/")`.
- [Normative] The frozen v1 registry mapping is `/api/discord/` → Discord adapter.
- [Normative] Frozen future registry entry shape is `{ prefixes, capabilities, handleHttp, handleUpgrade?, ... }`, with `capabilities` mandatory.
- [Normative] Auth-gate transport derivation is separate from dispatch and is never client-supplied:
  - [Normative] Settings, `/health`, and `/calibrate*` derive to "no gate".
  - [Normative] Registry prefix derives to that adapter literal.
  - [Normative] Enumerated legacy Attendee endpoints derive to `"meet"`: `/join-meeting`, `/active-session`, `/leave-meeting`, `/agents`, `/info`, `/readiness*`, `/`, and the meeting WebSocket upgrade.
  - [Normative] Anything else is underivable and must be validated against every transport's requirements. This over-require branch is dormant today because unknown paths 404 before any gate; its live consumers are non-join `getStatus()` and unknown contexts.
- [Normative] Discord bootstrap is lazy, non-fatal, and never awaited during `bootstrap()`. Init failure is a readiness issue, not a dead settings UI.
- [Normative] Local-only is an enforced boundary, not documentation:
  - [Normative] Discord-prefix routes must reject non-loopback callers.
  - [Normative] They must reject any `Forwarded` or `X-Forwarded-*` headers.
  - [Normative] Rejection surface is concealed `404`, not an explicit transport-auth leak.
- [Normative] Omitting Discord routes from an ngrok fixture is not local-only enforcement and cannot replace these guards.
- [Lane-note] `server.js` is outside issue #99's file set. The scheme is frozen here for #1 implementation.

## D9. Cross-Transport Single-Active-Session Mutex [Normative]

- [Normative] The invariant is one active voice session process-wide across all transports.
- [Normative] "Active" means present in the transport's session registry. For Attendee that includes the delegation-retention window, so ended meetings with open delegations still 409.
- [Normative] Frozen future coordinator interface is:

```js
tryAcquire(transport, sessionId) -> lease | null
release(lease)
active() -> { transport, sessionId } | null
```

- [Normative] `lease` is opaque.
- [Normative] `release(lease)` is idempotent and releases only that exact lease. No ABA release is allowed.
- [Normative] Acquire happens after validation and before any vendor or voice side effect.
- [Normative] Release happens on every failed-join path and every terminal teardown.
- [Normative] Same-session reconnect or supersede reuses the same lease and must not 409 itself.
- [Normative] Missing, throwing, or uninitialized coordination fails closed. Join is rejected rather than failing open.
- [Normative] There is no timeout-based auto-release. A leak must stay visible, not be silently healed.
- [Normative] The release checklist for Attendee-side future wiring includes:
  - [Normative] `finalizeSessionIfInactive`
  - [Normative] `/leave-meeting`
  - [Normative] join-failure rollback
  - [Normative] the `/join-meeting` catch block
  - [Normative] any other throw-after-acquire path
  - [Normative] the WebSocket close finalize path
- [Normative] The `/join-meeting` catch (~`meet-routes.js:1410`) currently does NOT delete the session registry entry (pre-existing leak); a lease acquired before it must be released there or joins stick at `409`.
- [Normative] Discord join must not ship without the Attendee-side coordinator wiring. A one-directional mutex fails open and is forbidden.
- [Normative] The conflict surface stays transport-specific: Attendee preserves its exact HTTP `409` response, while Discord surfaces a join refusal with a reason.
- [Lane-note] Issue #1 adds the coordinator, Discord wiring, and the declared Attendee acquire/release edits. Issue #99 only pins the exact existing Attendee 409 surface and retention-window behavior.
- [Lane-note] Child #5's "meet-routes byte-identical" golden check holds through #99 and is amended by exactly the declared #1 edit set.

## D10. STT Mux Ownership [Normative]

- [Normative] The pipeline owns the STT mux. A transport never instantiates vendor STT for multi-speaker routing.
- [Normative] The transport supplies normalized per-user PCM only through `sendAudio(buffer, meta)`.
- [Normative] When `meta.speaker.id` is present, the pipeline routes PCM to a per-speaker STT stream created on first use.
- [Normative] Absent `meta` preserves today's single mixed STT stream.
- [Normative] The frozen vendor-stream ceiling is four attributed per-user streams plus one mixed `"unknown"` stream, for five total vendor STT streams.
- [Normative] The five-stream ceiling constant lives in the pipeline. It is not a settings field in v1.
- [Normative] Slot LRU is keyed by inbound PCM arrival for that `speaker.id`, never by `receiver.speaking`.
- [Normative] Admission happens when PCM for an unslotted speaker arrives and a free slot exists at that moment.
- [Normative] Mid-utterance admission is allowed even though the first partial utterance may be truncated.
- [Normative] Eviction happens only when the candidate slot emits a final utterance and is also the LRU slot at that moment.
- [Normative] Beyond-cap speakers degrade into the mixed stream after resample and sum, attributed as `{ platform: "discord", id: "unknown", isBot: false }`.
- [Normative] `isBot: false` on the mixed degrade bucket is guaranteed by the D6 no-bot-subscription rule.
- [Normative] Wake words from the mixed stream must keep the addressed flow alive even when speaker attribution degrades.
- [Normative] Mixed attribution across speaker overlap is lossy and recorded as such.
- [Normative] The frozen downstream transcript/log schema target is `speaker.platform`, `speaker.id`, `speaker.displayName`, and `speaker.isBot` on transcript entries.
- [Lane-note] Issue #99 keeps scope to signature acceptance and malformed-meta rejection. The mux is issue #1 pipeline work; issue #1 is explicitly not adapter-only.

## D11. Additive Pipeline Changes [Lane-note]

- [Lane-note] Issue #99 makes only these additive changes in `src/pipeline.js`:
  - [Lane-note] Accept optional `options.transport`, default it to `"meet"`, validate an explicitly supplied value against the canonical literal set, and construct both parent and agent sessionUser values through `sessionUserFor`.
  - [Lane-note] Load `src/session-user.js` lazily inside `createPipeline`; no top-level import or require is added.
  - [Lane-note] Accept optional `options.capabilities` and suppress only the interim-transcript barge-in branch when `echoesOwnOutput === false`; an absent capability object preserves legacy behavior.
  - [Lane-note] Accept `sendAudio(buffer, meta)`, drop malformed present meta without throwing into the transport, and otherwise continue to call the existing `stt.send(buffer)` path unchanged.
  - [Lane-note] Document the frozen options, audio-in, and audio-out callback shapes in JSDoc.
- [Lane-note] Lines 23–61 of the pre-issue `src/pipeline.js` are pinned by all 23 settings inventory references and must remain byte-identical. All issue #99 edits stay below line 61.
- [Lane-note] Issue #99 adds no direct `process.env` access in `src/` or `bin/`. If any pinned line shifts despite this constraint, `docs/settings-env-inventory.json` must be regenerated in the same change.
- [Lane-note] Meet defaults, ordering, and emitted values remain byte-identical. The canonical gates are `make test` and `make lint`, including `test/settings-hardening.js`.

## D12. Attendee Characterization Coverage [Lane-note]

- [Lane-note] `test/characterization-attendee-session.test.js` pins all of the following current observables without network access:
  - [Lane-note] Join guard order: setup-incomplete `503 MEETING_SETUP_REQUIRED`, then exact active-session `409`, then URL-validation `400`.
  - [Lane-note] The exact second-join `409` status/body and the delegation-retention-window `409`.
  - [Lane-note] Direct leave and WebSocket-close terminal transitions, their reasons, skipped `ending`, and handler closure.
  - [Lane-note] `leavingSessionIds` rejection as close code `1000` and reason `"Session is leaving"`.
  - [Lane-note] The WebSocket rejection ladder: unknown session `1008`, then bad token `1008`.
  - [Lane-note] Live supersede: old client close `1012`, old handler closure, one successor handler, and the observed shared lifecycle state after the old close event fires.
  - [Lane-note] Reconnect inside the finalize window: accepted connection, invalid-transition warning, and lifecycle remaining terminal.
  - [Lane-note] A Zoom URL still creates lifecycle transport `"meet"`.
  - [Lane-note] Full sorted key sets and transport/state values for `state_change`, `session_start`, and `session_end`.
  - [Lane-note] `/active-session` response shape and importable `getStatus()` readiness field names/types.
  - [Lane-note] The `/health` HTTP envelope pin is deferred to #1 (`server.js` is not importable without listening); readiness is pinned via importable `getStatus()`.
  - [Lane-note] Attendee calls `createPipeline` without `options.transport` or `options.capabilities`.
- [Lane-note] `test/characterization-attendee-audio.test.js` pins all of the following current or issue-#99 observables without network access:
  - [Lane-note] `realtime_audio.mixed` base64 decoding and `sendAudio(buffer)` pass-through with no meta.
  - [Lane-note] Echo gating during agent speech and cooldown, dropped-frame counting/reset, and the legacy `ECHO_GATE_CLOSED_BYPASS` branch.
  - [Lane-note] Exact `bot_output` framing with no epoch on the wire, plus Attendee's 16 kHz inbound request premise.
  - [Lane-note] `onAudio` metadata keys, synchronous cancelled-epoch reporting, silent envelope-rearm epoch advance, and absence of a cancellation event for that silent advance.
  - [Lane-note] Idle close after turn completion emits no `playback_cancelled` event.
  - [Lane-note] Live pipeline sessionUser parent/delegate values, default-transport behavior, explicit transport behavior, and `sessionUserFor` unit cases.
  - [Lane-note] Legacy Attendee barge-in remains reachable, while `capabilities.echoesOwnOutput === false` suppresses `barge_in` at the source.
  - [Lane-note] Greeting remains scheduled approximately two seconds after pipeline creation.
  - [Lane-note] Absent and well-formed audio meta reach STT; malformed present meta is dropped without throwing.
- [Lane-note] These two files are regression armor for issues #1, #2, and #5 and must be green before and after each later child.

## Out of Scope [Normative]

- [Normative] Barge-in as a Discord feature.
- [Normative] STT mux implementation beyond accepting and validating `meta`.
- [Normative] Cross-transport coordinator implementation and server dispatch wiring.
- [Normative] Settings-surface changes and `docs/settings-contract.md` amendments.
- [Normative] Attendee reconnect-terminal-lifecycle fixes.
- [Normative] Any widening that cannot fit this contract without reinterpretation. That case escalates to EPIC #41 checkpoint 4.
