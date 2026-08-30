# ADR: Discord adapter — security & configuration decisions

- **Status**: Draft — pending owner approval (EPIC #41 checkpoints 2 and 5)
- **Date**: 2026-08-30
- **Lane**: EPIC #41 child 0a ([#98](https://github.com/caty-ai/meetmate/issues/98))
- **Basis**: Design review r1 (5 seats, all GO-WITH-CHANGES) convergent findings C4, C7, C8 — see the review record on #41
- **Scope note**: This document is the *decision record only*. It does not modify `docs/settings-contract.md`, `src/settings/registry.js`, or `docs/settings-env-inventory.json`. The exact amendment text those files will receive is frozen in [Appendix A](#appendix-a-settings-contract-amendment-text-applied-in-child-2a) and applied by child #2a (after the #79 lane's lock clears), together with the env-inventory and lock-test updates in the same commit.

---

## ADR-1: `discord_bot_token` is a class-1 credential

**Decision**: The Discord bot token is stored as a **class-1** credential in the settings store — the same plane as `slack_bot_token`, which is its exact structural precedent.

**Registry entry** (applied in #2a):

```js
d("discord_bot_token", "discord.botToken", secret, { ux: "basic", credential: "class-1", envAlias: "DISCORD_BOT_TOKEN" }),
```

| Field | Value | Rationale |
|---|---|---|
| id / path | `discord_bot_token` / `discord.botToken` | Mirrors `slack_bot_token` / `slack.botToken` |
| class | `class-1` | The class split is **plane-based** (which surface owns the value), not token-vs-key. Review r1 C4: the earlier "class-2 tension" was a misread. Class-1 gives the token the full §2 store guarantees below |
| envAlias | `DISCORD_BOT_TOKEN` | Accepted only as a §3 launch-env override / `.env` seed and as an explicit class-1 migration input (`POST /api/settings/migrate-env-class1`), same as every class-1 alias |
| apply | `restart-required` | The voice gateway process binds the token at bootstrap; no live re-auth path in v1 |
| `requiredAtMeetingStart` | **not set** | Unlike `attendee_api_key` (globally required), the Discord token is required only when the session being started is a Discord session. See ADR-7 |

**What class-1 buys (existing §2/§8 guarantees, no new mechanism)**: masked in every UI/API projection (mask preserve/replace/explicit-clear semantics), stored in `config.json` written `0600` via the atomic locked store transaction, **excluded from version-1 export** (credential-free export), never echoed in issues/logs/errors, connection tests are value-free.

**Blast-radius caveat (recorded for checkpoint 2)**: a bot token is a **persistent identity with standing guild access** — unlike a per-meeting join credential, a leaked token is exploitable whenever the attacker wants, against every guild the bot is in, until rotated. This is why ADR-2 (rotation) and ADR-4 (intents minimization) are mandatory companions of this registration, not optional hygiene.

**Placeholder sentinel**: `your_discord_bot_token` is added to the contract's exact, case-sensitive sentinel list (13 → 14 entries), because `config.json.example` will carry the `discord.botToken` path (class-1 paths appear in the example per §9).

## ADR-2: Token rotation procedure

Discord's Developer Portal has a single-token model: **"Reset Token" immediately invalidates the old token** — there is no dual-token overlap window. The documented procedure (lands in the setup guide via child #4) is:

1. Discord Developer Portal → the bot application → Bot → **Reset Token**. The old token dies at this moment; the bot's live gateway connection survives until it next needs to re-authenticate, but treat the bot as down from here.
2. Paste the new token into the settings UI (`discord_bot_token`, masked field) and save.
3. Restart meetmate (`restart-required` apply). Expected downtime = the restart window.
4. Verify with the `discord` connection test (ADR-6) or by observing the bot come online in an allowlisted guild.
5. If the token was rotated because of suspected compromise: also review the bot's guild membership list in the portal (an attacker with the old token could have joined it to new guilds — the allowlist (ADR-3) prevents *our* process from serving those guilds, but membership itself should be pruned) and check the audit log of allowlisted guilds.

Rotation requires no settings-contract machinery beyond ADR-1: it is a value replacement through the normal masked-field replace path.

## ADR-3: Guild-ID allowlist

**Decision**: A non-secret settings field holds an explicit list of Discord guild (server) IDs the bot is allowed to operate in. **Empty list ⇒ refuse to join anything** (fail-closed default). Enforcement lives **in the adapter** (`src/transport-discord/`), not in operator policy: join requests targeting a non-allowlisted guild are rejected before any voice connection is attempted, and if the bot finds itself connected in a non-allowlisted guild (e.g. added via an old invite while the gateway was down), the adapter refuses to open a voice session there.

**Registry entries** (applied in #2a):

```js
d("discord_guild_allowlist", "discord.guildAllowlist", z.array(trimmedString(32)), { ux: "basic", defaultValue: [] }),
```

- Guild IDs are Discord snowflakes (numeric strings) — stored as strings; arrays replace as units per §2.
- This turns the EPIC's "身内サーバー第1弾" (private-server first) from a policy statement into a **technical boundary** (review r1 C8).
- Channel selection is *not* frozen here: which voice channel to join is a per-join runtime input (child #2b, join UX/probe). The allowlist bounds *where* joins are possible; it does not enumerate channels.
- The allowlist is a general (non-credential) setting: visible unmasked, included in export, editable in the settings UI.

## ADR-4: Intents & permissions minimization

**Decision** — the bot requests exactly:

| Surface | Granted | Explicitly NOT granted |
|---|---|---|
| Gateway intents | `Guilds`, `GuildVoiceStates` | `MessageContent` (privileged), `GuildMessages`, `GuildMembers`, presence — none of them |
| OAuth permissions | `View Channel`, `Connect`, `Speak` | Administrator, any text-send permission, `Mute/Deafen Members`, `Move Members` |

Voice receive/send in discord.js requires no additional privileged intent beyond `GuildVoiceStates`. The bot cannot read any text channel; text-chat relay is a recorded deferral (ADR-8). The setup guide (child #4) documents this as the invite-URL permission integer and portal-side intent switches, and states that granting more than the above is unsupported, not merely unnecessary.

**Standing trust guardrails restated for this transport** (review r1 C8 — these are existing brain-side invariants the Discord adapter must not weaken): wake word remains the **only** LLM entry point; unaddressed-speech injection stays OFF; `trustedAgentTools` stays `false`; no tool authority is ever derived from voice identity; Discord display names are presentation-only untrusted data (stable user ID is the identity key).

## ADR-5: Consent & recording posture (checkpoint 5)

Context that makes this different from Meet/Zoom: a **standing bot in a guild is not a meeting invitee**. Attendees of a scheduled meeting have implicitly accepted a participant list; people wandering into a voice channel where a bot idles have accepted nothing. The posture below is the **recommended default set** put to the owner as checkpoint 5:

| # | Question | Recommended default | Alternatives considered |
|---|---|---|---|
| 5.1 | Announce on join? | **YES — always announce.** On joining a voice channel the bot plays/says one short announce line: that it listens for its wake word, transcribes audio to respond, and what happens to transcripts (5.2/5.3). Not configurable OFF in v1 | Configurable announce (rejected for v1: a silent transcribing bot in a channel of non-inviters is exactly the consent gap C8 flags) |
| 5.2 | Slack summary for Discord sessions | **ON, same as meetings** (follows existing `summary_enabled` / Slack notification settings; no Discord-specific default flip) | OFF-by-default for Discord (rejected: summaries go to the operator's own Slack — same audience as Meet summaries; splitting defaults adds a surprise, not privacy) |
| 5.3 | LCM ingest for Discord sessions | **OFF by default** for Discord sessions, opt-in via a Discord-scoped setting (child #2a adds the flag) | Same-as-meetings ON (rejected: LCM ingest makes casual voice-channel chatter part of long-term memory; standing-bot capture differs from scheduled-meeting capture — this is the one place the posture is deliberately stricter than Meet) |
| 5.4 | Retention | Discord transcripts follow the **same retention as existing meeting transcripts** (no new store, no longer retention). The announce line (5.1) states that transcripts are kept by the operator | Discord-specific shorter retention (deferred: introduces a second retention regime; revisit if/when public servers are ever considered) |

First deployment is owner-managed private servers only (EPIC scope), so the people affected by these defaults are the owner's own community; the fail-closed pieces (allowlist empty-by-default, announce always-on, LCM off) keep the posture safe if that ever drifts.

## ADR-6: Connection-test provider enum — add the 6th literal

**Decision**: Amend the §5 enum from five literals to six: `soniox|deepgram|fish-audio|attendee|slack|discord`, with `discord` joining the **optional** test tier (Deepgram/Attendee/Slack pattern): the route may return `501 TEST_NOT_IMPLEMENTED` until implemented; once implemented it must use the same 5-second, value-free contract (implementation lands with #2a/#2b, likely `GET /users/@me` against the Discord API — a minimal authenticated request returning bot identity).

**Why not defer**: the enum sentence says the five literals are "the complete endpoint enum in v1", so *any* future addition requires an owner-approved amendment. Checkpoint 2 is already open for this ADR's amendment — folding the enum change in costs one line now and avoids a second owner-approval round-trip later. The alternative (explicit deferral, keep 5) was rejected on that economy; nothing else in the contract depends on the count staying five except the enum sentence and T12-14's wording (both amended in Appendix A).

## ADR-7: Per-transport requirement generalization (`requiredWhen`)

**Problem (r1 C7)**: `attendee_api_key` is globally `requiredAtMeetingStart`. A Discord-only operator could never reach `meetingReady` (or the gate would have to be bypassed, silently skipping credential checks). The Slack precedent already shows the shape informally: *"Slack is required only when Slack notifications are enabled"* (§7) — a conditional requirement resolved at meeting start, expressed today as resolver special-casing.

**Decision — the declarative shape** (contract-level; wiring lands in #0b/#2a):

- The registry gains an optional declarative field `requiredWhen` on any entry, replacing boolean `requiredAtMeetingStart` as the general form (`requiredAtMeetingStart: true` ≡ `requiredWhen: { always: true }`; existing entries keep their behavior).
- `requiredWhen` is a flat predicate object evaluated at the meeting-start validation boundary against the join request + resolved settings — same style as the UI's `visibleWhen`. v1 predicate vocabulary (closed): `{ always: true }` | `{ transport: "<literal>" }` | `{ setting: "<registry-id>", equals: <value> }`.
- Applied to this Epic: `attendee_api_key` → `requiredWhen: { transport: "attendee" }` (Meet/Zoom paths — today's behavior for those transports, corrected for Discord); `discord_bot_token` → `requiredWhen: { transport: "discord" }`; `slack_bot_token` keeps its notifications-enabled conditional, now expressible as `{ setting: "slack_notifications_enabled", equals: true }` instead of resolver prose.
- The meeting-start `503 MEETING_SETUP_REQUIRED` issue list is computed from the predicates; no transport may bypass the boundary (the gate generalizes, it does not develop holes).

## ADR-8: Explicit deferrals (recorded, out of scope for this Epic)

| Deferred item | Note |
|---|---|
| Public-server operation | EPIC checkpoint 3 territory; would reopen ADR-3/ADR-5 (moderation, rate limits, prompt defense) |
| Role-based wake ACL | Voice identity never grants authority in v1 (ADR-4); role gating is a future trust-model extension |
| Slash commands | No `applications.commands` scope requested |
| Text-chat relay | No text intents/permissions (ADR-4); the brain-over-text idea lives in the EPIC's future-candidates list |
| Barge-in (auto-interrupt on human speech) | **Excluded by owner decision 2026-08-30 (L1-8 superseding record on #41)**; stop plumbing `stopPlayback/flush(outputEpoch)` stays frozen in #0b for exit commands / manual stop |

---

## Appendix A: settings-contract amendment text (applied in child #2a)

The following is the complete, owner-approval-scoped (checkpoint 2) amendment. Child #2a applies it verbatim to `docs/settings-contract.md`, `src/settings/registry.js`, and `docs/settings-env-inventory.json` **in one commit** together with the regenerated lock-test expectations (`test/settings-hardening.js` is line- and count-pinned).

**A-1. §1 allowlist table — add two rows** (after the `slack_*` block):

```
| `discord_bot_token` | `discord.botToken` | `secret` | basic | class-1 | restart-required | `DISCORD_BOT_TOKEN` |
| `discord_guild_allowlist` | `discord.guildAllowlist` | `str(32)[]` | basic | — | restart-required | — |
```

**A-2. `src/settings/registry.js`** — add the two `d(...)` entries given in ADR-1 and ADR-3, adjacent to the Slack block.

**A-3. §5 connection-test enum sentence** — replace:

> The five provider literals `soniox|deepgram|fish-audio|attendee|slack` remain the complete endpoint enum in v1

with:

> The six provider literals `soniox|deepgram|fish-audio|attendee|slack|discord` remain the complete endpoint enum in v1

and extend the optional-tier sentence: "Deepgram, Attendee, Slack, and Discord are optional compatibility/integration tests" (same `501 TEST_NOT_IMPLEMENTED` semantics). T12-14's enum wording updates identically ("lock the six-provider route enum"; 501 permitted for Deepgram/Attendee/Slack/Discord).

**A-4. §3 sentinel list** — "13 exact, case-sensitive checked-in sentinels" becomes "14 …", adding `your_discord_bot_token`.

**A-5. §7 meeting-start requirements** — the requirement sentence gains the transport conditional (ADR-7): Attendee's class-1 key is required for Attendee-transport (Meet/Zoom) sessions; `discord_bot_token` is required for Discord sessions; the `requiredWhen` predicate vocabulary from ADR-7 is added to §1's registry field glossary. (`attendee_base_url` and other Attendee-plane fields follow their owning transport unchanged.)

**A-6. `docs/settings-env-inventory.json`** — add `DISCORD_BOT_TOKEN` as a class-1 alias entry (same shape as `SLACK_BOT_TOKEN`), regenerated with the inventory tool in the same commit.

**A-7. Class-1 migration** — no text change needed: `POST /api/settings/migrate-env-class1` operates over all class-1 entries by construction; `DISCORD_BOT_TOKEN` becomes migratable by virtue of A-1/A-2.

Anything in the contract not listed above is **unchanged** by this Epic's settings work.
