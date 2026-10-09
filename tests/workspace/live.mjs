import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const enabled = process.env.SIMURGH_WORKSPACE_LIVE === '1';
if (!enabled) throw new Error('Opt-in required: set SIMURGH_WORKSPACE_LIVE=1 to run the live workspace proof.');

const configPath = requiredPath('SIMURGH_CONFIG');
const capturePath = requiredPath('SIMURGH_CAPTURE_PATH');
const sourcePath = requiredPath('SIMURGH_SOURCE_PATH');
const [configStat, captureStat, sourceStat] = await Promise.all([
  stat(configPath), stat(capturePath), stat(sourcePath),
]);
assert.ok(configStat.isFile(), 'SIMURGH_CONFIG must be a file.');
assert.equal(configStat.mode & 0o077, 0, 'SIMURGH_CONFIG must be owner-only.');
if (process.getuid) assert.equal(configStat.uid, process.getuid(), 'SIMURGH_CONFIG must be owned by this user.');
assert.ok(captureStat.isFile(), 'SIMURGH_CAPTURE_PATH must be a file.');
assert.ok(sourceStat.isFile(), 'SIMURGH_SOURCE_PATH must be a file.');

const config = JSON.parse(await readFile(configPath, 'utf8'));
assert.ok(config.codex?.isolationQualified, 'SIMURGH_CONFIG must contain the qualified isolated Codex adapter settings.');
assert.ok(config.telemetry, 'SIMURGH_CONFIG must contain the live telemetry policy.');
const capture = JSON.parse(await readFile(capturePath, 'utf8'));
const source = JSON.parse(await readFile(sourcePath, 'utf8'));
assert.equal(capture.schema, 'simurgh.capture', 'SIMURGH_CAPTURE_PATH must contain a confirmed telemetry capture.');
assert.ok(capture.confirmation?.range?.from && capture.confirmation?.range?.to, 'Telemetry capture must have a confirmed time range.');
assert.equal(source.schema, 'simurgh.source', 'SIMURGH_SOURCE_PATH must contain a source snapshot.');
assert.ok(source.selection?.text?.trim(), 'Source snapshot must contain selected source text.');
assert.equal(
  createHash('sha256').update(source.selection.text).digest('hex'),
  source.document?.contentHash,
  'Source snapshot selected-text hash does not match its document hash.',
);

const workspaceDist = path.join(project, 'packages/workspace/dist');
for (const filename of ['index.html', 'workspace.js', 'workspace.css'])
  assert.ok((await stat(path.join(workspaceDist, filename))).isFile(), 'Build the workspace before running the live proof.');

const stateDirectory = await mkdtemp(path.join(tmpdir(), 'simurgh-workspace-live-'));
await chmod(stateDirectory, 0o700);
const serverBundle = path.join(workspaceDist, `.live-workspace-server-${process.pid}.mjs`);
const resultPath = path.join(stateDirectory, 'session.json');
const screenshotDirectory = path.join(project, 'test-results/workspace');
await mkdir(screenshotDirectory, { recursive: true });

let serverProcess;
let browser;
let context;
let viewerContext;
const hardTimeout = setTimeout(() => {
  void stopServer(serverProcess)
    .catch(() => {})
    .finally(() => browser?.close());
}, 180_000);

