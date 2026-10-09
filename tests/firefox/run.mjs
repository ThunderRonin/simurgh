import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { freePort, startGeckodriver, waitForGeckodriver, WebDriver } from './webdriver.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const firefoxBinary = path.resolve(process.env.SIMURGH_FIREFOX_BIN ?? path.join(root, 'work/firefox-tools/firefox/firefox'));
const geckodriverPath = path.resolve(process.env.SIMURGH_GECKODRIVER ?? path.join(root, 'work/firefox-tools/geckodriver'));
const extensionDir = path.resolve(process.env.SIMURGH_FIREFOX_EXTENSION_PATH ?? path.join(root, 'packages/chromium-extension/dist-firefox'));
const grafanaUrl = (process.env.SIMURGH_GRAFANA_URL ?? 'http://127.0.0.1:3300').replace(/\/$/, '');
const dashboardUrl = process.env.SIMURGH_DASHBOARD_URL ??
  `${grafanaUrl}/d/simurgh-cpu-lab/simurgh-local-cpu-lab?orgId=1&from=now-5m&to=now`;
const artifactDir = path.resolve(process.env.SIMURGH_FIREFOX_ARTIFACTS ?? path.join(root, 'test-results/firefox'));
const panelTitle = 'Lab host CPU utilization by core';

for (const candidate of [firefoxBinary, geckodriverPath, path.join(extensionDir, 'manifest.json')]) {
  await access(candidate).catch(() => { throw new Error(`Firefox test input is missing: ${candidate}`); });
}
const profile = await mkdtemp(path.join(os.tmpdir(), 'simurgh-firefox-e2e-'));
const downloadDir = path.join(profile, 'downloads');
await mkdir(downloadDir);
const port = await freePort();
const wrongPort = await freePort();
assert.notEqual(wrongPort, 3300);
const driverBase = `http://127.0.0.1:${port}`;
const geckodriver = startGeckodriver(geckodriverPath, port);
const driver = new WebDriver(driverBase);
const wrongOriginServer = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><title>Wrong-port guard</title><main>Loopback page on an unrelated port</main>');
});
await new Promise((resolve, reject) => {
  wrongOriginServer.once('error', reject);
  wrongOriginServer.listen(wrongPort, '127.0.0.1', resolve);
});
let installedAddonId;
let phase = 'startup';
let metadata;

