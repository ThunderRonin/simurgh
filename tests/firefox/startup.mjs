import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { freePort, startGeckodriver, waitForGeckodriver, WebDriver } from './webdriver.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const firefoxBinary = path.resolve(process.env.SIMURGH_FIREFOX_BIN ?? path.join(root, 'work/firefox-tools/firefox/firefox'));
const geckodriverPath = path.resolve(process.env.SIMURGH_GECKODRIVER ?? path.join(root, 'work/firefox-tools/geckodriver'));
const extensionDir = path.resolve(process.env.SIMURGH_FIREFOX_EXTENSION_PATH ?? path.join(root, 'packages/chromium-extension/dist-firefox'));
const grafanaUrl = (process.env.SIMURGH_GRAFANA_URL ?? 'http://127.0.0.1:3300').replace(/\/$/, '');
const dashboardUrl = process.env.SIMURGH_DASHBOARD_URL ??
  `${grafanaUrl}/d/simurgh-cpu-lab/simurgh-local-cpu-lab?from=now-15m&to=now&timezone=utc&var-host=node-exporter:9100&refresh=5s`;
const artifactDir = path.resolve(process.env.SIMURGH_FIREFOX_ARTIFACTS ?? path.join(root, 'test-results/firefox'));
const attempts = Number.parseInt(process.env.SIMURGH_FIREFOX_COLD_ATTEMPTS ?? '1', 10);
const moduleDelayMs = Number.parseInt(process.env.SIMURGH_FIREFOX_DELAY_MODULE_MS ?? '2500', 10);
if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3) throw new Error('SIMURGH_FIREFOX_COLD_ATTEMPTS must be between 1 and 3');
if (!Number.isInteger(moduleDelayMs) || moduleDelayMs < 1000 || moduleDelayMs > 10_000) {
  throw new Error('SIMURGH_FIREFOX_DELAY_MODULE_MS must be between 1000 and 10000');
}

for (const candidate of [firefoxBinary, geckodriverPath, path.join(extensionDir, 'manifest.json')]) {
  await access(candidate).catch(() => { throw new Error(`Firefox startup probe input is missing: ${candidate}`); });
}
const appSettings = await fetch(`${grafanaUrl}/api/plugins/simurgh-context-app/settings`, {
  signal: AbortSignal.timeout(10_000),
}).then(async response => {
  let body;
  try { body = await response.json(); } catch { body = {}; }
  return { status: response.status, id: body.id, enabled: body.enabled };
});
const proxyPort = await freePort();
const delayProxy = createGrafanaDelayProxy(proxyPort, grafanaUrl, moduleDelayMs);
await new Promise((resolve, reject) => {
  delayProxy.server.once('error', reject);
  delayProxy.server.listen(proxyPort, '127.0.0.1', resolve);
});

