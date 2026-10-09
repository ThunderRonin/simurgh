import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../packages/workspace/dist');
const artifacts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../test-results/workspace');
const now = Date.now();
const user = { id: 'user-ada', name: 'Ada' };
const users = [user, { id: 'user-grace', name: 'Grace' }];
const limits = { wallMs: 120_000, queries: 8, bytes: 524_288, concurrency: 1 };
const evidence = {
  id: 'evidence-cpu-1', kind: 'metric', title: 'CPU utilization by core', origin: 'queried',
  capturedAt: new Date(now).toISOString(), scope: 'simurgh-lab-host / cpu=0',
  data: [{ time: now - 30_000, value: 0.31 }, { time: now - 15_000, value: 0.72 }],
  limitations: ['Fixture data for client interaction tests only.'],
};
const fixture = {
  auth: true,
  revoked: false,
  voice: false,
  speech: true,
  refs: [],
  investigations: [],
  created: 0,
  speechRequests: [],
  speechAborts: 0,
  transcriptionRequests: [],
  transcriptionAborts: 0,
  cancelRequests: 0,
  slowSpeech: false,
  slowTranscription: false,
  speechUnauthorized: false,
  transcriptionError: null,
};
let browser;
let server;
let baseUrl;
const consoleErrors = [];
const pageErrors = [];

