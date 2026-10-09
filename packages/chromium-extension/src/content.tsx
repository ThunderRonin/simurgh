import React, { useEffect, useRef, useState } from 'react';
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
  type FreehandPlotBinding,
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
const STARTUP_RETRY_MS = 500;
const STARTUP_MAX_HELLOS = 20;
const STARTUP_ERROR = 'Grafana app plugin did not respond. Enable the Simurgh app plugin for this Grafana origin, then reload.';

function post(kind: BridgeMessage['kind'], sessionId: string, requestSeq: number, capture?: CaptureSnapshot, details?: Pick<BridgeMessage, 'bindingId' | 'captureId'>) {
  const message: BridgeMessage = {
    channel: BRIDGE_CHANNEL,
    version: BRIDGE_VERSION,
    integrationId: INTEGRATION_ID,
    kind,
    sessionId,
    requestSeq,
    ...(capture ? { capture } : {}),
    ...(details ?? {}),
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
  const closedRequests = useRef<number[]>([]);
  const [pluginPresent, setPluginPresent] = useState(false);
  const [startupDismissed, setStartupDismissed] = useState(false);
  const [capture, setCapture] = useState<CaptureSnapshot | null>(null);
  const [freehandBinding, setFreehandBinding] = useState<FreehandPlotBinding | null>(null);
  const [confirmedHistory, setConfirmedHistory] = useState<ConfirmedCapture[]>([]);
  const [error, setError] = useState('');
  const [activeSessionId, setActiveSessionId] = useState('');
  const [activeRequestSeq, setActiveRequestSeq] = useState(-1);

  useEffect(() => {
    let pluginSeen = false;
    let startupTimer: number | undefined;
    let helloAttempts = 0;
    let activeSessionId = '';
    let activeRequestSeq = -1;
    const stopStartupTimer = () => {
      if (startupTimer !== undefined) {
        window.clearTimeout(startupTimer);
        startupTimer = undefined;
      }
    };
    const markPluginSeen = () => {
      if (pluginSeen) return;
      pluginSeen = true;
      stopStartupTimer();
      setPluginPresent(true);
      setError('');
    };
    const sendHello = () => {
      if (pluginSeen) return;
      if (helloAttempts >= STARTUP_MAX_HELLOS) {
        setError(STARTUP_ERROR);
        startupTimer = undefined;
        return;
      }
      helloAttempts += 1;
      post('hello', helloSessionId, 0);
      startupTimer = window.setTimeout(sendHello, STARTUP_RETRY_MS);
    };
    const onMessage = (event: MessageEvent<unknown>) => {
      const data = event.data as Partial<BridgeMessage> | null;
      if (!data || event.source !== window || event.origin !== window.location.origin) return;
      if (data.kind === 'plugin-ready' && isPageMessage(event, helloSessionId, 0)) {
        markPluginSeen();
        return;
      }
      if (data.kind === 'probe' && typeof data.sessionId === 'string' && Number.isSafeInteger(data.requestSeq) &&
        data.requestSeq! > activeRequestSeq && isPageMessage(event, data.sessionId, data.requestSeq!)) {
        markPluginSeen();
        activeRequestSeq = data.requestSeq!;
        activeSessionId = data.sessionId;
        setActiveSessionId(data.sessionId);
        setActiveRequestSeq(data.requestSeq!);
        setCapture(null);
        setFreehandBinding(null);
        setError('');
        post('ready', data.sessionId, activeRequestSeq);
        return;
      }
      if (data.kind === 'capture' && typeof data.sessionId === 'string' && data.sessionId === activeSessionId &&
        data.requestSeq === activeRequestSeq && !closedRequests.current.includes(activeRequestSeq) &&
        isPageMessage(event, activeSessionId, activeRequestSeq)) {
        const validated = validateCapture(data.capture);
        if (!validated.ok) {
          setError(validated.reason);
          return;
        }
        setCapture(validated.value);
        setFreehandBinding(data.freehandBinding ?? null);
        setError('');
        return;
      }
      if (data.kind === 'freehand-error' && data.sessionId === activeSessionId && data.requestSeq === activeRequestSeq &&
        !closedRequests.current.includes(activeRequestSeq) && isPageMessage(event, activeSessionId, activeRequestSeq)) {
        const message = typeof data.error === 'string' ? data.error : 'The freehand selection could not be matched to the native chart.';
        setFreehandBinding(null);
        setError(`${message} Close and reopen the inspector to bind the current chart.`);
      }
    };
    window.addEventListener('message', onMessage);
    sendHello();
    return () => {
      stopStartupTimer();
      window.removeEventListener('message', onMessage);
    };
  }, []);

  if (capture) {
    const closeInspector = () => {
      closedRequests.current = [...closedRequests.current.filter((seq) => seq !== activeRequestSeq), activeRequestSeq].slice(-20);
      post('freehand-cancel', activeSessionId, activeRequestSeq, undefined,
        { captureId: capture.captureId, ...(freehandBinding ? { bindingId: freehandBinding.id } : {}) });
      setCapture(null);
      setFreehandBinding(null);
    };
    return <Inspector key={capture.captureId} capture={capture} error={error} freehandBinding={freehandBinding}
      sessionId={activeSessionId} requestSeq={activeRequestSeq} confirmedHistory={confirmedHistory}
      onConfirmed={(item) => setConfirmedHistory((items) => [...items, item])}
      onBindingInvalidated={() => {
        if (freehandBinding) {
          post('freehand-cancel', activeSessionId, activeRequestSeq, undefined,
            { captureId: capture.captureId, bindingId: freehandBinding.id });
        }
        setFreehandBinding(null);
      }} onClose={closeInspector} />;
  }
  if (error) {
    return <StatusBanner message={error} onDismiss={() => { setError(''); setStartupDismissed(true); }} />;
  }
  if (!pluginPresent && !startupDismissed) {
    return <StatusBanner message="Connecting to the Grafana app plugin…" onDismiss={() => setStartupDismissed(true)} />;
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

function Inspector({ capture, error: bridgeError, freehandBinding, sessionId, requestSeq, confirmedHistory, onConfirmed, onBindingInvalidated, onClose }: {
  capture: CaptureSnapshot;
  error: string;
  freehandBinding: FreehandPlotBinding | null;
  sessionId: string;
  requestSeq: number;
  confirmedHistory: ConfirmedCapture[];
  onConfirmed: (item: ConfirmedCapture) => void;
  onBindingInvalidated: () => void;
  onClose: () => void;
}) {
  const [seriesId, setSeriesId] = useState('');
  const [startText, setStartText] = useState(() => localDate(capture.freehand?.interval.from ?? capture.range.from));
  const [endText, setEndText] = useState(() => localDate(capture.freehand?.interval.to ?? capture.range.to));
  const [confirmed, setConfirmed] = useState<ConfirmedCapture | null>(null);
  const [error, setError] = useState('');
  const [drawing, setDrawing] = useState(false);
  const [vertices, setVertices] = useState<Array<{ x: number; y: number }>>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    setSeriesId('');
    setStartText(localDate(capture.freehand?.interval.from ?? capture.range.from));
    setEndText(localDate(capture.freehand?.interval.to ?? capture.range.to));
    setConfirmed(null);
    setError('');
  }, [capture.captureId]);

  useEffect(() => {
    if (!drawing || !freehandBinding) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(freehandBinding.plotRect.width * ratio);
    canvas.height = Math.round(freehandBinding.plotRect.height * ratio);
    const context = canvas.getContext('2d');
    if (!context) return;
    context.scale(ratio, ratio);
    context.clearRect(0, 0, freehandBinding.plotRect.width, freehandBinding.plotRect.height);
    if (vertices.length > 0) {
      context.beginPath();
      context.moveTo(vertices[0].x, vertices[0].y);
      for (const point of vertices.slice(1)) context.lineTo(point.x, point.y);
      if (vertices.length >= 3) context.closePath();
      context.strokeStyle = '#fff2a6';
      context.lineWidth = 2;
      context.stroke();
      if (vertices.length >= 3) {
        context.fillStyle = 'rgba(255, 242, 166, 0.18)';
        context.fill();
      }
    }
  }, [drawing, freehandBinding, vertices]);

  useEffect(() => {
    if (!drawing) return;
    const cancelForLayoutChange = () => {
      setDrawing(false);
      setVertices([]);
      onBindingInvalidated();
      setError('The chart layout changed during the gesture. Close and reopen the inspector to bind the current chart.');
    };
    window.addEventListener('resize', cancelForLayoutChange);
    window.addEventListener('scroll', cancelForLayoutChange, true);
    return () => {
      window.removeEventListener('resize', cancelForLayoutChange);
      window.removeEventListener('scroll', cancelForLayoutChange, true);
    };
  }, [drawing, onBindingInvalidated]);

  useEffect(() => {
    if (!drawing) return;
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelDrawing();
    };
    window.addEventListener('keydown', cancelOnEscape);
    return () => window.removeEventListener('keydown', cancelOnEscape);
  }, [drawing]);

  const start = Date.parse(startText);
  const end = Date.parse(endText);
  const rangeIsValid = Number.isFinite(start) && Number.isFinite(end) && start < end && start >= capture.range.from && end <= capture.range.to;
  const updateStart = (value: string) => { setStartText(value); setConfirmed(null); };
  const updateEnd = (value: string) => { setEndText(value); setConfirmed(null); };
  const updateSeries = (value: string) => { setSeriesId(value); setConfirmed(null); };
  const beginDrawing = () => {
    setError('');
    setVertices([]);
    setDrawing(true);
  };
  const addVertex = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing || !freehandBinding || event.buttons !== 1) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    setVertices((current) => {
      const previous = current[current.length - 1];
      if (previous && Math.hypot(previous.x - point.x, previous.y - point.y) < 2.5) return current;
      if (current.length >= 256) {
        setDrawing(false);
        setError('This freehand path exceeded the supported 256-point limit. Draw a simpler shape.');
        return [];
      }
      return [...current, point];
    });
  };
  const finishDrawing = () => {
    if (!drawing || !freehandBinding) return;
    setDrawing(false);
    if (vertices.length < 3) {
      setError('Draw a closed freehand shape around at least one chart sample.');
      return;
    }
    window.postMessage({ channel: BRIDGE_CHANNEL, version: BRIDGE_VERSION, integrationId: INTEGRATION_ID,
      kind: 'freehand-submit', sessionId, requestSeq, captureId: capture.captureId,
      bindingId: freehandBinding.id, vertices }, window.location.origin);
    setError('Checking the native chart samples...');
  };
  const cancelDrawing = () => {
    setDrawing(false);
    setVertices([]);
    if (freehandBinding) {
      post('freehand-cancel', sessionId, requestSeq, undefined,
        { captureId: capture.captureId, bindingId: freehandBinding.id });
      onBindingInvalidated();
      setError('Freehand canceled. Refresh has been restored; close and reopen the inspector to draw again.');
    } else {
      setError('Freehand selection canceled.');
    }
  };

  const onConfirm = () => {
    try {
      const result = confirmCapture(capture, seriesId, { from: start, to: end });
      setConfirmed(result);
      onConfirmed(result);
      if (capture.selectionMethod === 'grafana-freehand') {
        post('freehand-complete', sessionId, requestSeq, undefined, { captureId: capture.captureId });
      }
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

  const visibleSeries = capture.freehand
    ? capture.series.filter((series) => capture.freehand!.candidates.some((candidate) => candidate.seriesId === series.id))
    : capture.series;

  return (
    <>
    <section className="inspector" hidden={drawing} role="dialog" aria-modal="false" aria-labelledby="simurgh-title" data-testid="simurgh-inspector" style={{ pointerEvents: 'auto' }}>
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
            {visibleSeries.map((series) => (
              <label className={`candidate ${seriesId === series.id ? 'active' : ''}`} key={series.id} data-testid={`series-option-${series.id}`}>
                <input type="radio" name="series" value={series.id} checked={seriesId === series.id} onChange={() => updateSeries(series.id)} />
                <span className="candidate-main"><strong>{series.name}</strong><small>{Object.entries(series.labels).map(([key, value]) => `${key}=${value}`).join(', ') || 'No labels'}</small></span>
                  <span className="sample-count">{capture.freehand?.candidates.find((candidate) => candidate.seriesId === series.id)?.pointIndexes.length ?? series.points.length} pts</span>
              </label>
            ))}
          </fieldset>

          <div className="time-edit">
            <label>Start time (local)<input aria-label="Start time" type="datetime-local" step="0.001" value={startText} onChange={(event) => updateStart(event.target.value)} /></label>
            <label>End time (local)<input aria-label="End time" type="datetime-local" step="0.001" value={endText} onChange={(event) => updateEnd(event.target.value)} /></label>
          </div>
            {freehandBinding && !capture.freehand && <div className="draw-actions">
              <button className="button secondary" type="button" data-testid="begin-freehand" onClick={beginDrawing}>Draw</button>
              <small>Experimental renderer binding · Grafana {freehandBinding.grafanaVersion} · uPlot {freehandBinding.uPlotVersion}</small>
            </div>}
          <p className="note">Confirmed timestamps are stored as absolute UTC values. A selection does not imply finer resolution than the captured samples.</p>
          {error && <p className="error" role="alert">{error}</p>}
          <details className="query-inspect">
            <summary>Query provenance</summary>
            {capture.query.map((query, index) => <pre key={`${query.refId ?? 'query'}-${index}`}>{query.executedQueryString ?? query.expression ?? 'Query text unavailable'}</pre>)}
          </details>
          <footer className="footer">
            <button className="button secondary" type="button" onClick={onClose}>Cancel</button>
            <button className="button primary" type="button" data-testid="confirm-capture" disabled={!seriesId || !rangeIsValid || Boolean(freehandBinding && !capture.freehand)} onClick={onConfirm}>Confirm target</button>
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
    {drawing && freehandBinding && <>
      <canvas ref={canvasRef} data-testid="freehand-surface" aria-label="Draw a freehand polygon over the native Grafana chart"
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); addVertex(event); }}
        onPointerMove={addVertex}
        onPointerUp={finishDrawing}
        onPointerCancel={cancelDrawing}
        style={{ position: 'fixed', zIndex: 2147483647, left: freehandBinding.plotRect.left, top: freehandBinding.plotRect.top,
          width: freehandBinding.plotRect.width, height: freehandBinding.plotRect.height, touchAction: 'none', cursor: 'crosshair', pointerEvents: 'auto' }} />
      <button className="draw-cancel" type="button" data-testid="cancel-freehand" onClick={cancelDrawing}
        style={{ position: 'fixed', zIndex: 2147483647, left: freehandBinding.plotRect.left + 8, top: freehandBinding.plotRect.top + 8 }}>
        Cancel
      </button>
    </>}
    </>
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
.draw-actions { display: flex; align-items: center; gap: 8px; padding: 4px 20px 8px; flex-wrap: wrap; }
.draw-actions small { color: #a8bbb5; font-size: 10px; }
.draw-cancel { padding: 6px 9px; color: #f3f0e6; background: #2c2920; border: 1px solid #a78c50; border-radius: 4px; font: 600 11px ui-sans-serif, system-ui, sans-serif; cursor: pointer; }
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