const trialResults = [];
for (let trial = 1; trial <= attempts; trial += 1) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'simurgh-firefox-cold-'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const geckodriver = startGeckodriver(geckodriverPath, port);
  const driver = new WebDriver(baseUrl);
  let addonId;
  await writeFile(path.join(profile, 'user.js'), [
    'user_pref("network.proxy.type", 1);',
    'user_pref("network.proxy.http", "127.0.0.1");',
    `user_pref("network.proxy.http_port", ${proxyPort});`,
    'user_pref("network.proxy.share_proxy_settings", true);',
    'user_pref("network.proxy.no_proxies_on", "");',
    'user_pref("network.proxy.allow_hijacking_localhost", true);',
  ].join('\n'));
  const trialResult = { trial, profileIsFresh: true };

  try {
    await waitForGeckodriver(baseUrl, geckodriver.process);
    const capabilities = await driver.newFirefoxSession({ binary: firefoxBinary, profile });
    trialResult.browser = {
      name: capabilities.browserName,
      version: capabilities.browserVersion,
      geckodriverVersion: capabilities['moz:geckodriverVersion'],
    };
    const installed = await driver.command('/moz/addon/install', 'POST', { path: extensionDir, temporary: true });
    addonId = typeof installed === 'string' ? installed : installed.id;
    trialResult.addonId = addonId;
    const proxyLogStart = delayProxy.log.length;
    await driver.navigate(dashboardUrl);
    await waitFor(async () => driver.execute(`return document.readyState==='complete' &&
      Boolean(document.querySelector('[data-testid="simurgh-overlay-host"]')?.shadowRoot)`),
    60_000, 'Grafana and the real content-script overlay did not finish loading');
    await driver.execute(`window.__simurghStartupHandshake=[];
      window.addEventListener('message', event => {
        const data=event.data;
        if (!data || data.channel!=='simurgh.context' || !['hello','plugin-ready'].includes(data.kind)) return;
        window.__simurghStartupHandshake.push({kind:data.kind,sessionId:data.sessionId,requestSeq:data.requestSeq,
          channel:data.channel,version:data.version,integrationId:data.integrationId,
          sourceIsWindow:event.source===window,origin:event.origin});
      });
      return true;`);

    const timeline = [];
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const state = await driver.execute(`return (() => {
        const root=document.querySelector('[data-testid="simurgh-overlay-host"]')?.shadowRoot;
        const status=root?.querySelector('[data-testid="simurgh-status"]');
        return {url:location.href,readyState:document.readyState,hasOverlay:Boolean(root),
          banner:status?.innerText ?? null,inspector:Boolean(root?.querySelector('section[data-testid="simurgh-inspector"]'))};
      })()`);
      timeline.push({ elapsedMs: Date.now() - (deadline - 3000), ...state });
      if (state.banner?.includes('Grafana app plugin unavailable on this origin.')) {
        trialResult.observedBanner = true;
        trialResult.bannerText = state.banner;
        trialResult.bannerElapsedMs = timeline.at(-1).elapsedMs;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    trialResult.timeline = timeline;
    trialResult.panelActionsOpened = false;
    trialResult.moduleRequest = await waitFor(() => Promise.resolve(delayProxy.log.slice(proxyLogStart).find(item => item.path.includes('/public/plugins/simurgh-context-app/module.js'))),
      10_000, 'Firefox did not request the Grafana app module through the controlled loopback proxy');
    await waitFor(() => Promise.resolve(trialResult.moduleRequest.upstreamStatus === 200 && trialResult.moduleRequest.forwardedAt),
      moduleDelayMs + 10_000, 'Grafana app module did not return HTTP 200 after the controlled delay');
    const postLoadRetryWindowMs = 1800;
    await new Promise(resolve => setTimeout(resolve, postLoadRetryWindowMs));
    const postLoadState = await driver.execute(`return (() => {
      const root=document.querySelector('[data-testid="simurgh-overlay-host"]')?.shadowRoot;
      return {banner:root?.querySelector('[data-testid="simurgh-status"]')?.innerText ?? null,
        messages:window.__simurghStartupHandshake ?? []};
    })()`);
    const hellos = postLoadState.messages.filter(message => message.kind === 'hello' && message.sourceIsWindow &&
      message.origin === new URL(dashboardUrl).origin && message.channel === 'simurgh.context' &&
      message.version === 1 && message.integrationId === 'simurgh-context-app' && message.requestSeq === 0);
    const ready = postLoadState.messages.find(message => message.kind === 'plugin-ready' && message.sourceIsWindow &&
      message.origin === new URL(dashboardUrl).origin && message.channel === 'simurgh.context' &&
      message.version === 1 && message.integrationId === 'simurgh-context-app' && message.requestSeq === 0 &&
      hellos.some(hello => hello.sessionId === message.sessionId));
    const afterModuleLoaded = postLoadState.banner;
    trialResult.postLoadRetryWindowMs = postLoadRetryWindowMs;
    trialResult.bannerAfterRealModuleLoad = afterModuleLoaded;
    trialResult.handshakeMessages = postLoadState.messages;
    trialResult.matchedPluginReady = ready ?? null;
    trialResult.proxyLog = delayProxy.log.slice(proxyLogStart);
    trialResult.regressionPassed = trialResult.moduleRequest.upstreamStatus === 200 && Boolean(ready) &&
      !afterModuleLoaded?.includes('Grafana app plugin unavailable on this origin.');
    if (!trialResult.regressionPassed) {
      trialResult.bannerPersistsAfterModuleLoad = afterModuleLoaded?.includes('Grafana app plugin unavailable on this origin.') ?? false;
      trialResult.screenshot = path.join(artifactDir, 'startup-banner-firefox.png');
      await mkdir(artifactDir, { recursive: true });
      await writeFile(trialResult.screenshot, await driver.screenshot());
    }
    trialResults.push(trialResult);
  } catch (error) {
    trialResult.error = { name: error?.name, message: error?.message, stack: error?.stack };
    trialResult.geckodriverOutput = geckodriver.output;
    if (driver.sessionId) {
      try {
        trialResult.page = await driver.execute(`return ({url:location.href,title:document.title,
          overlay:Boolean(document.querySelector('[data-testid="simurgh-overlay-host"]')),
          status:document.querySelector('[data-testid="simurgh-overlay-host"]')?.shadowRoot?.querySelector('[data-testid="simurgh-status"]')?.innerText ?? null})`);
      } catch (inspectError) { trialResult.inspectionError = inspectError.message; }
      await mkdir(artifactDir, { recursive: true }).catch(() => {});
      await writeFile(path.join(artifactDir, `startup-failure-trial-${trial}.png`), await driver.screenshot().catch(() => Buffer.alloc(0)));
    }
    trialResults.push(trialResult);
  } finally {
    if (addonId) await driver.command('/moz/addon/uninstall', 'POST', { id: addonId }).catch(() => {});
    await driver.close();
    await geckodriver.stop();
    await rm(profile, { recursive: true, force: true });
  }
}
await new Promise(resolve => delayProxy.server.close(resolve));

