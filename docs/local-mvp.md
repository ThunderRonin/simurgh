# Local MVP Runbook

This is a provisional, same-machine development runbook for the Grafana capture, workspace, and local coordinator. It is not a customer deployment guide. Commands assume a clean checkout at the repository root, Node.js 20.19+, npm 10+, Docker, and a local Chromium installation for Chromium browser tests. Firefox has a separate build and host harness; see the [Firefox guide](firefox.md).

## Build and verify

```sh
npm ci
npm test
npm run typecheck
npm run build
```

The aggregate build includes both the Chromium extension and `packages/chromium-extension/dist-firefox`. To rebuild only the Firefox target, run `npm run build:firefox`.

For **Freehand with Simurgh**, active dashboard refresh is paused automatically until confirmation, close, terminal failure, or the five-minute safety timeout. Manual refresh changes and navigation take precedence over restoration. Establish an absolute time range with native zoom first; if a query is still in flight, wait for it to settle and reopen the action. After rebuilding, reload the temporary Firefox add-on and hard-refresh Grafana so both sides use the updated bridge.

The Grafana browser acceptance additionally requires the local lab:

```sh
docker compose -f infra/compose.yaml config
docker compose -f infra/compose.yaml up -d
npx playwright install chromium
npm run test:browser
```

`npm run test:browser` uses Chromium. The Firefox automation target is verified locally with Mozilla Firefox 157.0.1 and geckodriver 0.37.1; its manifest minimum is Firefox 140.0, which is not a tested-version claim. The full Grafana browser flow passed: normal injection, wrong-port inertness, real freehand CPU selection/confirmation, equality of all 10 points against actual API samples, downloaded JSON equality, refresh immutability, and stale binding invalidation/rebind after resize in Draw mode but before pointer-down. An actual Firefox capture plus editor export passed the configured live-Codex cross-surface check. The inspector bounds check used Firefox's clamped 500px viewport, not 390px. The Firefox workspace smoke also passed login, saved finding, TTS playback, and logout, but microphone capture remains untested. Firefox host permissions cover both loopback hostnames across ports because Firefox match patterns cannot specify a port; `include_globs` and the pre-import origin guard restrict script operation to Grafana port 3300. The host check is:

```sh
npm run test:firefox
```

The Firefox runner passed its full local browser flow. See the [Firefox guide](firefox.md) for temporary installation steps, binary-path overrides, exact upstream version links, and the current support boundary. Temporary installation is for development only and is removed when Firefox restarts. Do not disable signature enforcement.

