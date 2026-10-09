import { AppPlugin, PluginExtensionPoints, type PluginExtensionEventHelpers, type PluginExtensionPanelContext } from '@grafana/data';
import { locationService } from '@grafana/runtime';

import { BRIDGE_CHANNEL, BRIDGE_VERSION, INTEGRATION_ID, type BridgeMessage, type CaptureSnapshot } from '../../shared/src/index';
import { setStatusMessage, StatusDialog } from './status-dialog';
import { buildPanelCapture, type CaptureContext } from './capture';
import { bindNativeUPlot, installNativeUPlotAdapter } from './native-uplot';
import { createRefreshLeaseManager, type RefreshLeaseToken } from './refresh-lease';

const extensionLabel = 'Inspect with Simurgh';
const freehandLabel = 'Freehand with Simurgh';
let latestRequestSeq = 0;
const pendingTimers = new Map<string, number>();
const refreshLeaseManager = createRefreshLeaseManager(locationService, { ttlMs: 5 * 60_000 });
let activeRefreshLease: { token: RefreshLeaseToken; requestSeq: number; sessionId: string; captureId?: string } | undefined;
const pendingFreehand = new Map<string, {
  capture: CaptureSnapshot;
  sessionId: string;
  requestSeq: number;
  resolve: ReturnType<typeof bindNativeUPlot>['resolve'];
  expiresAt: number;
}>();

installNativeUPlotAdapter();

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window || event.origin !== window.location.origin || !isEnvelope(event.data)) {
    return;
  }
  if (event.data.kind === 'hello') {
    postBridge({ ...event.data, kind: 'plugin-ready' });
    return;
  }
  if (event.data.kind === 'freehand-cancel') {
    if (typeof event.data.captureId !== 'string' || event.data.captureId.length === 0 ||
      event.data.bindingId !== undefined && (typeof event.data.bindingId !== 'string' || event.data.bindingId.length === 0)) return;
    for (const [id, pending] of pendingFreehand) {
      if (pending.sessionId === event.data.sessionId && pending.requestSeq === event.data.requestSeq &&
        (!event.data.captureId || pending.capture.captureId === event.data.captureId) &&
        (!event.data.bindingId || id === event.data.bindingId)) removePendingFreehand(id);
    }
    releaseRefreshLease(event.data.requestSeq, event.data.sessionId, event.data.captureId);
    return;
  }
  if (event.data.kind === 'freehand-complete') {
    if (typeof event.data.captureId !== 'string' || event.data.captureId.length === 0) return;
    releaseRefreshLease(event.data.requestSeq, event.data.sessionId, event.data.captureId);
    return;
  }
  if (event.data.kind === 'freehand-submit') {
    const pending = pendingFreehand.get(event.data.bindingId!);
    if (!pending || event.data.sessionId !== pending.sessionId || event.data.requestSeq !== pending.requestSeq ||
      event.data.captureId !== pending.capture.captureId || pending.expiresAt < Date.now() || !Array.isArray(event.data.vertices)) return;
    removePendingFreehand(event.data.bindingId!);
    try {
      const freehand = pending.resolve(event.data.vertices);
      const capture: CaptureSnapshot = {
        ...pending.capture,
        captureId: crypto.randomUUID(),
        revision: `${pending.capture.revision}:freehand:${crypto.randomUUID()}`,
        selectionMethod: 'grafana-freehand',
        freehand,
      };
      if (activeRefreshLease?.requestSeq === pending.requestSeq && activeRefreshLease.sessionId === pending.sessionId) {
        activeRefreshLease.captureId = capture.captureId;
        refreshLeaseManager.setCaptureId(activeRefreshLease.token, capture.captureId);
      }
      postBridge({ channel: BRIDGE_CHANNEL, version: BRIDGE_VERSION, integrationId: INTEGRATION_ID,
        kind: 'capture', sessionId: pending.sessionId, requestSeq: pending.requestSeq, capture });
    } catch (error) {
      releaseRefreshLease(pending.requestSeq, pending.sessionId);
      postBridge({ channel: BRIDGE_CHANNEL, version: BRIDGE_VERSION, integrationId: INTEGRATION_ID,
        kind: 'freehand-error', sessionId: pending.sessionId, requestSeq: pending.requestSeq,
        error: error instanceof Error ? error.message : 'The freehand selection could not be matched to the native chart.' });
    }
  }
});

export const plugin = new AppPlugin()
  .addLink({
    targets: PluginExtensionPoints.DashboardPanelMenu,
    title: extensionLabel,
    description: 'Inspect captured panel data and its absolute time range.',
    onClick: (_event, helpers) => {
      const requestSeq = beginRequest();
      void captureAndSend(helpers.context as PluginExtensionPanelContext | undefined, helpers, requestSeq, false);
    },
  })
  .addLink({
    targets: PluginExtensionPoints.DashboardPanelMenu,
    title: freehandLabel,
    description: 'Draw a freehand region over the native chart and inspect enclosed data samples.',
    onClick: (_event, helpers) => {
      const requestSeq = beginRequest();
      void captureAndSend(helpers.context as PluginExtensionPanelContext | undefined, helpers, requestSeq, true);
    },
  });

