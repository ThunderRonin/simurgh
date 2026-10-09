import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

if (process.env.SIMURGH_VOICE_LIVE !== '1') {
  console.log('Skipped live voice browser proof; set SIMURGH_VOICE_LIVE=1 with SIMURGH_CONFIG and SIMURGH_VOICE_SAMPLE to run local Docker ASR/TTS.');
  process.exit(0);
}

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const coordinatorConfigPath = process.env.SIMURGH_CONFIG;
const samplePath = process.env.SIMURGH_VOICE_SAMPLE;
if (!coordinatorConfigPath || !samplePath) {
  throw new Error('Set SIMURGH_CONFIG to the private voice-enabled coordinator config and SIMURGH_VOICE_SAMPLE to the verified local WAV fixture.');
}
const configStat = await stat(coordinatorConfigPath);
assert.equal(configStat.mode & 0o077, 0, 'Coordinator configuration must be owner-only.');
if (process.getuid) assert.equal(configStat.uid, process.getuid(), 'Coordinator configuration must be owned by the current user.');
const coordinatorConfig = JSON.parse(await readFile(coordinatorConfigPath, 'utf8'));
const voiceSettings = coordinatorConfig.voice;
assert.ok(voiceSettings && typeof voiceSettings.image === 'string' && path.isAbsolute(voiceSettings.modelDirectory), 'Run optional local voice setup before this test.');
assert.ok(path.isAbsolute(samplePath), 'SIMURGH_VOICE_SAMPLE must be an absolute path.');
assert.equal((await stat(samplePath)).size, 352078, 'Voice sample has an unexpected size.');
const sampleBytes = await readFile(samplePath);
assert.equal(sampleBytes.length, 352078, 'Voice sample has an unexpected size.');
assert.equal(createHash('sha256').update(sampleBytes).digest('hex'), '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e', 'Voice sample checksum does not match the pinned fixture.');
const stateDirectory = await mkdtemp(path.join(tmpdir(), 'simurgh-voice-live-'));
await chmod(stateDirectory, 0o700);
const resultPath = path.join(stateDirectory, 'browser-session.json');
const bundlePath = path.join(project, 'packages/workspace/dist/.voice-live-server.mjs');
const workspaceDist = path.join(project, 'packages/workspace/dist');
let serverProcess;
let browser;
let context;