try {
  await build({
    entryPoints: [path.join(project, 'tests/workspace/live-server.ts')],
    outfile: serverBundle,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });
  serverProcess = spawn(process.execPath, [serverBundle, stateDirectory, workspaceDist, configPath, resultPath], {
    cwd: project,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await waitForReady(serverProcess);
  const session = JSON.parse(await readFile(resultPath, 'utf8'));
  const sessionStat = await stat(resultPath);
  assert.equal(sessionStat.mode & 0o077, 0, 'Temporary test token file must be owner-only.');
  const url = new URL(session.url);
  assert.equal(url.hostname, '127.0.0.1', 'Live workspace server must bind to loopback.');

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(session.url);
  await page.getByRole('heading', { name: 'Sign in' }).waitFor();
  await page.getByLabel('Access token').fill(session.token);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('heading', { name: 'References' }).waitFor();
  await assertDarkScheme(page);
  const initiallySaved = await ownerGet(page, '/api/references');
  assert.deepEqual(initiallySaved.references, [], 'Isolated live workspace must start without saved references.');
  await page.getByText('No references saved').waitFor();

  const importedCapture = await importReference(page, capturePath, 'simurgh.capture');
  const importedSource = await importReference(page, sourcePath, 'simurgh.source');
  const savedReferences = await ownerGet(page, '/api/references');
  assert.equal(savedReferences.references.length, 2, 'The live workspace must contain exactly the two supplied artifacts.');
  assert.deepEqual(
    new Set(savedReferences.references.map((reference) => reference.id)),
    new Set([importedCapture.id, importedSource.id]),
    'Only the two freshly imported references may be present.',
  );

  const captureCheckbox = page.getByRole('checkbox', { name: `Attach ${importedCapture.title}` });
  const sourceCheckbox = page.getByRole('checkbox', { name: `Attach ${importedSource.title}` });
  await captureCheckbox.check();
  await sourceCheckbox.check();
  assert.equal(await page.getByRole('checkbox', { name: /^Attach / }).count(), 2, 'Unexpected reference checkbox in isolated workspace.');

  const questionText = 'Compare CPU utilization in the selected interval with the preceding baseline. Read both metric windows and the selected source. Summarize the difference concisely, cite all three evidence items, and distinguish observation from cause.';
  await page.getByLabel('Question', { exact: true }).fill(questionText);
  const submissionPromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/investigations' && response.request().method() === 'POST',
  );
  await page.getByTestId('start-investigation').click();
  const submission = await submissionPromise;
  assert.equal(submission.status(), 202, 'Real investigation submission did not return 202.');
  const investigationId = (await submission.json()).investigation?.id;
  assert.match(investigationId ?? '', /^[0-9a-f-]{36}$/i, 'Investigation response did not include its new ID.');
  const sentReferenceIds = submission.request().postDataJSON().referenceIds;
  assert.deepEqual(new Set(sentReferenceIds), new Set([importedCapture.id, importedSource.id]), 'Submitted investigation did not use exactly the two fresh references.');

  const completed = await waitForInvestigation(page, investigationId, 130_000);
  verifyActualEvidence(completed, capture, source);
  const selectedHistory = page.locator('.history-item.active');
  await selectedHistory.waitFor();
  assert.equal(await selectedHistory.locator('.history-question').textContent(), questionText, 'Active history item did not match the submitted question.');
  await selectedHistory.locator('.status-completed').waitFor();
  await page.getByTestId('investigation-result').locator('.status-completed').waitFor();
  assert.equal((await page.getByTestId('investigation-result').innerText()).includes(completed.finding.summary), true, 'Workspace finding did not match the completed investigation.');
  await assertDarkScheme(page);
  await page.screenshot({ path: path.join(screenshotDirectory, 'live-desktop.png'), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await assertNoHorizontalOverflow(page, 390);
  await page.screenshot({ path: path.join(screenshotDirectory, 'live-narrow.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });

  viewerContext = await browser.newContext({ viewport: { width: 1100, height: 850 } });
  const viewer = await viewerContext.newPage();
  viewer.setDefaultTimeout(20_000);
  await viewer.goto(session.url);
  await viewer.getByRole('heading', { name: 'Sign in' }).waitFor();
  await viewer.getByLabel('Access token').fill(session.viewerToken);
  await viewer.getByRole('button', { name: 'Continue' }).click();
  await viewer.getByRole('heading', { name: 'References' }).waitFor();
  assert.equal(await viewer.evaluate(async (id) => (await fetch(`/api/investigations/${encodeURIComponent(id)}`, { credentials: 'same-origin' })).status, investigationId), 404, 'Viewer could access the investigation before sharing.');

  await page.getByRole('button', { name: 'Review sharing' }).click();
  const shareDialog = page.getByRole('dialog', { name: 'Review sharing' });
  await shareDialog.getByRole('checkbox', { name: /Live workspace viewer/ }).check();
  await shareDialog.getByRole('button', { name: 'Save access' }).click();
  await shareDialog.waitFor({ state: 'detached' });
  await viewer.getByRole('button', { name: 'Refresh workspace' }).click();
  await viewer.locator('.history-item').filter({ hasText: questionText }).waitFor();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export investigation' }).click();
  const download = await downloadPromise;
  const exportPath = path.join(stateDirectory, 'investigation-export.json');
  await download.saveAs(exportPath);
  const exported = JSON.parse(await readFile(exportPath, 'utf8'));
  assert.equal(exported.investigation.id, investigationId, 'Export did not contain the completed live investigation.');
  assert.deepEqual(new Set(exported.investigation.references.map((reference) => reference.id)), new Set([importedCapture.id, importedSource.id]));

  await page.getByRole('button', { name: 'Review sharing' }).click();
  const revokeDialog = page.getByRole('dialog', { name: 'Review sharing' });
  await revokeDialog.getByRole('button', { name: 'Revoke all' }).click();
  await revokeDialog.waitFor({ state: 'detached' });
  await viewer.getByRole('button', { name: 'Refresh workspace' }).click();
  await viewer.getByText('No investigations saved').waitFor();
  assert.equal(await viewer.evaluate(async (id) => (await fetch(`/api/investigations/${encodeURIComponent(id)}`, { credentials: 'same-origin' })).status, investigationId), 404, 'Viewer retained investigation access after revoke.');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('heading', { name: 'Sign in' }).waitFor();
  await viewer.getByRole('button', { name: 'Sign out' }).click();
  await viewer.getByRole('heading', { name: 'Sign in' }).waitFor();
  assert.deepEqual(pageErrors, [], `Unexpected uncaught browser errors: ${pageErrors.join('; ')}`);
  console.log('Live workspace proof passed: actual telemetry and source artifacts, isolated Codex investigation, API/UI completion, share/revoke/export/logout, and desktop/narrow screenshots.');
} finally {
  clearTimeout(hardTimeout);
  try {
    await stopServer(serverProcess);
  } finally {
    await viewerContext?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await rm(serverBundle, { force: true });
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

function requiredPath(name) {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be set to an absolute path.`);
  return value;
}

async function importReference(page, filePath, expectedSchema) {
  const responsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/references' && response.request().method() === 'POST',
  );
  await page.getByLabel('Import a Simurgh JSON reference').setInputFiles(filePath);
  const preview = page.getByTestId('import-preview');
  await preview.waitFor();
  assert.match(await preview.innerText(), expectedSchema === 'simurgh.capture' ? /CPU|Dashboard|Panel/i : /\.\w+|source|file/i, 'Imported artifact preview did not identify its content.');
  const addButton = preview.getByRole('button', { name: 'Add reference' });
  const responsePromiseAfterPreview = responsePromise;
  await addButton.click();
  const response = await responsePromiseAfterPreview;
  assert.equal(response.status(), 201, `${expectedSchema} import was not accepted.`);
  const reference = (await response.json()).reference;
  assert.ok(reference?.id && reference.kind && reference.title, `${expectedSchema} import response was incomplete.`);
  await page.getByRole('checkbox', { name: `Attach ${reference.title}` }).waitFor();
  return reference;
}

async function ownerGet(page, endpoint) {
  const response = await page.evaluate(async (pathName) => {
    const result = await fetch(pathName, { credentials: 'same-origin' });
    return { status: result.status, body: result.ok ? await result.json() : null };
  }, endpoint);
  assert.equal(response.status, 200, `Authenticated GET ${endpoint} failed.`);
  return response.body;
}

async function waitForInvestigation(page, id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let result;
  while (Date.now() < deadline) {
    const response = await page.evaluate(async (investigationId) => {
      const result = await fetch(`/api/investigations/${encodeURIComponent(investigationId)}`, { credentials: 'same-origin' });
      return { status: result.status, body: result.ok ? await result.json() : null };
    }, id);
    assert.equal(response.status, 200, 'Could not read the submitted investigation by its response ID.');
    result = response.body.investigation;
    if (result && !['queued', 'running'].includes(result.status)) break;
    await page.waitForTimeout(750);
  }
  assert.equal(result?.status, 'completed', `Investigation ${id} did not complete before the live proof deadline.`);
  return result;
}

function verifyActualEvidence(investigation, capture, source) {
  assert.ok(investigation.usage.inputTokens > 0 && investigation.usage.outputTokens > 0, 'Real Codex token usage was not reported.');
  const metrics = investigation.evidence.filter((item) => item.kind === 'metric' && item.origin === 'queried');
  const sourceEvidence = investigation.evidence.find((item) => item.kind === 'source' && item.origin === 'user-supplied');
  assert.ok(metrics.length >= 2, 'Expected selected and baseline queried metric evidence.');
  const range = capture.confirmation.range;
  const span = range.to - range.from;
  const metricScopes = new Set(metrics.map((item) => item.scope));
  assert.ok(metricScopes.has(`${range.from}..${range.to}`), 'Selected metric evidence did not preserve the captured interval.');
  assert.ok(metricScopes.has(`${range.from - span}..${range.from}`), 'Baseline metric evidence did not use the interval immediately before the capture.');
  assert.ok(metrics.every((item) => Array.isArray(item.data?.data?.result) && item.data.data.result.some((series) => Array.isArray(series.values) && series.values.length > 0)), 'Queried telemetry evidence contained no actual metric samples.');
  assert.ok(sourceEvidence, 'Investigation did not cite/read the imported source evidence.');
  assert.equal(sourceEvidence.data.document.contentHash, source.document.contentHash, 'Imported source content hash changed during investigation.');
  assert.equal(sourceEvidence.data.document.version, source.document.version, 'Source document version changed during investigation.');
  assert.equal(sourceEvidence.data.document.dirty, source.document.dirty, 'Source dirty state changed during investigation.');
  assert.equal(sourceEvidence.data.text, source.selection.text, 'Selected source text changed during investigation.');
  assert.equal(sourceEvidence.data.workspace?.gitRevision, source.workspace?.gitRevision, 'Source Git revision changed during investigation.');
  const evidenceIds = new Set(investigation.evidence.map((item) => item.id));
  assert.ok(investigation.finding?.citations?.includes(sourceEvidence.id), 'Finding did not cite source evidence.');
  assert.ok(metrics.every((item) => investigation.finding.citations.includes(item.id)), 'Finding did not cite every selected and baseline metric.');
  assert.ok(investigation.finding.citations.every((id) => evidenceIds.has(id)), 'Finding cited an evidence ID that was not returned.');
}

async function assertDarkScheme(page) {
  const scheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  assert.equal(scheme, 'dark', 'Actual workspace must render with the default dark scheme.');
}

async function assertNoHorizontalOverflow(page, width) {
  const result = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    offenders: [...document.querySelectorAll('.workspace-shell, .workspace-grid, .references-column, .investigation-column, .history-column, .investigation-result, .evidence-content')]
      .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1 || element.scrollWidth > element.clientWidth + 2)
      .map((element) => ({ selector: element.className, right: element.getBoundingClientRect().right, width: element.clientWidth, scrollWidth: element.scrollWidth })),
  }));
  assert.equal(result.viewport, width);
  assert.ok(result.document <= width + 1, `Live workspace overflowed at ${width}px: ${JSON.stringify(result)}`);
  assert.deepEqual(result.offenders.filter((item) => item.scrollWidth > item.width + 2), [], `Live workspace has internally overflowing content: ${JSON.stringify(result)}`);
}

async function waitForReady(child) {
  await new Promise((resolveReady, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Live workspace coordinator did not become ready.')), 20_000);
    const fail = (error) => { clearTimeout(timer); reject(error); };
    child.once('error', () => fail(new Error('Live workspace coordinator could not start.')));
    child.once('exit', (code) => fail(new Error(`Live workspace coordinator exited before readiness (${code}).`)));
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
      if (!output.includes('READY\n')) return;
      clearTimeout(timer);
      resolveReady();
    });
  });
}

async function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  let timer;
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveTimeout) => { timer = setTimeout(resolveTimeout, timeoutMs); }),
  ]);
  clearTimeout(timer);
  return child.exitCode !== null || child.signalCode !== null;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await waitForExit(child, 5_000)) return;
  child.kill('SIGKILL');
  if (!(await waitForExit(child, 5_000))) throw new Error('Live workspace coordinator did not exit after forced shutdown.');
}