async function captureAndSend(
  context: PluginExtensionPanelContext | undefined,
  helpers: PluginExtensionEventHelpers,
  requestSeq: number,
  useFreehand: boolean,
) {
  let sessionId = '';
  try {
    sessionId = crypto.randomUUID();
    if (useFreehand) {
      const token = refreshLeaseManager.acquire(`${sessionId}:${requestSeq}`);
      activeRefreshLease = { token, requestSeq, sessionId };
    } else {
      releaseRefreshLease();
    }
    if (!context) throw new Error('Grafana did not provide panel context for this action.');
    const capture = await buildPanelCapture(context as unknown as CaptureContext, window.location.origin, sessionId);
    if (requestSeq !== latestRequestSeq) {
      releaseRefreshLease(requestSeq, sessionId);
      return;
    }
    const binding = useFreehand ? bindNativeUPlot(context as unknown as CaptureContext, capture) : undefined;
    if (useFreehand && !binding) {
      throw new Error('The current native chart could not be bound safely for freehand selection. Refresh has been restored; wait for the chart to settle and reopen Freehand.');
    }
    if (useFreehand && activeRefreshLease?.requestSeq === requestSeq && activeRefreshLease.sessionId === sessionId) {
      activeRefreshLease.captureId = capture.captureId;
      refreshLeaseManager.setCaptureId(activeRefreshLease.token, capture.captureId);
    }
    if (binding) {
      pendingFreehand.set(binding.descriptor.id, {
        capture,
        sessionId,
        requestSeq,
        resolve: binding.resolve,
        expiresAt: Date.now() + 5 * 60_000,
      });
      pendingTimers.set(binding.descriptor.id, window.setTimeout(() => {
        removePendingFreehand(binding.descriptor.id);
        releaseRefreshLease(requestSeq, sessionId);
      }, 5 * 60_000));
      while (pendingFreehand.size > 20) removePendingFreehand(pendingFreehand.keys().next().value!);
    }
    const ready = await waitForExtension(sessionId, requestSeq);
    if (requestSeq !== latestRequestSeq) {
      releaseRefreshLease(requestSeq, sessionId);
      return;
    }
    if (!ready) {
      for (const [id, item] of pendingFreehand) if (item.sessionId === sessionId && item.requestSeq === requestSeq) removePendingFreehand(id);
      releaseRefreshLease(requestSeq, sessionId);
      setStatusMessage('Install and enable the Simurgh browser extension, then open this panel action again.');
      helpers.openModal({ title: 'Simurgh extension required', body: StatusDialog, width: 520 });
      return;
    }
    postBridge({ channel: BRIDGE_CHANNEL, version: BRIDGE_VERSION, integrationId: INTEGRATION_ID, kind: 'capture', sessionId, requestSeq, capture,
      ...(binding ? { freehandBinding: binding.descriptor } : {}) });
  } catch (error) {
    releaseRefreshLease(requestSeq, sessionId || undefined);
    if (requestSeq !== latestRequestSeq) return;
    setStatusMessage(error instanceof Error ? error.message : 'The panel context could not be captured.');
    helpers.openModal({ title: 'Panel capture unavailable', body: StatusDialog, width: 560 });
  }
}

function waitForExtension(sessionId: string, requestSeq: number): Promise<boolean> {
  return new Promise((resolve) => {
    let complete = false;
    const finish = (ready: boolean) => {
      if (complete) return;
      complete = true;
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timeout);
      resolve(ready);
    };
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== window || event.origin !== window.location.origin || !isEnvelope(event.data) ||
        event.data.kind !== 'ready' || event.data.sessionId !== sessionId || event.data.requestSeq !== requestSeq) return;
      finish(true);
    };
    const timeout = window.setTimeout(() => finish(false), 700);
    window.addEventListener('message', onMessage);
    postBridge({ channel: BRIDGE_CHANNEL, version: BRIDGE_VERSION, integrationId: INTEGRATION_ID, kind: 'probe', sessionId, requestSeq });
  });
}

function postBridge(message: BridgeMessage) {
  window.postMessage(message, window.location.origin);
}

function isEnvelope(value: unknown): value is BridgeMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<BridgeMessage>;
  return message.channel === BRIDGE_CHANNEL && message.version === BRIDGE_VERSION &&
    message.integrationId === INTEGRATION_ID && typeof message.sessionId === 'string' &&
    Number.isSafeInteger(message.requestSeq) && Number(message.requestSeq) >= 0 &&
    ['hello', 'plugin-ready', 'probe', 'ready', 'capture', 'freehand-submit', 'freehand-error', 'freehand-cancel', 'freehand-complete'].includes(String(message.kind));
}

function beginRequest(): number {
  latestRequestSeq += 1;
  for (const id of pendingFreehand.keys()) removePendingFreehand(id);
  return latestRequestSeq;
}

function removePendingFreehand(id: string) {
  const timer = pendingTimers.get(id);
  if (timer !== undefined) window.clearTimeout(timer);
  pendingTimers.delete(id);
  pendingFreehand.delete(id);
}

function releaseRefreshLease(requestSeq?: number, sessionId?: string, captureId?: string) {
  if (!activeRefreshLease || (requestSeq !== undefined && activeRefreshLease.requestSeq !== requestSeq) ||
    (sessionId !== undefined && activeRefreshLease.sessionId !== sessionId) ||
    (captureId !== undefined && activeRefreshLease.captureId !== captureId)) return;
  refreshLeaseManager.release(activeRefreshLease.token, captureId);
  activeRefreshLease = undefined;
}

export default plugin;
