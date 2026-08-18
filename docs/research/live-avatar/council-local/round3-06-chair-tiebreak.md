# Round 3 chair tie-break — deployable file ceiling

Date: 2026-07-23

## Question

The five final proposals agreed on the architecture and gates, but proposed
different whole-issue ceilings:

- 10 paths: reuse the H0 page, renderer, tests, and fixture for L1;
- 15 paths: add calibration, provenance, and three synthetic or cleared frames;
- 16 paths: add calibration, provenance, and four frames.

The chair asked every council member whether the ten-path version was
deployment-correct, not merely test-correct.

## First vote

| Council member | Vote | Reason |
|---|---:|---|
| Meeting Bot / Media | Reject 10 | Runtime calibration cannot depend on `test/`; `package.json` does not publish that directory. |
| Audio / DSP | Accept 10 | The state machine and fixture can hold the necessary contracts. |
| Local Renderer | Accept 10 | Original synthetic Canvas geometry removes the image and provenance files. |
| Module Boundary | Accept 10 | L1 can edit the H0 files without creating a renderer or asset module. |
| Skeptic / Security / Ops | Prefer 11 | Production calibration is an auditable runtime input and must ship with `src/`. |

Repository verification confirmed that `package.json#files` publishes `src/`
and `public/` but excludes `test/`. Importing runtime values from the test
fixture would therefore pass a source checkout and fail in a packaged
deployment.

## Revised proposal

Keep the ten shared paths and add exactly one production artifact:

`src/transport-meet/local-avatar-calibration.json`

It is created only after H0 is approved. It holds the frozen extractor version,
24 kHz S16LE geometry, calibration corpus hashes, normalization, thresholds,
hysteresis, and attack/decay. The independent test fixture continues to hold the
input timeline and expected trace. Runtime never imports from `test/`.

L1 uses original, non-personal Canvas geometry for closed, half, and open states.
It imports no Caty image, WebRig code, third-party art, or likeness. Caty's
short-window energy/state-machine technique remains a behavioral reference only.

## Final vote

| Council member | Eleven-path ceiling |
|---|---:|
| Meeting Bot / Media | Accept |
| Audio / DSP | Accept |
| Local Renderer | Accept |
| Module Boundary | Accept |
| Skeptic / Security / Ops | Accept |

**Decision: 5/5 accept eleven touched paths as the smallest
deployment-correct ceiling for this experiment.**

This tie-break does not authorize source work. The M0, H0, and conditional L1
gates in the council decision remain binding.
