# ADR: defer production live avatar; authorize a gated comparison PoC

- Status: **Accepted for research**
- Date: 2026-07-23
- Decision owners: Meetmate maintainers
- Related: Issue #69

## Decision

Keep the current Attendee static-image bot plus Fish Audio as the only
production-qualified architecture. Do not implement or adopt a live-avatar
production path yet.

Authorize a separate, reversible PoC that first tests Attendee's webpage media
carrier without an avatar. If and only if it passes baseline-derived hard gates,
compare:

1. Attendee Voice Agent webpage + bounded local renderer; and
2. Attendee Voice Agent webpage + LiveAvatar LITE renderer.

Recall.ai is not a first-round candidate. It may be used later as a controlled
carrier diagnostic if Attendee fails for a repeatable provider-specific reason or
cannot provide sufficient evidence. Attendee `output_video` and full managed
conversational avatar modes are rejected.

## Drivers

1. Preserve the currently acceptable Fish Audio quality.
2. Preserve Agent Core identity, memory, skills, tools, policy, and turn authority.
3. Keep static mode unchanged, independently deployable, and the default.
4. Avoid repeating a multi-variable Recall experiment whose root cause was never
   established.
5. Measure observer-side audio, response latency, A/V timing, cancellation,
   reconnect, duplicate output, and 30-minute stability.
6. Bound cost, privacy, likeness, deletion, and operational risk before real data.
7. Prefer the smallest reversible change and evidence before abstraction.

## Context and historical Recall result

The previous Recall branch evolved through several materially different designs:

- browser-scheduled PCM playback with one `AudioBuffer` per chunk;
- `getUserMedia` plus `ScriptProcessor(4096)` and manual downsampling;
- an `AudioWorklet`, still with 4096-frame capture;
- a hybrid of direct Recall raw input for meeting audio and browser output for TTS;
- enabling mixed raw audio;
- later Fish S2-Pro and prompt/tag changes;
- an exact revert.

The surviving diff proves those topologies existed. It does **not** preserve the
heard symptom, meeting/platform conditions, recordings, actual browser rate, CPU
trace, Recall compute variant, or the human reason for reverting. Therefore:

- “Recall intrinsically degrades audio” is not established;
- browser scheduling/resampling, insufficient compute, capture/codec effects, echo,
  and tunnel/network behavior remain hypotheses;
- the historical attempt must be treated as an unattributed failure, not vendor
  proof or a clean benchmark.

## Considered alternatives

### A — Attendee Voice Agent webpage

Selected as the shared carrier to test. It is the smallest meeting-provider change
from current production and supports a webpage whose audio/video become the bot's
meeting media. It still replaces the known direct realtime-audio egress with an
unmeasured browser/capture/WebRTC path.

### B — Attendee `output_video`

Rejected. The current documented contract queues an HTTPS MP4 URL; it is not
continuous live video injection. Segment swapping would be an unsupported hack with
poor real-time and cancellation properties.

### C — Recall.ai Output Media

Deferred. It provides useful page-capture diagnostics and compute variants but
changes the meeting provider, cost/lifecycle, and repeats the historical failure
class. It is reserved for a named carrier discriminator after A evidence exists.

### D — managed FULL avatar pipeline

Rejected. Giving a vendor STT, LLM, memory, dialogue, tools, or TTS would duplicate
or replace the frozen Agent Core/Fish authority.

### E — bounded local renderer

Selected as the first renderer control after the carrier gate. It maximizes local
observability and replaceability and introduces no new audio processor. It is not
assumed to meet a photorealistic product requirement.

### LiveAvatar LITE

Selected as the managed challenger after independent bench qualification. Its
documented raw mono S16LE 24 kHz input matches current Fish output and can remain
renderer-only. It still introduces a remote queue, separate video clock, credential,
voice/likeness processor, billing session, cleanup, privacy, and outage domain.

### Tavus Audio Echo

Deferred pending exact contract, sole-audio ownership, interrupt, pricing, privacy,
and meeting-handoff evidence.

## Why the chosen path