Grafana is available at `http://127.0.0.1:3300`. Follow the unpacked extension and native range-selection steps in the [README](../README.md#start). The lab reads real node-exporter CPU counters from the Docker Engine host kernel; with Docker Desktop, that kernel is the Docker Desktop Linux VM. These local measurements are not evidence about a customer or Windows host.

### Freehand prototype (local experimental MVP checks passed)

The extension/plugin build exposes **Freehand with Simurgh** in the Grafana panel menu on the exact development renderer it recognizes: Grafana 13.2.3 with uPlot 1.6.32. First use Grafana's native drag-to-zoom to establish the absolute time range; moving relative dashboard ranges are rejected. Then open **Freehand with Simurgh**, choose **Draw** in the inspector, trace a simple closed region around visible data samples, review the matched series and interval, explicitly choose a series, and confirm the target. You can cancel with the onscreen control or Escape. If renderer matching is ambiguous, stale, unsupported, or cannot identify native samples, the action should reject rather than infer from pixels.

The combined browser run passed for a 40-vertex circle over 20 real CPU series: explicitly confirming CPU 0 produced five native samples matching Grafana `/api/ds/query` (an earlier artifact had six points). Checks also covered moving-range denial, empty-draw invalidation, close/replay rejection, resize while drawing, refresh after pointer-down, stale-binding rejection and fresh rebinding, and confirmed-bundle immutability. A 390x844 run verified inspector bounds, not freehand mobile touch input. A live cross-surface test passed with the actual freehand capture and pinned local Codex configuration. A separate real authenticated workspace browser session imported that capture plus an actual editor JSON export, submitted a typed question, and completed through live Codex in 23.4 seconds with three evidence reads; desktop 1440px and mobile 390px views had no page errors or overflow and the user logged out cleanly. The implementation instruments native uPlot renderer hooks because Grafana does not expose a supported pixel-to-series selection API here. Root build, typecheck, combined browser run, and lab-enabled suite passed; the default suite also passed. These results verify only the local experimental MVP, not a supported or production workflow. Other renderer versions and mobile touch drawing are unqualified; a screenshot alone is never authoritative evidence.

## Start the workspace

Choose a private state directory outside the checkout. Setup creates the directory with owner-only permissions and prints two bootstrap access tokens once. They are reusable credentials, not one-time-use tokens; store them privately and do not put them in shell history, source control, screenshots, or support logs.

```sh
state_dir="$HOME/.local/state/simurgh"
install -d -m 700 "$state_dir"
npm run setup -- "$state_dir" "$PWD/packages/workspace/dist"
SIMURGH_CONFIG="$state_dir/coordinator.json" npm run start
```

Open `http://127.0.0.1:4317`, sign in with one of the bootstrap access tokens, then import a confirmed capture or reviewed source snapshot. The coordinator persists local investigations in SQLite under the private state directory. Imported snapshots are user-supplied references; telemetry reads are restricted to the configured local policy. Sharing is explicit and revocable. Stopping the process does not publish data elsewhere.

### Capture a source snapshot in VS Code

Build the workspace and extension from the repository root, then start a VS Code Extension Development Host against the local extension source. The `code` command must be available in `PATH`:

```sh
npm run build
code --extensionDevelopmentPath="$PWD/packages/vscode-extension" "$PWD"
```

In the development host, open a source file, select the text to reference, open the Command Palette, and run **Simurgh: Capture Selected Source**. Review the read-only **Selected Source Snapshot** preview; the selection is not exported or sent anywhere yet. Choose **Export JSON**, save the file in a private location, then in the workspace choose **Import**, select that JSON file, review its import preview, and add it as a reference. The extension also offers **Copy JSON** as an explicit alternative to export. Do not select secrets or unrelated source. This launches the unpacked development extension directly; it does not build, sign, or claim a VSIX or production release.

## Optional local voice

Voice is optional and uses local CPU processing. From the repository root, run the setup command against the private coordinator config:

```sh
npm run setup:voice -- "$state_dir/coordinator.json"
SIMURGH_CONFIG="$state_dir/coordinator.json" npm run start
```

Setup downloads the pinned `tiny.en` model into `$state_dir/voice-models`, checks its expected size and SHA-256, builds the local `simurgh-voice:local` Docker image, and adds the immutable image ID and model path to the existing private config. It does not print or replace bootstrap tokens. Restart the coordinator after setup. Docker must be available; the provider operation runs in a bounded container with no network.

Whisper.cpp and the model are MIT-licensed. The image also invokes eSpeak NG as a separate GPL-3.0-or-later executable; keep applicable notices when redistributing. See [voice notices](../infra/voice/NOTICE.md).

The live browser check requires the optional voice setup above and a verified public speech fixture. The model/image are read from the private coordinator config; the test sample is passed separately. Download the JFK sample from the pinned Whisper.cpp source revision and verify its SHA-256:

```sh
voice_fixture_dir="$state_dir/voice-test-fixtures"
install -d -m 700 "$voice_fixture_dir"
curl -fL "https://raw.githubusercontent.com/ggerganov/whisper.cpp/d1be6fde11ac6e0407606b4e42fe72d34add8037/samples/jfk.wav" -o "$voice_fixture_dir/jfk.wav"
printf '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e  %s\n' "$voice_fixture_dir/jfk.wav" | sha256sum --check -
SIMURGH_CONFIG="$state_dir/coordinator.json" SIMURGH_VOICE_SAMPLE="$voice_fixture_dir/jfk.wav" SIMURGH_VOICE_LIVE=1 npm run test:voice-live --workspace @simurgh/workspace
```

The runner validates the config permissions, configured image ID, and sample checksum before starting. It creates and removes a temporary private coordinator database and test token. It does not retain or print the transcript or audio. The sample is a test fixture, not a genuine user question; the test uses a deterministic finding adapter and is not a Codex reasoning test.

## Optional Codex qualification

The coordinator does not configure or qualify Codex automatically. The optional adapter uses an existing signed-in ChatGPT account and its model entitlement; it is not a new API account or API-key path. Install the pinned Codex CLI `0.160.0` using the [official Codex CLI guide](https://help.openai.com/en/articles/11096431), confirm it with `codex --version`, and create a dedicated private home plus an empty working directory outside every repository:

```sh
npm install --global @openai/codex@0.160.0
codex --version
install -d -m 700 "$state_dir/codex-home" "$state_dir/empty-codex-cwd"
CODEX_HOME="$state_dir/codex-home" codex login
```

Complete the interactive login using the existing ChatGPT account. Do not copy credential files or tokens from another Codex profile. Keep this login state and the coordinator config private. The configured model is `gpt-6.1-sol`; the account must be entitled to use it through this CLI/provider setup.

The telemetry policy is an independent local trust decision. Start from the provisioned sample dashboard, not an imported capture: the example in [coordinator.local.example.json](examples/coordinator.local.example.json) records its dashboard/panel/datasource identity, exact query template, the approved `$host` resolution, label allowlist, and bounded time/step. Review the dashboard and target labels locally, then merge the `telemetry` and `codex` objects into the private `coordinator.json` created by `npm run setup`. Keep its generated users/database/workspace settings. The `cpu` allowlist in the example intentionally permits only CPU `0`; add only label values you verified and intend to authorize. At runtime the coordinator verifies imported capture provenance against this policy and executes only the locally configured expression, never the expression supplied by the imported capture.

Keep `isolationQualified` false while setting up. Run all three opt-in checks against the exact executable, private Codex home, empty cwd, CLI version, and model you intend to configure:

```sh
export SIMURGH_CODEX_EXECUTABLE="$(command -v codex)"
export SIMURGH_CODEX_HOME="$state_dir/codex-home"
export SIMURGH_CODEX_CWD="$state_dir/empty-codex-cwd"
SIMURGH_CODEX_REAL_VERIFY=1 npx vitest run tests/coordinator/codex-real.test.ts
```

These authenticated live-provider checks can use model entitlement and exercise selected/baseline evidence plus hostile data, native file/network canaries, and cancellation during a pending tool call. They do not change the config. Only after all three pass for this exact local setup, manually set `codex.isolationQualified` to `true` in the private coordinator config and start/restart the coordinator. Any change of executable/version, profile, cwd, model/provider, or isolation boundary requires requalification. Current reported result: 3/3 passed for the pinned local configuration, not as a universal guarantee.

After producing a fresh confirmed capture with `npm run test:browser`, a reviewed source export with `npm run test:editor`, and starting the local Grafana lab, the bounded cross-surface test can be run separately:

```sh
SIMURGH_CROSS_SURFACE_REAL_VERIFY=1 npx vitest run tests/coordinator/cross-surface-real.test.ts
```

It imports the exact browser/editor artifacts, validates telemetry scope, collects selected/baseline values through the trusted local policy, and uses the same isolated Codex settings. One targeted pass using an actual freehand-confirmed capture passed for the pinned local config; this does not qualify another machine or deployment. Do not describe the MVP as production-qualified. Local experimental MVP checks passed; compatibility outside the pinned Grafana/uPlot versions and freehand mobile touch input remain unqualified. The accepted Grafana baseline is native drag-to-zoom. Consult [GitHub Actions](https://github.com/ThunderRonin/simurgh/actions) for the remote result associated with a specific commit. See [MVP status](mvp-status.md) and [Phase 1 status](phase1-status.md).
