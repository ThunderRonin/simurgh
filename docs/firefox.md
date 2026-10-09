# Firefox Extension

The Firefox build uses the same content-script implementation as the Chromium build. Its manifest targets Firefox 140 and newer. The current isolated automation binaries are Firefox 157.0.1 and geckodriver 0.37.1.

**Verified local Firefox run:** on Firefox 157.0.1 with geckodriver 0.37.1, temporary install and wrong-port inertness passed. The first captured freehand run exposed 20 CPU candidates; explicitly confirming CPU 0 returned 10 points, all matched against the actual Grafana Prometheus proxy. A final independent rerun exposed 20 candidates and returned 7 CPU 0 points; all 7 matched the API data. The changing point count reflects live telemetry and selection interval, not a fixed fixture. In both runs, downloaded JSON matched the confirmed snapshot and refresh left it immutable. Resizing while Draw mode was active but before pointer-down invalidated the old binding; a fresh binding then succeeded. The inspector layout check passed at Firefox's effective 500px viewport; Firefox clamped a requested 390px width to 500px, so this is not a 390px/mobile-width result. A real Firefox capture plus editor export also passed the configured live-Codex cross-surface check (1/1). This evidence applies to the pinned local setup, not every Firefox/geckodriver version or production installation.

## Build

From the repository root:

```sh
npm ci
npm run build:firefox
```

The output is `packages/chromium-extension/dist-firefox`. The aggregate `npm run build` also builds this target. The existing Chromium target remains at `packages/chromium-extension/dist`.

## Temporary Installation

Start the local Grafana lab and open its dashboard first. In Firefox:

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on**.
3. Select `packages/chromium-extension/dist-firefox/manifest.json`.
4. Open the local Grafana dashboard and use the panel menu.

This development installation is removed when Firefox restarts. Repeat the steps after a restart or rebuild. Temporary installation is not an end-user install or an AMO-signed release; no signing or publication is claimed. Do not disable Firefox's signature enforcement or change `xpinstall.signatures.required`. See Mozilla's [temporary installation guide](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/).

## Grafana Workflow

Freehand automatically pauses an active dashboard refresh interval before capturing the panel. The prior interval is restored on confirmation, close, terminal layout invalidation, capture failure, or a five-minute safety timeout. Choosing another refresh interval or navigating away relinquishes ownership so Simurgh does not overwrite that choice. Time range and variable changes are preserved; restoration changes only the refresh setting. An already stopped dashboard stays stopped. In-flight or mismatched panel results still fail closed: wait for the chart to settle and reopen Freehand rather than accepting stale samples.

The automatic lifecycle passed the real Firefox harness: start at 5s, open Freehand and observe Off, close and observe 5s, invalidate a drawing by resizing and observe 5s, then reopen/draw/review while paused and confirm to restore 5s. Non-refresh URL parameters stayed unchanged. This run retained 12 CPU 0 samples matching the datasource API; exact sample counts vary with the live lab. Unit coverage separately checks manual cadence changes, navigation, timeout, replacement, and stale capture identity.

The verified Firefox workflow is to drag across the chart's time axis to establish an absolute range, open **Freehand with Simurgh**, choose **Draw**, trace around visible plotted samples, select a candidate series, and confirm. Relative ranges and unsupported or stale renderer bindings are rejected. The freehand renderer instrumentation is experimental and version-gated to Grafana 13.2.3/uPlot 1.6.32; the verified Firefox browser version is 157.0.1.

Firefox match patterns do not support ports. The manifest therefore requests host access for `http://localhost/*` and `http://127.0.0.1/*` (all ports on those two loopback hostnames); it uses `include_globs` plus a bootstrap exact-origin check to keep content code inactive except on `http://localhost:3300` and `http://127.0.0.1:3300`. The permission prompt can consequently grant those hostnames across ports; do not describe the granted host permission itself as port-restricted. See Mozilla's [match-pattern documentation](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Match_patterns).

The Firefox manifest declares `data_collection_permissions.required: ["none"]`; the add-on does not automatically transmit captures to a server. JSON export and import into the local workspace are separate, explicit user actions. A later user-submitted workspace question may invoke the agent configured for that local workspace; installing or using the extension does not trigger that action. Mozilla documents the [data collection declaration](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/).

## Browser Verification

Startup discovery retries for up to ten seconds while Grafana loads the app plugin. A validated readiness reply or panel-action probe stops discovery. If the plugin still does not respond, the banner offers enable/reload guidance. The Firefox test command first delays the real Grafana plugin module by 2.5 seconds and requires an observed matching readiness handshake, without opening a panel action; this catches the former one-shot startup race.

The root `test:firefox` runner passed the real-host Firefox Grafana flow, including API sample equality, downloaded JSON equality, refresh immutability, wrong-port inertness, resize invalidation/rebind, automatic refresh pause/restoration, and effective viewport bounds. Release-preparation parent checks also passed the root suite (69 passed, 7 skipped), aggregate build, and typecheck:

```sh
npm run test:firefox
```

The current harness defaults to `work/firefox-tools/firefox/firefox`, `work/firefox-tools/geckodriver`, and `packages/chromium-extension/dist-firefox`. It accepts these binary and extension path overrides:

```sh
SIMURGH_FIREFOX_BIN=/path/to/firefox \
SIMURGH_GECKODRIVER=/path/to/geckodriver \
SIMURGH_FIREFOX_EXTENSION_PATH="$PWD/packages/chromium-extension/dist-firefox" \
npm run test:firefox
```

The provisioned Linux automation versions are [Mozilla Firefox 157.0.1](https://archive.mozilla.org/pub/firefox/releases/157.0.1/) and [geckodriver 0.37.1](https://github.com/mozilla/geckodriver/releases/tag/v0.37.1). They are the tested versions, not an endorsement of every Firefox/geckodriver combination. The manifest minimum is 140.0 and is not a tested-version claim. Temporary installation remains development-only; no signing or publication is claimed.