The carrier-only test isolates the largest shared unknown before renderer work. E
then provides a locally observable control; LITE tests whether managed visual
quality is worth its timing, privacy, lifecycle, and cost tradeoffs. Both receive
the same single Fish PCM lineage and keep all semantic Agent Core data out of the
renderer.

This sequencing yields useful negative results: a failed carrier ends both A
compositions cheaply; a passing E with failing LITE isolates the managed renderer;
a passing carrier with both renderers failing points to visual/timing requirements
rather than the meeting provider.

## Consequences

### Positive

- Production static behavior is unchanged.
- The PoC changes one failure domain at a time.
- Audio quality claims require observer evidence, not API-format inference.
- No second speech or cognition stack is introduced.
- Recall remains available as a later diagnostic without becoming a default.
- Vendor abstraction is postponed until an actual common interface is observed.

### Negative

- There is no immediate polished avatar feature.
- The carrier probe and baseline add work before a visual demo.
- A+LITE may need added audio delay, which can worsen perceived responsiveness and
  cancellation even if lip sync improves.
- A bounded local renderer may be useful only as laboratory equipment.
- A single uninterrupted 30-minute LITE run may require a plan with a long enough
  session limit; plan and concurrency terms must be confirmed before scheduling.

## Risks

- Observer audio may degrade despite identical source PCM.
- Split clocks may make stable A/V sync unattainable.
- Browser/page rendering may exceed target Mac mini headroom.
- Cancel/reconnect may leak queued media or create duplicate output.
- Vendor cleanup failure may leave billable orphan sessions.
- Custom likeness and voice processing may require consent, DPA, retention,
  regional, deletion, and biometric review.
- The product's visual floor is not yet quantified.

## Rejected implementation shapes

- Generic `AvatarProvider` interface or provider registry before two passing paths.
- Generic media-shell, DI, plugin, or lifecycle framework.
- Automatic Attendee/Recall failover.
- Same-meeting live-to-static fallback.
- A second TTS or resynthesis by the avatar vendor.
- Sending prompts, transcripts, memory, tools, stable user IDs, or internal turn
  state to a renderer.
- Repeated MP4 replacement through Attendee `output_video`.
- Combining Recall and LiveAvatar before each layer is independently qualified.

## PoC exit criteria

The research PoC is complete only when:

1. a 30-minute current-static baseline and each eligible composite have comparable
   observer recordings and complete structured telemetry;
2. Fish source lineage and exactly one audible meeting waveform are proven;
3. response latency, signed/absolute A/V skew, drift, underrun/overrun, cancellation
   tail, reconnect, duplicate bot/audio, CPU/memory/thermal, and cleanup are measured;
4. predetermined baseline-derived thresholds and the visual floor are evaluated
   without moving them after candidate results;
5. failure injection covers renderer timeout, websocket loss, vendor 5xx, lost
   delete response, page reload, meeting reconnect, and repeated cancellation;
6. static mode passes regression with live dependencies missing and blackholed;
7. cost, plan/session/concurrency, privacy, likeness rights, retention, deletion,
   region, subprocessors, and operational ownership are recorded;
8. the result recommends adopt, reject, or run one named diagnostic—never an
   unbounded “iterate more.”

Detailed protocol: [`04-comparison-poc-spec.md`](./04-comparison-poc-spec.md).

## Follow-ups

1. Approve the written baseline script, visual floor, and threshold-setting method.
2. Recover any historical Recall recordings/logs and the original revert rationale.
3. Confirm Attendee Voice Agent and target meeting-platform account constraints.
4. Confirm LiveAvatar current plan/session/concurrency/API and deletion terms.
5. Complete privacy/likeness review before any real participant or custom avatar.
6. Execute the carrier probe in a new implementation session and isolated worktree.
7. Write a new adoption ADR only after PoC evidence exists.

## Minority opinion

The two named compositions are an authorization ceiling, not a build mandate. The
avatar-free A probe and off-meeting LITE probe can falsify the largest assumptions
more cheaply. If either fails, stop without creating its composite. Also, E must not
be called the leading product architecture unless stakeholders first confirm that
its bounded visual class could satisfy the product.
