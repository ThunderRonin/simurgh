import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extensionDir = path.resolve(
  process.env.SIMURGH_EXTENSION_DIR ?? path.join(root, 'packages/chromium-extension/dist'),
);
const grafanaUrl = (process.env.SIMURGH_GRAFANA_URL ?? 'http://127.0.0.1:3300').replace(/\/$/, '');
const dashboardUrl = process.env.SIMURGH_DASHBOARD_URL ??
  `${grafanaUrl}/d/simurgh-cpu-lab/simurgh-local-cpu-lab?orgId=1`;
const artifactDir = path.resolve(process.env.SIMURGH_BROWSER_ARTIFACTS ?? path.join(root, 'tests/browser/artifacts'));
const panelTitle = 'Lab host CPU utilization by core';
const errors = [];
const expectedConsoleErrors = [];

async function waitForGrafana() {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${grafanaUrl}/api/health`, { signal: AbortSignal.timeout(2500) });
      assert.equal(response.status, 200, `Grafana health returned HTTP ${response.status}`);
      const health = await response.json();
      assert.equal(health.database, 'ok', 'Grafana database is not healthy');
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`Grafana did not become healthy at ${grafanaUrl}: ${lastError?.message ?? 'timeout'}`);
}

async function waitUntil(predicate, message, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

function browserLaunchOptions() {
  const executablePath = process.env.PW_CHROMIUM_EXECUTABLE;
  return {
    headless: true,
    ...(executablePath ? { executablePath } : { channel: 'chromium' }),
  };
}

function queryFrames(body) {
  return Object.values(body?.results ?? {}).flatMap(result => Array.isArray(result?.frames) ? result.frames : []);
}

function grafanaSeries(body) {
  const series = [];
  for (const frame of queryFrames(body)) {
    const fields = frame.schema?.fields ?? [];
    const values = frame.data?.values ?? [];
    const timeIndex = fields.findIndex(field => field.type === 'time' || field.name?.toLowerCase() === 'time');
    if (timeIndex < 0 || !Array.isArray(values[timeIndex])) continue;
    for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
      if (fields[fieldIndex].type !== 'number' || !Array.isArray(values[fieldIndex])) continue;
      const timestamps = values[timeIndex];
      const samples = values[fieldIndex];
      const labels = Object.fromEntries(Object.entries(fields[fieldIndex].labels ?? {}).map(([key, value]) => [key, String(value)]));
      const points = timestamps.flatMap((time, index) => {
        const timestamp = typeof time === 'number' ? time : Date.parse(time);
        const value = samples[index];
        return Number.isFinite(timestamp) && typeof value === 'number' && Number.isFinite(value)
          ? [{ time: timestamp, value }]
          : [];
      });
      if (points.length) series.push({ labels, points, field: fields[fieldIndex] });
    }
  }
  return series;
}

function epoch(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) return Number(value);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

function localDateTimeInput(epochMillis) {
  return new Date(epochMillis).toISOString().slice(0, 19);
}

function assertSnapshotAgainstGrafana(snapshot, actualSeries, zoom) {
  assert.equal(snapshot.selectionMethod, 'grafana-native-range', 'Snapshot does not record Grafana native range selection');
  const rangeFrom = epoch(snapshot.range.from);
  const rangeTo = epoch(snapshot.range.to);
  assert.ok(Number.isFinite(rangeFrom) && Number.isFinite(rangeTo), 'Snapshot request range is not absolute');
  assert.equal(rangeFrom, epoch(zoom.from), 'Captured request start does not match Grafana native zoom');
  assert.equal(rangeTo, epoch(zoom.to), 'Captured request end does not match Grafana native zoom');
  assert.equal(snapshot.confirmation.seriesId, snapshot.selected.id, 'Confirmation series identity differs from selected data');
  assert.ok(snapshot.selected.labels && Object.keys(snapshot.selected.labels).length > 0,
    'Selected snapshot has no series labels');

  const source = actualSeries.find(series => JSON.stringify(series.labels, Object.keys(series.labels).sort()) ===
    JSON.stringify(snapshot.selected.labels, Object.keys(snapshot.selected.labels).sort()));
  assert.ok(source, `Confirmed labels do not match any actual Grafana frame: ${JSON.stringify(snapshot.selected.labels)}`);
  assert.ok(snapshot.selected.points.length > 0, 'Confirmed snapshot contains no numeric samples');
  for (const point of snapshot.selected.points) {
    assert.ok(point.time >= snapshot.confirmation.range.from && point.time <= snapshot.confirmation.range.to,
      `Confirmed point is outside the user-confirmed interval: ${JSON.stringify(point)}`);
    const match = source.points.find(sample => sample.time === point.time &&
      Math.abs(sample.value - point.value) <= Math.max(1, Math.abs(sample.value)) * 1e-12);
    assert.ok(match, `Confirmed point does not match an actual Grafana /api/ds/query sample: ${JSON.stringify(point)}`);
  }
}

async function latestNumericResponse(responses) {
  for (let index = responses.length - 1; index >= 0; index -= 1) {
    const response = responses[index];
    if (response.status !== 200) continue;
    const body = await response.body;
    const series = grafanaSeries(body);
    if (series.length) return { ...response, body, series };
  }
  return null;
}

function hasSufficientRecentSamples(series, now = Date.now()) {
  const points = series.flatMap(item => item.points);
  if (!points.length) return false;
  const latest = Math.max(...points.map(point => point.time));
  const recent = new Set(points.filter(point => point.time >= latest - 120_000).map(point => point.time));
  return now - latest <= 30_000 && recent.size >= 3;
}

async function disableDashboardRefresh(page) {
  const picker = page.getByRole('button', { name: /choose refresh time interval/i });
  await picker.click();
  await page.getByRole('menuitemradio', { name: 'Off', exact: true }).click();
  await page.getByRole('button', { name: /auto refresh turned off/i }).waitFor({ state: 'visible', timeout: 5_000 });
}

async function waitForRecentSamples(page, responses) {
  const deadline = Date.now() + 150_000;
  let current = await latestNumericResponse(responses);
  while ((!current || !hasSufficientRecentSamples(current.series)) && Date.now() < deadline) {
    const beforeCount = responses.length;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await waitUntil(() => responses.length > beforeCount, 'Grafana refresh produced no datasource response', 30_000);
    await page.waitForTimeout(500);
    current = await latestNumericResponse(responses);
  }
  assert.ok(current, 'Grafana produced no numeric CPU series in its real datasource response');
  const points = current.series.flatMap(item => item.points);
  const latest = Math.max(...points.map(point => point.time));
  const uniqueRecentTimes = new Set(points.filter(point => point.time >= latest - 120_000).map(point => point.time));
  assert.ok(hasSufficientRecentSamples(current.series),
    `CPU data did not warm up to three fresh samples within 150s (latest=${new Date(latest).toISOString()}, recentPoints=${uniqueRecentTimes.size})`);
  const rangeFrom = epoch(current.requestRange?.from);
  const rangeTo = epoch(current.requestRange?.to);
  assert.ok(Number.isFinite(rangeFrom) && Number.isFinite(rangeTo) && rangeFrom < rangeTo,
    `Grafana request did not expose absolute query bounds: ${JSON.stringify(current.requestRange)}`);
  return { ...current, range: { from: rangeFrom, to: rangeTo }, latestSampleTime: latest };
}

async function waitForNumericResponse(responses, startIndex, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const response = await latestNumericResponse(responses.slice(startIndex));
    if (response) return response;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Grafana did not return numeric series after the native range query');
}

async function findPanelMenu(page) {
  const panelHeading = page.getByText(panelTitle, { exact: true });
  await panelHeading.waitFor({ state: 'visible', timeout: 30_000 });
  await panelHeading.hover();

  const candidates = [
    page.getByRole('button', { name: /menu for panel|panel actions|more/i }),
    page.locator('button[data-testid*="Panel menu"]'),
    page.locator('button[aria-label*="More"]'),
  ];
  for (const candidateSet of candidates) {
    const count = await candidateSet.count();
    for (let index = count - 1; index >= 0; index -= 1) {
      const candidate = candidateSet.nth(index);
      if (await candidate.isVisible()) return candidate;
    }
  }
  throw new Error('Could not find the native Grafana panel menu button');
}

async function openSimurghMenuAction(page, actionTitle = 'Inspect with Simurgh') {
  const menu = await findPanelMenu(page);
  await menu.click();
  const extensions = page.getByRole('menuitem', { name: 'Extensions', exact: true });
  await extensions.waitFor({ state: 'visible', timeout: 10_000 });
  await extensions.click();
  const action = page.getByRole('menuitem', { name: actionTitle, exact: true });
  await action.waitFor({ state: 'visible', timeout: 10_000 });
  return action;
}

async function saveFailureEvidence(page, error, contextName, consoleEvents, pageErrors) {
  if (!page || page.isClosed()) return;
  const timestamp = new Date().toISOString().replaceAll(':', '-');
  const prefix = path.join(artifactDir, `failure-${contextName}-${timestamp}`);
  await page.screenshot({ path: `${prefix}.png`, fullPage: true, timeout: 10_000 }).catch(() => {});
  let bridgeMessages = [];
  try {
    bridgeMessages = await page.evaluate(() => window.__simurghBridgeMessages ?? []);
  } catch {}
  const diagnostics = {
    context: contextName,
    url: page.url(),
    viewport: page.viewportSize(),
    error: { name: error?.name, message: error?.message, stack: error?.stack },
    consoleEvents,
    pageErrors,
    bridgeMessages,
  };
  await writeFile(`${prefix}.json`, JSON.stringify(diagnostics, null, 2));
}

async function selectNativeRange(page, initialRange, latestSampleTime) {
  const before = new URL(page.url());
  const canvases = page.locator('canvas');
  const canvasCount = await canvases.count();
  assert.ok(canvasCount > 0, 'Grafana timeseries rendered no canvas surface');

  let target;
  for (let index = 0; index < canvasCount; index += 1) {
    const canvas = canvases.nth(index);
    const box = await canvas.boundingBox();
    if (box && box.width > 300 && box.height > 120) {
      target = { canvas, box };
      break;
    }
  }
  assert.ok(target, 'Could not locate the native Grafana timeseries canvas');

  const targetEnd = Math.min(initialRange.to, latestSampleTime - 1000);
  const targetStart = Math.max(initialRange.from, latestSampleTime - 120_000);
  assert.ok(targetEnd - targetStart >= 10_000,
    `Recent real samples span too little time for a native drag: ${targetStart}..${targetEnd}`);
  const startRatio = (targetStart - initialRange.from) / (initialRange.to - initialRange.from);
  const endRatio = (targetEnd - initialRange.from) / (initialRange.to - initialRange.from);
  assert.ok(endRatio - startRatio > 0.03, `Recent sample interval is too narrow on the actual chart: ${startRatio}..${endRatio}`);

  // The drag is still performed on Grafana's chart. Its x coordinates target
  // real timestamps returned by Grafana, not pixels inferred from a screenshot.
  const { x, y, width, height } = target.box;
  await page.mouse.move(x + width * startRatio, y + height * 0.55);
  await page.mouse.down();
  await page.mouse.move(x + width * endRatio, y + height * 0.55, { steps: 12 });
  await page.mouse.up();

  await page.waitForFunction(() => {
    const url = new URL(location.href);
    return Boolean(url.searchParams.get('from') && url.searchParams.get('to'));
  }, null, { timeout: 20_000 }).catch(() => {});
  const after = new URL(page.url());
  const from = after.searchParams.get('from');
  const to = after.searchParams.get('to');
  assert.ok(from && to, `Native Grafana zoom did not publish absolute from/to in the URL (before=${before.href}, after=${after.href})`);
  assert.notEqual(`${from}/${to}`, `${before.searchParams.get('from')}/${before.searchParams.get('to')}`,
    'Native Grafana range did not change after drag');
  return { from, to, targetStart, targetEnd, startRatio, endRatio };
}

async function openInspector(page) {
  const action = await openSimurghMenuAction(page);
  await action.click();
  const inspector = page.locator('section[data-testid="simurgh-inspector"]');
  await inspector.waitFor({ state: 'visible', timeout: 15_000 });
  return inspector;
}

async function openFreehandInspector(page) {
  const action = await openSimurghMenuAction(page, 'Freehand with Simurgh');
  await action.click();
  const inspector = page.locator('section[data-testid="simurgh-inspector"]');
  try {
    await inspector.waitFor({ state: 'visible', timeout: 15_000 });
  } catch {
    const dialogs = await page.getByRole('dialog').allTextContents();
    const status = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].map(item => item.textContent));
    const bridge = await page.evaluate(() => window.__simurghBridgeMessages ?? []);
    throw new Error(`Freehand action did not open the inspector. dialogs=${JSON.stringify(dialogs)} status=${JSON.stringify(status)} bridge=${JSON.stringify(bridge)}`);
  }
  return inspector;
}

async function verifyFreehandGesture() {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'simurgh-freehand-'));
  let browser;
  try {
    browser = await chromium.launchPersistentContext(profileDir, {
      ...browserLaunchOptions(),
      timezoneId: 'UTC',
      viewport: { width: 1440, height: 1000 },
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
    });
  } catch (error) {
    await rm(profileDir, { recursive: true, force: true });
    throw error;
  }
  let page;
  try {
    page = await browser.newPage();
    const queries = [];
    const consoleErrors = [];
    page.on('console', message => {
      if (message.type() === 'error' && !(message.location().url.includes('/api/user/stars') && /401/.test(message.text()))) consoleErrors.push(message.text());
    });
    page.on('pageerror', error => consoleErrors.push(error.message));
    page.on('response', response => {
      if (response.url().includes('/api/ds/query') && response.request().method() === 'POST') {
        let requestRange;
        try {
          const body = response.request().postDataJSON();
          requestRange = { from: body.from, to: body.to };
        } catch { requestRange = undefined; }
        queries.push({ status: response.status(), requestRange, body: response.json().catch(error => ({ responseError: error.message })) });
      }
    });
    await page.addInitScript(() => {
      window.__simurghBridgeMessages = [];
      window.addEventListener('message', event => {
        if (event.source === window && event.origin === location.origin && event.data?.channel === 'simurgh.context') {
          window.__simurghBridgeMessages.push(event.data);
        }
      });
    });
    await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.getByText(panelTitle, { exact: true }).waitFor({ state: 'visible', timeout: 60_000 });
    await waitUntil(() => queries.length > 0, 'Grafana did not issue a real datasource request for freehand capture');
    await disableDashboardRefresh(page);
    const warmData = await waitForRecentSamples(page, queries);
    let actual = (await latestNumericResponse(queries)).series;
    let inspector;
    let relativeRangeOutcome = 'native binding opened without a prior range change';
    const initialAction = await openSimurghMenuAction(page, 'Freehand with Simurgh');
    await initialAction.click();
    inspector = page.locator('section[data-testid="simurgh-inspector"]');
    try {
      await inspector.waitFor({ state: 'visible', timeout: 6_000 });
    } catch {
      const dialogs = await page.getByRole('dialog').allTextContents();
      relativeRangeOutcome = dialogs.join(' ').replace(/\s+/g, ' ').trim();
      assert.match(relativeRangeOutcome, /absolute bounds|request.*range/i,
        `Initial freehand attempt failed for an unexpected reason: ${relativeRangeOutcome}`);
      await page.getByRole('button', { name: 'Close', exact: true }).last().click();
      const queryIndex = queries.length;
      await selectNativeRange(page, warmData.range, warmData.latestSampleTime);
      await waitForNumericResponse(queries, queryIndex);
      actual = (await latestNumericResponse(queries)).series;
      inspector = await openFreehandInspector(page);
    }
    const initialMessage = await page.evaluate(() => window.__simurghBridgeMessages.filter(message =>
      message.kind === 'capture' && message.freehandBinding).at(-1));
    assert.ok(initialMessage?.freehandBinding, 'Normal Grafana startup did not provide a preloaded native renderer binding');
    assert.equal(initialMessage.freehandBinding.grafanaVersion, '13.2.3');
    assert.equal(initialMessage.freehandBinding.uPlotVersion, '1.6.32');
    let plotRect = initialMessage.freehandBinding.plotRect;
    assert.ok(plotRect.width > 300 && plotRect.height > 120, `Native interaction rectangle is implausibly small: ${JSON.stringify(plotRect)}`);
    await inspector.getByTestId('begin-freehand').click();
    const surface = page.getByTestId('freehand-surface');
    await surface.waitFor({ state: 'visible' });

    const emptyPath = [
      { x: plotRect.left + 8, y: plotRect.top + 8 }, { x: plotRect.left + 28, y: plotRect.top + 8 },
      { x: plotRect.left + 28, y: plotRect.top + 28 }, { x: plotRect.left + 8, y: plotRect.top + 28 },
      { x: plotRect.left + 8, y: plotRect.top + 8 },
    ];
    await page.mouse.move(emptyPath[0].x, emptyPath[0].y);
    await page.mouse.down();
    for (const point of emptyPath.slice(1)) await page.mouse.move(point.x, point.y, { steps: 1 });
    await page.mouse.up();
    await inspector.getByRole('alert').filter({ hasText: /did not enclose any available native data samples/i }).waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await inspector.getByTestId('begin-freehand').count(), 0,
      'A terminal freehand error left a consumed binding available for retry');
    await inspector.getByRole('button', { name: 'Close inspector' }).click();
    const freehandCaptureCount = await page.evaluate(() => window.__simurghBridgeMessages.filter(message =>
      message.kind === 'capture' && message.capture?.selectionMethod === 'grafana-freehand').length);
    await page.evaluate((message) => window.postMessage(message, window.location.origin), initialMessage);
    const replayGesture = {
      channel: 'simurgh.context', version: 1, integrationId: 'simurgh-context-app', kind: 'freehand-submit',
      sessionId: initialMessage.sessionId, requestSeq: initialMessage.requestSeq, captureId: initialMessage.capture.captureId,
      bindingId: initialMessage.freehandBinding.id, vertices: [{ x: 8, y: 8 }, { x: 28, y: 8 }, { x: 28, y: 28 }, { x: 8, y: 28 }],
    };
    await page.evaluate((gesture) => window.postMessage(gesture, window.location.origin), replayGesture);
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => window.__simurghBridgeMessages.filter(message =>
      message.kind === 'capture' && message.capture?.selectionMethod === 'grafana-freehand').length), freehandCaptureCount,
    'A closed inspector reopened or accepted a replayed freehand request');
    inspector = await openFreehandInspector(page);
    const reboundMessage = await page.evaluate(() => window.__simurghBridgeMessages.filter(message =>
      message.kind === 'capture' && message.freehandBinding).at(-1));
    assert.ok(reboundMessage?.freehandBinding, 'An empty-selection error did not permit a fresh binding after reopening');
    plotRect = reboundMessage.freehandBinding.plotRect;
    await inspector.getByTestId('begin-freehand').click();
    await page.getByTestId('freehand-surface').waitFor({ state: 'visible' });
    await page.setViewportSize({ width: 1320, height: 920 });
    await inspector.getByRole('alert').filter({ hasText: /chart layout changed during the gesture/i }).waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await inspector.getByTestId('begin-freehand').count(), 0,
      'A resize during drawing left a stale renderer binding available');
    await inspector.getByRole('button', { name: 'Close inspector' }).click();
    inspector = await openFreehandInspector(page);
    const resizedMessage = await page.evaluate(() => window.__simurghBridgeMessages.filter(message =>
      message.kind === 'capture' && message.freehandBinding).at(-1));
    assert.ok(resizedMessage?.freehandBinding, 'The resized native renderer could not bind again after reopening');
    plotRect = resizedMessage.freehandBinding.plotRect;
    await inspector.getByTestId('begin-freehand').click();
    await page.getByTestId('freehand-surface').waitFor({ state: 'visible' });

    const circlePoints = (rect) => Array.from({ length: 40 }, (_unused, index) => {
        const angle = index / 39 * Math.PI * 2;
        return { x: rect.left + rect.width * (0.5 + 0.46 * Math.cos(angle)),
          y: rect.top + rect.height * (0.92 + 0.079 * Math.sin(angle)) };
      });
    const drawCircle = async (rect) => {
      const circle = circlePoints(rect);
      await page.mouse.move(circle[0].x, circle[0].y);
      await page.mouse.down();
      for (const point of circle.slice(1)) await page.mouse.move(point.x, point.y, { steps: 1 });
      await page.mouse.up();
    };
    const staleCircle = circlePoints(plotRect);
    const refreshIndex = queries.length;
    await page.mouse.move(staleCircle[0].x, staleCircle[0].y);
    await page.mouse.down();
    await page.getByRole('button', { name: 'Refresh', exact: true }).evaluate((button) => button.click());
    await waitForNumericResponse(queries, refreshIndex);
    for (const point of staleCircle.slice(1)) await page.mouse.move(point.x, point.y, { steps: 1 });
    await page.mouse.up();
    await inspector.getByText(/chart data, visibility, scale, or layout changed during the gesture/i).waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await inspector.getByTestId('begin-freehand').count(), 0,
      'A stale renderer binding remained available for another gesture');
    await inspector.getByRole('button', { name: 'Close inspector' }).click();
    inspector = await openFreehandInspector(page);
    const refreshedMessage = await page.evaluate(() => window.__simurghBridgeMessages.filter(message =>
      message.kind === 'capture' && message.freehandBinding).at(-1));
    assert.ok(refreshedMessage?.freehandBinding, 'A refreshed native renderer could not bind to its current panel data');
    plotRect = refreshedMessage.freehandBinding.plotRect;
    await inspector.getByTestId('begin-freehand').click();
    await page.getByTestId('freehand-surface').waitFor({ state: 'visible' });
    await drawCircle(plotRect);

    await waitUntil(async () => page.evaluate(() => window.__simurghBridgeMessages.some(message =>
      message.kind === 'capture' && message.capture?.selectionMethod === 'grafana-freehand') ||
      [...(document.querySelector('[data-testid="simurgh-overlay-host"]')?.shadowRoot?.querySelectorAll('[role="alert"]') ?? [])]
        .some(alert => !/checking the native chart samples/i.test(alert.textContent ?? ''))),
    'Native renderer did not return a freehand result or visible rejection', 20_000);
    const error = await inspector.locator('[role="alert"]').allTextContents();
    const resultMessage = await page.evaluate(() => window.__simurghBridgeMessages.filter(message =>
      message.kind === 'capture' && message.capture?.selectionMethod === 'grafana-freehand').at(-1));
    const submittedGesture = await page.evaluate(() => window.__simurghBridgeMessages.filter(message => message.kind === 'freehand-submit').at(-1));
    assert.ok(resultMessage, `Native freehand was rejected: ${error.join(' | ')}; submit=${JSON.stringify(submittedGesture)}`);
    const snapshot = resultMessage.capture;
    assert.ok(snapshot.freehand.vertices.length >= 3, 'Confirmed geometry did not retain the actual freehand path');
    assert.ok(snapshot.freehand.candidates.length > 1, 'The overlapping freehand gesture did not preserve multiple explicit series candidates');
    assert.equal(snapshot.freehand.candidates.length, await inspector.locator('[data-testid^="series-option-"]').count());
    assert.ok(snapshot.freehand.interval.from >= snapshot.range.from && snapshot.freehand.interval.to <= snapshot.range.to);

    const radio = inspector.locator('[data-testid^="series-option-"] input[type="radio"]').first();
    const selectedId = await radio.inputValue();
    await radio.check();
    await inspector.getByTestId('confirm-capture').click();
    const bundle = await openConfirmedBundle(inspector);
    const confirmed = JSON.parse((await bundle.textContent()).trim());
    assert.equal(confirmed.selectionMethod, 'grafana-freehand');
    assert.equal(confirmed.selected.id, selectedId);
    assert.deepEqual(confirmed.confirmation.range, snapshot.freehand.interval);
    assert.deepEqual(confirmed.freehand.confirmedPointIndexes.length, confirmed.selected.points.length);
    const source = actual.find(item => JSON.stringify(item.labels, Object.keys(item.labels).sort()) ===
      JSON.stringify(confirmed.selected.labels, Object.keys(confirmed.selected.labels).sort()));
    assert.ok(source, 'Chosen freehand series labels do not match any actual Grafana datasource frame');
    for (const point of confirmed.selected.points) {
      assert.ok(source.points.some(sample => sample.time === point.time && sample.value === point.value),
        `Freehand confirmation contains a point absent from actual /api/ds/query data: ${JSON.stringify(point)}`);
    }
    assert.equal(confirmed.freehand.confirmedSeriesId, confirmed.selected.id);
    const refreshAfterConfirm = queries.length;
    await page.getByRole('button', { name: 'Refresh', exact: true }).evaluate((button) => button.click());
    await waitForNumericResponse(queries, refreshAfterConfirm);
    assert.deepEqual(JSON.parse((await bundle.textContent()).trim()), confirmed,
      'A post-confirmation Grafana refresh changed the immutable freehand bundle');
    const freehandArtifact = path.join(artifactDir, 'freehand-confirmed-capture.json');
    await writeFile(freehandArtifact, JSON.stringify(confirmed, null, 2));
    await page.screenshot({ path: path.join(artifactDir, 'freehand-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(350);
    const narrowInspector = await page.locator('section[data-testid="simurgh-inspector"]').boundingBox();
    assert.ok(narrowInspector && narrowInspector.x >= 0 && narrowInspector.x + narrowInspector.width <= 390,
      `Inspector overflows narrow viewport: ${JSON.stringify(narrowInspector)}`);
    await page.screenshot({ path: path.join(artifactDir, 'freehand-narrow.png'), fullPage: true });
    assert.deepEqual(consoleErrors, [], `Freehand browser flow emitted errors: ${consoleErrors.join('\n')}`);
    return { candidateCount: snapshot.freehand.candidates.length, selectedId, selectedPoints: confirmed.selected.points.length,
      selectedInterval: confirmed.confirmation.range, freehandArtifact, relativeRangeOutcome,
      staleRefreshRejected: true, refreshedBindingAccepted: true, narrowViewportInspectorVisible: true,
      confirmedBundleStableAfterRefresh: true };
  } finally {
    await browser.close();
    await rm(profileDir, { recursive: true, force: true });
  }
}

async function openConfirmedBundle(inspector) {
  const details = inspector.locator('details.json-inspect');
  await details.waitFor({ state: 'visible', timeout: 10_000 });
  if (!(await details.evaluate(element => element.open))) await details.locator('summary').click();
  const bundle = inspector.getByTestId('confirmed-bundle');
  await bundle.waitFor({ state: 'visible', timeout: 10_000 });
  return bundle;
}

async function verifyMissingExtensionState() {
  const browser = await chromium.launch(browserLaunchOptions());
  let page;
  const consoleEvents = [];
  const pageErrors = [];
  try {
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: 'UTC' });
    page.on('console', message => consoleEvents.push({ type: message.type(), text: message.text(), location: message.location() }));
    page.on('pageerror', error => pageErrors.push(error.message));
    const grafanaQueries = [];
    page.on('response', response => {
      if (response.url().includes('/api/ds/query') && response.request().method() === 'POST') {
        let requestRange;
        try {
          const body = response.request().postDataJSON();
          requestRange = { from: body.from, to: body.to };
        } catch {
          requestRange = undefined;
        }
        grafanaQueries.push({ status: response.status(), requestRange, body: response.json().catch(error => ({ responseError: error.message })) });
      }
    });
    await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.getByText(panelTitle, { exact: true }).waitFor({ state: 'visible', timeout: 60_000 });
    await page.getByText(/CPU\s+\d+/, { exact: false }).first().waitFor({ state: 'visible', timeout: 60_000 });
    await waitUntil(() => grafanaQueries.length > 0, 'Grafana did not query real datasource samples in the missing-extension context');
    await disableDashboardRefresh(page);
    const warmData = await waitForRecentSamples(page, grafanaQueries);
    const queryStart = grafanaQueries.length;
    const zoom = await selectNativeRange(page, warmData.range, warmData.latestSampleTime);
    const zoomResponse = await waitForNumericResponse(grafanaQueries, queryStart);
    assert.equal(zoomResponse.status, 200, 'Native Grafana zoom query failed in the missing-extension context');
    assert.equal(epoch(zoomResponse.requestRange?.from), epoch(zoom.from), 'Missing-extension native request start is not absolute');
    assert.equal(epoch(zoomResponse.requestRange?.to), epoch(zoom.to), 'Missing-extension native request end is not absolute');
    const action = await openSimurghMenuAction(page);
    await action.click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ state: 'visible', timeout: 15_000 });
    const dialogText = await dialog.innerText();
    await page.getByText('Simurgh extension required', { exact: true }).waitFor({ state: 'visible' });
    assert.match(dialogText, /install and enable.*browser extension/i, 'Missing-extension dialog does not tell the user what to do');
    return dialogText;
  } catch (error) {
    await saveFailureEvidence(page, error, 'missing-extension', consoleEvents, pageErrors);
    throw error;
  } finally {
    await browser.close();
  }
}

function nativeExtensionContextProbe(session) {
  const contexts = new Map();
  session.on('Runtime.executionContextCreated', ({ context }) => {
    if (context.auxData?.type === 'isolated' && context.origin.startsWith('chrome-extension://')) {
      contexts.set(context.id, context);
    }
  });
  return async () => {
    await session.send('Runtime.enable');
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      for (const context of contexts.values()) {
        try {
          const result = await session.send('Runtime.evaluate', {
            expression: 'chrome.runtime.id',
            contextId: context.id,
            returnByValue: true,
          });
          const id = result.result?.value;
          if (typeof id === 'string' && id.length) return { id, origin: context.origin };
        } catch {
          contexts.delete(context.id);
        }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('The unpacked extension did not create an isolated-world execution context on Grafana');
  };
}

async function main() {
  const manifestPath = path.join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.manifest_version, 3, 'Expected the built Chromium extension to be MV3');
  assert.ok(manifest.content_scripts?.length, 'Built extension has no content script');
  assert.ok(manifest.host_permissions?.some(permission => permission.includes('localhost:3300') || permission.includes('127.0.0.1:3300')),
    'Extension host permissions do not cover the local Grafana lab origin');

  await waitForGrafana();
  await mkdir(artifactDir, { recursive: true });
  if (process.env.SIMURGH_FREEHAND_ONLY === '1') {
    console.log(JSON.stringify({ status: 'freehand-only', ...(await verifyFreehandGesture()) }, null, 2));
    return;
  }
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'simurgh-browser-'));
  let context;
  let page;
  const consoleEvents = [];
  const pageErrors = [];
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      ...browserLaunchOptions(),
      timezoneId: 'UTC',
      viewport: { width: 1440, height: 1000 },
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
      ],
    });
    page = await context.newPage();
    const grafanaQueries = [];
    page.on('pageerror', error => {
      errors.push(error.message);
      pageErrors.push(error.message);
    });
    await page.addInitScript(() => {
      window.__simurghBridgeMessages = [];
      window.addEventListener('message', event => {
        const data = event.data;
        if (event.source === window && event.origin === location.origin && data?.channel === 'simurgh.context') {
          window.__simurghBridgeMessages.push(data);
        }
      });
    });
    page.on('response', response => {
      if (response.url().includes('/api/ds/query') && response.request().method() === 'POST') {
        let requestRange;
        try {
          const body = response.request().postDataJSON();
          requestRange = { from: body.from, to: body.to };
        } catch {
          requestRange = undefined;
        }
        grafanaQueries.push({ status: response.status(), requestRange, body: response.json().catch(error => ({ responseError: error.message })) });
      }
    });
    page.on('console', message => {
      consoleEvents.push({ type: message.type(), text: message.text(), location: message.location() });
      if (message.type() === 'error') {
        const location = message.location().url;
        if (location.includes('/api/user/stars') && /401/.test(message.text())) expectedConsoleErrors.push(message.text());
        else errors.push(message.text());
      }
    });
    const session = await context.newCDPSession(page);
    const extensionProbe = nativeExtensionContextProbe(session);

    await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.getByText(panelTitle, { exact: true }).waitFor({ state: 'visible', timeout: 60_000 });
    await page.getByText(/CPU\s+\d+/, { exact: false }).first().waitFor({ state: 'visible', timeout: 60_000 });
    await waitUntil(() => grafanaQueries.length > 0, 'Grafana did not issue its real /api/ds/query request');
    await disableDashboardRefresh(page);
    const warmData = await waitForRecentSamples(page, grafanaQueries);

    const queryCountBeforeZoom = grafanaQueries.length;
    const zoom = await selectNativeRange(page, warmData.range, warmData.latestSampleTime);
    await waitUntil(() => grafanaQueries.length > queryCountBeforeZoom, 'Native zoom did not issue a new Grafana data query', 30_000);
    const zoomResponse = await waitForNumericResponse(grafanaQueries, queryCountBeforeZoom);
    assert.equal(zoomResponse.status, 200, 'Grafana native zoom query failed');
    const nativeSeries = zoomResponse.series;
    assert.ok(nativeSeries.length > 1, `Grafana query returned ${nativeSeries.length} numeric series; expected the real multi-series CPU panel`);

    const inspector = await openInspector(page);
    const isolatedExtension = await extensionProbe();
    assert.match(isolatedExtension.origin, /^chrome-extension:\/\//);

    const series = inspector.locator('[data-testid^="series-option-"]');
    const seriesCount = await series.count();
    assert.ok(seriesCount > 1, `Expected multiple actual CPU series candidates, found ${seriesCount}`);
    for (let index = 0; index < seriesCount; index += 1) {
      assert.equal(await series.nth(index).locator('input[type="radio"]').isChecked(), false, `Series candidate ${index} was auto-selected`);
    }

    const chosenOption = series.first();
    const chosen = chosenOption.locator('input[type="radio"]');
    const chosenLabel = (await chosenOption.innerText()).trim();
    const chosenId = await chosen.inputValue();
    assert.ok(chosenId, 'Series option did not expose a stable series id');
    await chosen.check();
    await inspector.getByTestId('confirm-capture').click();

    let bundle = await openConfirmedBundle(inspector);
    const initialBundleText = (await bundle.textContent()).trim();
    const initialSnapshot = JSON.parse(initialBundleText);
    assert.equal(initialSnapshot.selected.id, chosenId, 'Confirmed snapshot selected a different series than the explicit radio choice');
    assertSnapshotAgainstGrafana(initialSnapshot, nativeSeries, zoom);
    assert.ok(initialSnapshot.limitations.some((item) =>
      /structured scoped values were unavailable/i.test(item) && /\bhost\b/.test(item)),
    'Capture did not disclose that the referenced host template variable lacks structured values');
    const downloadPromise = page.waitForEvent('download');
    await inspector.getByRole('button', { name: 'Download JSON', exact: true }).click();
    const download = await downloadPromise;
    assert.ok(download.suggestedFilename().includes(initialSnapshot.captureId), 'JSON download filename is not bound to the confirmed capture');
    const downloadPath = await download.path();
    assert.ok(downloadPath, 'Confirmed JSON download did not produce a file');
    assert.deepEqual(JSON.parse(await readFile(downloadPath, 'utf8')), initialSnapshot,
      'Downloaded JSON differs from the exact confirmed snapshot');
    const persistedCapturePath = path.join(artifactDir, 'confirmed-capture.json');
    await writeFile(persistedCapturePath, await readFile(downloadPath));
    assert.deepEqual(JSON.parse(await readFile(persistedCapturePath, 'utf8')), initialSnapshot,
      'Persisted confirmed capture differs from the exact downloaded snapshot');

    await inspector.getByRole('button', { name: /correct selection/i }).click();
    await bundle.waitFor({ state: 'detached', timeout: 10_000 });
    const startField = inspector.getByLabel('Start time', { exact: true });
    const startBeforeCorrection = await startField.inputValue();
    const endBeforeCorrection = await inspector.getByLabel('End time', { exact: true }).inputValue();
    assert.ok(startBeforeCorrection && endBeforeCorrection, 'Capture correction did not restore absolute editable interval bounds');
    const originalStart = initialSnapshot.confirmation.range.from;
    const originalEnd = initialSnapshot.confirmation.range.to;
    assert.ok(originalEnd - originalStart > 1000, `Captured range is too short to correct: ${originalStart}..${originalEnd}`);
    const correctedStartMillis = originalStart + Math.max(1, Math.floor((originalEnd - originalStart) / 10));
    const inputType = await startField.getAttribute('type');
    const correctedStart = inputType === 'datetime-local'
      ? localDateTimeInput(correctedStartMillis)
      : new Date(correctedStartMillis).toISOString();
    await startField.fill(correctedStart);
    assert.equal(await inspector.getByTestId('confirmed-bundle').count(), 0, 'Correcting the accepted range did not require reconfirmation');
    await inspector.getByTestId('confirm-capture').click();

    bundle = await openConfirmedBundle(inspector);
    const confirmedText = (await bundle.textContent()).trim();
    const confirmedSnapshot = JSON.parse(confirmedText);
    assert.equal(confirmedSnapshot.selected.id, chosenId, 'Corrected confirmation changed the explicitly selected series');
    assertSnapshotAgainstGrafana(confirmedSnapshot, nativeSeries, zoom);
    assert.ok(confirmedSnapshot.confirmation.range.from > initialSnapshot.confirmation.range.from,
      'Corrected absolute time did not change the confirmed interval');
    assert.equal(confirmedSnapshot.candidateCount, seriesCount, 'Confirmed candidate count does not match the actual ambiguity');

    const activeBridgeCapture = await page.evaluate(() => window.__simurghBridgeMessages.filter(message => message.kind === 'capture').at(-1));
    await page.evaluate(requestSeq => {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.dataset.simurghRejection = 'true';
      frame.srcdoc = `<script>parent.postMessage({ channel: 'simurgh.context', version: 1, integrationId: 'simurgh-context-app', kind: 'capture', sessionId: 'wrong-origin', requestSeq: ${requestSeq}, capture: {} }, '*')<\/script>`;
      document.body.append(frame);
      setTimeout(() => frame.remove(), 1000);
    }, activeBridgeCapture.requestSeq);
    await page.waitForTimeout(300);
    assert.equal((await bundle.textContent()).trim(), confirmedText, 'Wrong-origin message changed the accepted snapshot');
    await page.locator('iframe[data-simurgh-rejection="true"]').evaluate(frame => frame.remove());

    const staleSession = `stale-${confirmedSnapshot.sessionId}`;
    const staleCapture = structuredClone(confirmedSnapshot);
    staleCapture.sessionId = staleSession;
    await page.evaluate(payload => window.postMessage(payload, location.origin), {
      channel: 'simurgh.context', version: 1, integrationId: 'simurgh-context-app',
      kind: 'capture', sessionId: staleSession, requestSeq: activeBridgeCapture.requestSeq, capture: staleCapture,
    });
    await page.waitForTimeout(100);
    assert.equal((await bundle.textContent()).trim(), confirmedText, 'Stale-session capture changed the accepted snapshot');

    await page.evaluate(({ sessionId, requestSeq }) => window.postMessage({
      channel: 'simurgh.context', version: 1, integrationId: 'simurgh-context-app',
      kind: 'capture', sessionId, requestSeq, capture: { schema: 'forged-and-invalid' },
    }, location.origin), { sessionId: confirmedSnapshot.sessionId, requestSeq: activeBridgeCapture.requestSeq });
    await page.waitForTimeout(300);
    assert.equal((await bundle.textContent()).trim(), confirmedText, 'Malformed same-session capture changed the accepted snapshot');

    await page.screenshot({ path: path.join(artifactDir, 'desktop.png'), fullPage: true });
    const queryCountBeforeRefresh = grafanaQueries.length;
    const refreshButton = page.getByRole('button', { name: 'Refresh', exact: true });
    await inspector.getByRole('button', { name: 'Close inspector' }).click();
    await refreshButton.click();
    await waitUntil(() => grafanaQueries.length > queryCountBeforeRefresh, 'Grafana refresh did not issue a new real data request', 30_000);
    const retainedBeforeSecondCapture = [initialBundleText, confirmedText];
    const secondCaptureInspector = await openInspector(page);
    await secondCaptureInspector.getByTestId('active-capture-id').waitFor({ state: 'visible' });
    assert.equal(await secondCaptureInspector.getByTestId('confirmed-view').count(), 0,
      'Second capture incorrectly remained confirmed without user reconfirmation');
    const secondOptions = secondCaptureInspector.locator('[data-testid^="series-option-"]');
    assert.ok(await secondOptions.count() > 1, 'Second native capture lost its ambiguous candidate series');
    for (let index = 0; index < await secondOptions.count(); index += 1) {
      assert.equal(await secondOptions.nth(index).locator('input[type="radio"]').isChecked(), false,
        `Second capture auto-selected candidate ${index}`);
    }
    const secondHistory = secondCaptureInspector.locator('[data-testid^="accepted-bundle-"]');
    assert.equal(await secondHistory.count(), 2, 'Second capture discarded previously confirmed immutable bundles');
    const retainedAfterSecondCapture = await Promise.all(Array.from({ length: 2 }, async (_, index) =>
      (await secondCaptureInspector.getByTestId(`accepted-bundle-${index}`).textContent()).trim()));
    assert.deepEqual(retainedAfterSecondCapture, retainedBeforeSecondCapture,
      'A second native capture mutated prior accepted bundle history');
    const secondBridgeCapture = await page.evaluate(() => window.__simurghBridgeMessages.filter(message => message.kind === 'capture').at(-1));
    const bridgeCapturesBeforeSecond = await page.evaluate(() => window.__simurghBridgeMessages.filter(message => message.kind === 'capture'));
    assert.ok(bridgeCapturesBeforeSecond.length >= 2, 'Expected two real plugin-to-extension captures in the browser bridge');
    const firstBridgeCapture = bridgeCapturesBeforeSecond.at(-2);
    assert.ok(secondBridgeCapture && secondBridgeCapture.requestSeq > firstBridgeCapture.requestSeq,
      'Second actual plugin-to-extension capture did not carry a monotonic requestSeq');
    const secondNativeSeries = (await latestNumericResponse(grafanaQueries)).series;
    const secondOption = secondOptions.first();
    const secondRadio = secondOption.locator('input[type="radio"]');
    const secondChosenId = await secondRadio.inputValue();
    await secondRadio.check();
    await secondCaptureInspector.getByTestId('confirm-capture').click();
    const secondBundle = await openConfirmedBundle(secondCaptureInspector);
    const secondConfirmedText = (await secondBundle.textContent()).trim();
    const secondSnapshot = JSON.parse(secondConfirmedText);
    assert.notEqual(secondSnapshot.captureId, initialSnapshot.captureId, 'Second confirmation reused the first capture identity');
    assert.equal(secondSnapshot.selected.id, secondChosenId, 'Second capture did not require and honor an explicit series choice');
    assertSnapshotAgainstGrafana(secondSnapshot, secondNativeSeries, zoom);
    assert.deepEqual(await Promise.all(Array.from({ length: 2 }, async (_, index) =>
      (await secondCaptureInspector.getByTestId(`accepted-bundle-${index}`).textContent()).trim())), retainedBeforeSecondCapture,
    'Confirming a second capture mutated the original accepted bundles');
    const bridgeCaptures = await page.evaluate(() => window.__simurghBridgeMessages.filter(message => message.kind === 'capture'));
    assert.ok(bridgeCaptures.length >= 2 && bridgeCaptures.at(-1).requestSeq > bridgeCaptures.at(-2).requestSeq,
      'Observed plugin-to-extension capture requestSeq values were not monotonic');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    const overlayBox = await inspector.boundingBox();
    assert.ok(overlayBox, 'Inspector overlay is not visible at narrow viewport');
    assert.ok(overlayBox.x >= 0 && overlayBox.y >= 0 && overlayBox.x + overlayBox.width <= 390 && overlayBox.y + overlayBox.height <= 844,
      `Inspector overflows the 390x844 viewport: ${JSON.stringify(overlayBox)}`);
    const overflowingControls = await inspector.evaluate(element => Array.from(element.querySelectorAll('button, input, label, pre')).flatMap(child => {
      const rect = child.getBoundingClientRect();
      return rect.width > 0 && (rect.left < element.getBoundingClientRect().left - 1 || rect.right > element.getBoundingClientRect().right + 1)
        ? [{ tag: child.tagName, label: child.getAttribute('aria-label') ?? child.textContent?.slice(0, 40), rect: { left: rect.left, right: rect.right } }]
        : [];
    }));
    assert.deepEqual(overflowingControls, [], `Inspector controls overflow horizontally at narrow viewport: ${JSON.stringify(overflowingControls)}`);
    await page.screenshot({ path: path.join(artifactDir, 'narrow.png'), fullPage: true });
    assert.equal(await secondBundle.textContent(), secondConfirmedText, 'Viewport change mutated the second accepted snapshot');

    const missingExtensionState = await verifyMissingExtensionState();

    assert.deepEqual(errors, [], `Browser emitted console/page errors: ${errors.join('\n')}`);
    console.log(JSON.stringify({
      status: 'passed',
      grafanaUrl,
      dashboardUrl: page.url(),
      missingExtensionState: 'actionable modal shown',
      missingExtensionMessage: missingExtensionState,
      nativeZoom: zoom,
      isolatedExtension,
      candidateCount: seriesCount,
      chosenSeries: chosenLabel,
      chosenSeriesId: chosenId,
      confirmedRange: confirmedSnapshot.confirmation.range,
      capturedPoints: confirmedSnapshot.selected.points.length,
      comparedQueryFrames: nativeSeries.length,
      correctedStart: correctedStart,
      confirmedSnapshotLength: confirmedText.length,
      downloadedFilename: download.suggestedFilename(),
      persistedConfirmedCapture: persistedCapturePath,
      secondCaptureId: secondSnapshot.captureId,
      secondCaptureRequestSeq: secondBridgeCapture.requestSeq,
      retainedAcceptedBundles: retainedAfterSecondCapture.length,
      screenshots: [path.join(artifactDir, 'desktop.png'), path.join(artifactDir, 'narrow.png')],
      browserErrors: errors,
      expectedAnonymousViewerErrors: expectedConsoleErrors,
    }, null, 2));
  } catch (error) {
    await saveFailureEvidence(page, error, 'extension', consoleEvents, pageErrors);
    throw error;
  } finally {
    await context?.close();
    await rm(profileDir, { recursive: true, force: true });
  }

  const freehand = await verifyFreehandGesture();
  console.log(JSON.stringify({ status: 'freehand-passed', ...freehand }, null, 2));
}

main().catch(error => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
