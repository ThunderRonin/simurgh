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
