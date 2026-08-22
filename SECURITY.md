# Security Policy

## Supported versions

The `main` branch is the only supported version.

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub's **Report a vulnerability** (Security tab of this repository) rather than a public issue. Include the affected component (meeting adapter, gateway client, local server), a reproduction, and the impact you see. You can expect an initial response within a week.

## Scope notes

- Meetmate joins live meetings and processes room audio. Anything that causes audio, transcripts, or meeting content to reach a destination other than the ones you configured is in scope.
- Credentials live in your own `config.json` / `.env` (both gitignored). Protecting those files is the operator's job, but weaknesses in how Meetmate stores, forwards, or logs them — including secrets leaking into logs or error output — are in scope.
- Meetmate runs a local server and drives a browser session. Exposure of that local control surface beyond the interfaces you configured is in scope.
- The agent gateway you point Meetmate at (OpenClaw Gateway or any OpenAI-compatible endpoint) is trusted by design; vulnerabilities in that endpoint belong to its own project. How Meetmate hands off tokens to it is in scope.
- Wake-word and barge-in behavior are usability features, not a security boundary. A missed wake word is a bug, not a vulnerability; audio being captured or sent while the agent is supposed to be idle is a vulnerability.
