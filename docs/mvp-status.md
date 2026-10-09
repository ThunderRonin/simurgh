# MVP status

Last updated 2026-10-09. This is an implementation status note, not a claim that the five-phase product design is complete.

## Current verification

The release-preparation unit suite passed 69 tests with 7 opt-in tests skipped; full build/typecheck, the isolated VS Code host (10/10), and the workspace browser fixture passed. One initial full-suite run hit a coordinator child-process test timeout; its isolated rerun and subsequent full-suite reruns passed. The dependency audit against the official npm registry reported no high/critical findings and four moderate findings in the pinned Grafana dependency tree.

Firefox support includes a real installed-add-on harness, exact-origin enforcement, freehand capture/export checks, and a delayed-plugin startup regression. Automated Firefox evidence applies to Linux Firefox 157.0.1, not blanket Windows Developer Edition qualification. The user's Firefox Developer Edition 158 session exposed refresh interference; manual Off resolved it. Automatic refresh handling and its final browser results are recorded in the [Firefox guide](firefox.md).

The final Firefox run passed automatic pause, close/confirmation restoration, terminal resize-error restoration, exact preservation of other URL parameters, and sample/export checks. Chromium native/freehand regression also passed. The resulting Firefox capture plus a fresh editor export passed a real existing-account Codex investigation (1/1, 29.61 seconds) through the bounded local coordinator. These results verify the integrated local branch, not every intermediate commit or a production deployment.

## Earlier MVP evidence

The local Grafana Phase 1 native flow has passed browser acceptance against Grafana 13.2.3 and 20 real CPU series. A separate freehand prototype has passed expanded browser checks: a 40-vertex circle produced 20 actual CPU candidates, and explicitly confirming CPU 0 exported native samples matching Grafana `/api/ds/query` (five points in the latest artifact, six in an earlier run). Moving-range denial, empty-draw invalidation, close/replay rejection, resize while drawing, refresh after pointer-down, stale-binding rejection, and fresh rebinding were checked. The 390x844 browser check covered inspector bounds, not freehand mobile touch input. A live cross-surface test using the exact capture passed once with the pinned isolated Codex configuration (1/1, 26.54 seconds).

The final combined browser run passed against the local Grafana lab. A separate real authenticated workspace-browser session imported that freehand capture and an actual editor JSON export, submitted a typed question, and completed through live Codex in 23.4 seconds with three evidence queries (about 21 KiB read). Desktop 1440px and mobile 390px views had no page errors or overflow, and the user logged out cleanly. Separate browser checks passed for local-provider speech request/response and two-user share grant/revocation; the finding used in those voice checks is a deterministic test adapter, not live Codex reasoning. Root build/typecheck and the lab-enabled suite passed (54 passed, 6 opt-in skipped); the default suite passed 53 tests with 7 opt-in skipped. These results verify the local experimental MVP only, not production or other-renderer qualification. See [Phase 1 evidence and boundaries](phase1-status.md).

The Grafana plugin and Chromium extension are unsigned development builds. Their localhost permissions and the lab's unsigned-plugin allowance are not production settings.

## Implemented locally

The VS Code extension captures only the selected source text plus bounded document/workspace metadata. It presents the snapshot for review and requires an explicit local export or copy action. It does not automatically upload selected source. Its isolated VS Code 1.137.0 host suite passed 10/10 locally; remote CI is not yet verified.

The browser-based workspace/client is implemented with a bounded same-origin fixture test, separate from the real Grafana browser test. The workspace package build, typecheck, and fixture browser check pass locally. An opt-in Chromium test also passed against the local Whisper/eSpeak providers using a checksum-verified upstream speech sample through MediaRecorder; it checked frozen references, non-silent WAV playback, and grant/revocation access using a deterministic test-only finding adapter. This does not qualify live Codex reasoning; remote CI is not yet verified. See [the local MVP runbook](local-mvp.md) for the reproducible fixture setup.

A local coordinator with a bounded localhost API and SQLite persistence is integrated. The setup-generated hash-only credentials/configuration and permission checks are covered by tests. An opt-in lab test imported the actual browser capture, validated its scope, and read selected and baseline CPU data from local Prometheus through a deterministic test adapter. The pinned local Codex configuration passed its three qualification checks: selected/baseline evidence reads with injection, native file/network canaries, and cancellation during an actual tool wait. One targeted live cross-surface test also passed with an actual confirmed Grafana capture, actual editor source export, local Prometheus evidence reads, and the isolated live Codex adapter; its finding cites collected evidence and states the runtime-to-code attribution gap. These are scoped results for the tested local configuration, not production or universal isolation proof.

As of 2026-10-09, the VS Code host suite passed 10/10, workspace fixture test, opt-in local voice browser test, combined Grafana browser test, root build, and root typecheck passed locally. The latest default `npm test` passed 53 tests and skipped 7 opt-in tests; the lab-enabled suite passed 54 and skipped 6 opt-in tests. Remote GitHub Actions has not run.

## Remaining boundaries and open gates

- Local experimental MVP gates have passed. The prototype uses experimental Grafana 13.2.3/uPlot 1.6.32 renderer instrumentation; browser data matching, chart-change rejection, and a live user-runtime Codex path are verified, but this does not establish mobile touch-drawing, other-renderer, or production qualification. See [Phase 1 evidence and boundaries](phase1-status.md).
- The Codex adapter uses an existing signed-in ChatGPT account and its model entitlement, not a new API account or API billing path. Its checks apply only to the exact pinned local configuration and do not establish universal isolation or production qualification. The voice-browser finding adapter is deliberately test-only, not live reasoning.
- Local Docker-based Whisper transcription and eSpeak speech synthesis passed real browser microphone/playback checks. This is local request/response audio, not an RTC service.
- The cross-surface live test is one targeted same-machine acceptance, not qualification of arbitrary machines, policies, or deployments.
- There is no hosted collaboration service or customer deployment. Local coordinator permissions/sharing tests and browser fixtures are not production-readiness evidence.
- No supported release policy, signed extension/plugin build, or production telemetry access is validated.
- Remote CI status is commit-specific: check [GitHub Actions](https://github.com/ThunderRonin/simurgh/actions). Local checks alone do not establish a remote CI pass.

## Local checks

Use Node.js 20.19+ and npm 10+ from the repository root:

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run test:editor
npm run test:workspace
npm run test:voice-live --workspace @simurgh/workspace
npm run test:browser
npm run test:firefox
SIMURGH_LAB_VERIFY=1 npm test
```

`npm run test:editor` downloads and launches the pinned VS Code test host with temporary user-data and extension directories. `npm run test:workspace` runs a same-origin client fixture without provider credentials. The real local voice browser check is opt-in and also needs `SIMURGH_CONFIG` pointing to a private voice-enabled config and `SIMURGH_VOICE_SAMPLE` pointing to the verified sample; its deterministic finding adapter does not test Codex reasoning. `npm run test:browser` requires the local Grafana lab to be running. `SIMURGH_LAB_VERIFY=1 npm test` additionally imports the latest confirmed Grafana browser capture and queries local Prometheus; it requires the lab to be running. See [the local MVP runbook](local-mvp.md) for private coordinator setup, optional voice setup, and Codex qualification boundaries. Local checks do not establish that remote GitHub Actions passed; check the workflow result for that evidence.
