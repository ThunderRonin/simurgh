import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmCapture, type CaptureSnapshot } from "../../packages/shared/src/index";
import { createCoordinator, type AgentAdapter } from "../../packages/coordinator/src/server";

const apps: Array<ReturnType<typeof createCoordinator>> = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

const appOrigin = "http://127.0.0.1:4317";
const grafanaOrigin = "http://127.0.0.1:4300";
const token = "a".repeat(64);

function telemetryFixture() {
  const to = Math.floor(Date.now() / 1000) * 1000 - 5_000;
  const from = to - 15_000;
  const capture: CaptureSnapshot = {
    schema: "simurgh.capture",
    version: 1,
    integrationId: "simurgh-context-app",
    sessionId: "telemetry-budget-session",
    captureId: "telemetry-budget-capture",
    revision: "telemetry-budget-revision",
    capturedAt: new Date().toISOString(),
    selectionMethod: "grafana-native-range",
    panel: {
      grafanaOrigin,
      grafanaOrgId: 1,
      dashboardUid: "budget-dashboard",
      dashboardTitle: "Budget dashboard",
      panelId: 1,
      panelTitle: "CPU",
      datasourceUid: "prometheus-test",
      datasourceType: "prometheus",
    },
    timezone: "utc",
    range: { from, to },
    resolution: { sampleSpacingMs: 15_000, scrapeIntervalMs: null },
    transformations: [],
    variables: [],
    query: [{ refId: "A", expression: "up", datasourceUid: "prometheus-test" }],
    series: [{
      id: "A:up:Value:cpu=0",
      refId: "A",
      name: "Value",
      labels: { cpu: "0" },
      points: [{ time: from, value: 0.4 }, { time: to, value: 0.6 }],
    }],
    limitations: [],
  };
  const confirmed = confirmCapture(capture, capture.series[0].id, { from, to });
  const dashboardBody = JSON.stringify({ dashboard: { panels: [{
    id: 1,
    type: "timeseries",
    targets: [{ expr: "up", refId: "A", range: true, datasource: { uid: "prometheus-test" } }],
  }] } });
  const metricBody = JSON.stringify({
    status: "success",
    data: {
      resultType: "matrix",
      result: [{ metric: { cpu: "0" }, values: [[from / 1000, "0.4"], [to / 1000, "0.6"]] }],
    },
  });
  const policy = {
    origin: grafanaOrigin,
    orgId: 1,
    dashboardUid: "budget-dashboard",
    panelId: 1,
    datasourceUid: "prometheus-test",
    expression: "up",
    labels: { cpu: ["0"] },
    maxSpanMs: 30_000,
    maxAgeMs: 120_000,
    stepSeconds: 15,
  };
  return { confirmed, dashboardBody, metricBody, policy };
}

async function startScenario(
  fixture: ReturnType<typeof telemetryFixture>,
  bytes: number,
  metricBodies: string[],
  run: AgentAdapter["run"],
) {
  const dir = mkdtempSync(join(tmpdir(), "simurgh-telemetry-budget-"));
  dirs.push(dir);
  const datasourceRequests: string[] = [];
  let metricIndex = 0;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== grafanaOrigin) return nativeFetch(input, init);
    datasourceRequests.push(url.href);
    if (url.pathname === "/api/dashboards/uid/budget-dashboard") {
      return new Response(fixture.dashboardBody, { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname.endsWith("/api/v1/query_range")) {
      const body = metricBodies[metricIndex++];
      if (body === undefined) throw new Error("Unexpected extra metric request");
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  });
  const app = createCoordinator({
    databasePath: join(dir, "db"),
    origin: appOrigin,
    users: [{ id: "alice", name: "Alice", token }],
    limits: { wallMs: 10_000, queries: 4, bytes, concurrency: 1 },
    telemetry: fixture.policy,
    agent: { run },
  });
  apps.push(app);
  await app.listen(0);
  const request = (path: string, method = "GET", body?: unknown, cookie = "") =>
    nativeFetch(app.url + path, {
      method,
      headers: { Origin: appOrigin, "Content-Type": "application/json", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const cookie = (await request("/api/session", "POST", { token })).headers.get("set-cookie")!.split(";")[0];
  const imported = await request("/api/references", "POST", { snapshot: fixture.confirmed }, cookie);
  if (imported.status !== 201) throw new Error(`Telemetry fixture import failed: ${await imported.text()}`);
  const reference = (await imported.json()).reference;
  const created = await request("/api/investigations", "POST", {
    question: "Check the selected CPU data",
    referenceIds: [reference.id],
  }, cookie);
  const investigation = (await created.json()).investigation;
  return { app, cookie, investigation, request, datasourceRequests };
}

async function waitForInvestigation(scenario: Awaited<ReturnType<typeof startScenario>>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await scenario.request(`/api/investigations/${scenario.investigation.id}`, "GET", undefined, scenario.cookie);
    const investigation = (await response.json()).investigation;
    if (!["queued", "running"].includes(investigation.status)) return investigation;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Telemetry budget investigation did not finish");
}

const finding = (evidenceId: string) => ({
  strength: "hypothesis" as const,
  summary: "The selected metric sample was inspected.",
  citations: [evidenceId],
  limitations: [],
  nextCheck: "Compare the surrounding interval.",
});

describe("coordinator telemetry byte accounting", () => {
  it("charges streamed dashboard and metric bodies once when the combined wire bytes fit", async () => {
    const fixture = telemetryFixture();
    const wireBytes = Buffer.byteLength(fixture.dashboardBody) + Buffer.byteLength(fixture.metricBody);
    let evidence: any;
    const scenario = await startScenario(fixture, wireBytes, [fixture.metricBody], async (input: any) => {
      evidence = await input.read(input.references[0].id, "selected");
      return finding(evidence.id);
    });
    const result = await waitForInvestigation(scenario);
    expect(result.status).toBe("completed");
    expect(result.usage.bytes).toBe(wireBytes);
    expect(result.usage.queries).toBe(1);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toEqual(evidence);
    expect(wireBytes + Buffer.byteLength(JSON.stringify(evidence))).toBeGreaterThan(result.limits.bytes);
    expect(scenario.datasourceRequests).toHaveLength(2);
  });

  it("keeps invalid datasource JSON charged cumulatively and caps the next read", async () => {
    const fixture = telemetryFixture();
    const failedAttemptBytes = Buffer.byteLength(fixture.dashboardBody) + Buffer.byteLength("{");
    const validAttemptBytes = Buffer.byteLength(fixture.dashboardBody) + Buffer.byteLength(fixture.metricBody);
    const limit = failedAttemptBytes + validAttemptBytes;
    let invalidError = "";
    let nextReadError = "";
    const scenario = await startScenario(fixture, limit, ["{", fixture.metricBody], async (input: any) => {
      try {
        await input.read(input.references[0].id, "selected");
      } catch (error) {
        invalidError = String(error);
      }
      const evidence = await input.read(input.references[0].id, "selected");
      try {
        await input.read(input.references[0].id, "selected");
      } catch (error) {
        nextReadError = String(error);
      }
      return finding(evidence.id);
    });
    const result = await waitForInvestigation(scenario);
    expect(invalidError).toMatch(/JSON|Unexpected/i);
    expect(nextReadError).toMatch(/Evidence budget reached/);
    expect(result.status).toBe("limited");
    expect(result.usage.bytes).toBe(limit);
    expect(result.usage.queries).toBe(2);
    expect(result.evidence).toHaveLength(1);
    expect(scenario.datasourceRequests).toHaveLength(4);
  });
});