await import('node:fs/promises').then(({ mkdir }) => mkdir(artifacts, { recursive: true }));
server = createServer((request, response) => void route(request, response));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
baseUrl = `http://127.0.0.1:${server.address().port}`;
browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(7_000);
  observe(page);
  await page.goto(baseUrl);
  await page.getByRole('heading', { name: 'Sign in' }).waitFor();
  await assertDarkAppearance(page, '.login-page', '.login-form', '.login-form input');
  await page.getByLabel('Access token').fill('fixture-token');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('heading', { name: 'References' }).waitFor();
  await assertDarkAppearance(page, '.workspace-shell', '.references-column', '.question-form textarea');
  assert.equal(await page.evaluate(() => localStorage.length), 0, 'session token must not be persisted in localStorage');
  assert.equal(await page.locator('#local-token').count(), 0, 'token input must leave the DOM after login');
  assert.match(await page.locator('.voice-section').innerText(), /Voice input unavailable for this workspace/);

  await importConfirmedCapture(page);
  const referenceCheckbox = page.getByRole('checkbox', { name: /Attach .*Lab host CPU utilization/ });
  await referenceCheckbox.check();
  await page.getByLabel('Question', { exact: true }).fill('What changed in CPU utilization?');
  await page.getByTestId('start-investigation').click();
  await page.getByTestId('investigation-result').waitFor();
  await page.getByRole('heading', { name: 'CPU utilization rose during the selected interval.' }).waitFor();
  await page.locator('.investigation-result .status-completed').waitFor();
  await assertTextContrast(page, '.usage-note');
  assert.match(await page.getByTestId('investigation-result').innerText(), /Fixture data for client interaction tests only/);
  assert.equal(await page.getByRole('button', { name: /CPU utilization by core/ }).count(), 1, 'finding citation should resolve to its evidence');
  await page.getByTestId('play-finding-audio').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="finding-audio"]')?.currentTime > 0.02);
  assert.match(await page.getByTestId('investigation-result').innerText(), /Audio is an excerpt/);
  assert.equal(fixture.speechRequests[0].body, '{}');
  assert.equal(fixture.speechRequests[0].contentType, 'application/json');
  await page.getByTestId('stop-finding-audio').click();
  assert.equal(await page.getByTestId('finding-audio').evaluate((audio) => audio.currentTime), 0);
  assert.equal(fixture.investigations[0].status, 'completed', 'stopping speech must not cancel the investigation');
  assert.equal(fixture.cancelRequests, 0, 'stopping speech called the investigation cancellation route');

  await page.request.post(`${baseUrl}/__fixture/slow-speech`);
  await page.getByTestId('play-finding-audio').click();
  await page.getByTestId('stop-finding-audio').waitFor({ state: 'visible' });
  await page.getByTestId('stop-finding-audio').click();
  await waitForFixture(() => fixture.speechAborts > 0, 'Stop playback did not abort pending speech generation');
  assert.equal(fixture.investigations[0].status, 'completed');
  assert.deepEqual(fixture.investigations[0].referenceIds, [fixture.refs[0].id]);
  await page.screenshot({ path: path.join(artifacts, 'workspace-desktop.png'), fullPage: true });
  await assertNoOverflow(page, 1440);

  await page.getByRole('button', { name: 'Review sharing' }).click();
  const shareDialog = page.getByRole('dialog', { name: 'Review sharing' });
  await shareDialog.getByText('What changed in CPU utilization?').waitFor();
  await assertDarkAppearance(page, '.dialog', '.share-preview', '.recipient-row');
  await assertTextContrast(page, '.dialog-intro', '.share-preview > span:not(.section-kicker)');
  await shareDialog.getByRole('checkbox', { name: /Grace/ }).check();
  await shareDialog.getByRole('button', { name: 'Save access' }).click();
  await page.getByText('Shared with Grace').waitFor();
  assert.deepEqual(fixture.investigations[0].grants, ['user-grace']);
  await page.getByRole('button', { name: 'Review sharing' }).click();
  await page.getByRole('button', { name: 'Revoke all' }).click();
  await page.getByRole('button', { name: 'Review sharing' }).waitFor();
  assert.deepEqual(fixture.investigations[0].grants, []);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export investigation' }).click();
  const download = await downloadPromise;
  const exportPath = path.join(artifacts, 'investigation-export.json');
  await download.saveAs(exportPath);
  const exported = JSON.parse(await readFile(exportPath, 'utf8'));
  assert.equal(exported.investigation.id, fixture.investigations[0].id);
  assert.equal(exported.investigation.references[0].snapshot.selected.name, 'CPU 0');

  await page.getByRole('button', { name: 'Refresh workspace' }).click();
  await page.getByRole('button', { name: 'Start investigation' }).waitFor();
  await page.getByLabel('Question', { exact: true }).fill('Should the investigation cancel cleanly?');
  await page.getByTestId('start-investigation').click();
  await page.getByRole('button', { name: 'Cancel investigation' }).waitFor();
  await page.getByRole('button', { name: 'Cancel investigation' }).click();
  await page.getByText('Cancelled', { exact: true }).first().waitFor();
  assert.equal(fixture.investigations[0].status, 'cancelled');

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.getByRole('navigation', { name: 'Workspace sections' }).getByRole('link').count(), 3);
  await page.screenshot({ path: path.join(artifacts, 'workspace-narrow.png'), fullPage: true });
  await assertNoOverflow(page, 390);

  await page.getByRole('button', { name: /Delete .*Lab host CPU utilization/ }).click();
  const deleteReferenceDialog = page.getByRole('dialog', { name: 'Delete reference?' });
  const deleteReferenceButton = deleteReferenceDialog.getByRole('button', { name: 'Delete' });
  await assertTextContrast(page, '.dialog-intro', '.dialog .button.danger');
  await deleteReferenceButton.hover();
  await assertTextContrast(page, '.dialog .button.danger');
  await deleteReferenceButton.click();
  await page.getByText('No references saved').waitFor();
  await assertTextContrast(page, '.references-column .empty-state strong');
  assert.equal(fixture.refs.length, 0);
  await page.getByRole('button', { name: 'Delete investigation' }).click();
  await page.getByRole('dialog', { name: 'Delete investigation?' }).getByRole('button', { name: 'Delete' }).click();
  await page.getByText('What changed in CPU utilization?', { exact: true }).click();
  await page.getByRole('button', { name: 'Delete investigation' }).click();
  await page.getByRole('dialog', { name: 'Delete investigation?' }).getByRole('button', { name: 'Delete' }).click();
  await page.getByText('No investigations saved').waitFor();
  await assertTextContrast(page, '.history-column .empty-state strong');
  assert.equal(fixture.investigations.length, 0);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('heading', { name: 'Sign in' }).waitFor();
  await context.close();

  await verifyVoiceFrozenSelection();
  await verifyTranscriptionCancellation();
  await verifyVoiceProviderError();
  await verifySpeechAuthorizationClearsData();
  await verifyAuthRevocationClearsData();
  const unexpectedConsoleErrors = consoleErrors.filter((message) => !message.includes('401 (Unauthorized)') && !message.includes('503 (Service Unavailable)'));
  assert.deepEqual(unexpectedConsoleErrors, [], `unexpected browser console errors: ${unexpectedConsoleErrors.join('\n')}`);
  assert.deepEqual(pageErrors, [], `uncaught browser errors: ${pageErrors.join('\n')}`);
  console.log(`Client workspace browser fixture passed. Screenshots and export: ${artifacts}`);
} catch (error) {
  await failureArtifacts(error);
  throw error;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}

