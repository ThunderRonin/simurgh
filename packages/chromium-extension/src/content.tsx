import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BRIDGE_CHANNEL,
  BRIDGE_VERSION,
  confirmCapture,
  INTEGRATION_ID,
  isBridgeMessage,
  validateCapture,
  type BridgeMessage,
  type CaptureSnapshot,
  type ConfirmedCapture,
} from '../../shared/src/index';

const rootElement = document.createElement('div');
rootElement.dataset.testid = 'simurgh-overlay-host';
rootElement.style.position = 'fixed';
rootElement.style.inset = '0';
rootElement.style.zIndex = '2147483647';
rootElement.style.pointerEvents = 'none';
document.documentElement.append(rootElement);

const shadow = rootElement.attachShadow({ mode: 'open' });
const style = document.createElement('style');
style.textContent = getStyles();
shadow.append(style);
const mount = document.createElement('div');
mount.dataset.testid = 'simurgh-inspector';
shadow.append(mount);

const helloSessionId = crypto.randomUUID();
const root = createRoot(mount);

function post(kind: BridgeMessage['kind'], sessionId: string, requestSeq: number, capture?: CaptureSnapshot) {
  const message: BridgeMessage = {
    channel: BRIDGE_CHANNEL,
    version: BRIDGE_VERSION,
    integrationId: INTEGRATION_ID,
    kind,
    sessionId,
    requestSeq,
    ...(capture ? { capture } : {}),
  };
  window.postMessage(message, window.location.origin);
}

function isPageMessage(event: MessageEvent<unknown>, sessionId: string, requestSeq: number): event is MessageEvent<BridgeMessage> {
  return isBridgeMessage(event.data, {
    source: event.source === window ? 'window' : 'other-window',
    origin: event.origin,
    expectedOrigin: window.location.origin,
    sessionId,
    requestSeq,
  });
}

function ContentApp() {
  const [pluginPresent, setPluginPresent] = useState(false);
  const [capture, setCapture] = useState<CaptureSnapshot | null>(null);
  const [confirmedHistory, setConfirmedHistory] = useState<ConfirmedCapture[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let pluginSeen = false;
    let timeout = 0;
    let activeSessionId = '';
    let activeRequestSeq = -1;
    const onMessage = (event: MessageEvent<unknown>) => {
      const data = event.data as Partial<BridgeMessage> | null;
      if (!data || event.source !== window || event.origin !== window.location.origin) return;
      if (data.kind === 'plugin-ready' && isPageMessage(event, helloSessionId, 0)) {
        pluginSeen = true;
        window.clearTimeout(timeout);
        setPluginPresent(true);
        setError('');
        return;
      }
      if (data.kind === 'probe' && typeof data.sessionId === 'string' && Number.isSafeInteger(data.requestSeq) &&
        data.requestSeq! > activeRequestSeq && isPageMessage(event, data.sessionId, data.requestSeq!)) {
        activeRequestSeq = data.requestSeq!;
        activeSessionId = data.sessionId;
        setError('');
        post('ready', data.sessionId, activeRequestSeq);
        return;
      }
      if (data.kind === 'capture' && typeof data.sessionId === 'string' && data.sessionId === activeSessionId &&
        data.requestSeq === activeRequestSeq && isPageMessage(event, activeSessionId, activeRequestSeq)) {
        const validated = validateCapture(data.capture);
        if (!validated.ok) {
          setError(validated.reason);
          return;
        }
        setCapture(validated.value);
        setError('');
      }
    };
    window.addEventListener('message', onMessage);
    post('hello', helloSessionId, 0);
    timeout = window.setTimeout(() => {
      if (!pluginSeen) setError('Grafana app plugin unavailable on this origin.');
    }, 900);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
    };
  }, []);

  if (capture) {
    return <Inspector key={capture.captureId} capture={capture} error={error} confirmedHistory={confirmedHistory}
      onConfirmed={(item) => setConfirmedHistory((items) => [...items, item])} onClose={() => setCapture(null)} />;
  }
  if (error) {
    return <StatusBanner message={error} onDismiss={() => setError('')} />;
  }
  return null;
}

function StatusBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <aside className="status" role="status" data-testid="simurgh-status" style={{ pointerEvents: 'auto' }}>
      <strong>Simurgh</strong>
      <span>{message}</span>
      <button type="button" aria-label="Dismiss status" onClick={onDismiss}>×</button>
    </aside>
  );
}

function Inspector({ capture, error: bridgeError, confirmedHistory, onConfirmed, onClose }: {
  capture: CaptureSnapshot;
  error: string;
  confirmedHistory: ConfirmedCapture[];
  onConfirmed: (item: ConfirmedCapture) => void;
  onClose: () => void;
}) {
  const [seriesId, setSeriesId] = useState('');
  const [startText, setStartText] = useState(() => localDate(capture.range.from));
  const [endText, setEndText] = useState(() => localDate(capture.range.to));
  const [confirmed, setConfirmed] = useState<ConfirmedCapture | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setSeriesId('');
    setStartText(localDate(capture.range.from));
    setEndText(localDate(capture.range.to));
    setConfirmed(null);
    setError('');
  }, [capture.captureId]);

  const start = Date.parse(startText);
  const end = Date.parse(endText);
  const rangeIsValid = Number.isFinite(start) && Number.isFinite(end) && start < end && start >= capture.range.from && end <= capture.range.to;
  const updateStart = (value: string) => { setStartText(value); setConfirmed(null); };
  const updateEnd = (value: string) => { setEndText(value); setConfirmed(null); };
  const updateSeries = (value: string) => { setSeriesId(value); setConfirmed(null); };

  const onConfirm = () => {
    try {
      const result = confirmCapture(capture, seriesId, { from: start, to: end });
      setConfirmed(result);
      onConfirmed(result);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The selection could not be confirmed.');
    }
  };

  const onDownload = () => {
    if (!confirmed) return;
    const file = new Blob([JSON.stringify(confirmed, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(file);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${confirmed.captureId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="inspector" role="dialog" aria-modal="false" aria-labelledby="simurgh-title" data-testid="simurgh-inspector" style={{ pointerEvents: 'auto' }}>
      <header className="header">
        <div>
          <div className="eyebrow">GRAFANA CONTEXT</div>
          <h2 id="simurgh-title">{capture.panel.panelTitle}</h2>
          <p>{capture.panel.dashboardTitle} · panel {capture.panel.panelId}</p>
        </div>
        <button className="icon-button" aria-label="Close inspector" onClick={onClose}>×</button>
      </header>

      <span className="sr-only" data-testid="active-capture-id">{capture.captureId}</span>

      {confirmed ? (
        <div className="confirmed" data-testid="confirmed-view">
          {bridgeError && <p className="error" role="alert">{bridgeError}</p>}
          <div className="confirm-mark" aria-hidden="true">✓</div>
          <div>
            <strong>Target confirmed</strong>
            <p>{confirmed.selected.name} · {Object.entries(confirmed.selected.labels).map(([key, value]) => `${key}=${value}`).join(', ')}</p>
            <p>{new Date(confirmed.confirmation.range.from).toISOString()} – {new Date(confirmed.confirmation.range.to).toISOString()}</p>
          </div>
          <div className="button-row">
            <button className="button secondary" type="button" onClick={() => setConfirmed(null)}>Correct selection</button>
            <button className="button secondary" type="button" onClick={onDownload}>Download JSON</button>
          </div>
          <details className="json-inspect">
            <summary>Inspect confirmed bundle</summary>
            <pre data-testid="confirmed-bundle">{JSON.stringify(confirmed, null, 2)}</pre>
          </details>
        </div>
      ) : (
        <>
          {bridgeError && <p className="error" role="alert">{bridgeError}</p>}
          <div className="capture-meta">
            <div><span>Selected range</span><strong>{new Date(capture.range.from).toISOString()} – {new Date(capture.range.to).toISOString()}</strong></div>
            <div><span>Available candidates</span><strong>{capture.series.length}</strong></div>
            <div><span>Capture revision</span><strong className="mono">{capture.revision.slice(0, 16)}</strong></div>
          </div>

          <fieldset className="candidate-list">
            <legend>Choose a numeric series</legend>
            {capture.series.map((series) => (
              <label className={`candidate ${seriesId === series.id ? 'active' : ''}`} key={series.id} data-testid={`series-option-${series.id}`}>
                <input type="radio" name="series" value={series.id} checked={seriesId === series.id} onChange={() => updateSeries(series.id)} />
                <span className="candidate-main"><strong>{series.name}</strong><small>{Object.entries(series.labels).map(([key, value]) => `${key}=${value}`).join(', ') || 'No labels'}</small></span>
                <span className="sample-count">{series.points.length} pts</span>
              </label>
            ))}
          </fieldset>

          <div className="time-edit">
            <label>Start time (local)<input aria-label="Start time" type="datetime-local" step="0.001" value={startText} onChange={(event) => updateStart(event.target.value)} /></label>
            <label>End time (local)<input aria-label="End time" type="datetime-local" step="0.001" value={endText} onChange={(event) => updateEnd(event.target.value)} /></label>
          </div>
          <p className="note">Confirmed timestamps are stored as absolute UTC values. A selection does not imply finer resolution than the captured samples.</p>
          {error && <p className="error" role="alert">{error}</p>}
          <details className="query-inspect">
            <summary>Query provenance</summary>
            {capture.query.map((query, index) => <pre key={`${query.refId ?? 'query'}-${index}`}>{query.executedQueryString ?? query.expression ?? 'Query text unavailable'}</pre>)}
          </details>
          <footer className="footer">
            <button className="button secondary" type="button" onClick={onClose}>Cancel</button>
            <button className="button primary" type="button" data-testid="confirm-capture" disabled={!seriesId || !rangeIsValid} onClick={onConfirm}>Confirm target</button>
          </footer>
        </>
      )}
      {confirmedHistory.length > 0 && <details className="accepted-history">
        <summary>Previously confirmed bundles ({confirmedHistory.length})</summary>
        {confirmedHistory.map((item, index) => <pre key={`${item.captureId}-${index}`} data-testid={`accepted-bundle-${index}`}>
          {JSON.stringify(item, null, 2)}
        </pre>)}
      </details>}
    </section>
  );
}

function localDate(timestamp: number): string {
  const date = new Date(timestamp);
  return new Date(timestamp - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 23);
}

root.render(<ContentApp />);

function getStyles() {
  return `
:host { all: initial; }
* { box-sizing: border-box; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.inspector { position: fixed; right: 20px; top: 20px; width: min(460px, calc(100vw - 40px)); max-height: calc(100vh - 40px); overflow: auto; color: #e8f0ee; background: #14201f; border: 1px solid #39534e; border-radius: 8px; box-shadow: 0 18px 52px #07110fcc; font: 13px/1.45 Inter, ui-sans-serif, system-ui, sans-serif; }
.header { display: flex; justify-content: space-between; gap: 16px; padding: 18px 20px 14px; border-bottom: 1px solid #344542; }
.header h2 { font-size: 17px; line-height: 1.25; margin: 3px 0 4px; color: #f2f7f5; font-weight: 650; }
.header p { color: #afc2bd; margin: 0; font-size: 12px; }
.eyebrow { color: #7fc4a5; font-size: 10px; font-weight: 700; letter-spacing: .08em; }
.icon-button, .status button { border: 0; color: #c6d5d0; background: transparent; font-size: 23px; line-height: 1; padding: 0 3px; cursor: pointer; }
.capture-meta { display: grid; grid-template-columns: 1fr 105px; gap: 11px 18px; padding: 14px 20px; border-bottom: 1px solid #344542; }
.capture-meta div:first-child { grid-column: 1 / -1; }
.capture-meta span { display: block; color: #9eb3ad; font-size: 11px; margin-bottom: 3px; }
.capture-meta strong { display: block; color: #edf3f1; font-size: 12px; overflow-wrap: anywhere; font-weight: 550; }
.mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.candidate-list { border: 0; margin: 0; padding: 14px 20px 6px; }
.candidate-list legend { padding: 0; margin-bottom: 8px; color: #c1d2cc; font-size: 12px; font-weight: 650; }
.candidate { display: flex; align-items: center; gap: 10px; min-height: 52px; padding: 8px 10px; border: 1px solid #3b514b; border-radius: 5px; margin-bottom: 7px; cursor: pointer; }
.candidate.active { border-color: #64c092; background: #203b33; }
.candidate input { accent-color: #69cb9b; margin: 0; }
.candidate-main { flex: 1; min-width: 0; }
.candidate-main strong, .candidate-main small { display: block; overflow-wrap: anywhere; }
.candidate-main strong { font-weight: 600; color: #eff5f2; }
.candidate-main small { color: #adc1ba; font-size: 11px; }
.sample-count { color: #c1d2cc; font-size: 11px; white-space: nowrap; }
.time-edit { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 8px 20px; }
.time-edit label { display: grid; gap: 5px; color: #b6c9c3; font-size: 11px; }
.time-edit input { width: 100%; min-width: 0; padding: 8px; color: #edf3f1; background: #0d1716; border: 1px solid #49615a; border-radius: 4px; font: 12px ui-monospace, monospace; }
.note { color: #a8bbb5; font-size: 11px; margin: 5px 20px 12px; }
.query-inspect, .json-inspect { margin: 0 20px 14px; border-top: 1px solid #344542; padding-top: 10px; }
summary { color: #8bd4af; cursor: pointer; font-size: 12px; }
pre { overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 180px; padding: 10px; margin: 8px 0 0; background: #0c1514; border-radius: 4px; color: #d6e5df; font: 10px/1.45 ui-monospace, monospace; }
.footer, .button-row { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px 18px; }
.button { border-radius: 4px; padding: 8px 12px; border: 1px solid #526a62; font: 600 12px ui-sans-serif, system-ui, sans-serif; cursor: pointer; }
.button.primary { color: #0c1914; background: #8dd7ac; border-color: #8dd7ac; }
.button.secondary { color: #e0ebe6; background: #263834; }
.button:disabled { cursor: not-allowed; opacity: .48; }
.error { color: #ffb6a8; margin: 0 20px 8px; font-size: 12px; }
.confirmed { padding: 18px 20px 0; }
.confirmed strong { color: #eff8f2; }
.confirmed p { color: #c0d0ca; font-size: 11px; margin: 5px 0; overflow-wrap: anywhere; }
.confirm-mark { float: left; margin-right: 10px; width: 25px; height: 25px; border-radius: 50%; background: #2c6e50; color: #d8f6e4; display: grid; place-items: center; font-size: 14px; }
.confirmed .button-row { padding: 14px 0; flex-wrap: wrap; }
.json-inspect { margin: 0 0 16px; }
.accepted-history { margin: 0 20px 16px; border-top: 1px solid #344542; padding-top: 10px; }
.status { position: fixed; right: 20px; bottom: 20px; width: min(370px, calc(100vw - 40px)); display: flex; align-items: center; gap: 10px; padding: 12px 14px; color: #f3f0e6; background: #2c2920; border: 1px solid #a78c50; border-radius: 6px; box-shadow: 0 10px 32px #070b0bcc; font: 12px/1.4 Inter, ui-sans-serif, system-ui, sans-serif; }
.status strong { color: #f1d992; }
.status span { flex: 1; }
@media (max-width: 520px) { .inspector { right: 10px; top: 10px; width: calc(100vw - 20px); max-height: calc(100vh - 20px); } .time-edit { grid-template-columns: 1fr; } .status { right: 10px; bottom: 10px; width: calc(100vw - 20px); } }
`;
}
