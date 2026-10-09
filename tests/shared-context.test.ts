import { describe, expect, it } from 'vitest';

import {
  confirmCapture,
  extractNumericSeries,
  effectiveTargetsMatch,
  isBridgeMessage,
  parseGrafanaRange,
  parseAbsoluteRange,
  validateCapture,
  type CaptureSnapshot,
  type PanelDataLike,
} from '../packages/shared/src/index';

describe('shared capture contract', () => {
  it('accepts only finite, ordered absolute time bounds', () => {
    expect(parseAbsoluteRange({ from: 1_700_000_000_000, to: 1_700_000_015_000 })).toEqual({
      from: 1_700_000_000_000,
      to: 1_700_000_015_000,
    });
    expect(parseAbsoluteRange({ from: 'now-5m', to: 'now' })).toBeNull();
    expect(parseAbsoluteRange({ from: 20, to: 20 })).toBeNull();
    expect(parseAbsoluteRange({ from: Number.NaN, to: 30 })).toBeNull();
  });

  it('normalizes Grafana DateTime bounds but rejects unresolved relative bounds', () => {
    expect(parseGrafanaRange({ from: { valueOf: () => 1000 }, to: new Date(3000) })).toEqual({ from: 1000, to: 3000 });
    expect(parseGrafanaRange({ from: 'now-5m', to: 'now' })).toBeNull();
  });

  it('matches effective targets by refId and query meaning, not refId alone', () => {
    const menu = [{ refId: 'A', expr: 'up{instance=~"$host"}', datasource: { uid: 'prom', type: 'prometheus' } }];
    const changedWithoutTemplate = [{ refId: 'A', expr: 'secret_metric', datasource: { uid: 'prom', type: 'prometheus' } }];
    const expandedTemplate = [{ refId: 'A', expr: 'up{instance="node-a"}', instant: false, datasource: { uid: 'prom', type: 'prometheus' } }];
    const variableMenu = [{ refId: 'A', expr: 'up{instance="$host"}', instant: false, datasource: { uid: 'prom', type: 'prometheus' } }];
    expect(effectiveTargetsMatch(changedWithoutTemplate, menu, {})).toBe(false);
    expect(effectiveTargetsMatch(expandedTemplate, variableMenu, { A: 'up{instance="node-a"}' }, { host: 'node-a' })).toBe(true);
    expect(effectiveTargetsMatch([{ ...expandedTemplate[0], instant: true }], variableMenu, { A: 'up{instance="node-a"}' }, { host: 'node-a' })).toBe(false);
    expect(effectiveTargetsMatch([{ ...expandedTemplate[0], expr: 'secret_metric' }], variableMenu, { A: 'secret_metric' }, { host: 'node-a' })).toBe(false);
    expect(effectiveTargetsMatch([{ ...expandedTemplate[0], datasource: { uid: 'other', type: 'prometheus' } }], menu, { A: 'up{instance="node-a"}' })).toBe(false);
  });

  it('extracts actual finite numeric frame values and preserves series identity', () => {
    const data: PanelDataLike = {
      state: 'Done',
      series: [{
        refId: 'A',
        name: 'node_cpu',
        fields: [
          { name: 'Time', type: 'time', values: [1000, 2000, 3000] },
          { name: 'Value', type: 'number', labels: { cpu: '0', instance: 'node-a' }, values: [0.4, null, 0.8] },
          { name: 'Note', type: 'string', values: ['a', 'b', 'c'] },
        ],
      }],
    };

    expect(extractNumericSeries(data)).toEqual([{
      id: 'A:node_cpu:Value:cpu=0,instance=node-a',
      refId: 'A',
      name: 'Value',
      labels: { cpu: '0', instance: 'node-a' },
      points: [{ time: 1000, value: 0.4 }, { time: 3000, value: 0.8 }],
    }]);
  });

  it('does not extract data until the panel request is complete', () => {
    expect(extractNumericSeries({ state: 'Loading', series: [] })).toEqual([]);
    expect(extractNumericSeries({ state: 'Streaming', series: [] })).toEqual([]);
  });

  it('rejects malformed, oversized, wrong-origin, wrong-source, and stale bridge messages', () => {
    const message = {
      channel: 'simurgh.context',
      version: 1,
      integrationId: 'simurgh-context-app',
      kind: 'ready',
      sessionId: 'session-1',
      requestSeq: 3,
    };
    const allowed = {
      source: 'window',
      origin: 'http://localhost:3300',
      expectedOrigin: 'http://localhost:3300',
      sessionId: 'session-1',
      requestSeq: 3,
      maxBytes: 1024,
    };

    expect(isBridgeMessage(message, allowed)).toBe(true);
    expect(isBridgeMessage(message, { ...allowed, origin: 'https://attacker.example' })).toBe(false);
    expect(isBridgeMessage(message, { ...allowed, source: 'other-window' })).toBe(false);
    expect(isBridgeMessage(message, { ...allowed, sessionId: 'session-2' })).toBe(false);
    expect(isBridgeMessage({ ...message, requestSeq: 2 }, allowed)).toBe(false);
    expect(isBridgeMessage({ ...message, untrusted: 'x'.repeat(2048) }, allowed)).toBe(false);
    expect(isBridgeMessage({ ...message, version: 99 }, allowed)).toBe(false);
    expect(isBridgeMessage({ ...message, kind: 'capture', capture: { ...validCapture(), sessionId: 'other-session' } }, allowed)).toBe(false);
    expect(isBridgeMessage({ ...message, kind: 'capture', capture: { ...validCapture(), panel: { ...validCapture().panel, grafanaOrigin: 'https://other.example' } } }, allowed)).toBe(false);
    expect(isBridgeMessage({ ...message, kind: 'capture', capture: { ...validCapture(), query: [] } }, allowed)).toBe(false);
  });

  it('validates captures, requires an explicit series, and freezes a detached confirmed bundle', () => {
    const capture = validCapture();
    expect(validateCapture(capture)).toEqual({ ok: true, value: capture });
    expect(validateCapture({ ...capture, range: { from: 'now-5m', to: 'now' } }).ok).toBe(false);
    expect(validateCapture({ ...capture, range: { from: 1e20, to: 1e20 + 1 } }).ok).toBe(false);
    expect(validateCapture({ ...capture, query: [] }).ok).toBe(false);
    expect(validateCapture({ ...capture, query: [{}] }).ok).toBe(false);
    expect(validateCapture({ ...capture, query: [{ ...capture.query[0], refId: 'B' }] }).ok).toBe(false);
    expect(validateCapture({ ...capture, series: [capture.series[0], { ...capture.series[0] }] }).ok).toBe(false);
    expect(() => confirmCapture(capture, 'missing-series', { from: 1000, to: 2000 })).toThrow(/series/i);

    const confirmed = confirmCapture(capture, 'A:node_cpu:Value:cpu=0,instance=node-a', { from: 1000, to: 3000 });
    capture.series[0].labels.instance = 'changed-after-confirmation';
    expect(confirmed.series[0].labels.instance).toBe('node-a');
    expect(Object.isFrozen(confirmed)).toBe(true);
    expect(Object.isFrozen(confirmed.series[0].labels)).toBe(true);
    expect(confirmed.series).toHaveLength(1);
    expect(confirmed.candidateCount).toBe(1);
  });

  it('clips only available samples and preserves a resolution limitation', () => {
    const confirmed = confirmCapture(validCapture(), 'A:node_cpu:Value:cpu=0,instance=node-a', { from: 1500, to: 2500 });
    expect(confirmed.selected.points).toEqual([{ time: 2000, value: 0.6 }]);
    expect(confirmed.limitations).toContain('The selected interval is shorter than the available sample spacing.');
  });

  it('validates native freehand geometry and confirms only samples enclosed for the chosen series', () => {
    const capture = freehandCapture();
    expect(validateCapture(capture).ok).toBe(true);

    const confirmed = confirmCapture(capture, capture.series[0].id, { from: 1000, to: 3000 });
    expect(confirmed.selectionMethod).toBe('grafana-freehand');
    expect(confirmed.confirmation.range).toEqual({ from: 1000, to: 3000 });
    expect(confirmed.selected.points).toEqual([{ time: 2000, value: 0.6 }]);
    expect(confirmed.freehand?.candidates[0].pointIndexes).toEqual([1]);
    expect(Object.isFrozen(confirmed.freehand?.vertices)).toBe(true);
    expect(validateCapture(confirmed).ok).toBe(true);
    const forgedOutsideGeometry = {
      ...confirmed,
      series: [{ ...confirmed.series[0], points: [{ time: 500, value: 0.6 }] }],
      selected: { ...confirmed.selected, points: [{ time: 500, value: 0.6 }] },
    };
    expect(validateCapture(forgedOutsideGeometry).ok).toBe(false);
  });

  it('rejects unsupported renderer versions and out-of-range freehand sample indexes', () => {
    const capture = freehandCapture();
    expect(validateCapture({ ...capture, freehand: { ...capture.freehand, grafanaVersion: '13.2.4' } }).ok).toBe(false);
    expect(validateCapture({ ...capture, freehand: { ...capture.freehand, candidates: [{ seriesId: capture.series[0].id, pointIndexes: [3] }] } }).ok).toBe(false);
    expect(validateCapture({ ...capture, freehand: { ...capture.freehand, vertices: [{ x: 12, y: 12 }, { x: 50, y: 20 }] } }).ok).toBe(false);
  });

  it('requires the explicitly chosen freehand candidate to have enclosed real samples', () => {
    const capture = freehandCapture();
    const notEnclosed = { ...capture.series[0], id: 'A:node_cpu:Value:cpu=1', labels: { cpu: '1', instance: 'node-a' } };
    capture.series.push(notEnclosed);
    expect(() => confirmCapture(capture, notEnclosed.id, { from: 1000, to: 3000 })).toThrow(/freehand candidate/i);
  });

  it('accepts a bounded renderer binding and rejects malformed or stale gesture envelopes', () => {
    const capture = validCapture();
    const binding = {
      id: 'binding-1', captureId: capture.captureId, grafanaVersion: '13.2.3', uPlotVersion: '1.6.32',
      plotRect: { left: 100, top: 80, width: 400, height: 200 },
    };
    const captureMessage = { channel: 'simurgh.context', version: 1, integrationId: 'simurgh-context-app',
      kind: 'capture', sessionId: capture.sessionId, requestSeq: 3, capture, freehandBinding: binding };
    const gesture = { channel: 'simurgh.context', version: 1, integrationId: 'simurgh-context-app',
      kind: 'freehand-submit', sessionId: capture.sessionId, requestSeq: 3, captureId: capture.captureId,
      bindingId: binding.id, vertices: [{ x: 10, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 70 }, { x: 10, y: 70 }] };
    const allowed = { source: 'window', origin: 'http://localhost:3300', expectedOrigin: 'http://localhost:3300',
      sessionId: capture.sessionId, requestSeq: 3 };
    expect(isBridgeMessage(captureMessage, allowed)).toBe(true);
    expect(isBridgeMessage({ ...captureMessage, freehandBinding: { ...binding, captureId: 'stale' } }, allowed)).toBe(false);
    expect(isBridgeMessage(gesture, allowed)).toBe(true);
    expect(isBridgeMessage({ ...gesture, requestSeq: 2 }, allowed)).toBe(false);
    expect(isBridgeMessage({ ...gesture, vertices: [{ x: 1, y: 2 }] }, allowed)).toBe(false);
    expect(isBridgeMessage({ ...gesture, kind: 'freehand-cancel', vertices: undefined, captureId: undefined }, allowed)).toBe(false);
    expect(isBridgeMessage({ ...gesture, kind: 'freehand-cancel', vertices: undefined, captureId: capture.captureId }, allowed)).toBe(true);
    const completion = { ...gesture, kind: 'freehand-complete' as const, vertices: undefined, captureId: capture.captureId };
    expect(isBridgeMessage(completion, allowed)).toBe(true);
    expect(isBridgeMessage({ ...completion, captureId: undefined }, allowed)).toBe(false);
    expect(isBridgeMessage({ ...completion, sessionId: 'stale-session' }, allowed)).toBe(false);
    expect(isBridgeMessage({ ...completion, requestSeq: 4 }, allowed)).toBe(false);
  });
});