async function importConfirmedCapture(page) {
  const capture = confirmedCapture();
  const file = path.join(artifacts, 'confirmed-capture.json');
  await (await import('node:fs/promises')).writeFile(file, `${JSON.stringify(capture, null, 2)}\n`);
  await page.getByLabel('Import a Simurgh JSON reference').setInputFiles(file);
  await page.getByTestId('import-preview').waitFor();
  const preview = page.getByTestId('import-preview');
  assert.match(await preview.innerText(), /CPU 0/);
  assert.match(await preview.innerText(), /cpu=0/);
  assert.match(await preview.innerText(), /User-supplied/);
  await preview.getByRole('button', { name: 'Add reference' }).click();
  await page.getByRole('checkbox', { name: /Attach .*Lab host CPU utilization/ }).waitFor();
  assert.equal(fixture.refs[0].snapshot.selected.id, 'A:cpu:Value:cpu=0');
}

async function verifyVoiceFrozenSelection() {
  resetFixture({ voice: true });
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(7_000);
  observe(page);
  await page.goto(baseUrl);
  await login(page);
  await importConfirmedCapture(page);
  const checkbox = page.getByRole('checkbox', { name: /Attach .*Lab host CPU utilization/ });
  await checkbox.check();
  await page.getByRole('button', { name: 'Record question' }).click();
  await page.getByRole('button', { name: 'Stop recording' }).waitFor();
  await page.waitForTimeout(600);
  await checkbox.uncheck();
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await page.getByTestId('transcript-review').waitFor({ timeout: 10_000 });
  assert.match(await page.getByTestId('transcript-review').innerText(), /Lab host CPU utilization/);
  assert.deepEqual(fixture.transcriptionReferenceIds, [fixture.refs[0].id]);
  assert.deepEqual(fixture.transcriptionRequests[0].referenceIds, [fixture.refs[0].id]);
  assert.match(fixture.transcriptionRequests[0].contentType, /^audio\//);
  assert.equal(fixture.investigations.length, 0, 'transcription must not automatically start an investigation');
  await page.getByRole('button', { name: 'Use this question' }).click();
  await page.getByTestId('question-reference-snapshot').waitFor();
  assert.match(await page.locator('.attached-references').innerText(), /Lab host CPU utilization/);
  await checkbox.check();
  const transcriptionCount = fixture.transcriptionRequests.length;
  await page.getByRole('button', { name: 'Record question' }).click();
  await page.getByRole('button', { name: 'Discard recording' }).waitFor();
  await page.getByTestId('discard-recording').click();
  assert.equal(fixture.transcriptionRequests.length, transcriptionCount, 'discarding a recording submitted audio');
  await context.close();
}

async function verifyTranscriptionCancellation() {
  resetFixture({ voice: true });
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(7_000);
  observe(page);
  await page.goto(baseUrl);
  await login(page);
  await importConfirmedCapture(page);
  const checkbox = page.getByRole('checkbox', { name: /Attach .*Lab host CPU utilization/ });
  await checkbox.check();
  await page.request.post(`${baseUrl}/__fixture/slow-transcription`);
  await page.getByRole('button', { name: 'Record question' }).click();
  await page.getByRole('button', { name: 'Stop recording' }).waitFor();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await page.getByTestId('cancel-transcription').waitFor();
  await page.getByTestId('cancel-transcription').click();
  await waitForFixture(() => fixture.transcriptionAborts > 0, 'Cancel transcription did not abort the pending request');
  assert.equal(await page.getByTestId('transcript-review').count(), 0);
  assert.equal(fixture.investigations.length, 0);
  await context.close();
}

async function verifyVoiceProviderError() {
  resetFixture({ voice: true });
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(7_000);
  observe(page);
  await page.goto(baseUrl);
  await login(page);
  await importConfirmedCapture(page);
  await page.getByRole('checkbox', { name: /Attach .*Lab host CPU utilization/ }).check();
  await page.request.post(`${baseUrl}/__fixture/transcription-error`);
  await page.getByRole('button', { name: 'Record question' }).click();
  await page.getByRole('button', { name: 'Stop recording' }).waitFor();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await page.getByRole('alert').filter({ hasText: 'Local transcription provider is unavailable.' }).waitFor();
  assert.equal(await page.getByTestId('transcript-review').count(), 0);
  await context.close();
}

async function verifySpeechAuthorizationClearsData() {
  resetFixture({ voice: false });
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(7_000);
  observe(page);
  await page.goto(baseUrl);
  await login(page);
  await importConfirmedCapture(page);
  await page.getByRole('checkbox', { name: /Attach .*Lab host CPU utilization/ }).check();
  await page.getByLabel('Question', { exact: true }).fill('Test response speech authorization.');
  await page.getByTestId('start-investigation').click();
  await page.locator('.investigation-result .status-completed').waitFor();
  await page.request.post(`${baseUrl}/__fixture/speech-unauthorized`);
  await page.getByTestId('play-finding-audio').click();
  await page.getByRole('heading', { name: 'Sign in' }).waitFor();
  assert.equal(await page.getByTestId('investigation-result').count(), 0);
  await context.close();
}

async function verifyAuthRevocationClearsData() {
  resetFixture({ voice: false });
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(7_000);
  observe(page);
  await page.goto(baseUrl);
  await login(page);
  await importConfirmedCapture(page);
  await page.request.post(`${baseUrl}/__fixture/revoke`);
  await page.getByRole('button', { name: 'Refresh workspace' }).click();
  await page.getByRole('heading', { name: 'Sign in' }).waitFor({ timeout: 10_000 });
  assert.equal(await page.getByText('Lab host CPU utilization').count(), 0);
  await context.close();
}

async function login(page) {
  await page.getByRole('heading', { name: 'Sign in' }).waitFor();
  await page.getByLabel('Access token').fill('fixture-token');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('heading', { name: 'References' }).waitFor();
}

async function assertNoOverflow(page, width) {
  const result = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.workspace-shell, .workspace-grid, .references-column, .investigation-column, .history-column, .dialog, .evidence-content, .question-form')];
    return {
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      offenders: nodes.filter((node) => node.getBoundingClientRect().right > window.innerWidth + 1 || node.scrollWidth > node.clientWidth + 2)
        .map((node) => ({ name: node.className, width: node.clientWidth, scrollWidth: node.scrollWidth, right: node.getBoundingClientRect().right })),
    };
  });
  assert.equal(result.viewport, width);
  assert.ok(result.document <= width + 1, `document overflow at ${width}px: ${JSON.stringify(result)}`);
  assert.deepEqual(result.offenders.filter((item) => item.scrollWidth > item.width + 2), [], `internal overflow: ${JSON.stringify(result)}`);
}

