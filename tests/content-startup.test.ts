import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';
import type { CaptureSnapshot } from '../packages/shared/src/index';

const origin = 'http://127.0.0.1:3300';
const helloSessionId = 'extension-hello-session';

type MessageHandler = (event: MessageEvent<unknown>) => void;

async function loadContentApp(onPost?: (message: Record<string, unknown>, send: (message: Record<string, unknown>, options?: { source?: unknown; origin?: string }) => void) => void) {
  const listeners = new Map<string, MessageHandler>();
  const posted: Array<Record<string, unknown>> = [];
  const state: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  const effects: Array<() => void | (() => void)> = [];
  let stateIndex = 0;
  let refIndex = 0;
  let rendered: { type: () => unknown } | undefined;

  vi.resetModules();
  vi.doMock('react', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react')>();
    return {
      ...actual,
      useState: (initial: unknown) => {
        const index = stateIndex++;
        if (!(index in state)) state[index] = initial;
        return [state[index], (value: unknown) => { state[index] = value; }];
      },
      useRef: (initial: unknown) => {
        const index = refIndex++;
        refs[index] ??= { current: initial };
        return refs[index];
      },
      useEffect: (effect: () => void | (() => void)) => { effects.push(effect); },
    };
  });
  vi.doMock('react-dom/client', () => ({
    createRoot: () => ({ render: (element: { type: () => unknown }) => { rendered = element; } }),
  }));

  const makeElement = () => ({
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
    textContent: '',
    append: vi.fn(),
    attachShadow: () => ({ append: vi.fn() }),
  });
  vi.stubGlobal('document', { createElement: makeElement, documentElement: { append: vi.fn() } });
  vi.stubGlobal('crypto', { randomUUID: () => helloSessionId });
  const send = (message: Record<string, unknown>, options: { source?: unknown; origin?: string } = {}) => {
    listeners.get('message')?.({
      data: message,
      source: options.source ?? fakeWindow,
      origin: options.origin ?? origin,
    } as MessageEvent<unknown>);
  };
  const fakeWindow = {
    location: { origin },
    postMessage: (message: Record<string, unknown>) => {
      posted.push(message);
      onPost?.(message, send);
    },
    addEventListener: (kind: string, listener: MessageHandler) => listeners.set(kind, listener),
    removeEventListener: (kind: string) => listeners.delete(kind),
    setTimeout,
    clearTimeout,
  };
  vi.stubGlobal('window', fakeWindow);

  await import('../packages/chromium-extension/src/content');
  assert.ok(rendered);
  const render = () => {
    stateIndex = 0;
    refIndex = 0;
    return rendered!.type();
  };
  render();
  const cleanups = effects.map((effect) => effect()).filter((cleanup): cleanup is () => void => typeof cleanup === 'function');

  return {
    state,
    posted,
    send,
    render,
    hasListener: () => listeners.has('message'),
    cleanup: () => cleanups.forEach((cleanup) => cleanup()),
  };
}

function bridgeMessage(kind: 'plugin-ready' | 'probe', sessionId: string, requestSeq: number) {
  return {
    channel: 'simurgh.context',
    version: 1,
    integrationId: 'simurgh-context-app',
    kind,
    sessionId,
    requestSeq,
  };
}

