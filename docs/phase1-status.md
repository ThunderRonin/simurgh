# Phase 1 status

## Scope and current flow

The agreed Phase 1 interaction is selection, resolution, inspection, correction or confirmation, then inspection of a captured context bundle. [Design section 4.1](../DESIGN.md#41-dashboard-selection) describes clicking or circling a plotted region. The accepted baseline uses Grafana's native drag-to-zoom time selection, then captures the active panel from its menu into the extension. A version-pinned freehand overlay prototype has passed the combined local browser checks and a live cross-surface test, including resize, chart refresh, and narrow inspector bounds. This verifies the local experimental MVP selection scope, not a general Grafana compatibility or production claim.

## Evidence boundary

Grafana 13.2.3 defines [`PluginExtensionPanelContext`](https://github.com/grafana/grafana/blob/v13.2.3/packages/grafana-data/src/types/pluginExtensions.ts) with panel identity and title, raw time range, timezone, dashboard identity, query targets, scoped variables, panel data, and an optional rendered-panel path ID. The release's [panel-menu implementation](https://github.com/grafana/grafana/blob/v13.2.3/public/app/features/dashboard-scene/scene/PanelMenuBehavior.tsx) constructs this context from the live panel, dashboard, query runner, time range, variables, and query-runner data.

This API is the supported metadata path for the selected panel. Its type definition does not prove that a running plugin receives a particular rendering revision, nor that every panel's displayed pixels can be mapped to one series. A screenshot can document appearance, but cannot authoritatively establish the effective query, datasource, labels, selected series, timestamps, transformation state, or correspondence between pixels and returned data. Runtime capture and comparison against the live panel/data remain necessary. Where the API or data cannot resolve a selection, report ambiguity or missing evidence rather than infer a target from the screenshot.

The freehand prototype is not built on a supported Grafana chart-selection API. On Grafana 13.2.3 with uPlot 1.6.32, it experimentally instruments the native renderer's `UPlotConfigBuilder` data-preparation/configuration hooks, then matches the live plot, frames, and geometry back to the panel capture before accepting enclosed samples. That exact renderer/version match is enforced by the prototype; other versions or ambiguous/stale plots must fail closed. This is a version-pinned development technique, not a compatibility promise or production support statement.

## Local lab evidence

The lab pins these images by version and digest:

| Component | Image | Digest |
|---|---|---|
| Grafana | `grafana/grafana:13.2.3` | `sha256:b28bae15e219c998fb0e0424ed724930cc61b1f61fb404d47c862f9a23f9e572` |
| Prometheus | `prom/prometheus:v3.5.0` | `sha256:63805ebb8d2b3920190daf1cb14a60871b16fd38bed42b857a3182bc621f4996` |
| node-exporter | `prom/node-exporter:v1.9.1` | `sha256:d00a542e409ee618a4edc67da14dd48c5da66726bbd5537ab2af9c1dfc442c8a` |
| Optional CPU workload | `alpine:3.22.1` | `sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1` |

The running Grafana 13.2.3 image reported build commit `90ffed056f0884267356c12a0eeb72a022af53f1` from `/api/health`. The digest above is the runtime image identity; the public `v13.2.3` source tag is API-contract reference material, not evidence that the running image was built from that exact source commit.

The Prometheus scrape target is `node-exporter:9100`, labeled `job="simurgh-lab-host"`, `telemetry_host="simurgh-lab-host"`, and `instance="node-exporter:9100"`. The target reports `up`; querying `count(node_cpu_seconds_total{job="simurgh-lab-host",telemetry_host="simurgh-lab-host",mode="idle"})` returned 20 CPU-core series. A direct Prometheus query matching the dashboard expression returned one series per `cpu` label. The optional workload was observed at about 50% CPU, under its 0.50 CPU limit, then stopped. It runs as UID 10001 with a read-only root filesystem, all capabilities dropped, a 32 MiB memory limit, and a 16-process limit.

Dashboard identity: UID `simurgh-cpu-lab`, panel ID `1`, datasource UID `prometheus-local`, host variable `$host`. Scrape interval: 5 seconds. Rate window: 1 minute. Query:

```promql
100 * (1 - sum by (cpu) (rate(node_cpu_seconds_total{job="simurgh-lab-host", telemetry_host="simurgh-lab-host", instance=~"$host", mode="idle"}[1m])))
```

The panel intentionally retains per-core series, requiring an explicit series choice when multiple cores are present. The percentage is kernel CPU busy time derived from idle counters, not per-container CPU. With Docker Desktop, the lab describes Docker Desktop's Linux VM; with native Linux Docker, it describes the Docker Engine host's Linux kernel. It does not observe Windows CPU or a customer environment.

## Development-only boundary

- Grafana is published on loopback port 3300. Prometheus and node-exporter are internal to the Compose network.
- Anonymous Grafana access is Viewer-only. The documented admin password is a local demo credential and must not be reused.
- The unsigned app plugin is allowed only in this local stack. Its source is mounted read-only from `packages/grafana-plugin/dist` and provisioned enabled. This configuration does not establish a signed, reviewed, or customer-ready release.
- The local extension host permission is for the loopback Grafana lab. A customer Grafana origin requires its own explicit configuration and browser authorization.
- The plugin manifest pins Grafana `13.2.3`. This is the development target for the experimental renderer integration, not a supported customer-version policy.
- The CPU target is the Linux kernel host of the local Docker Engine: Docker Desktop's Linux VM with Docker Desktop, or the Linux host with native Docker. Node-exporter receives only a read-only `/proc` mount and runs only its CPU collector; host filesystem roots, Docker socket, secrets, and privileged mode are not used.

## Acceptance status

Native-flow browser acceptance passed on 2026-10-09 using Chromium with an explicit executable override against the running Grafana 13.2.3 lab. Native Grafana zoom captured an absolute range and 20 real CPU frames; the harness compared extension capture labels and points with Grafana `/api/ds/query`. Explicit series choice, confirmation, and range correction passed. Refresh did not alter the accepted snapshot; a second capture request reset to unconfirmed with no preselection while both accepted bundles remained byte-identical. Wrong-origin, stale-session, and malformed messages were rejected, and the missing-extension path presented an actionable prompt. Desktop and narrow-viewport checks had no unexpected console errors or overflow.

The final combined freehand browser run used native zoom first to establish a stable absolute request range, then **Freehand with Simurgh** and a 40-vertex circle. It matched 20 actual CPU series as candidates; explicitly confirming CPU 0 exported five native samples matching the corresponding Grafana `/api/ds/query` data (an earlier artifact contained six points). The run checked rejection of moving relative ranges, invalidation after an empty drawing consumed the binding, close/replay rejection, stale-binding rejection followed by fresh binding after refresh, resize while drawing, refresh after pointer-down, and confirmed-bundle immutability. X-scale value changes were checked to affect units without changing the selected time bounds. The 390x844 check verified the inspector stays within the viewport; it did not validate freehand drawing as a mobile touch gesture.

A live cross-surface test imported the exact confirmed freehand capture and passed once with the pinned isolated Codex configuration (1/1, 26.54 seconds). Separately, a real authenticated workspace browser session at the rebuilt local coordinator imported the freehand capture and an actual editor JSON export, submitted a typed question, and completed with the live Codex adapter in 23.4 seconds using three evidence queries (about 21 KiB read). The desktop 1440px and mobile 390px views had no page errors or overflow; the session logged out cleanly. This is evidence for that one private local setup, not universal qualification or production readiness.

The combined `npm run test:browser` passed, as did root build and typecheck and the lab-enabled suite (54 passed, 6 opt-in skipped). The default suite passed 53 tests and skipped 7 opt-in tests. These results verify the local experimental MVP gates only; the prototype's exact renderer pin means they do not establish compatibility with other Grafana/uPlot versions.

The provisioned dashboard API reports UID `simurgh-cpu-lab`, panel ID `1`, the expected Prometheus expression, and `editable: false`; `/api/plugins/simurgh-context-app/settings` reports the app enabled with an unsigned signature. This is local browser evidence, not a remote GitHub Actions result or production-readiness claim. Do not treat the Grafana 13.2.3 development target, local unsigned plugin build, or screenshots alone as release validation.

The accepted baseline is native drag-to-zoom. The combined local checks verify the freehand selection gate for Grafana 13.2.3/uPlot 1.6.32. Other renderer versions, mobile touch-drawing behavior, and production deployment remain unqualified. Consult the [GitHub Actions runs](https://github.com/ThunderRonin/simurgh/actions) for remote verification of a particular commit; local results do not establish a remote CI pass.

The 2026-10-09 npm audit reported four moderate and zero high or critical advisories in the Grafana host dependency tree, involving `routercompat`/`react-router` (GHSA-wrjc-x8rr-h8h6, GHSA-337j-9hxr-rhxg). See [SECURITY.md](../SECURITY.md); this does not assert that Grafana is unaffected.
