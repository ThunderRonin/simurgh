import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  `${grafanaUrl}/d/simurgh-cpu-lab/simurgh-local-cpu-lab?orgId=1`;
const artifactDir = path.resolve(process.env.SIMURGH_FIREFOX_ARTIFACTS ?? path.join(root, 'test-results/firefox'));

for (const candidate of [firefoxBinary, geckodriverPath, path.join(extensionDir, 'manifest.json')]) {
  await access(candidate).catch(() => { throw new Error(`Firefox probe input is missing: ${candidate}`); });
}

const manifest = JSON.parse(await readFile(path.join(extensionDir, 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3, 'Built Firefox extension is not Manifest V3');
assert.deepEqual(manifest.host_permissions, ['http://localhost/*', 'http://127.0.0.1/*'],
  'Firefox requires portless host patterns; keep origin restriction in include_globs and the bootstrap guard');
assert.deepEqual(manifest.content_scripts?.[0]?.matches, ['http://localhost/*', 'http://127.0.0.1/*']);
assert.deepEqual(manifest.content_scripts?.[0]?.include_globs, [
  'http://localhost:3300/*', 'http://127.0.0.1:3300/*',
], 'Firefox content script must include only the two configured Grafana origins');
assert.equal(manifest.browser_specific_settings?.gecko?.id, 'simurgh-context-inspector@simurgh.dev');
for (const file of manifest.content_scripts[0].js ?? []) {
  await access(path.join(extensionDir, file)).catch(() => { throw new Error(`Firefox content script is missing: ${file}`); });
}

const profile = await mkdtemp(path.join(os.tmpdir(), 'simurgh-firefox-probe-profile-'));
const port = await freePort();
const wrongPort = await freePort();
assert.notEqual(wrongPort, 3300);
const baseUrl = `http://127.0.0.1:${port}`;
const geckodriver = startGeckodriver(geckodriverPath, port);
const driver = new WebDriver(baseUrl);
const wrongOriginServer = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><title>Wrong-origin guard check</title><main>ordinary loopback page on another port</main>');
});
await new Promise((resolve, reject) => {
  wrongOriginServer.once('error', reject);
  wrongOriginServer.listen(wrongPort, '127.0.0.1', resolve);
});
let installedAddonId;
let pageLoaded = false;
let browserMeta;

try {
  await waitForGeckodriver(baseUrl, geckodriver.process);
  const capabilities = await driver.newFirefoxSession({ binary: firefoxBinary, profile });
  browserMeta = {
    browserName: capabilities.browserName,
    browserVersion: capabilities.browserVersion,
    geckodriverVersion: capabilities['moz:geckodriverVersion'],
  };
  assert.equal(capabilities.browserName, 'firefox');

  const installed = await driver.command('/moz/addon/install', 'POST', {
    path: extensionDir,
    temporary: true,
  });
  installedAddonId = typeof installed === 'string' ? installed : installed.id;
  assert.ok(installedAddonId, `Geckodriver did not report the temporary add-on id: ${JSON.stringify(installed)}`);

  await driver.navigate(`http://127.0.0.1:${wrongPort}/`);
  await waitFor(() => driver.execute('return document.readyState === "complete"'), 10_000,
    'Wrong-port loopback page did not load');
  await new Promise(resolve => setTimeout(resolve, 1000));
  const wrongOriginOverlay = await driver.execute(
    'return Boolean(document.querySelector("[data-testid=simurgh-overlay-host]"))',
  );
  assert.equal(wrongOriginOverlay, false,
    'Firefox content script ran on a non-Grafana port; exact-origin guard failed');

  await driver.navigate(dashboardUrl);
  await waitFor(async () => {
    const state = await driver.execute(`return {
      readyState: document.readyState,
      title: document.title,
      url: location.href,
      overlay: Boolean(document.querySelector('[data-testid="simurgh-overlay-host"]')),
      panel: [...document.querySelectorAll('h1,h2,[role="heading"]')].some(node => node.textContent?.includes('Lab host CPU utilization by core')),
      shadowStatus: document.querySelector('[data-testid="simurgh-overlay-host"]')?.shadowRoot?.querySelector('[data-testid="simurgh-status"]')?.innerText ?? '',
    };`);
    if (state?.overlay && state.readyState === 'complete') return state;
    return false;
  }, 35_000, 'Firefox did not load Grafana and inject the temporary Simurgh content script');
  pageLoaded = true;
  const probeResult = {
    result: 'PASS',
    browser: browserMeta,
    addonId: installedAddonId,
    dashboardUrl,
    wrongPort: `http://127.0.0.1:${wrongPort}`,
    assertion: 'Temporary Firefox MV3 add-on installed through geckodriver; wrong-port loopback page stayed inert; Grafana dashboard loaded and the content-script shadow host appeared.',
  };
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, 'install-probe.json'), JSON.stringify(probeResult, null, 2));
  await writeFile(path.join(artifactDir, 'install-probe.png'), await driver.screenshot());
  process.stdout.write(`${JSON.stringify(probeResult, null, 2)}\n`);
} catch (error) {
  await saveFailure(error);
  throw error;
} finally {
  if (installedAddonId) await driver.command('/moz/addon/uninstall', 'POST', { id: installedAddonId }).catch(() => {});
  await driver.close();
  await geckodriver.stop();
  await new Promise(resolve => wrongOriginServer.close(resolve));
  await rm(profile, { recursive: true, force: true });
  if (!pageLoaded) process.stderr.write(`Geckodriver output:\n${geckodriver.output}\n`);
}

async function waitFor(predicate, timeoutMs, failureMessage) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`${failureMessage}${lastError ? `: ${lastError.message}` : ''}`);
}

async function saveFailure(error) {
  await mkdir(artifactDir, { recursive: true }).catch(() => {});
  const prefix = path.join(artifactDir, 'install-probe-failure');
  const details = {
    result: 'FAIL',
    browser: browserMeta,
    addonId: installedAddonId,
    dashboardUrl,
    pageLoaded,
    error: { name: error?.name, message: error?.message, stack: error?.stack },
    geckodriverOutput: geckodriver.output,
  };
  if (driver.sessionId) {
    try {
      details.page = await driver.execute(`return {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        overlay: Boolean(document.querySelector('[data-testid="simurgh-overlay-host"]')),
        shadowStatus: document.querySelector('[data-testid="simurgh-overlay-host"]')?.shadowRoot?.querySelector('[data-testid="simurgh-status"]')?.innerText ?? '',
      };`);
    } catch (inspectionError) { details.pageInspectionError = inspectionError.message; }
    try { await writeFile(`${prefix}.png`, await driver.screenshot()); }
    catch (screenshotError) { details.screenshotError = screenshotError.message; }
  }
  await writeFile(`${prefix}.json`, JSON.stringify(details, null, 2));
}