describe('content startup handshake', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('react');
    vi.doUnmock('react-dom/client');
    vi.unstubAllGlobals();
  });

  it('does not restore the unavailable banner after a validated probe proves the plugin is live', async () => {
    vi.useFakeTimers();
    const app = await loadContentApp();

    assert.equal(app.posted[0]?.kind, 'hello');
    vi.advanceTimersByTime(400);
    app.send(bridgeMessage('probe', 'panel-session', 1));
    assert.equal(app.posted.at(-1)?.kind, 'ready');

    vi.advanceTimersByTime(11000);
    assert.equal(app.state[5], '', 'a stale startup timeout must not show an unavailable banner');
    assert.equal(app.state[0], true);
    app.cleanup();
  });

  it('retries the same hello until a delayed plugin responds to a later attempt', async () => {
    vi.useFakeTimers();
    let helloCount = 0;
    const app = await loadContentApp((message, send) => {
      if (message.kind !== 'hello') return;
      helloCount += 1;
      if (helloCount === 2) {
        send(bridgeMessage('plugin-ready', String(message.sessionId), Number(message.requestSeq)));
      }
    });

    assert.equal(app.posted.length, 1);
    vi.advanceTimersByTime(500);
    assert.equal(helloCount, 2);
    assert.deepEqual(app.posted.slice(0, 2), [
      { ...app.posted[0] },
      { ...app.posted[0] },
    ]);
    assert.equal(app.state[0], true);
    assert.equal(app.state[5], '');
    vi.advanceTimersByTime(11000);
    assert.equal(helloCount, 2, 'a ready plugin must stop retrying');
    app.cleanup();
    assert.equal(vi.getTimerCount(), 0);
  });

  it('ignores readiness messages with the wrong source, origin, session, or version and eventually shows guidance', async () => {
    vi.useFakeTimers();
    const app = await loadContentApp();
    const valid = bridgeMessage('plugin-ready', helloSessionId, 0);
    app.send(valid, { source: {} });
    app.send(valid, { origin: 'http://127.0.0.1:3301' });
    app.send(bridgeMessage('plugin-ready', 'wrong-session', 0));
    app.send({ ...valid, version: 99 });
    assert.equal(app.state[0], false);

    vi.advanceTimersByTime(11000);
    assert.equal(app.state[5], 'Grafana app plugin did not respond. Enable the Simurgh app plugin for this Grafana origin, then reload.');
    const attempts = app.posted.filter((message) => message.kind === 'hello');
    assert.ok(attempts.length > 1 && attempts.length <= 20, 'retries must be bounded');
    assert.ok(attempts.every((message) => message.sessionId === helloSessionId && message.requestSeq === 0));
    app.cleanup();
    assert.equal(vi.getTimerCount(), 0);
    assert.equal(app.hasListener(), false);
  });

  it('recovers when plugin-ready arrives after the initial timeout', async () => {
    vi.useFakeTimers();
    const app = await loadContentApp();
    vi.advanceTimersByTime(11000);
    assert.equal(app.state[5], 'Grafana app plugin did not respond. Enable the Simurgh app plugin for this Grafana origin, then reload.');

    app.send(bridgeMessage('plugin-ready', helloSessionId, 0));
    assert.equal(app.state[5], '');
    app.cleanup();
  });

  it('registers the listener before hello and cleans up pending discovery on unmount', async () => {
    vi.useFakeTimers();
    let helloCount = 0;
    const app = await loadContentApp((message, send) => {
      if (message.kind === 'hello') {
        helloCount += 1;
        send(bridgeMessage('plugin-ready', String(message.sessionId), Number(message.requestSeq)));
      }
    });
    assert.equal(helloCount, 1);
    assert.equal(app.state[0], true, 'the hello response must be received by the already-installed listener');
    app.cleanup();
    assert.equal(vi.getTimerCount(), 0);

    const pending = await loadContentApp();
    assert.equal(pending.posted.length, 1);
    pending.cleanup();
    assert.equal(pending.hasListener(), false);
    assert.equal(vi.getTimerCount(), 0);
    vi.advanceTimersByTime(12000);
    assert.equal(pending.posted.length, 1, 'cleanup must stop pending retries');
    assert.equal(pending.state[5], '', 'cleanup must prevent a post-unmount timeout error');
    assert.equal(vi.getTimerCount(), 0);
  });

  it('releases the refresh lease when a bound freehand gesture is invalidated', async () => {
    const app = await loadContentApp();
    const capture: CaptureSnapshot = {
      schema: 'simurgh.capture', version: 1, integrationId: 'simurgh-context-app',
      sessionId: 'panel-session', captureId: 'capture-1', revision: 'rev-1',
      capturedAt: '2026-10-09T10:00:00.000Z', selectionMethod: 'grafana-native-range',
      panel: { grafanaOrigin: origin, grafanaOrgId: 1, dashboardUid: 'dashboard', dashboardTitle: 'Dashboard',
        panelId: 1, panelTitle: 'CPU', datasourceUid: 'prometheus', datasourceType: 'prometheus' },
      timezone: 'utc', range: { from: 1000, to: 3000 },
      resolution: { sampleSpacingMs: 1000, scrapeIntervalMs: null }, transformations: [], variables: [],
      query: [{ refId: 'A', expression: 'up', executedQueryString: 'up' }],
      series: [{ id: 'A:cpu:Value:cpu=0', refId: 'A', name: 'Value', labels: { cpu: '0' },
        points: [{ time: 1000, value: 0.4 }, { time: 2000, value: 0.6 }, { time: 3000, value: 0.8 }] }],
      limitations: [],
    };
    const binding = { id: 'binding-1', captureId: capture.captureId, grafanaVersion: '13.2.3', uPlotVersion: '1.6.32',
      plotRect: { left: 0, top: 0, width: 400, height: 200 } };
    app.send(bridgeMessage('probe', capture.sessionId, 1));
    app.send({ ...bridgeMessage('probe', capture.sessionId, 1), kind: 'capture', capture, freehandBinding: binding });

    const inspector = app.render() as { props: { onBindingInvalidated: () => void } };
    inspector.props.onBindingInvalidated();

    assert.deepEqual(app.posted.at(-1), {
      channel: 'simurgh.context', version: 1, integrationId: 'simurgh-context-app',
      kind: 'freehand-cancel', sessionId: capture.sessionId, requestSeq: 1,
      captureId: capture.captureId, bindingId: binding.id,
    });
    app.cleanup();
  });
});
