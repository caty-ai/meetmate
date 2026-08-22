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

| Command | Behavior |
|---|---|
| `meetmate init [--force]` | Interactive wizard, then writes `config.json`, `.env`, `AGENTS.md` into the **resolved home** (§3 — same tier logic as `start`; the current cwd-only behavior in `bin/ai-meet.js:77-78` is a confirmed gap). Per-file overwrite rules in §5. |
| `meetmate start` | Boots the server. The settings-UI URL is printed **only after the listen port is bound**, and must equal the actually-bound host:port (the current pre-require print of `process.env.PORT || 5005` at `bin/ai-meet.js:127` is a confirmed gap). |
| `meetmate mcp` | MCP stdio server (unchanged). |
| `--help` / no args | Usage (unchanged). |

Wizard scope (kickoff decision ②): collects, each with a one-line "where to get it" hint —

1. `SONIOX_API_KEY` (STT)
2. `FISH_AUDIO_API_KEY` + **`FISH_AUDIO_VOICE_ID`** (TTS voice)
3. `ATTENDEE_API_KEY` (meeting bot)
4. **LLM provider choice**: `openclaw` → `OPENCLAW_GATEWAY_URL` + `OPENCLAW_GATEWAY_TOKEN`;
   `openai-compatible` → `openaiCompatible.baseUrl` + `openaiCompatible.apiKey` + `llm.model`
5. **Local control tokens are generated, not asked** (kickoff decision ③):
   `JOIN_SHARED_TOKEN` and `WS_SHARED_TOKEN` are filled with generated random values.

Out of wizard scope (stated in output + README, not collected): ngrok/Tailscale setup,
Google Meet admission. The wizard's closing message names them as the remaining manual steps.

Non-interactive use: the wizard reads stdin line-per-prompt (documented order = the list
above), so proofs/CI pipe a scripted stdin transcript. No `--yes` flag is added.

Preflight: both `init` and `start` check `process.version` against `engines.node` (≥ 26)
and fail with a one-line actionable message (not a stack trace).

Resumability: an interrupted `init` leaves no partial file (existing atomic
tmp-file+rename per file is kept); re-running completes only the missing files
per §5's per-file rules without corrupting existing ones.

## 3. Config & data resolution order

For `config.json` / `.env`, in order:

1. **`AI_MEET_HOME`** (shell environment; the explicit tier — kept and honored
   **identically by `init` and `start`**). `AI_MEET_HOME` is read from the process
   environment only; a value inside `.env` is not honored (the `.env` location itself
   depends on the home — no circular resolution).
2. **Current working directory** (default).
3. **XDG fallback: NO** for this launch (decided upstream at delta review). Adding XDG
   later is a new contract change with its own lane.

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
- Deny-set (asserted absent in the packaging proof): `test/`, `docs/` (except assets
  explicitly added for npm-page rendering, if #15 chooses to ship instead of absolute-linking),
  `scripts/`, `tools/`, `.env`, `config.json`, `_handoffs/`, `.omc/`.
- **AGENTS.md template path: `src/agents-template.md`** — inside the already-shipped
  `src/`, so #16 needs no `package.json` edit.
- NOTICE: reworded to "clone the repository if you need to seed fillers; the npm tarball
  does not include the seeder" (the seeder script stays out; `scripts/` stays denied).

## 5. init-generated files

`init` writes three files into the resolved home; overwrite rules are **per-file**:

| File | Exists already | Behavior |
|---|---|---|
| `config.json` / `.env` | yes, without `--force` | refuse that file (as today), but do not block generation of a *missing* `AGENTS.md` |
| `config.json` / `.env` | yes, with `--force` | overwrite (atomic tmp+rename, `.env` mode 0600 — as today) |
| `AGENTS.md` | absent | generate — **even when config/.env already exist** (upgrade path for existing users) |
| `AGENTS.md` | present **with** meetmate marker | keep without `--force`; regenerate with `--force` |
| `AGENTS.md` | present **without** marker (foreign file) | **never overwrite, `--force` included** — print a notice and skip |

Template guarantees (all testable, tests live in #16):

- Static file shipped in the tarball (`src/agents-template.md`); **no interpolation of
  user or config values** into the generated output.
- Contains configuration key **names only, never values** (test: sentinel values written
  to `.env` must not appear in the generated file; no `KEY=value` lines).
- First lines: meetmate generated-marker + template version + "regenerate with
  `meetmate init --force`".
- Includes the AI-security notice: **"SECURITY NOTICE FOR AI AGENTS: never print, log,
  or commit values from `.env`."** The file never instructs an assistant to read or
  echo `.env` values.
- Content scope: instance docs (key meanings, file locations, start/stop, settings-UI,
  common failure modes incl. LLM endpoint unreachable / port in use / tunnel down,
  remaining manual steps). It grants no privileges.
