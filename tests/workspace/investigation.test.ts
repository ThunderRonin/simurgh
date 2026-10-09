import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { confirmCapture, type CaptureSnapshot } from '../../packages/shared/src/index';
import {
  createInvestigationSubmission,
  presentFinding,
  previewImportedSnapshot,
  type Evidence,
  type Finding,
} from '../../packages/shared/src/investigation';

describe('workspace investigation boundaries', () => {
  it('freezes a question and its exact available reference selection', () => {
    const selected = ['ref-a', 'ref-b'];
    const request = createInvestigationSubmission(' Why did CPU rise? ', selected, ['ref-a', 'ref-b', 'ref-c']);
    selected.splice(0, 1);

    expect(request).toEqual({ question: 'Why did CPU rise?', referenceIds: ['ref-a', 'ref-b'] });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.referenceIds)).toBe(true);
  });

  it('rejects empty, oversized, duplicated, and unavailable investigation inputs', () => {
    const available = ['ref-a', 'ref-b', 'ref-c', 'ref-d', 'ref-e'];
    expect(() => createInvestigationSubmission('   ', ['ref-a'], available)).toThrow(/question/i);
    expect(() => createInvestigationSubmission('x'.repeat(4001), ['ref-a'], available)).toThrow(/4000/i);
    expect(() => createInvestigationSubmission('Question', [], available)).toThrow(/reference/i);
    expect(() => createInvestigationSubmission('Question', ['ref-a', 'ref-a'], available)).toThrow(/duplicate/i);
    expect(() => createInvestigationSubmission('Question', available, available)).toThrow(/one to 4/i);
    expect(() => createInvestigationSubmission('Question', ['private-ref'], available)).toThrow(/available/i);
  });

  it('fails closed when a finding names evidence outside its investigation', () => {
    const finding: Finding = {
      strength: 'supported',
      summary: 'CPU increased during the interval.',
      citations: ['ev-real', 'ev-invented'],
      limitations: [],
      nextCheck: 'Compare the baseline interval.',
    };
    const result = presentFinding(finding, [evidence('ev-real')]);

    if (result.status !== 'invalid') throw new Error('Expected the unsupported citation to produce an invalid finding.');
    expect(result).not.toHaveProperty('finding');
    expect(result.reason).toMatch(/citation/i);
  });

  it('resolves only citations from the supplied investigation evidence', () => {
    const finding: Finding = {
      strength: 'hypothesis',
      summary: 'A short-lived workload may explain the increase.',
      citations: ['ev-cpu'],
      limitations: ['The runtime-to-code link is unavailable.'],
      nextCheck: 'Inspect the workload timeline.',
    };
    const result = presentFinding(finding, [evidence('ev-cpu'), evidence('other')]);

    expect(result).toEqual({ status: 'valid', finding, evidence: [evidence('ev-cpu')] });
  });

  it('previews actual imported identity and rejects unconfirmed telemetry candidates', async () => {
    const capture = validCapture();
    const confirmed = confirmCapture(capture, capture.series[0].id, capture.range, '2026-10-09T10:00:00.000Z');
    const preview = await previewImportedSnapshot(confirmed);

    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.value.title).toBe('Host CPU · CPU utilization');
      expect(preview.value.details.some((detail) => detail.includes('cpu=0'))).toBe(true);
      expect(preview.value.range).toEqual(capture.range);
      expect(preview.value.origin).toBe('user-supplied');
    }
    expect(await previewImportedSnapshot(capture)).toMatchObject({ ok: false, reason: expect.stringMatching(/confirmed/i) });
  });

  it('previews selected source exports with their actual revision and limitations', async () => {
    const selectedText = 'const value = 1;';
    const source = {
      schema: 'simurgh.source',
      version: 1,
      captureId: 'd26bab81-00a8-4ad1-80dc-0df15e6d817f',
      capturedAt: '2026-10-09T10:00:00.000Z',
      editor: 'vscode',
      document: {
        uri: 'file:///workspace/src/cpu.ts',
        languageId: 'typescript',
        version: 3,
        dirty: false,
        contentHash: createHash('sha256').update(selectedText).digest('hex'),
      },
      workspace: { name: 'simurgh', rootUri: 'file:///workspace', relativePath: 'src/cpu.ts', gitRevision: 'a'.repeat(40) },
      selection: { start: { line: 1, character: 0 }, end: { line: 1, character: selectedText.length }, text: selectedText },
      symbols: [],
      definitions: [],
      limitations: ['Working tree revision is not verified as deployed.'],
    };

    expect(await previewImportedSnapshot(source)).toMatchObject({
      ok: true,
      value: {
        kind: 'source',
        title: 'src/cpu.ts',
        details: expect.arrayContaining(['Git revision: ' + 'a'.repeat(40)]),
        limitations: ['Working tree revision is not verified as deployed.'],
      },
    });
  });
});

function evidence(id: string): Evidence {
  return { id, kind: 'metric', title: 'CPU samples', origin: 'queried', capturedAt: '2026-10-09T10:00:00.000Z', scope: 'host CPU', data: [], limitations: [] };
}

function validCapture(): CaptureSnapshot {
  return {
    schema: 'simurgh.capture',
    version: 1,
    integrationId: 'simurgh-context-app',
    sessionId: 'session-1',
    captureId: 'capture-1',
    revision: 'revision-1',
    capturedAt: '2026-10-09T09:59:00.000Z',
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
    range: { from: 1_791_540_000_000, to: 1_791_540_060_000 },
      resolution: { sampleSpacingMs: 15_000, scrapeIntervalMs: null },
    transformations: [],
    variables: [],
    query: [{ refId: 'A', expression: 'up', executedQueryString: 'up', datasourceUid: 'prometheus-local' }],
    series: [{
      id: 'A:cpu:Value:cpu=0',
      refId: 'A',
      name: 'CPU 0',
      labels: { cpu: '0' },
      unit: 'percent',
      points: [
        { time: 1_791_540_000_000, value: 0.3 },
        { time: 1_791_540_015_000, value: 0.8 },
        { time: 1_791_540_030_000, value: 0.4 },
        { time: 1_791_540_045_000, value: 0.2 },
        { time: 1_791_540_060_000, value: 0.3 },
      ],
    }],
    limitations: ['The sample spacing is 15 seconds.'],
  };
}