try {
  await waitForGeckodriver(driverBase, geckodriver.process);
  const capabilities = await driver.newFirefoxSession({ binary: firefoxBinary, profile, downloadDir });
  metadata = {
    name: capabilities.browserName,
    version: capabilities.browserVersion,
    geckodriverVersion: capabilities['moz:geckodriverVersion'],
  };
  assert.equal(metadata.name, 'firefox');
  assert.match(metadata.version, /^157\./, 'Unexpected Firefox release for the pinned acceptance environment');
  const addon = await driver.command('/moz/addon/install', 'POST', { path: extensionDir, temporary: true });
  installedAddonId = typeof addon === 'string' ? addon : addon.id;
  assert.ok(installedAddonId, 'Firefox did not report the temporary add-on id');

  phase = 'wrong-port-guard';
  await driver.navigate(`http://127.0.0.1:${wrongPort}/`);
  await waitFor(async () => driver.execute(`return document.readyState==='complete'`), 10_000,
    'Wrong-port loopback page did not load');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(await driver.execute(`return Boolean(document.querySelector('[data-testid="simurgh-overlay-host"]'))`), false,
    'Firefox injected Simurgh on a loopback origin other than the exact Grafana port');

  phase = 'dashboard-load';
  await driver.navigate(dashboardUrl);
  await waitFor(async () => driver.execute(`return document.readyState === 'complete' &&
    [...document.querySelectorAll('h1,h2,[role=heading]')].some(el => el.textContent?.includes(${JSON.stringify(panelTitle)}))`),
  60_000, 'Grafana dashboard panel did not load');
  await waitFor(async () => driver.execute(`return Boolean(document.querySelector('[data-testid="simurgh-overlay-host"]'))`),
    30_000, 'Temporary Firefox add-on did not inject its content script on Grafana');
  await waitFor(async () => driver.execute(`return new URL(location.href).searchParams.get('var-host') === 'node-exporter:9100'`),
    20_000, 'Grafana host variable did not resolve before refresh setup');
  await waitFor(async () => driver.execute(`return [...document.querySelectorAll('canvas')].some(el => {
    const r = el.getBoundingClientRect(); return r.width > 300 && r.height > 120;
  })`), 30_000, 'Grafana timeseries canvas did not render');

  phase = 'set-initial-refresh';
  await setDashboardRefresh(driver, '5s');

  phase = 'native-range';
  const chart = await driver.execute(`return (() => { const canvas = [...document.querySelectorAll('canvas')].map(el => ({
    el, rect: el.getBoundingClientRect()
  })).find(({ rect }) => rect.width > 300 && rect.height > 120);
  return canvas && { x: canvas.rect.x, y: canvas.rect.y, width: canvas.rect.width, height: canvas.rect.height }; })()`);
  assert.ok(chart, 'Could not find Grafana chart canvas');
  await driver.drag([
    { x: chart.x + chart.width * 0.25, y: chart.y + chart.height * 0.52 },
    { x: chart.x + chart.width * 0.90, y: chart.y + chart.height * 0.52 },
  ]);
  await waitFor(async () => driver.execute(`return (() => { const u = new URL(location.href); return Number.isFinite(Date.parse(u.searchParams.get('from') ?? '')) && Number.isFinite(Date.parse(u.searchParams.get('to') ?? '')); })()`),
    15_000, 'Native Grafana drag did not commit an absolute from/to range');
  const absoluteRange = await driver.execute(`return (() => { const u = new URL(location.href); return { from: u.searchParams.get('from'), to: u.searchParams.get('to') }; })()`);
  assert.ok(Date.parse(absoluteRange.from) < Date.parse(absoluteRange.to), `Invalid absolute range: ${JSON.stringify(absoluteRange)}`);
  const activeUrlState = await readUrlState(driver);
  assert.equal(activeUrlState.params.find(([key]) => key === 'var-host')?.[1], 'node-exporter:9100',
    `Grafana host variable did not resolve before capture: ${JSON.stringify(activeUrlState)}`);
  await assertRefreshState(driver, '5s', activeUrlState, 'before first Freehand action');

  phase = 'native-extension-menu';
  await openGrafanaAction(driver, 'Freehand with Simurgh');
  await waitFor(async () => driver.execute(`return Boolean(document.querySelector('[data-testid="simurgh-overlay-host"]')?.shadowRoot?.querySelector('section[data-testid="simurgh-inspector"]'))`),
    15_000, 'Freehand extension action did not open the inspector');
  await assertRefreshState(driver, null, activeUrlState, 'while first Freehand inspector is open');
  await clickInShadow(driver, '[aria-label="Close inspector"]');
  await assertRefreshState(driver, '5s', activeUrlState, 'after closing first Freehand inspector');
  await openGrafanaAction(driver, 'Freehand with Simurgh');
  await waitFor(async () => driver.execute(`return Boolean(document.querySelector('[data-testid="simurgh-overlay-host"]')?.shadowRoot?.querySelector('section[data-testid="simurgh-inspector"]'))`),
    15_000, 'Freehand inspector did not reopen after refresh restoration');
  await assertRefreshState(driver, null, activeUrlState, 'after reopening Freehand inspector');

  phase = 'resize-invalidation';
  const beforeResize = await driver.execute(`return {width:outerWidth,height:outerHeight}`);
  await clickInShadow(driver, '[data-testid="begin-freehand"]');
  await waitFor(async () => driver.execute(`return Boolean(document.querySelector('[data-testid="simurgh-overlay-host"]')?.shadowRoot?.querySelector('[data-testid="freehand-surface"]'))`),
    10_000, 'Freehand drawing did not activate for resize invalidation check');
  await driver.setWindowRect({ x: 0, y: 0, width: beforeResize.width + 100, height: beforeResize.height + 80 });
  await waitFor(async () => driver.execute(`const root=document.querySelector('[data-testid="simurgh-overlay-host"]')?.shadowRoot;
    return [...(root?.querySelectorAll('[role="alert"]')??[])].some(el=>/chart layout changed during the gesture/i.test(el.textContent??''))`),
  10_000, 'Resize during an active freehand gesture did not invalidate the renderer binding');
  await assertRefreshState(driver, '5s', activeUrlState, 'after terminal resize invalidation');
  await clickInShadow(driver, '[aria-label="Close inspector"]');
  await assertRefreshState(driver, '5s', activeUrlState, 'after closing invalidated inspector');
  await openGrafanaAction(driver, 'Freehand with Simurgh');
  await waitFor(async () => driver.execute(`return Boolean(document.querySelector('[data-testid="simurgh-overlay-host"]')?.shadowRoot?.querySelector('section[data-testid="simurgh-inspector"]'))`),
    15_000, 'Inspector could not reopen after resize invalidation');
  await assertRefreshState(driver, null, activeUrlState, 'after reopening refreshed Freehand inspector');

  phase = 'freehand-selection';
  await clickInShadow(driver, '[data-testid="begin-freehand"]');
  const surface = await waitFor(async () => driver.execute(`const root = document.querySelector('[data-testid="simurgh-overlay-host"]')?.shadowRoot;
    const canvas = root?.querySelector('[data-testid="freehand-surface"]');
    if (!canvas) return null; const r = canvas.getBoundingClientRect();
    return r.width > 100 && r.height > 80 ? { x:r.x,y:r.y,width:r.width,height:r.height } : null;`),
  10_000, 'Freehand canvas did not appear');
  const vertices = Array.from({ length: 40 }, (_unused, index) => {
    const angle = index / 39 * Math.PI * 2;
    return { x: surface.x + surface.width * (0.5 + 0.46 * Math.cos(angle)),
      y: surface.y + surface.height * (0.92 + 0.079 * Math.sin(angle)) };
  });
  await driver.drag(vertices);
  await waitFor(async () => driver.execute(`const root = document.querySelector('[data-testid="simurgh-overlay-host"]')?.shadowRoot;
    return Boolean(root?.querySelector('[data-testid^="series-option-"]')) ||
      Boolean([...root.querySelectorAll('[role=alert]')].find(el => !/checking the native chart samples/i.test(el.textContent ?? '')));`),
  20_000, 'Freehand gesture yielded neither candidates nor a visible rejection');
  const candidates = await driver.execute(`const root = document.querySelector('[data-testid="simurgh-overlay-host"]')?.shadowRoot;
    return [...(root?.querySelectorAll('[data-testid^="series-option-"]') ?? [])].map(el => ({
      testId: el.getAttribute('data-testid'), text: el.textContent?.trim(),
      radio: el.querySelector('input[type=radio]')?.value ?? ''
    }));`);
  assert.ok(candidates.length > 0, `Freehand gesture did not select any actual Grafana samples. ${await readStatus(driver)}`);
  await assertRefreshState(driver, null, activeUrlState, 'during candidate review');
  const selected = candidates[0];
  assert.ok(selected.radio, `Series candidate has no explicit radio input: ${JSON.stringify(selected)}`);
  await clickInShadow(driver, `[data-testid="${selected.testId}"] input[type="radio"]`);
  await clickInShadow(driver, '[data-testid="confirm-capture"]');
  await waitFor(async () => driver.execute(`return Boolean(document.querySelector('[data-testid="simurgh-overlay-host"]')?.shadowRoot?.querySelector('[data-testid="confirmed-bundle"]'))`),
    10_000, 'Explicit confirmation did not produce a confirmed capture bundle');
  const confirmedText = await driver.execute(`return document.querySelector('[data-testid="simurgh-overlay-host"]')?.shadowRoot?.querySelector('[data-testid="confirmed-bundle"]')?.textContent ?? '';`);
  const confirmed = JSON.parse(confirmedText);
  await assertRefreshState(driver, '5s', activeUrlState, 'after explicit target confirmation');
  assert.equal(confirmed.selectionMethod, 'grafana-freehand');
  assert.equal(confirmed.selected.id, selected.radio);
  assert.equal(confirmed.confirmation.range.from, confirmed.freehand.interval.from);
  assert.equal(confirmed.confirmation.range.to, confirmed.freehand.interval.to);
  assert.ok(confirmed.selected.points.length > 0, 'Confirmed capture contains no numeric points');
  assert.ok(confirmed.freehand.vertices.length >= 3, 'Confirmed capture did not retain its drawn geometry');
  assert.ok(confirmed.freehand.candidates.length > 0, 'Confirmed capture did not preserve candidates');
  const apiComparison = await comparePrometheusSamples(confirmed);

  const refresh = await waitFor(async () => driver.execute(`const el=[...document.querySelectorAll('button')].find(node => node.getAttribute('aria-label')==='Refresh');
    if(!el)return null; const r=el.getBoundingClientRect();return r.width>0&&r.height>0?{x:r.x,y:r.y,width:r.width,height:r.height}:null;`),
  10_000, 'Grafana refresh control unavailable after confirmation');
  await driver.clickAt(refresh.x + refresh.width / 2, refresh.y + refresh.height / 2);
  await new Promise(resolve => setTimeout(resolve, 3000));
  const afterRefreshText = await driver.execute(`return document.querySelector('[data-testid="simurgh-overlay-host"]')?.shadowRoot?.querySelector('[data-testid="confirmed-bundle"]')?.textContent ?? '';`);
  assert.deepEqual(JSON.parse(afterRefreshText), confirmed,
    'A real Grafana refresh changed the previously confirmed Firefox bundle');

  const beforeDownload = new Set(await readdir(downloadDir));
  await clickShadowText(driver, 'Download JSON');
  const download = await waitFor(async () => {
    const files = (await readdir(downloadDir)).filter(file => !beforeDownload.has(file) && !file.endsWith('.part'));
    return files.length ? files[0] : false;
  }, 10_000, 'Firefox did not download the confirmed JSON bundle');
  const downloadedBytes = await readFile(path.join(downloadDir, download));
  const downloaded = JSON.parse(downloadedBytes.toString('utf8'));
  assert.deepEqual(downloaded, confirmed, 'Firefox Download JSON output differs from the confirmed immutable snapshot');

  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, 'freehand-confirmed-capture-firefox.json'), JSON.stringify(confirmed, null, 2));
  await writeFile(path.join(artifactDir, 'confirmed-capture-export-firefox.json'), downloadedBytes);
  await writeFile(path.join(artifactDir, 'freehand-confirmed-firefox.png'), await driver.screenshot());
  const desktopSize = await driver.execute(`return {width:innerWidth,height:innerHeight}`);
  await driver.setWindowRect({ x: 0, y: 0, width: 390, height: 844 });
  const narrowSize = await driver.execute(`return {width:innerWidth,height:innerHeight}`);
  const narrowRect = await driver.execute(`const root=document.querySelector('[data-testid="simurgh-overlay-host"]')?.shadowRoot;
    const el=root?.querySelector('section[data-testid="simurgh-inspector"]');if(!el)return null;const r=el.getBoundingClientRect();
    return {x:r.x,y:r.y,width:r.width,height:r.height};`);
  assert.ok(narrowRect && narrowRect.x >= 0 && narrowRect.x + narrowRect.width <= narrowSize.width,
    `Firefox inspector overflows its actual narrow viewport ${JSON.stringify({ narrowSize, narrowRect })}`);
  await writeFile(path.join(artifactDir, 'freehand-narrow-firefox.png'), await driver.screenshot());
  const result = {
    result: 'PASS', browser: metadata, addonId: installedAddonId, dashboardUrl, absoluteRange,
    selectionMethod: confirmed.selectionMethod, candidateCount: confirmed.freehand.candidates.length,
    selectedId: confirmed.selected.id, selectedPoints: confirmed.selected.points.length,
    actualPrometheusApiMatch: apiComparison,
    wrongPortStayedInert: true,
    resizeDuringDrawingRejected: true,
    refreshedDatasource: true, immutableBundleAfterRefresh: true, downloadedJsonMatchesConfirmed: true,
    desktopViewport: desktopSize, actualNarrowViewport: narrowSize,
    narrowInspector: narrowRect,
    artifact: path.join(artifactDir, 'freehand-confirmed-capture-firefox.json'),
    downloadedArtifact: path.join(artifactDir, 'confirmed-capture-export-firefox.json'),
    screenshot: path.join(artifactDir, 'freehand-confirmed-firefox.png'),
  };
  await writeFile(path.join(artifactDir, 'freehand-firefox-result.json'), JSON.stringify(result, null, 2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  await saveFailure(error);
  throw error;
} finally {
  if (installedAddonId) await driver.command('/moz/addon/uninstall', 'POST', { id: installedAddonId }).catch(() => {});
  await driver.close();
  await geckodriver.stop();
  await new Promise(resolve => wrongOriginServer.close(resolve));
  await rm(profile, { recursive: true, force: true });
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await predicate(); if (value) return value; }
    catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

async function readUrlState(driver) {
  return driver.execute(`const url=new URL(location.href);
    return {pathname:url.pathname,refresh:url.searchParams.get('refresh'),params:[...url.searchParams]
      .filter(([key])=>key!=='refresh').sort(([ak,av],[bk,bv])=>ak.localeCompare(bk)||av.localeCompare(bv))};`);
}

async function setDashboardRefresh(driver, choice) {
  const before = await readUrlState(driver);
  const picker = await waitFor(async () => driver.execute(`const buttons=[...document.querySelectorAll('button')];
    const el=buttons.find(node=>/refresh (picker|time interval)/i.test([node.getAttribute('aria-label'),node.title].filter(Boolean).join(' ')));
    if(!el)return null;const r=el.getBoundingClientRect();return r.width>0&&r.height>0?{x:r.x,y:r.y,width:r.width,height:r.height}:null;`),
  10_000, 'Grafana refresh interval picker was not visible');
  await driver.clickAt(picker.x + picker.width / 2, picker.y + picker.height / 2);
  const option = await waitFor(async () => driver.execute(`const nodes=[...document.querySelectorAll('[role="menuitem"],[role="option"]')];
    const el=nodes.find(node=>node.textContent?.trim()===${JSON.stringify(choice)}) ??
      [...document.querySelectorAll('button')].filter(node=>node.textContent?.trim()===${JSON.stringify(choice)}).at(-1);
    if(!el)return null;const r=el.getBoundingClientRect();return r.width>0&&r.height>0?{x:r.x,y:r.y,width:r.width,height:r.height}:null;`),
  10_000, `Grafana refresh option '${choice}' did not appear`);
  await driver.clickAt(option.x + option.width / 2, option.y + option.height / 2);
  await waitFor(async () => {
    const after = await readUrlState(driver);
    return after.refresh === (choice === 'Off' ? null : choice);
  }, 10_000, `Grafana URL did not reflect refresh '${choice}'`);
  const after = await readUrlState(driver);
  assert.deepEqual({ pathname: after.pathname, params: after.params },
    { pathname: before.pathname, params: before.params }, 'Changing refresh altered other dashboard URL state');
}

async function assertRefreshState(driver, expected, baseline, label) {
  let actual;
  await waitFor(async () => {
    actual = await readUrlState(driver);
    return actual.refresh === expected;
  }, 10_000, `${label}: refresh query state did not become ${expected ?? 'Off'}`);
  assert.deepEqual({ pathname: actual.pathname, params: actual.params },
    { pathname: baseline.pathname, params: baseline.params },
    `${label}: Grafana changed dashboard range/timezone/variables while leasing refresh`);
}

async function clickInShadow(driver, selector) {
  const rect = await driver.execute(`const el = document.querySelector('[data-testid="simurgh-overlay-host"]')?.shadowRoot?.querySelector(${JSON.stringify(selector)});
    el?.scrollIntoView({block:'center',inline:'nearest'});
    if (!el) return null; const r = el.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height };`);
  assert.ok(rect && rect.width > 0 && rect.height > 0, `Extension control not found/visible: ${selector}`);
  await driver.clickAt(rect.x + rect.width / 2, rect.y + rect.height / 2);
}

async function clickShadowText(driver, text) {
  const rect = await driver.execute(`const root=document.querySelector('[data-testid="simurgh-overlay-host"]')?.shadowRoot;
    const el=[...(root?.querySelectorAll('button')??[])].find(node=>node.textContent?.trim()===${JSON.stringify(text)});
    el?.scrollIntoView({block:'center',inline:'nearest'});if(!el)return null;const r=el.getBoundingClientRect();
    return {x:r.x,y:r.y,width:r.width,height:r.height};`);
  assert.ok(rect?.width > 0 && rect.height > 0, `Extension button not found: ${text}`);
  await driver.clickAt(rect.x + rect.width / 2, rect.y + rect.height / 2);
}

async function openGrafanaAction(driver, actionName) {
  const panelHeading = await waitFor(async () => driver.execute(`const h = [...document.querySelectorAll('h1,h2,[role=heading]')].find(el => el.textContent?.includes(${JSON.stringify(panelTitle)}));
    if (!h) return null; const r=h.getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 };`),
  20_000, 'Panel heading not found for native Grafana menu');
  await driver.actions([{ type: 'pointerMove', x: Math.round(panelHeading.x), y: Math.round(panelHeading.y), origin: 'viewport' }]);
  const menuInfo = await waitFor(async () => driver.execute(`return [...document.querySelectorAll('button')].map(el => {
    const r=el.getBoundingClientRect(), label=[el.getAttribute('aria-label'),el.getAttribute('title'),el.textContent].filter(Boolean).join(' ');
    return { label:label.trim(), x:r.x,y:r.y,width:r.width,height:r.height };
  }).filter(b => b.width>0 && b.height>0 && /menu for panel|panel actions|more/i.test(b.label));`),
  10_000, 'Native Grafana panel menu button did not appear');
  assert.ok(menuInfo.length, 'Could not find the native Grafana panel menu button');
  const panelMenu = menuInfo.at(-1);
  await driver.clickAt(panelMenu.x + panelMenu.width / 2, panelMenu.y + panelMenu.height / 2);
  await new Promise(resolve => setTimeout(resolve, 400));
  const extensions = await menuItemRect(driver, 'Extensions');
  await driver.actions([{ type: 'pointerMove', x: Math.round(extensions.x + extensions.width / 2),
    y: Math.round(extensions.y + extensions.height / 2), origin: 'viewport' }]);
  await new Promise(resolve => setTimeout(resolve, 500));
  await clickGrafanaMenuItem(driver, actionName);
}

async function menuItemRect(driver, label) {
  return waitFor(async () => driver.execute(`const el = [...document.querySelectorAll('[role="menuitem"]')].find(node => node.textContent?.trim().startsWith(${JSON.stringify(label)}));
    if (!el) return null; const r=el.getBoundingClientRect(); return r.width>0 && r.height>0 ? {x:r.x,y:r.y,width:r.width,height:r.height}:null;`),
  10_000, `Native Grafana menu item '${label}' did not appear`);
}

async function clickGrafanaMenuItem(driver, label) {
  const item = await menuItemRect(driver, label);
  await driver.clickAt(item.x + item.width / 2, item.y + item.height / 2);
}

async function readStatus(driver) {
  return JSON.stringify(await driver.execute(`const root=document.querySelector('[data-testid="simurgh-overlay-host"]')?.shadowRoot;
    return {alerts:[...(root?.querySelectorAll('[role=alert]')??[])].map(el=>el.textContent),status:root?.querySelector('[data-testid="simurgh-status"]')?.textContent};`));
}

async function comparePrometheusSamples(bundle) {
  const executed = bundle.query?.find(query => query.refId === bundle.selected.refId)?.executedQueryString ?? '';
  const expression = executed.split('\n', 1)[0].replace(/^Expr:\s*/, '').trim();
  assert.ok(expression.startsWith('100 * (1 - sum by (cpu) (rate(node_cpu_seconds_total{'),
    `Unexpected built-in lab query provenance: ${expression}`);
  const first = bundle.selected.points[0];
  const last = bundle.selected.points.at(-1);
  const url = new URL('/api/datasources/proxy/uid/prometheus-local/api/v1/query_range', grafanaUrl);
  url.search = new URLSearchParams({
    query: expression,
    start: String(first.time / 1000),
    end: String(last.time / 1000),
    step: '15s',
  }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  assert.ok(response.ok, `Grafana Prometheus proxy returned HTTP ${response.status}`);
  const payload = await response.json();
  assert.equal(payload.status, 'success', `Prometheus query failed: ${JSON.stringify(payload).slice(0, 1000)}`);
  const metric = payload.data?.result?.find(item => item.metric?.cpu === String(bundle.selected.labels.cpu));
  assert.ok(metric, `Prometheus API did not return CPU ${bundle.selected.labels.cpu}`);
  const returned = new Map((metric.values ?? []).map(([time, value]) => [Math.round(Number(time) * 1000), Number(value)]));
  for (const point of bundle.selected.points) {
    assert.equal(returned.get(point.time), point.value,
      `Confirmed sample differs from Grafana's real Prometheus proxy at ${new Date(point.time).toISOString()}`);
  }
  return { endpoint: `${grafanaUrl}/api/datasources/proxy/uid/prometheus-local/api/v1/query_range`,
    matchedPoints: bundle.selected.points.length, cpu: String(bundle.selected.labels.cpu), queryRef: bundle.selected.refId };
}

async function saveFailure(error) {
  await mkdir(artifactDir, { recursive: true }).catch(() => {});
  const prefix = path.join(artifactDir, 'freehand-firefox-failure');
  const details = { result: 'FAIL', phase, browser: metadata, addonId: installedAddonId, dashboardUrl,
    error: { name: error?.name, message: error?.message, stack: error?.stack }, geckodriverOutput: geckodriver.output };
  if (driver.sessionId) {
    try { details.page = await driver.execute(`return {url:location.href,title:document.title,readyState:document.readyState,
      panelButtons:[...document.querySelectorAll('button')].map(el=>({label:el.getAttribute('aria-label'),title:el.title,text:el.textContent?.trim()})).filter(x=>x.label||x.title||x.text).slice(0,100),
      overlay:Boolean(document.querySelector('[data-testid="simurgh-overlay-host"]')),
      shadowText:document.querySelector('[data-testid="simurgh-overlay-host"]')?.shadowRoot?.innerText?.slice(0,6000)};`); }
    catch (inspectError) { details.inspectionError = inspectError.message; }
    try { await writeFile(`${prefix}.png`, await driver.screenshot()); }
    catch (screenshotError) { details.screenshotError = screenshotError.message; }
  }
  await writeFile(`${prefix}.json`, JSON.stringify(details, null, 2));
}
