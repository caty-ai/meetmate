# CLI & Config-Resolution Contract (frozen — Epic #13, child #14)

Status: **frozen 2026-08-22** (Epic #13 v3.1 requirements + kickoff decisions
[#13 comment](https://github.com/caty-ai/meetmate/issues/13#issuecomment-5380997031)).
Changing any decided value below is contract-level deviation → E-3 checkpoint 3 (stop, owner approval).
Implementation issues: #3 (packaging/CLI/paths), #15 (README), #16 (AI files).

## 1. Package identity

- npm package name: **`meetmate`** (unscoped). No org scope, no dual-publish.
- Version line: **8.1.x** — `package.json` version is bumped `0.1.0 → 8.1.0`; the first
  published version continues the repository's existing `v8.0.0` release history.
  `v0.x` is never published. npm version = git tag (`v8.1.0`) = published bytes.
- `"private": true` is removed; `"publishConfig": { "access": "public" }` added;
  `repository`, `homepage`, `bugs`, `keywords` fields added.
- `bin`: `meetmate` → `bin/ai-meet.js` (unchanged).

## 2. CLI surface

Commands (no renames; no new *required* flags):

<!-- Amended by EPIC #29 child 0 (#30), CP#1 owner approval recorded 2026-08-29 (https://github.com/caty-ai/meetmate/issues/29#issuecomment-5460738835): start prints the guarded /settings UI URL; / remains the existing dashboard. -->
| Command | Behavior |
|---|---|
| `meetmate init [--force]` | Interactive wizard, then writes `config.json`, `.env`, `AGENTS.md` into the **resolved home** (§3 — same tier logic as `start`; the current cwd-only behavior in `bin/ai-meet.js:77-78` is a confirmed gap). Per-file overwrite rules in §5. |
| `meetmate start` | Boots the server. The settings-UI URL is printed **exactly once, only after `listen` succeeds**, as the browser-openable form `http://localhost:<port>/settings` where `<port>` = `server.address().port` — never the raw bind address (`::`/`0.0.0.0`). `/` remains the existing dashboard. The single print lives in the server's listen callback; the CLI's current pre-require print (`bin/ai-meet.js:127`) is removed (review fix, Grok F4; the pre-bind print is confirmed gap G2). |
| `meetmate mcp` | MCP stdio server (unchanged). |
| `--help` / no args | Usage (unchanged). |

Wizard scope (kickoff decision ②) — the **frozen prompt sequence**, one stdin line per
prompt, each with a one-line "where to get it" hint (review fix, Grok F2):

<!-- Amended by EPIC #29 child 0 (#30), CP#1 owner approval recorded 2026-08-29 (https://github.com/caty-ai/meetmate/issues/29#issuecomment-5460738835) -->
<!-- 4th amendment approved by owner 2026-08-25: FISH_AUDIO_VOICE_ID remains prompt 3 and is stored at tts.voiceId. -->
| # | Prompt | Written to |
|---|---|---|
| 1 | `SONIOX_API_KEY` | `config.json` (`stt.sonioxApiKey`) |
| 2 | `FISH_AUDIO_API_KEY` | `config.json` (`tts.apiKey`) |
| 3 | `FISH_AUDIO_VOICE_ID` | `config.json` (`tts.voiceId`) |
| 4 | `ATTENDEE_API_KEY` | `config.json` (`attendee.apiKey`) |
| 5 | LLM provider — accepted tokens exactly `openclaw` \| `openai-compatible` | see write-set below |
| 6+ | branch `openclaw`: `OPENCLAW_GATEWAY_URL`, then `OPENCLAW_GATEWAY_TOKEN` (2 lines). branch `openai-compatible`: `baseUrl`, then `apiKey`, then `llm.model` (3 lines) | see write-set below |

Generated values consume **zero** stdin lines: `JOIN_SHARED_TOKEN` and `WS_SHARED_TOKEN`
(kickoff decision ③) are generated via `crypto.randomBytes(32).toString("hex")` and
written as uncommented lines into `.env`; `--force` regeneration rotates them (accepted —
existing clients must be updated).

**LLM write-set per branch** (review fix, Grok F1, as amended by Issue #30): a meaningful
pre-dotenv launch `LLM_PROVIDER` beats `config.json` `llm.provider`; config beats the
resolved-home `.env` seed; and `llm.model` has no environment alias. This is the four-tier
precedence in §3 / `docs/settings-contract.md`, not the former blanket “env beats config” rule.

<!-- Amended by EPIC #29 child 0 (#30), CP#1 owner approval recorded 2026-08-29 (https://github.com/caty-ai/meetmate/issues/29#issuecomment-5460738835) -->
| Choice | `.env` (required) | `config.json` (required) |
|---|---|---|
| `openclaw` | `LLM_PROVIDER=openclaw`, `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN` | `llm.provider="openclaw"` (the example default may stay) |
| `openai-compatible` | `LLM_PROVIDER=openai-compatible` (**must overwrite the example's `LLM_PROVIDER=openclaw` default**), `OPENAI_COMPATIBLE_API_KEY` | `llm.provider="openai-compatible"`, `llm.model`, `llm.openaiCompatible.baseUrl` |

On the `openai-compatible` branch init therefore mutates **both** files; the API key is
environment-only as `OPENAI_COMPATIBLE_API_KEY` and must never be placed at
`llm.openaiCompatible.apiKey`. The sentinel test covers both files: class 1 vendor
credentials live in `config.json`, while class 2/3 credentials and control tokens live
in `.env`.

Out of wizard scope (stated in output + README, not collected): ngrok/Tailscale setup,
Google Meet admission. The wizard's closing message names them as the remaining manual steps.

The wizard prompts **only for inputs that will be written on this run** (review fix,
Grok F3 / GLM F4): on the upgrade path (config/.env exist, `AGENTS.md` missing) init runs
no credential wizard and only writes `AGENTS.md`. No `--yes` flag is added.

Preflight: both `init` and `start` check `process.version` against `engines.node` (≥ 26)
and fail with a one-line actionable message (not a stack trace).

Resumability: an interrupted `init` leaves no partial file (existing atomic
tmp-file+rename per file is kept); re-running completes only the missing files
per §5's per-file rules without corrupting existing ones.

## 3. Config & data resolution order

For `config.json` / `.env`, in order:

1. **`AI_MEET_HOME`** (shell environment; the explicit tier — kept and honored
   **identically by `init` and `start`**). **The resolved home is pinned from the
   pre-dotenv (launch) environment**: home resolution must capture
   `process.env.AI_MEET_HOME` before dotenv loads `.env`; lazy evaluation applies only to
   joining paths against that pinned home. A value inside `.env` has no effect on the
   home (the `.env` location itself depends on the home — no circular resolution).
   NOTE this is a **target, not today's behavior** (review fix, Kimi F1 / GLM F1): dotenv
   mutates `process.env`, so today's runtime-resolved paths (`logsDir()`,
   `ttsCacheDir()`, `avatarCachePath()`) partially honor a `.env`-sourced
   `AI_MEET_HOME`. The G3 lock-test must assert that an `AI_MEET_HOME` line inside
   `.env` has no effect on any resolved path.
2. **Current working directory** (default).
3. **XDG fallback: NO** for this launch (settled upstream at delta review). Adding XDG
   later is a new contract change with its own lane.

<!-- Amended by EPIC #29 child 0 (#30), CP#1 owner approval recorded 2026-08-29 (https://github.com/caty-ai/meetmate/issues/29#issuecomment-5460738835) -->
For an individual editable main-registry setting with `writeSurface:"settings"`, filesystem resolution above is followed by the four-tier
value precedence in `docs/settings-contract.md`: meaningful pre-dotenv OS/shell env →
`config.json` store → resolved-home `.env` init/legacy seed → code default. The startup
path alone captures the pre-dotenv snapshot; exact `${NAME}` placeholders and the 13
case-sensitive checked-in sentinels enumerated in `docs/settings-contract.md` are unset.
In particular `OPENAI_COMPATIBLE_API_KEY` is environment-only and
`llm.openaiCompatible.apiKey` is ignored and stripped by the settings migration/save.
Deployment-readonly extension aliases have no config path and use launch env → `.env` →
code default; they are diagnostics, not wizard/PUT/import fields.
The noneditable main entries are also outside editable four-tier semantics: `server_port`
reports the actual bound port, `resolved_home` reports the launch-pinned home, and
`audio_clips` is mutated only by the audio API.

From-source compatibility: running from a repo checkout with cwd = repo root behaves
exactly as today (cwd tier). Existing `AI_MEET_HOME` users keep their behavior; the fix
is that `init` starts honoring it (today it writes to cwd unconditionally — gap list below).

Bundled vs. user data split:

| Data | Location | Notes |
|---|---|---|
| Default avatar, fillers manifest, `public/`, templates | **Bundled, read-only** — resolved via `bundledPath()`/`bundledAssetPath()` (package install dir) | Shipped in the tarball. |
| User avatar override | `<home>/assets/avatar.png` (`avatarCachePath()`) | Absent → server falls back to the bundled default; `init` does **not** copy the avatar out. |
| TTS cache | `<home>/assets/tts-cache` (or `TTS_CACHE_DIR` env override — kept) | Created on demand. |
| Logs | `<home>/logs` (or `METRICS_LOG_DIR` env override for metrics — kept) | Created on demand. |
| `config.json`, `.env`, `AGENTS.md` | `<home>` per the order above | Written by `init`. |

Load-order rule: nothing may capture a resolved path at module-require time before
dotenv has loaded (`src/config.js:6` captures `CONFIG_PATH` at require — acceptable
today only because server.js loads dotenv first at `src/server.js:2-3`; the
implementation must make this ordering explicit or lazy, and a test locks it).

### Confirmed gap list (code survey 2026-08-22, verified in-repo)

| # | Site | Today | Contract target |
|---|---|---|---|
| G1 | `bin/ai-meet.js:77-78` | `init` writes to `process.cwd()` unconditionally, ignoring `AI_MEET_HOME` | `init` resolves home via §3 order — same as `start` |
| G2 | `bin/ai-meet.js:127` | URL printed before server require/bind, from shell `PORT` only | Print after bind; URL = bound host:port |
| G3 | `src/config.js:6` | `CONFIG_PATH` captured at require time | Explicit ordering or lazy resolution + test |
| G4 | `bin/ai-meet.js:8-12` | Wizard collects 3 keys only | §2 wizard scope (LLM + voice ID + generated tokens) |
| G5 | `bin/ai-meet.js:80` | Overwrite refusal is pair-wise on `config.json`/`.env`; `AGENTS.md` not in the set | §5 per-file rules |

## 4. Tarball contents

`package.json` `files` is the **only** packaging mechanism (no `.npmignore`), treated as
an explicit allowlist:

- Ships: `bin/`, `src/` (includes the AGENTS.md template — path below), `public/`,
  `assets/avatar.png`, `assets/fillers/`, `config.json.example`, `.env.example`,
  `README.md`, `LICENSE`, `NOTICE`.
- Deny-set (asserted absent in the packaging proof): `test/`, `docs/`, `scripts/`,
  `tools/`, `.env`, `config.json`, `_handoffs/`, `.omc/`. **npm-page rendering uses
  absolute GitHub URLs in the shipped README — nothing extra ships** (settled here so
  #15 makes no packaging choice; review fix, GLM F3).
- Amendment (owner cp3 decision, 2026-08-23, recorded on #3): npm force-includes
  README-class files regardless of `files`, so the localized `README.ja.md` /
  `README.th.md` / `README.zh.md` also ship. Accepted — they are documentation-only,
  secret-scanned, and carry absolute GitHub URLs (#15), so "nothing extra ships"
  reads as "nothing outside the allowlist plus npm's forced README/LICENSE/NOTICE
  class ships". The deny-set above is unchanged and remains the enforced assertion.
- Amendment (owner cp2 decision, 2026-08-23, recorded on #13): npm's readme picker
  selected `README.zh.md` as the registry `readmeFilename` at 8.1.0, rendering the
  Chinese README on the npm page. Fix shipped in 8.1.1: the localized READMEs moved
  from the package root to `docs/i18n/` (added to `files` as an explicit allowlist
  entry, so they **still ship** — the cp3 acceptance above is preserved), leaving
  `README.md` as the only root README so the picker is deterministic. The `docs/`
  deny-set entry now reads as "all of `docs/` except the explicitly allowlisted
  `docs/i18n/`"; everything else in `docs/` remains denied and asserted absent.
- **AGENTS.md template path: `src/agents-template.md`** — inside the already-shipped
  `src/`, so #16 needs no `package.json` edit.
- NOTICE: reworded to "clone the repository if you need to seed fillers; the npm tarball
  does not include the seeder" (the seeder script stays out; `scripts/` stays denied).

## 5. init-generated files

`init` writes three files into the resolved home; overwrite rules are **per-file**:

Three rules, stated without reference to today's behavior (review fix, Grok F3 / Kimi F2
— note today's refusal at `bin/ai-meet.js:80-84` is **joint over the pair**; G5 changes
it to per-file):

1. **`config.json` and `.env` are independent.** The existence of one never refuses the
   other. Without `--force`: skip (do not overwrite) each file that already exists; write
   each file that is missing. With `--force`: overwrite both (atomic tmp+rename, `.env`
   mode 0600 — kept). An interrupted run therefore resumes by re-running `init`, which
   completes only the missing files.
   <!-- Amended by EPIC #29 child 0 (#30), CP#1 owner approval recorded 2026-08-29 (https://github.com/caty-ai/meetmate/issues/29#issuecomment-5460738835) -->
   Class 1 vendor credentials collected by init are written to their allowlisted
   `config.json` settings paths, not `.env`; class 2/3 values remain environment-only.
2. **`AGENTS.md`**: absent → generate, even when config/.env already exist (upgrade
   path); present **with** the meetmate marker → keep without `--force`, regenerate with
   `--force`; present **without** the marker (foreign file) → **never overwrite,
   `--force` included** — print a notice and skip.
3. **Prompt only for what will be written on this run** (§2): if no credential-bearing
   file will be written, no credential wizard runs.

Template guarantees (all testable, tests live in #16):

- Static file shipped in the tarball (`src/agents-template.md`); **no interpolation of
  user or config values** into the generated output.
<!-- Amended by EPIC #29 child 0 (#30), CP#1 owner approval recorded 2026-08-29 (https://github.com/caty-ai/meetmate/issues/29#issuecomment-5460738835) -->
- Contains configuration key **names only, never values** (test: sentinel values written
  to **both `.env` and `config.json`** must not appear in the generated file; no
  `KEY=value` lines — class 1 values may live in `config.json`, while class 2/3 values
  remain environment-only, §2).
- **Amended frozen first line**: `<!-- meetmate-generated template=2 -->`, followed by
  the sentence "regenerate with `meetmate init --force`". The version is bumped because
  Issue #30 removes class 2 config paths and moves class 1 setup to the settings plane.
  Detection accepts the exact anchored family `<!-- meetmate-generated template=<positive integer> -->`
  so a generated template 1 remains recognizable; new generation always writes template 2.
- Includes the AI-security notice: **"SECURITY NOTICE FOR AI AGENTS: never print, log,
  or commit values from `.env`."** The file never instructs an assistant to read or
  echo `.env` values.
- Content scope: instance docs (key meanings, file locations, start/stop, settings-UI,
  common failure modes incl. LLM endpoint unreachable / port in use / tunnel down,
  remaining manual steps). It grants no privileges.

Issue #30 template-2 shape is contract-level: `config.json` contains class 1 settings and
no `gateway.url`, `gateway.token`, or `llm.openaiCompatible.apiKey`; `.env` contains
class 2/3 values and deployment aliases; generated `AGENTS.md` may name keys but contains
no values or `KEY=value` assignments. Tests cover template-1 ownership detection,
template-2 regeneration, both example shapes, all persistent class-2 deny paths (including
legacy agent/per-agent forms), and high-entropy sentinel nonleakage from both files.