async function assertDarkAppearance(page, ...selectors) {
  const appearance = await page.evaluate((surfaceSelectors) => ({
    scheme: getComputedStyle(document.documentElement).colorScheme,
    page: getComputedStyle(document.body).backgroundColor,
    surfaces: surfaceSelectors.map((selector) => {
      const element = document.querySelector(selector);
      return { selector, background: element && getComputedStyle(element).backgroundColor };
    }),
  }), selectors);
  assert.equal(appearance.scheme, 'dark', `workspace color scheme should default to dark: ${JSON.stringify(appearance)}`);
  for (const surface of appearance.surfaces) {
    assert.ok(surface.background, `expected rendered dark surface ${surface.selector}`);
    const channels = surface.background.match(/\d+/g).slice(0, 3).map(Number);
    assert.ok(Math.max(...channels) < 120, `${surface.selector} should render as a dark surface: ${surface.background}`);
  }
}

async function assertTextContrast(page, ...selectors) {
  const results = await page.evaluate((textSelectors) => {
    const rgb = (value) => value.match(/[\d.]+/g).slice(0, 3).map(Number);
    const luminance = (value) => value.map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    }).reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
    return textSelectors.map((selector) => {
      const element = document.querySelector(selector);
      if (!element) return { selector, missing: true };
      const foreground = luminance(rgb(getComputedStyle(element).color));
      let ancestor = element;
      let background;
      while (ancestor && !background) {
        const value = getComputedStyle(ancestor).backgroundColor;
        const alpha = value.match(/[\d.]+/g);
        if (value !== 'rgba(0, 0, 0, 0)' && (!alpha || alpha.length < 4 || Number(alpha[3]) > 0)) background = luminance(rgb(value));
        ancestor = ancestor.parentElement;
      }
      const [lighter, darker] = [foreground, background].sort((a, b) => b - a);
      return { selector, ratio: (lighter + 0.05) / (darker + 0.05), text: getComputedStyle(element).color };
    });
  }, selectors);
  for (const result of results) {
    assert.ok(!result.missing, `expected text for contrast check: ${result.selector}`);
    assert.ok(result.ratio >= 4.5, `${result.selector} contrast was ${result.ratio.toFixed(2)}:1 (${result.text})`);
  }
}

