# ADR: Discord adapter — security & configuration decisions

- **Status**: Draft v2 — pending owner approval (EPIC #41 checkpoints 2 and 5)
- **Date**: 2026-08-30 (v2 same day — revised per the 5-seat implementation review r1 on PR #104)
- **Lane**: EPIC #41 child 0a ([#98](https://github.com/caty-ai/meetmate/issues/98))
- **Basis**: Design review r1 (5 seats, all GO-WITH-CHANGES) convergent findings C4, C7, C8 — see the review record on #41
- **Scope note**: This document is the *decision record only*. It does not modify `docs/settings-contract.md`, `src/settings/registry.js`, `src/settings/resolver.js`, or `docs/settings-env-inventory.json`. The exact amendment those files will receive is frozen in [Appendix A](#appendix-a-settings-contract-amendment-applied-in-child-2a) and applied by child #2a (after the #79 lane's lock clears), in one commit together with the regenerated env-inventory and lock-test artifacts.
- **Verification posture**: Decisions below that rest on Discord-platform behavior are marked **[v1 assumption — verified by #0c]**. The frozen *security ceilings* (deny lists, fail-closed defaults) are not assumptions and do not move without a new owner round. If #0c/#1 evidence requires **widening** any frozen ceiling (e.g. an extra privileged intent), that returns to the owner as a new checkpoint round; evidence that merely *confirms or narrows* needs no re-approval.

---

## ADR-1: `discord_bot_token` is a class-1 credential

**Decision**: The Discord bot token is stored as a **class-1** credential in the settings store — the same plane as `slack_bot_token`, which is its exact structural precedent.

**Registry entry** (applied in #2a, with the `requiredWhen` machinery of ADR-7):

```js
d("discord_bot_token", "discord.botToken", secret, { ux: "basic", credential: "class-1", envAlias: "DISCORD_BOT_TOKEN", requiredWhen: { transport: ["discord"] } }),
```

| Field | Value | Rationale |
|---|---|---|
| id / path | `discord_bot_token` / `discord.botToken` | Mirrors `slack_bot_token` / `slack.botToken` |
| class | `class-1` | The class split is **plane-based** (which surface owns the value), not token-vs-key. Review r1 C4: the earlier "class-2 tension" was a misread. Class-1 gives the token the full §2 store guarantees below |
| envAlias | `DISCORD_BOT_TOKEN` | Accepted only as a §3 launch-env override / `.env` seed and as an explicit class-1 migration input (`POST /api/settings/migrate-env-class1`), same as every class-1 alias |
| apply | `restart-required` | The voice gateway process binds the token at bootstrap; no live re-auth path in v1 |
| requirement | `requiredWhen: { transport: ["discord"] }` | Required exactly for Discord-transport session starts (ADR-7); never blocks Meet/Zoom-only operators |

**What class-1 buys (existing §2/§8 guarantees, no new mechanism)**: masked in every UI/API projection (mask preserve/replace/explicit-clear semantics), stored in `config.json` written `0600` via the atomic locked store transaction, **excluded from version-1 export** (credential-free export), never echoed in issues/logs/errors, connection tests are value-free.

**Blast-radius caveat (recorded for checkpoint 2)**: a bot token is a **persistent identity with standing guild access** — unlike a per-meeting join credential, a leaked token is exploitable whenever the attacker wants, against every guild the bot is in, until rotated. This is why ADR-2 (rotation) and ADR-4 (intents minimization) are mandatory companions of this registration, not optional hygiene.

**Placeholder sentinel**: `your_discord_bot_token` is added to the contract's exact, case-sensitive sentinel list (13 → 14 entries) **and** to the resolver's implementing `SENTINELS` set (`src/settings/resolver.js:9-13` — the set that actually runs; amending only the doc would leave a checked-in placeholder counting as a configured token at the meeting-start gate). `config.json.example` carries the `discord.botToken` path per the §8 template rule.

**Unchanged by design**: no init-wizard change — `docs/cli-contract.md` stays frozen (r1 C4).

## ADR-2: Token rotation procedure

Premise **[v1 assumption — verified by the #4 setup-guide walkthrough]**: Discord's Developer Portal has a single-token model — "Reset Token" invalidates the old token with no dual-token overlap window. The documented procedure (lands in the setup guide via child #4) is:

1. Discord Developer Portal → the bot application → Bot → **Reset Token**. Treat the bot as down from this moment.
2. Paste the new token into the settings UI (`discord_bot_token`, masked field) and save.
3. **Clear any environment copy**: §3 precedence puts launch-env / `.env` seed **above** the store — a leftover `DISCORD_BOT_TOKEN` in the launch environment or `.env` would keep the dead (or worse, leaked) token as the effective value after restart. Unset the env var / remove the `.env` line (operator action; meetmate never edits `.env`).
4. Restart meetmate (`restart-required` apply). Expected downtime = the restart window.
5. Verify with the `discord` connection test (ADR-6) or by observing the bot come online in an allowlisted guild.
6. If rotating because of suspected compromise: also review the bot's guild membership in the portal (an attacker with the old token could have joined it to new guilds — the allowlist (ADR-3) prevents *our* process from serving those guilds, but membership itself should be pruned) and check the audit log of allowlisted guilds.

Rotation requires no settings-contract machinery beyond ADR-1: it is a value replacement through the normal masked-field replace path.

## ADR-3: Guild-ID allowlist

**Decision**: A non-secret settings field holds an explicit list of Discord guild (server) IDs the bot is allowed to operate in. **Empty list ⇒ refuse to join anything** (fail-closed default — this is a frozen ceiling, not an assumption). Enforcement lives **in the adapter** (`src/transport-discord/`), not in operator policy:

- join requests targeting a non-allowlisted guild are rejected before any voice connection is attempted;
- if the bot finds itself with a voice connection in a non-allowlisted guild (added via an old invite while the gateway was down, or a connection recovered after an allowlist shrink), the adapter **aborts that voice connection** — it does not merely decline new sessions;
- the allowlist is `restart-required`, so **shrinking it takes effect at the next restart**; this revocation window is accepted and recorded here (mitigation: restart after shrinking, which the settings UI already signals via the standard restart-required flow).

**Registry entry** (applied in #2a):

```js
d("discord_guild_allowlist", "discord.guildAllowlist", snowflakeArray, { ux: "basic", defaultValue: [] }),
```

where `snowflakeArray` is the registry's existing `stringArray` validator (unique entries, at most 64, per the §1 array glossary) further refined to `^[0-9]{17,20}$` — guild IDs are Discord snowflakes (numeric strings; bounds **[v1 assumption — verified by #0c]**). The regex catches operator typos early; matching stays exact-string and fail-closed either way.

- This turns the EPIC's "身内サーバー第1弾" (private-server first) from a policy statement into a **technical boundary** (review r1 C8).
- Channel selection is *not* frozen here: which voice channel to join is a per-join runtime input (child #2b). The allowlist bounds *where* joins are possible; it does not enumerate channels. UX note for #2b: an empty allowlist on a Discord start attempt should surface an early, non-requirement setup hint rather than failing only at adapter join.
- The allowlist is a general (non-credential) setting: visible unmasked, included in export, editable in the settings UI.

## ADR-4: Intents & permissions minimization

**The frozen security ceiling (deny list — moves only with a new owner round)**: the bot must NOT request or hold `MessageContent`, `GuildMessages`, `GuildMembers`, presence intents, Administrator, any text-send permission, `Mute/Deafen Members`, or `Move Members`.

**The v1 grant set [v1 assumption — verified by #0c's live round-trip]**:

| Surface | Granted |
|---|---|
| Gateway intents | `Guilds`, `GuildVoiceStates` |
| OAuth permissions | `View Channel`, `Connect`, `Speak` |

The claim that voice receive/send in discord.js needs nothing beyond this is exactly what the #0c spike exercises. If #0c shows a *smaller* set suffices, narrow without re-approval; if it needs anything **on or beyond the deny list**, stop and return to the owner (new checkpoint round). The setup guide (child #4) documents the invite-URL permission integer and portal-side intent switches, and states that granting more than the v1 set is unsupported, not merely unnecessary.

**Standing trust guardrails restated for this transport** (review r1 C8 — existing brain-side invariants the Discord adapter must not weaken): wake word remains the **only** LLM entry point; unaddressed-speech injection stays OFF; `trustedAgentTools` stays `false`; no tool authority is ever derived from voice identity; Discord display names are presentation-only untrusted data (stable user ID is the identity key).

## ADR-5: Consent & recording posture (checkpoint 5)

Context that makes this different from Meet/Zoom: a **standing bot in a guild is not a meeting invitee**. Attendees of a scheduled meeting have implicitly accepted a participant list; people in a voice channel with a bot have accepted nothing. The posture below is the **recommended default set** put to the owner as checkpoint 5:

| # | Question | Recommended default | Alternatives considered |
|---|---|---|---|
| 5.1 | Announce on join? | **YES — always announce, and capture starts only after the announce completes.** On joining a voice channel the bot plays/says one short announce line: that it listens for its wake word, transcribes audio to respond, and what happens to transcripts (5.2/5.3). Not configurable OFF in v1. No audio is transcribed or buffered before the announce finishes | Configurable announce (rejected for v1: a silent transcribing bot is exactly the consent gap C8 flags) |
| 5.2 | Slack summary for Discord sessions | **ON, same as meetings** (follows existing `summary_enabled` / Slack notification settings; no Discord-specific default flip) | OFF-by-default for Discord (rejected: summaries go to the operator's own Slack — same audience as Meet summaries; splitting defaults adds a surprise, not privacy) |
| 5.3 | LCM ingest for Discord sessions | **OFF by default**, opt-in via a dedicated flag frozen here and added by #2a: `discord_lcm_ingest_enabled` / `discord.lcmIngestEnabled` / boolean / `defaultValue: false` / non-credential, exported, restart-required (spec in Appendix A-1/A-2) | Same-as-meetings ON (rejected: LCM ingest makes casual voice-channel chatter part of long-term memory; standing-bot capture differs from scheduled-meeting capture — the one place the posture is deliberately stricter than Meet) |
| 5.4 | Retention | Discord transcripts follow the **same retention as existing meeting transcripts** (no new store, no longer retention). The announce line (5.1) states that transcripts are kept by the operator | Discord-specific shorter retention (deferred: introduces a second retention regime; revisit if/when public servers are considered) |
| 5.5 | Late entrants (people joining the channel after the bot) | **No idle listening**: the bot's presence in a voice channel is session-bound — it joins for an active session and leaves when the session ends; it never lingers as a passive listener. Late entrants are covered by the bot's visible member-list presence + the session having been announced (5.1), documented in the setup guide. A per-entrant audio notice is **rejected for v1** (repeated chimes in an owner-managed private guild are noise, not consent) and becomes a mandatory design item at the public-server checkpoint (EPIC row 3) | Per-entrant announce now (rejected as above); allow idle presence (rejected: recreates the silent-listener gap for every later entrant) |

First deployment is owner-managed private servers only (EPIC scope), so the people affected by these defaults are the owner's own community; the fail-closed pieces (allowlist empty-by-default, announce always-on with capture-after-announce, LCM off, no idle listening) keep the posture safe if that ever drifts.

## ADR-6: Connection-test provider enum — add the 6th literal

**Decision**: Amend the connection-test provider enum from five literals to six: `soniox|deepgram|fish-audio|attendee|slack|discord`, with `discord` joining the **optional** test tier (Deepgram/Attendee/Slack pattern): the route may return `501 TEST_NOT_IMPLEMENTED` until implemented; once implemented it must use the same 5-second, **value-free** contract — the fixed five-field response shape only; no bot username, ID, or any vendor-response detail in `message` (the Discord API call, likely `GET /users/@me`, is non-normative implementation detail).

**Why not defer**: the enum sentence declares the literals "the complete endpoint enum in v1", so *any* future addition requires an owner-approved amendment. Checkpoint 2 is already open for this ADR's amendment — folding the enum change in costs a few lines now and avoids a second owner-approval round-trip later. Note the enum is pinned in **two places** (§6 route table and §6 prose sentence) plus T12-14 — Appendix A-3 amends all three.

## ADR-7: Per-transport requirement generalization (`requiredWhen`)

**Problem (r1 C7)**: `attendee_api_key` is enforced unconditionally at meeting start (`resolver.js:247-252`); a Discord-only operator could never reach `meetingReady`, or the gate would be bypassed. The resolver already special-cases STT keys (`stt_provider` skip, `resolver.js:248-249`) and Slack (explicitly-enabled source rule, `resolver.js:259-261`) — the conditional logic exists but as prose + code, not as declarative registry data.

### 7.1 Canonical transport literals

The canonical transport identifiers are the session-layer literals that exist today plus the new one: **`"meet" | "zoom" | "discord"`** (`src/session-events.js:29` documents `"meet"|"zoom"`). The **Attendee plane** is `["meet", "zoom"]`. There is no transport named `"attendee"` — predicates name real session transports only.

### 7.2 Predicate vocabulary (closed, v1)

`requiredWhen` is an optional declarative registry field replacing boolean `requiredAtMeetingStart`. Closed vocabulary:

- `{ always: true }`
- `{ transport: [<canonical literal>, ...] }` — non-empty list
- `{ setting: "<registry-id>", equals: <value>, explicit?: true }` — `explicit: true` means the setting's resolved **source is neither `default` nor `unset`** (the existing Slack source-tier rule, made declarative)

What the vocabulary deliberately does NOT cover: the per-agent dynamic Slack token family (`<AGENTID>_SLACK_BOT_TOKEN`, `resolveDynamicSlackToken`) **remains resolver-owned special-casing, unchanged and documented** — this ADR does not claim it is expressible declaratively.

### 7.3 Evaluation semantics (frozen — this is the security boundary)

1. The join request's transport is **derived server-side from the join route/dispatch** (#0b's dispatch scheme). It is never a client-supplied field that selects which credentials get checked.
2. **Fail-closed on absent/unknown transport**: a validation context without a determinable canonical transport evaluates every transport-scoped predicate as **required** — i.e. behaves like today's global gate. An unknown transport can only over-require, never under-require.
3. The meeting-start boundary (`503 MEETING_SETUP_REQUIRED`) re-evaluates predicates **for the requested transport** on every join; `/health` remaining coarse never substitutes for the join-time check.
4. `/health.meetingReady` stays a backward-compatible context-free boolean: computed as today for the Attendee plane, with Discord-transport requirements joining the conjunction **only when Discord is configured** (meaningful `discord.botToken` or non-empty allowlist). An operator who never touches Discord fields sees exactly today's behavior. Per-transport readiness detail may be added **additively** (#0b's decision); `setupMode`/`settingsIssues` semantics unchanged.

### 7.4 Migration matrix (exact — the boolean⇒predicate equivalence is NOT mechanical)

`requiredAtMeetingStart: true ≡ requiredWhen: { always: true }` holds **only for entries that are unconditional today**. Entries with existing conditional behavior get their exact predicates:

| Registry entry | Today | Becomes |
|---|---|---|
| `attendee_api_key` | boolean true (unconditional in resolver) | `requiredWhen: { transport: ["meet", "zoom"] }` |
| `discord_bot_token` | (new) | `requiredWhen: { transport: ["discord"] }` |
| `soniox_api_key` | boolean true + resolver skip unless `stt_provider === "soniox"` | `requiredWhen: { setting: "stt_provider", equals: "soniox" }` |
| `deepgram_api_key` | boolean true + resolver skip unless `stt_provider === "deepgram"` | `requiredWhen: { setting: "stt_provider", equals: "deepgram" }` |
| `fish_audio_api_key`, `fish_voice_id` | boolean true, unconditional | `requiredWhen: { always: true }` |
| `slack_bot_token` | resolver rule: enabled AND source not default/unset AND no dynamic token | `requiredWhen: { setting: "slack_notifications_enabled", equals: true, explicit: true }` — the dynamic-token escape stays resolver-owned (7.2) |

A mechanical `always: true` rewrite would newly block Deepgram-only operators (both STT keys demanded) and every default configuration (Slack default is `true` with source `default`) — the matrix above is therefore normative, not illustrative.

### 7.5 Application constraint (one commit, #2a)

#2a applies the registry migration, the `requiredWhen` field in the `SettingDefinition` type/glossary, resolver evaluation with the transport context (`getStatus({ transport })` or equivalent), the join-route context wiring for the existing Meet path, and **T12-07 transport-split test cases proving Meet/Zoom gating is byte-identical for Attendee-plane operators** — in the same commit as the rest of Appendix A (the lock tests force this anyway). Until that commit lands, the current boolean gate remains in force; there is no intermediate state where `attendee_api_key` is unenforced.

## ADR-8: Explicit deferrals (recorded, out of scope for this Epic)

| Deferred item | Note |
|---|---|
| Public-server operation | EPIC checkpoint 3 territory; would reopen ADR-3/ADR-5 (moderation, rate limits, prompt defense, per-entrant notice — ADR-5.5) |
| Role-based wake ACL | Voice identity never grants authority in v1 (ADR-4); role gating is a future trust-model extension |
| Slash commands | No `applications.commands` scope requested |
| Text-chat relay | No text intents/permissions (ADR-4); the brain-over-text idea lives in the EPIC's future-candidates list |
| Barge-in (auto-interrupt on human speech) | **Excluded by owner decision 2026-08-30 (L1-8 superseding record on #41)**; stop plumbing `stopPlayback/flush(outputEpoch)` stays frozen in #0b for exit commands / manual stop |

---

## Appendix A: settings-contract amendment (applied in child #2a)

The complete, owner-approval-scoped (checkpoint 2) amendment. Child #2a applies it to `docs/settings-contract.md`, `src/settings/registry.js`, `src/settings/resolver.js`, and `docs/settings-env-inventory.json` **in one commit** together with the regenerated lock-test expectations (`test/settings-hardening.js` and the inventory lock test are line- and count-pinned), the schemas regeneration, and the template artifacts (`config.json.example`). Implementation sites that follow mechanically (e.g. the routes-plane provider set in `src/settings/routes.js`, T12-07 cases) land in the same commit.

**A-1. §1 allowlist table — add three rows** (after the `slack_*` block; cell conventions follow the table: `none` for empty Credential/Env alias cells, `/ <default>` notation):

```
| `discord_bot_token` | `discord.botToken` | `secret` | basic | class-1 | restart-required | `DISCORD_BOT_TOKEN` |
| `discord_guild_allowlist` | `discord.guildAllowlist` | `str[]` (unique, ≤64, each `^[0-9]{17,20}$`) / `[]` | basic | none | restart-required | none |
| `discord_lcm_ingest_enabled` | `discord.lcmIngestEnabled` | `bool` / `false` | basic | none | restart-required | none |
```

**A-2. `src/settings/registry.js`** — add the three `d(...)` entries (ADR-1, ADR-3, ADR-5.3 — the token entry carries `requiredWhen: { transport: ["discord"] }`), apply the ADR-7.4 migration matrix to `attendee_api_key` / `soniox_api_key` / `deepgram_api_key` / `slack_bot_token` / `fish_audio_api_key` / `fish_voice_id`, and extend the definition helper/type with the `requiredWhen` field (replacing `requiredAtMeetingStart`).

**A-3. Connection-test enum — three pinned sites, all amended**: (i) the **§6 route table** row for `POST /api/settings/connections/:provider/test` — provider set becomes `soniox|deepgram|fish-audio|attendee|slack|discord`; (ii) the **§6 prose sentence** "The five provider literals `soniox|deepgram|fish-audio|attendee|slack` remain the complete endpoint enum in v1" → "The six provider literals `soniox|deepgram|fish-audio|attendee|slack|discord` remain the complete endpoint enum in v1", and the optional-tier sentence becomes "Deepgram, Attendee, Slack, and Discord are optional compatibility/integration tests" (same `501 TEST_NOT_IMPLEMENTED` semantics); (iii) **T12-14** — "lock the six-provider route enum"; 501 permitted for Deepgram/Attendee/Slack/Discord.

**A-4. Sentinels — all four sites**: (i) §3's "13 exact, case-sensitive checked-in sentinels" → "14 …", adding `your_discord_bot_token`; (ii) **T12-13**'s "the 13 exact case-sensitive placeholder sentinels" → 14; (iii) the implementing `SENTINELS` set in `src/settings/resolver.js`; (iv) `config.json.example` gains the `discord.*` registry paths with the new sentinel as the `discord.botToken` placeholder (§8 template rule; template tests updated accordingly).

**A-5. §7 meeting-start requirements — quoted replacement.** The §7 requirement sentence

> "It returns `503` … until the active provider combination has meaningful requirements: agent id/display name and wake word; selected STT class 1 key; Fish Audio class 1 API key and voice id; Attendee class 1 key; plus a valid environment-only agent/LLM connection. Slack is required only when Slack notifications are enabled."

becomes

> "It returns `503` … until the active provider combination has meaningful requirements: agent id/display name and wake word; selected STT class 1 key; Fish Audio class 1 API key and voice id; for meet/zoom-transport session starts, the Attendee class 1 key; for discord-transport session starts, the Discord class 1 bot token; plus a valid environment-only agent/LLM connection. Slack is required only when Slack notifications are explicitly enabled (a non-default source). The join request's transport is derived server-side from the join route; a join whose transport cannot be determined is validated against every transport's requirements."

and §1 gains the `requiredWhen` field definition (vocabulary + evaluation semantics of ADR-7.2/7.3) in the `SettingDefinition` type block and glossary, replacing `requiredAtMeetingStart?: boolean`.

**A-6. `docs/settings-env-inventory.json`** — add `DISCORD_BOT_TOKEN` as a class-1 alias entry (same shape as `SLACK_BOT_TOKEN`: empty `references`, `class-1-external-vendor`, masked/store/export-excluded handling), and bump `baselineUniqueDirectCount` 91 → 92 together with the two doc sites that pin it: §5 "The baseline has 91 unique direct names" and T12-02's "the 91 direct names".

**A-7. Class-1 preamble (contract head)** — the fixed enumeration "Class 1 — external Meetmate vendors: `SONIOX_API_KEY`, `DEEPGRAM_API_KEY`, `FISH_AUDIO_API_KEY`, `ATTENDEE_API_KEY`, and `SLACK_BOT_TOKEN`" gains `DISCORD_BOT_TOKEN`.

**A-8. Class-1 migration** — no text change needed: `POST /api/settings/migrate-env-class1` operates over all class-1 entries by construction; `DISCORD_BOT_TOKEN` becomes migratable via A-1/A-2/A-6.

Anything in the contract not listed above is **unchanged** by this Epic's settings work; if #2a discovers a further count-pinned or enumerated site that this appendix missed, that discovery is a blocking finding to report back against this ADR (superseding record), not a silent extra edit.