function validCapture(): CaptureSnapshot {
  return {
    schema: 'simurgh.capture',
    version: 1,
    integrationId: 'simurgh-context-app',
    sessionId: 'session-1',
    captureId: 'capture-1',
    revision: 'revision-1',
    capturedAt: '2026-10-09T09:00:00.000Z',
    selectionMethod: 'grafana-native-range',
    panel: {
      grafanaOrigin: 'http://localhost:3300',
      grafanaOrgId: 1,
      dashboardUid: 'simurgh-cpu-lab',
      dashboardTitle: 'Host CPU',
      panelId: 1,
      panelTitle: 'CPU utilization',
      datasourceUid: 'prometheus-local',
      datasourceType: 'prometheus',
    },
    timezone: 'utc',
    range: { from: 1000, to: 3000 },
    resolution: { sampleSpacingMs: 1000, scrapeIntervalMs: null },
    transformations: [],
    variables: [],
    query: [{ refId: 'A', expression: 'up', executedQueryString: 'up' }],
    series: [{
      id: 'A:node_cpu:Value:cpu=0,instance=node-a',
      refId: 'A',
      name: 'Value',
      labels: { cpu: '0', instance: 'node-a' },
      points: [{ time: 1000, value: 0.4 }, { time: 2000, value: 0.6 }, { time: 3000, value: 0.8 }],
    }],
    limitations: [],
  };
}

function freehandCapture(): CaptureSnapshot {
  const capture = validCapture();
  return {
    ...capture,
    selectionMethod: 'grafana-freehand',
    freehand: {
      renderer: 'grafana-uplot',
      grafanaVersion: '13.2.3',
      uPlotVersion: '1.6.32',
      plotSize: { width: 400, height: 200 },
      vertices: [{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 10, y: 90 }],
      interval: { from: 1000, to: 3000 },
      candidates: [{ seriesId: capture.series[0].id, sampleCount: capture.series[0].points.length, pointIndexes: [1] }],
    },
  };
}