function observe(page) {
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => pageErrors.push(error.message));
}

async function failureArtifacts(error) {
  try {
    const pages = browser?.contexts().flatMap((context) => context.pages()) ?? [];
    const page = [...pages].reverse().find((candidate) => !candidate.isClosed());
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true });
      const activeText = await page.locator('.voice-section').innerText().catch(() => '');
      await (await import('node:fs/promises')).writeFile(path.join(artifacts, 'failure-diagnostics.json'), JSON.stringify({
        error: error instanceof Error ? error.stack : String(error), url: page.url(), activeText, consoleErrors, pageErrors,
        fixture: { slowTranscription: fixture.slowTranscription, transcriptionRequests: fixture.transcriptionRequests, transcriptionAborts: fixture.transcriptionAborts },
      }, null, 2));
    }
  } catch { /* Preserve the original assertion failure. */ }
}

function resetFixture({ voice = false } = {}) {
  fixture.auth = true;
  fixture.revoked = false;
  fixture.voice = voice;
  fixture.refs = [];
  fixture.investigations = [];
  fixture.created = 0;
  fixture.transcriptionReferenceIds = null;
  fixture.speechRequests = [];
  fixture.speechAborts = 0;
  fixture.transcriptionRequests = [];
  fixture.transcriptionAborts = 0;
  fixture.cancelRequests = 0;
  fixture.slowSpeech = false;
  fixture.slowTranscription = false;
  fixture.speechUnauthorized = false;
  fixture.transcriptionError = null;
}