const result = {
  result: trialResults.length === attempts && trialResults.every(trial => trial.regressionPassed) ? 'PASS' : 'FAIL',
  dashboardUrl,
  appPluginSettings: appSettings,
  delayedRealModuleMs: moduleDelayMs,
  postLoadRetryWindowMs: 1800,
  requiredAssertions: ['module HTTP 200', 'real plugin-ready message matching an observed hello session and requestSeq 0', 'unavailable banner absent after module load plus retry window'],
  attemptedColdProfiles: trialResults.length,
  note: 'Each trial used a fresh Firefox profile and temporary-installed the actual built add-on. No Grafana panel actions or extension menu interactions were opened.',
  trials: trialResults,
};
await mkdir(artifactDir, { recursive: true });
await writeFile(path.join(artifactDir, 'startup-firefox-result.json'), JSON.stringify(result, null, 2));
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.result !== 'PASS') process.exitCode = 1;

async function waitFor(predicate, timeoutMs, failureMessage) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await predicate(); if (value) return value; }
    catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`${failureMessage}${lastError ? `: ${lastError.message}` : ''}`);
}

function createGrafanaDelayProxy(port, expectedOrigin, delayMs) {
  const log = [];
  const server = createServer((request, response) => {
    let target;
    try { target = new URL(request.url, `http://${request.headers.host}`); }
    catch { response.writeHead(400).end('Invalid proxy target'); return; }
    if (target.origin !== expectedOrigin) { response.writeHead(403).end('Proxy only forwards the configured Grafana origin'); return; }
    const isModule = target.pathname.endsWith('/public/plugins/simurgh-context-app/module.js');
    const record = isModule ? { path: `${target.pathname}${target.search}`, requestedAt: Date.now(), forwardedAt: null, upstreamStatus: null, delayMs } : null;
    if (record) log.push(record);
    const headers = { ...request.headers, host: target.host };
    delete headers['proxy-connection'];
    delete headers.connection;
    const upstream = httpRequest({ hostname: target.hostname, port: target.port || 80,
      method: request.method, path: `${target.pathname}${target.search}`, headers }, upstreamResponse => {
      const forward = () => {
        if (record) { record.upstreamStatus = upstreamResponse.statusCode; record.forwardedAt = Date.now(); }
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      };
      if (record) setTimeout(forward, delayMs);
      else forward();
    });
    upstream.on('error', error => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
      response.end(error.message);
    });
    request.pipe(upstream);
  });
  return { server, log, port };
}
