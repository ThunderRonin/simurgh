# Simurgh

Simurgh is an early-stage, read-only context inspector for observability dashboards. Phase 1 connects a browser selection to the identity and data of a Grafana panel, then lets the user inspect and confirm that captured context. It does not investigate or explain telemetry yet.

This project is licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE), [CONTRIBUTING.md](CONTRIBUTING.md), and [SECURITY.md](SECURITY.md).

See [Phase 1 status](docs/phase1-status.md) for the current selection flow, evidence boundaries, and acceptance status.

## Local Grafana lab

The included Docker lab pins Grafana 13.2.3, Prometheus, and node-exporter by version and image digest. It supplies CPU telemetry and an optional bounded workload. This is a development fixture, not a customer environment or a Windows host monitor.

## Start

From the repository root:

```sh
npm ci
npm run build
docker compose -f infra/compose.yaml config
docker compose -f infra/compose.yaml up -d
```

Grafana is published only on `127.0.0.1:3300`. Open [http://127.0.0.1:3300](http://127.0.0.1:3300). The provisioned dashboard is **Simurgh local CPU lab**, UID `simurgh-cpu-lab`, panel ID `1`. Anonymous access is limited to Grafana's Viewer role. For administration, the local lab login is `admin` / `simurgh-local-only`; do not reuse it elsewhere.

The app plugin is mounted read-only from `packages/grafana-plugin/dist`, its ID is `simurgh-context-app`, and Grafana allows that unsigned plugin only in this lab. Build the plugin before starting Grafana. This local unsigned development build is not release-ready or trusted by virtue of the allow-list. Do not copy the lab allow-list setting into a customer or production Grafana.

Load the built extension in Chromium from `chrome://extensions`: turn on **Developer mode**, choose **Load unpacked**, and select `packages/chromium-extension/dist`. Review the requested host permissions and approve only the loopback Grafana origin used by this lab; do not grant broad site access. Open the local CPU dashboard, drag across the chart's time axis to use Grafana's native range zoom, then open the panel menu and choose **Inspect with Simurgh**. Review the available CPU series and selected interval, choose the intended series, and confirm the target. The extension lets you inspect the confirmed bundle and download it as JSON. This flow uses native time-range selection and does not provide a freehand circle overlay. A real deployment must configure and authorize its exact Grafana origin separately.

## CPU workload

The default stack does not run the load generator. Start its capped container when a visible workload is useful:

```sh
docker compose -f infra/compose.yaml --profile load up -d cpu-load
```

It is limited to 0.50 CPU, 32 MiB memory, and 16 processes. Stop it with:

```sh
docker compose -f infra/compose.yaml --profile load stop cpu-load
```

Remove the stack with `docker compose -f infra/compose.yaml down`.

## Telemetry meaning and limits

The monitored kernel depends on where Docker Engine runs. With Docker Desktop, including on Windows, containers run in Docker Desktop's Linux VM, so node-exporter reports that VM's Linux kernel CPU counters. With native Linux Docker, it reports the Linux host kernel. This lab does not report Windows CPU or represent a customer host. Node-exporter reads only the Docker Engine host's `/proc` through a read-only bind mount and has its default collectors disabled except CPU; the target uses generic `job="simurgh-lab-host"` and `telemetry_host="simurgh-lab-host"` labels. No Windows filesystem, Docker socket, secrets, privileged mode, or broad host-root mount is used. The optional workload is also a container and can perturb the Docker Engine host's CPU readings. Customer installations must use an authorized Prometheus-compatible datasource and real environment labels; the fixture labels are not evidence about another environment.

Prometheus scrapes every 5 seconds. Panel query rate window is 1 minute. Each plotted series is one logical CPU core, computed as `100 * (1 - sum by (cpu) (rate(node_cpu_seconds_total{job="simurgh-lab-host", telemetry_host="simurgh-lab-host", instance=~"$host", mode="idle"}[1m])))`. This is per-core busy percentage from idle time, not container CPU usage. A selected short interval or a displayed line does not establish finer event duration than the scrape and rate window support. Per-core series are intentionally preserved; when multiple series are present, the user must select the intended series explicitly.

Prometheus and node-exporter are only reachable on the Compose network; Grafana is the sole published service. Datasource UID: `prometheus-local`, using internal URL `http://prometheus:9090`.
Grafana's baked-in plugin preinstall list and plugin update checks are disabled in this lab so startup does not fetch unrelated plugins or depend on Grafana's plugin catalog. The local `simurgh-context-app` directory is supplied by the read-only bind mount and provisioned as enabled.

## Development checks

Use Node.js 20.19 or newer and npm 10 or newer from the repository root:

```sh
npm ci
npm test
npm run typecheck
npm run build
npx playwright install chromium
npm run test:browser
```

Run the browser check with the local lab running; it exercises native time-range selection, candidate ambiguity, confirmation/correction, and snapshot stability. GitHub Actions runs these commands and provisions the lab for the browser check. See [CONTRIBUTING.md](CONTRIBUTING.md) for change expectations.
