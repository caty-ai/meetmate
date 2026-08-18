# Meet Multi-Participant Repro Template

Use this template to create reproducible packets for multi-participant Meet issues.

## Packet shape

```json
{
  "packetId": "repro-meet-multi-<id>",
  "createdAt": "2026-03-05T00:00:00.000Z",
  "environment": {
    "node": "v26.x",
    "platform": "darwin|linux",
    "appCommit": "<git-sha>"
  },
  "preconditions": [
    "condition 1",
    "condition 2"
  ],
  "scenarios": [
    {
      "id": "duplicate-join-409",
      "title": "Duplicate join for same participant",
      "steps": [],
      "expected": {}
    }
  ],
  "artifacts": {
    "serverLog": "logs/<file>.log",
    "clientLog": "logs/<file>.log",
    "wsTrace": "logs/<file>.json"
  }
}
```

## How to fill each section

### 1) Preconditions

- List what must already be true before steps begin.
- Include participant counts, session state, and any required process readiness.

Example:

- Meet bridge process running with clean session cache.
- Participant A already connected to room `<roomId>`.

### 2) Steps

- Write ordered, deterministic actions with actor and timing.
- Include request payloads and reconnect timing windows (for race conditions).
- Keep each step minimal and observable.

Example:

1. Participant A sends `POST /join` with `participantId=p-001`.
2. Participant A repeats the same `POST /join` within 200 ms.
3. Capture API response and session log lines.

### 3) Expected

- Define exact outcomes per step or scenario.
- Prefer concrete fields: HTTP status, error code, final session state, ws close code.

Example expectations:

- Duplicate join returns `409` with code `DUPLICATE_PARTICIPANT`.
- Reconnect during leaving remains in `leaving` and reconnect is rejected.
- New websocket replaces old socket and old socket closes with code `1000`.

### 4) Artifacts / Logs

- Save paths for logs and traces generated during repro.
- Store at least server log, client log, and websocket trace.
- Use stable filenames so packets are comparable across runs.

### 5) Environment Snapshot

- Capture versions and commit metadata at repro time:
- Node version (`node -v`)
- Platform/OS
- App git commit SHA
- Optional: feature flags or env vars relevant to Meet session state

## Suggested workflow

1. Copy packet template from `test/meet-multi-participant-repro.test.js`.
2. Fill `preconditions`, `steps`, `expected`, and `artifacts`.
3. Re-run repro with the same packet and compare outcomes.
4. Attach packet JSON plus logs to issue/PR for triage.
