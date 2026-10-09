import { createServer } from 'node:net';
import { spawn } from 'node:child_process';

export async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

export function startGeckodriver(executable, port) {
  const process = spawn(executable, ['--host', '127.0.0.1', '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const capture = chunk => { output = `${output}${chunk}`.slice(-16_000); };
  process.stdout.on('data', capture);
  process.stderr.on('data', capture);
  return {
    process,
    get output() { return output; },
    async stop() {
      if (process.exitCode !== null || process.signalCode !== null) return;
      process.kill('SIGTERM');
      await Promise.race([
        new Promise(resolve => process.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 3000)),
      ]);
      if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL');
    },
  };
}

export class WebDriver {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.sessionId = '';
  }

  async request(route, method = 'GET', body, timeout = 30_000) {
    const response = await fetch(`${this.baseUrl}${route}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json; charset=utf-8' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; }
    catch { throw new Error(`WebDriver ${method} ${route} returned non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`); }
    if (!response.ok || payload.value?.error) {
      throw new Error(`WebDriver ${method} ${route} failed HTTP ${response.status}: ${JSON.stringify(payload.value ?? payload).slice(0, 1200)}`);
    }
    return payload.value;
  }

  async newFirefoxSession({ binary, profile, headless = true, downloadDir }) {
    const prefs = downloadDir ? {
      'browser.download.dir': downloadDir,
      'browser.download.folderList': 2,
      'browser.download.useDownloadDir': true,
      'browser.helperApps.neverAsk.saveToDisk': 'application/json,application/octet-stream',
    } : undefined;
    const value = await this.request('/session', 'POST', {
      capabilities: {
        alwaysMatch: {
          browserName: 'firefox',
          pageLoadStrategy: 'normal',
          timeouts: { implicit: 0, pageLoad: 60_000, script: 10_000 },
          'moz:firefoxOptions': {
            binary,
            args: [...(headless ? ['--headless'] : []), '--profile', profile],
            ...(prefs ? { prefs } : {}),
          },
        },
      },
    }, 120_000);
    this.sessionId = value.sessionId;
    if (!this.sessionId) throw new Error(`Geckodriver did not return a session id: ${JSON.stringify(value)}`);
    return value.capabilities;
  }

  async command(route, method = 'GET', body, timeout) {
    if (!this.sessionId) throw new Error('WebDriver session is not active');
    return this.request(`/session/${encodeURIComponent(this.sessionId)}${route}`, method, body, timeout);
  }

  async navigate(url) {
    await this.command('/url', 'POST', { url }, 90_000);
  }

  async execute(script, args = []) {
    return this.command('/execute/sync', 'POST', { script, args });
  }

  async actions(actions) {
    return this.command('/actions', 'POST', { actions: [{
      type: 'pointer', id: 'simurgh-mouse', parameters: { pointerType: 'mouse' }, actions,
    }] });
  }

  async clickAt(x, y) {
    await this.actions([
      { type: 'pointerMove', x: Math.round(x), y: Math.round(y), origin: 'viewport' },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerUp', button: 0 },
    ]);
  }

  async drag(points) {
    if (!points.length) throw new Error('Cannot drag an empty pointer path');
    const actions = [
      { type: 'pointerMove', x: Math.round(points[0].x), y: Math.round(points[0].y), origin: 'viewport' },
      { type: 'pointerDown', button: 0 },
      ...points.slice(1).map(point => ({ type: 'pointerMove', x: Math.round(point.x), y: Math.round(point.y), origin: 'viewport' })),
      { type: 'pointerUp', button: 0 },
    ];
    await this.actions(actions);
  }

  async screenshot() {
    const value = await this.command('/screenshot');
    return Buffer.from(value, 'base64');
  }

  async setWindowRect(rect) {
    return this.command('/window/rect', 'POST', rect);
  }

  async close() {
    if (!this.sessionId) return;
    const id = this.sessionId;
    this.sessionId = '';
    await this.request(`/session/${encodeURIComponent(id)}`, 'DELETE').catch(() => {});
  }
}

export async function waitForGeckodriver(baseUrl, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Geckodriver exited before becoming ready (code=${child.exitCode}, signal=${child.signalCode})`);
    }
    try {
      const response = await fetch(`${baseUrl}/status`, { signal: AbortSignal.timeout(1000) });
      const status = await response.json();
      if (response.ok && status.value?.ready) return status.value;
      lastError = new Error(JSON.stringify(status));
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Geckodriver did not become ready: ${lastError?.message ?? 'timeout'}`);
}