async function waitForFixture(predicate, message, timeoutMs = 7_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

function wavFixture() {
  const sampleRate = 16_000;
  const sampleCount = sampleRate;
  const data = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * index / sampleRate) * 5000), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function confirmedCapture() {
  const from = now - 60_000;
  const to = now;
  const selected = {
    id: 'A:cpu:Value:cpu=0', refId: 'A', name: 'CPU 0', labels: { cpu: '0' }, unit: 'percent',
    points: [{ time: from, value: 0.31 }, { time: from + 15_000, value: 0.48 }, { time: from + 30_000, value: 0.72 }, { time: to, value: 0.52 }],
  };
  return {
    schema: 'simurgh.capture', version: 1, integrationId: 'simurgh-context-app', sessionId: 'fixture-session',
    captureId: 'fixture-capture', revision: 'fixture-revision', capturedAt: new Date(now).toISOString(),
    selectionMethod: 'grafana-native-range',
    panel: { grafanaOrigin: 'http://localhost:3300', grafanaOrgId: 1, dashboardUid: 'simurgh-cpu-lab', dashboardTitle: 'Simurgh CPU lab', panelId: 1, panelTitle: 'Lab host CPU utilization', datasourceUid: 'prometheus-local', datasourceType: 'prometheus' },
    timezone: 'utc', range: { from, to }, resolution: { sampleSpacingMs: 15_000, scrapeIntervalMs: null },
    transformations: [], variables: [], query: [{ refId: 'A', expression: 'rate(node_cpu_seconds_total[1m])', executedQueryString: 'rate(node_cpu_seconds_total[1m])', datasourceUid: 'prometheus-local' }],
    series: [selected], limitations: ['Fixture snapshot for client interaction tests only.'],
    candidateCount: 1, confirmation: { seriesId: selected.id, range: { from, to }, confirmedAt: new Date(now).toISOString() }, selected,
  };
}

function recordFrom(body, status = 'queued') {
  const references = body.referenceIds.map((id) => fixture.refs.find((reference) => reference.id === id));
  return {
    id: `investigation-${++fixture.created}`, ownerId: user.id, question: body.question,
    referenceIds: [...body.referenceIds], references: structuredClone(references), createdAt: new Date(now + fixture.created).toISOString(),
    status, stopReason: null, limits, usage: { elapsedMs: 120, queries: 1, bytes: 240, inputTokens: null, outputTokens: null, modelUsageEnforcement: 'Fixture-only accounting; no agent executed.' },
    evidence: [], finding: null,
    grants: [], limitations: ['Client fixture: no agent, datasource, or backend was contacted.'],
  };
}