try {
  const inspect = spawnSync('docker', ['image', 'inspect', voiceSettings.image, '--format', '{{.Id}}'], { encoding: 'utf8' });
  assert.equal(inspect.status, 0, 'Local Simurgh voice image is not available. Run the approved local voice setup first.');
  const image = inspect.stdout.trim();
  assert.equal(image, voiceSettings.image, 'Configured local voice image ID is unavailable.');
  await build({
    entryPoints: [path.join(project, 'tests/workspace/voice-live-server.ts')],
    outfile: bundlePath,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });
  serverProcess = spawn(process.execPath, [bundlePath, stateDirectory, workspaceDist, image, voiceSettings.modelDirectory, resultPath], {
    cwd: project,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await waitForReady(serverProcess);
  const { url, token, viewerToken } = JSON.parse(await readFile(resultPath, 'utf8'));
  browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${samplePath}`,
    ],
  });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(25_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const createObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      if (blob.type.toLowerCase().includes('audio/wav')) window.__simurghSpeechBlob = blob;
      return createObjectURL(blob);
    };
  });
  await page.goto(url);
  await page.getByRole('heading', { name: 'Sign in' }).waitFor();
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('heading', { name: 'References' }).waitFor();
  assert.match(await page.locator('.scope-bar').innerText(), /Voice available/);
  assert.match(await page.locator('.scope-bar').innerText(), /Speech available/);

  const captureFile = path.join(stateDirectory, 'confirmed-capture.json');
  await (await import('node:fs/promises')).writeFile(captureFile, `${JSON.stringify(sourceSnapshot(), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await page.getByLabel('Import a Simurgh JSON reference').setInputFiles(captureFile);
  await page.getByTestId('import-preview').waitFor();
  const previewText = await page.getByTestId('import-preview').innerText();
  await page.getByTestId('import-preview').getByRole('button', { name: 'Add reference' }).click();
  const reference = page.getByRole('checkbox', { name: /Attach .*src\/voice-test\.ts/ });
  try {
    await reference.waitFor({ timeout: 8_000 });
  } catch {
    const pageText = await page.locator('.references-column').innerText().catch(() => '');
    throw new Error(`Live test reference import failed. Preview: ${previewText.slice(0, 500)}. References: ${pageText.slice(0, 500)}`);
  }
  await reference.check();

  await page.getByRole('button', { name: 'Record question' }).click();
  await page.getByRole('button', { name: 'Stop recording' }).waitFor();
  await page.waitForTimeout(800);
  await reference.uncheck();
  await page.waitForTimeout(12_000);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  const transcriptReview = page.getByTestId('transcript-review');
  await transcriptReview.waitFor({ timeout: 30_000 });
  const transcript = await transcriptReview.locator('textarea').inputValue();
  assert.ok(transcript.trim().length >= 20, 'Real local ASR returned no meaningful transcript.');
  assert.match(transcript.toLowerCase(), /ask not|country/, 'ASR transcript did not match the bundled JFK microphone sample.');
  assert.match(await transcriptReview.innerText(), /src\/voice-test\.ts/);
  await page.getByRole('button', { name: 'Use this question' }).click();
  await page.getByTestId('question-reference-snapshot').waitFor();
  assert.match(await page.locator('.attached-references').innerText(), /src\/voice-test\.ts/);

  const question = page.getByLabel('Question', { exact: true });
  await question.fill(transcript);
  const investigationResponsePromise = page.waitForResponse((response) => response.url().endsWith('/api/investigations') && response.request().method() === 'POST');
  await page.getByTestId('start-investigation').click();
  const investigationResponse = await investigationResponsePromise;
  assert.equal(investigationResponse.status(), 202);
  const investigationId = (await investigationResponse.json()).investigation.id;
  assert.equal(typeof investigationId, 'string');
  await page.locator('.investigation-result .status-completed').waitFor({ timeout: 20_000 });
  await page.getByRole('heading', { name: 'A local test finding for speech playback.' }).waitFor();
  const speechResponsePromise = page.waitForResponse((response) => response.url().endsWith('/speech'));
  await page.getByTestId('play-finding-audio').click();
  const speechResponse = await speechResponsePromise;
  await page.waitForFunction(() => document.querySelector('[data-testid="finding-audio"]')?.currentTime > 0.05, { timeout: 20_000 });
  assert.equal(speechResponse.status(), 200);
  assert.match(speechResponse.headers()['content-type'] ?? '', /^audio\/wav/i);
  const wav = await page.evaluate(async () => {
    const blob = window.__simurghSpeechBlob;
    if (!(blob instanceof Blob)) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return {
      size: bytes.length,
      riff: new TextDecoder().decode(bytes.subarray(0, 4)),
      wave: new TextDecoder().decode(bytes.subarray(8, 12)),
      nonSilent: bytes.subarray(44).some((sample) => sample !== 0),
    };
  });
  assert.ok(wav && wav.size >= 44, 'No actual WAV blob was received by the workspace.');
  assert.equal(wav.riff, 'RIFF');
  assert.equal(wav.wave, 'WAVE');
  assert.ok(wav.nonSilent, 'Local TTS returned silent PCM.');
  await page.getByTestId('stop-finding-audio').click();
  assert.equal(await page.getByTestId('finding-audio').evaluate((audio) => audio.currentTime), 0);
  assert.equal(await page.getByRole('button', { name: 'Cancel investigation' }).count(), 0, 'Stopping finding audio must not cancel investigation work.');

  const viewerContext = await browser.newContext({ viewport: { width: 980, height: 800 } });
  const viewer = await viewerContext.newPage();
  viewer.setDefaultTimeout(15_000);
  await viewer.addInitScript(() => {
    const createObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      if (blob.type.toLowerCase().includes('audio/wav')) window.__simurghSpeechBlob = blob;
      return createObjectURL(blob);
    };
  });
  await viewer.goto(url);
  await viewer.getByRole('heading', { name: 'Sign in' }).waitFor();
  await viewer.getByLabel('Access token').fill(viewerToken);
  await viewer.getByRole('button', { name: 'Continue' }).click();
  await viewer.getByRole('heading', { name: 'References' }).waitFor();
  const deniedBeforeGrant = await viewer.evaluate(async (id) => (await fetch(`/api/investigations/${encodeURIComponent(id)}`, { credentials: 'same-origin' })).status, investigationId);
  assert.equal(deniedBeforeGrant, 404, 'A viewer could read an investigation before a grant.');
  await page.getByRole('button', { name: 'Review sharing' }).click();
  const shareDialog = page.getByRole('dialog', { name: 'Review sharing' });
  await shareDialog.getByRole('checkbox', { name: /Local voice viewer/ }).check();
  await shareDialog.getByRole('button', { name: 'Save access' }).click();
  await shareDialog.waitFor({ state: 'detached' });
  await viewer.getByRole('button', { name: 'Refresh workspace' }).click();
  await viewer.getByRole('heading', { name: /And so my fellow American/ }).waitFor();
  await viewer.getByRole('button', { name: 'Play finding audio' }).click();
  await viewer.waitForFunction(() => document.querySelector('[data-testid="finding-audio"]')?.currentTime > 0.05, { timeout: 20_000 });
  assert.equal(await viewer.getByRole('heading', { name: 'A local test finding for speech playback.' }).count(), 1, 'Granted viewer could not read the finding.');
  await viewer.getByRole('button', { name: 'Stop playback' }).click();
  await page.getByRole('button', { name: 'Review sharing' }).click();
  await page.getByRole('button', { name: 'Revoke all' }).click();
  await viewer.getByRole('button', { name: 'Refresh workspace' }).click();
  await viewer.getByText('No investigations saved').waitFor();
  const deniedAfterRevoke = await viewer.evaluate(async (id) => (await fetch(`/api/investigations/${encodeURIComponent(id)}/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'same-origin' })).status, investigationId);
  assert.equal(deniedAfterRevoke, 404, 'Revoked viewer could still generate finding speech.');
  await viewerContext.close();
  assert.deepEqual(errors, [], `Uncaught workspace browser errors: ${errors.join('; ')}`);
  console.log('Real Chromium microphone sample -> local Whisper transcription -> finding review -> local espeak WAV playback passed. Investigation finding adapter was deterministic test-only; no live reasoning model was used.');
} finally {
  await context?.close();
  await browser?.close();
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
    await new Promise((resolve) => serverProcess.once('exit', resolve));
  }
  await rm(bundlePath, { force: true });
  await rm(stateDirectory, { recursive: true, force: true });
}

async function waitForReady(child) {
  await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('Voice test coordinator did not start')), 20_000);
    child.once('exit', (code) => reject(new Error(`Voice test coordinator exited before readiness (${code})`)));
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('READY\n')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

function sourceSnapshot() {
  const selectedText = 'export const voiceTest = true;';
  return {
    schema: 'simurgh.source', version: 1, captureId: 'd26bab81-00a8-4ad1-80dc-0df15e6d817f', capturedAt: new Date().toISOString(), editor: 'vscode',
    document: { uri: 'file:///workspace/src/voice-test.ts', languageId: 'typescript', version: 1, dirty: false, contentHash: createHash('sha256').update(selectedText).digest('hex') },
    workspace: { name: 'voice-test', rootUri: 'file:///workspace', relativePath: 'src/voice-test.ts', gitRevision: 'a'.repeat(40) },
    selection: { start: { line: 1, character: 0 }, end: { line: 1, character: selectedText.length }, text: selectedText },
    symbols: [], definitions: [], limitations: ['Synthetic test-only source; no filesystem read or runtime attribution.'],
  };
}
