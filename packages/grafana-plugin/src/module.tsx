import { AppPlugin, PluginExtensionPoints, type PluginExtensionEventHelpers, type PluginExtensionPanelContext } from '@grafana/data';

import { BRIDGE_CHANNEL, BRIDGE_VERSION, INTEGRATION_ID, type BridgeMessage } from '../../shared/src/index';
import { setStatusMessage, StatusDialog } from './status-dialog';
import { buildPanelCapture, type CaptureContext } from './capture';

const extensionLabel = 'Inspect with Simurgh';
let latestRequestSeq = 0;
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window || event.origin !== window.location.origin || !isEnvelope(event.data)) {
    return;
  }
  if (event.data.kind === 'hello') {
    postBridge({ ...event.data, kind: 'plugin-ready' });
  }
});

export const plugin = new AppPlugin().addLink({
  targets: PluginExtensionPoints.DashboardPanelMenu,
  title: extensionLabel,
  description: 'Inspect captured panel data and its absolute time range.',
  onClick: (_event, helpers) => {
    const requestSeq = ++latestRequestSeq;
    void captureAndSend(helpers.context as PluginExtensionPanelContext | undefined, helpers, requestSeq);
  },
});

async function captureAndSend(
  context: PluginExtensionPanelContext | undefined,
  helpers: PluginExtensionEventHelpers,
  requestSeq: number
) {
  try {
    if (!context) throw new Error('Grafana did not provide panel context for this action.');
    const sessionId = crypto.randomUUID();
    const capture = await buildPanelCapture(context as unknown as CaptureContext, window.location.origin, sessionId);
    if (requestSeq !== latestRequestSeq) return;
    const ready = await waitForExtension(sessionId, requestSeq);
    if (requestSeq !== latestRequestSeq) return;
    if (!ready) {
      setStatusMessage('Install and enable the matching Simurgh Chromium extension, then open this panel action again.');
      helpers.openModal({ title: 'Simurgh extension required', body: StatusDialog, width: 520 });
      return;
    }
    postBridge({ channel: BRIDGE_CHANNEL, version: BRIDGE_VERSION, integrationId: INTEGRATION_ID, kind: 'capture', sessionId, requestSeq, capture });
  } catch (error) {
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
    ['hello', 'plugin-ready', 'probe', 'ready', 'capture'].includes(String(message.kind));
}

export default plugin;