async function route(request, response) {
  const url = new URL(request.url, baseUrl ?? 'http://127.0.0.1');
  const method = request.method ?? 'GET';
  const pathname = url.pathname;
  if (pathname === '/__fixture/slow-speech' && method === 'POST') { fixture.slowSpeech = true; response.writeHead(204); return response.end(); }
  if (pathname === '/__fixture/slow-transcription' && method === 'POST') { fixture.slowTranscription = true; response.writeHead(204); return response.end(); }
  if (pathname === '/__fixture/transcription-error' && method === 'POST') { fixture.transcriptionError = 'unavailable'; response.writeHead(204); return response.end(); }
  if (pathname === '/__fixture/speech-unauthorized' && method === 'POST') { fixture.speechUnauthorized = true; response.writeHead(204); return response.end(); }
  if (pathname.startsWith('/api/')) {
    const authenticated = /(?:^|;\s*)simurgh_session=fixture(?:;|$)/.test(request.headers.cookie ?? '');
    if (fixture.revoked && pathname !== '/api/session') return json(response, 401, { error: { code: 'unauthorized', message: 'Session expired.' } });
    if (pathname === '/api/session' && method === 'GET') return authenticated ? json(response, 200, { user }) : json(response, 401, { error: { code: 'unauthorized', message: 'Sign in.' } });
    if (pathname === '/api/session' && method === 'POST') {
      const body = await readJson(request);
      if (body.token !== 'fixture-token') return json(response, 401, { error: { code: 'unauthorized', message: 'Invalid token.' } });
      response.setHeader('Set-Cookie', 'simurgh_session=fixture; HttpOnly; SameSite=Strict; Path=/');
      return json(response, 200, { user });
    }
    if (pathname === '/api/session' && method === 'DELETE') { response.writeHead(204); return response.end(); }
    if (!authenticated) return json(response, 401, { error: { code: 'unauthorized', message: 'Sign in.' } });
    if (pathname === '/api/config') return json(response, 200, { users, limits, capabilities: { agent: true, voice: fixture.voice, speech: fixture.speech }, limitations: ['Fixture server: no live backend connected.'] });
    if (pathname === '/api/references' && method === 'GET') return json(response, 200, { references: fixture.refs });
    if (pathname === '/api/references' && method === 'POST') {
      const body = await readJson(request);
      const reference = { id: `reference-${fixture.refs.length + 1}`, kind: 'telemetry', title: `${body.snapshot.panel.dashboardTitle} · ${body.snapshot.panel.panelTitle}`, createdAt: new Date(now).toISOString(), snapshot: body.snapshot, limitations: body.snapshot.limitations };
      fixture.refs.unshift(reference);
      return json(response, 201, { reference });
    }
    const referenceDelete = pathname.match(/^\/api\/references\/([^/]+)$/);
    if (referenceDelete && method === 'DELETE') { fixture.refs = fixture.refs.filter((item) => item.id !== decodeURIComponent(referenceDelete[1])); response.writeHead(204); return response.end(); }
    if (pathname === '/api/investigations' && method === 'GET') return json(response, 200, { investigations: fixture.investigations });
    if (pathname === '/api/investigations' && method === 'POST') {
      const body = await readJson(request);
      const investigation = recordFrom(body);
      fixture.investigations.unshift(investigation);
      if (fixture.created === 1) {
        setTimeout(() => {
          const current = fixture.investigations.find((item) => item.id === investigation.id);
          if (current?.status === 'queued') {
            current.status = 'completed';
            current.evidence = [structuredClone(evidence)];
            current.finding = { strength: 'supported', summary: 'CPU utilization rose during the selected interval.', citations: [evidence.id], limitations: ['Fixture data for client interaction tests only.'], nextCheck: 'Compare the next time window.' };
          }
        }, 160);
      }
      return json(response, 202, { investigation });
    }
    const eventRoute = pathname.match(/^\/api\/investigations\/([^/]+)\/events$/);
    if (eventRoute && method === 'GET') {
      const id = decodeURIComponent(eventRoute[1]);
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const initial = fixture.investigations.find((item) => item.id === id);
      if (initial) {
        const timer = setInterval(() => {
          const current = fixture.investigations.find((item) => item.id === id);
          if (!current) return;
          response.write(`event: investigation\ndata: ${JSON.stringify({ investigation: current })}\n\n`);
          if (!['queued', 'running'].includes(current.status)) clearInterval(timer);
        }, 80);
        request.on('close', () => clearInterval(timer));
      } else response.end();
      return;
    }
    const speechRoute = pathname.match(/^\/api\/investigations\/([^/]+)\/speech$/);
    if (speechRoute && method === 'POST') {
      const body = await readJson(request);
      fixture.speechRequests.push({ method, body: JSON.stringify(body), contentType: request.headers['content-type'] });
      if (fixture.speechUnauthorized) return json(response, 401, { error: { code: 'unauthorized', message: 'Session expired.' } });
      const id = decodeURIComponent(speechRoute[1]);
      if (!fixture.investigations.some((item) => item.id === id)) return json(response, 404, { error: { code: 'not_found', message: 'Not found.' } });
      if (fixture.slowSpeech) {
        fixture.slowSpeech = false;
        const timer = setTimeout(() => {
          if (!response.destroyed) {
            const audio = wavFixture();
            response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.length, 'X-Simurgh-Audio-Truncated': 'true' });
            response.end(audio);
          }
        }, 15_000);
        response.on('close', () => {
          clearTimeout(timer);
          if (!response.writableEnded) fixture.speechAborts += 1;
        });
        return;
      }
      const audio = wavFixture();
      response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.length, 'X-Simurgh-Audio-Truncated': 'true' });
      return response.end(audio);
    }
    const investigation = pathname.match(/^\/api\/investigations\/([^/]+)$/);
    if (investigation && method === 'GET') {
      const found = fixture.investigations.find((item) => item.id === decodeURIComponent(investigation[1]));
      return found ? json(response, 200, { investigation: found }) : json(response, 404, { error: { code: 'not_found', message: 'Not found.' } });
    }
    const cancel = pathname.match(/^\/api\/investigations\/([^/]+)\/cancel$/);
    if (cancel && method === 'POST') {
      fixture.cancelRequests += 1;
      const found = fixture.investigations.find((item) => item.id === decodeURIComponent(cancel[1]));
      if (!found) return json(response, 404, { error: { code: 'not_found', message: 'Not found.' } });
      found.status = 'cancelled';
      found.stopReason = 'Cancelled by the workspace user.';
      return json(response, 200, { investigation: found });
    }
    const grants = pathname.match(/^\/api\/investigations\/([^/]+)\/grants$/);
    if (grants && method === 'PUT') {
      const found = fixture.investigations.find((item) => item.id === decodeURIComponent(grants[1]));
      const body = await readJson(request);
      if (!found) return json(response, 404, { error: { code: 'not_found', message: 'Not found.' } });
      found.grants = body.userIds;
      return json(response, 200, { investigation: found });
    }
    const exportRoute = pathname.match(/^\/api\/investigations\/([^/]+)\/export$/);
    if (exportRoute && method === 'GET') {
      const found = fixture.investigations.find((item) => item.id === decodeURIComponent(exportRoute[1]));
      if (!found) return json(response, 404, { error: { code: 'not_found', message: 'Not found.' } });
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="simurgh-investigation.json"' });
      return response.end(JSON.stringify({ schema: 'simurgh.investigation', version: 1, investigation: found }));
    }
    if (investigation && method === 'DELETE') {
      fixture.investigations = fixture.investigations.filter((item) => item.id !== decodeURIComponent(investigation[1]));
      response.writeHead(204); return response.end();
    }
    if (pathname === '/api/transcriptions' && method === 'POST') {
      fixture.transcriptionReferenceIds = JSON.parse(String(request.headers['x-simurgh-reference-ids'] ?? '[]'));
      await readBody(request);
      fixture.transcriptionRequests.push({ referenceIds: [...fixture.transcriptionReferenceIds], contentType: request.headers['content-type'] ?? '' });
      if (fixture.transcriptionError) return json(response, 503, { error: { code: 'provider_unavailable', message: 'Local transcription provider is unavailable.' } });
      if (fixture.slowTranscription) {
        fixture.slowTranscription = false;
        const timer = setTimeout(() => {
          if (!response.destroyed) json(response, 200, { text: 'Why did CPU usage increase?', referenceIds: fixture.transcriptionReferenceIds });
        }, 15_000);
        response.on('close', () => {
          clearTimeout(timer);
          if (!response.writableEnded) fixture.transcriptionAborts += 1;
        });
        return;
      }
      return json(response, 200, { text: 'Why did CPU usage increase?', referenceIds: fixture.transcriptionReferenceIds });
    }
    return json(response, 404, { error: { code: 'not_found', message: 'Fixture route not found.' } });
  }
  if (pathname === '/__fixture/revoke' && method === 'POST') { fixture.revoked = true; response.writeHead(204); return response.end(); }
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(root, relative);
  if (!file.startsWith(`${root}${path.sep}`) && file !== path.join(root, 'index.html')) { response.writeHead(403); return response.end(); }
  try {
    await stat(file);
    const data = await readFile(file);
    const extension = path.extname(file);
    response.writeHead(200, { 'Content-Type': extension === '.js' ? 'text/javascript' : extension === '.css' ? 'text/css' : 'text/html' });
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readBody(request) {
  for await (const _chunk of request) { /* consume bounded fixture request */ }
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}
