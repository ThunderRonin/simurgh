export const CAPTURE_SCHEMA = 'simurgh.capture' as const;
export const BRIDGE_CHANNEL = 'simurgh.context' as const;
export const BRIDGE_VERSION = 1 as const;
export const INTEGRATION_ID = 'simurgh-context-app' as const;
export const MAX_CAPTURE_BYTES = 5_000_000;
export const MAX_SERIES = 100;
export const MAX_POINTS_PER_SERIES = 10_000;

export interface AbsoluteRange {
  from: number;
  to: number;
}

export interface NumericPoint {
  time: number;
  value: number;
}

export interface NumericSeries {
  id: string;
  refId?: string;
  name: string;
  labels: Record<string, string>;
  unit?: string;
  points: NumericPoint[];
}

export interface CaptureQuery {
  refId?: string;
  expression?: string;
  executedQueryString?: string;
  datasourceUid?: string;
}

export interface CaptureSnapshot {
  schema: typeof CAPTURE_SCHEMA;
  version: 1;
  integrationId: typeof INTEGRATION_ID;
  sessionId: string;
  captureId: string;
  revision: string;
  capturedAt: string;
  selectionMethod: 'grafana-native-range';
  panel: {
    grafanaOrigin: string;
    grafanaOrgId: number;
    dashboardUid: string;
    dashboardTitle: string;
    panelId: number;
    panelTitle: string;
    datasourceUid: string;
    datasourceType: string;
    defaultUnit?: string;
  };
  timezone: string;
  range: AbsoluteRange;
  resolution: {
    queryInterval?: string;
    queryIntervalMs?: number;
    sampleSpacingMs: number | null;
    scrapeIntervalMs: number | null;
  };
  transformations: string[];
  variables: Array<{ name: string; values: string[] }>;
  query: CaptureQuery[];
  series: NumericSeries[];
  limitations: string[];
  visual?: {
    mediaType: 'image/png';
    dataUrl: string;
    trustedForSelection: false;
  };
}

export interface ConfirmedCapture extends CaptureSnapshot {
  candidateCount: number;
  confirmation: {
    seriesId: string;
    range: AbsoluteRange;
    confirmedAt: string;
  };
  selected: NumericSeries & { points: NumericPoint[] };
}

export interface PanelDataLike {
  state?: string;
  series?: Array<{
    refId?: string;
    name?: string;
    fields?: Array<{
      name?: string;
      type?: string;
      labels?: Record<string, unknown>;
      config?: { unit?: string };
      values?: ArrayLike<unknown> | { get(index: number): unknown; length: number };
    }>;
    meta?: {
      executedQueryString?: string;
      transformations?: unknown[];
    };
  }>;
  request?: {
    range?: unknown;
    targets?: Array<Record<string, unknown>>;
    startTime?: number;
    interval?: string;
    intervalMs?: number;
    scopedVars?: unknown;
  };
}

export function parseAbsoluteRange(input: unknown): AbsoluteRange | null {
  if (!isRecord(input)) {
    return null;
  }
  const from = input.from;
  const to = input.to;
  if (typeof from !== 'number' || typeof to !== 'number' || !Number.isFinite(from) || !Number.isFinite(to) ||
    !Number.isFinite(new Date(from).getTime()) || !Number.isFinite(new Date(to).getTime()) || from >= to) {
    return null;
  }
  return { from, to };
}

export function parseGrafanaRange(input: unknown): AbsoluteRange | null {
  if (!isRecord(input)) return null;
  const from = toMillis(input.from);
  const to = toMillis(input.to);
  return parseAbsoluteRange({ from, to });
}

export function effectiveTargetsMatch(
  active: Array<Record<string, unknown>>,
  menu: Array<Record<string, unknown>>,
  executedByRef: Record<string, string | undefined>,
  variables: Record<string, string> = {}
): boolean {
  if (active.length === 0 || active.length !== menu.length) return false;
  const byRef = new Map<string, Record<string, unknown>>();
  for (const target of menu) {
    if (typeof target.refId !== 'string' || byRef.has(target.refId)) return false;
    byRef.set(target.refId, target);
  }
  const seen = new Set<string>();
  return active.every((target) => {
    const refId = typeof target.refId === 'string' ? target.refId : '';
    const expected = byRef.get(refId);
    if (!refId || seen.has(refId) || !expected) return false;
    seen.add(refId);

    const actualSource = isRecord(target.datasource) ? target.datasource : {};
    const expectedSource = isRecord(expected.datasource) ? expected.datasource : {};
    for (const key of ['uid', 'type']) {
      const expectedValue = expectedSource[key];
      if (typeof expectedValue === 'string' && actualSource[key] !== expectedValue) return false;
    }

    const menuExpression = queryExpression(expected);
    const actualExpression = queryExpression(target);
    const optionsMatch = ['legendFormat', 'interval', 'intervalMs', 'instant', 'range', 'format', 'queryType'].every((key) =>
      expected[key] === undefined || target[key] === expected[key]);
    if (!optionsMatch) return false;
    if (menuExpression === actualExpression) return true;
    const expanded = interpolateSimpleTemplate(menuExpression, variables);
    return expanded !== null && expanded === actualExpression && executedByRef[refId] === actualExpression;
  });
}

function interpolateSimpleTemplate(expression: string, variables: Record<string, string>): string | null {
  let unresolved = false;
  const expanded = expression.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_match, name: string) => {
    const value = variables[name];
    if (typeof value !== 'string') {
      unresolved = true;
      return '';
    }
    return value;
  });
  return unresolved || /\$[A-Za-z_{]/.test(expanded) ? null : expanded;
}

export function extractNumericSeries(data: PanelDataLike): NumericSeries[] {
  if (data.state !== 'Done' || !Array.isArray(data.series)) {
    return [];
  }

  const output: NumericSeries[] = [];
  for (const frame of data.series) {
    if (!Array.isArray(frame.fields)) {
      continue;
    }
    const timeField = frame.fields.find((field) => field.type === 'time' || field.type === 'string' && field.name?.toLowerCase() === 'time');
    if (!timeField || !Array.isArray(frame.meta?.transformations) || frame.meta.transformations.length > 0) {
      if (frame.meta?.transformations?.length) {
        continue;
      }
    }
    if (!timeField) {
      continue;
    }

    for (const field of frame.fields) {
      if (field.type !== 'number') {
        continue;
      }
      const labels = normalizeLabels(field.labels ?? {});
      const points: NumericPoint[] = [];
      const length = valueLength(timeField.values);
      if (length !== valueLength(field.values)) {
        continue;
      }
      for (let index = 0; index < length; index += 1) {
        const time = normalizeTime(readValue(timeField.values, index));
        const value = readValue(field.values, index);
        if (time !== null && typeof value === 'number' && Number.isFinite(value)) {
          points.push({ time, value });
        }
      }
      if (points.length === 0) {
        continue;
      }
      points.sort((a, b) => a.time - b.time);
      const name = field.name || frame.name || 'Value';
      const id = seriesIdentity(frame.refId, frame.name, name, labels);
      output.push({
        id,
        ...(frame.refId ? { refId: frame.refId } : {}),
        name,
        labels,
        ...(typeof field.config?.unit === 'string' ? { unit: field.config.unit } : {}),
        points,
      });
      if (output.length > MAX_SERIES) {
        return [];
      }
    }
  }
  return output;
}

export type BridgeMessage = {
  channel: typeof BRIDGE_CHANNEL;
  version: typeof BRIDGE_VERSION;
  integrationId: typeof INTEGRATION_ID;
  kind: 'hello' | 'plugin-ready' | 'probe' | 'ready' | 'capture';
  sessionId: string;
  requestSeq: number;
  capture?: CaptureSnapshot;
};

export function isBridgeMessage(
  input: unknown,
  context: { source: unknown; origin: string; expectedOrigin: string; sessionId: string; requestSeq: number; maxBytes?: number }
): input is BridgeMessage {
  if (context.source !== 'window' || context.origin !== context.expectedOrigin || !isRecord(input)) {
    return false;
  }
  const maxBytes = context.maxBytes ?? MAX_CAPTURE_BYTES;
  try {
    if (new TextEncoder().encode(JSON.stringify(input)).byteLength > maxBytes) {
      return false;
    }
  } catch {
    return false;
  }
  if (input.channel !== BRIDGE_CHANNEL || input.version !== BRIDGE_VERSION || input.integrationId !== INTEGRATION_ID ||
    input.sessionId !== context.sessionId || input.requestSeq !== context.requestSeq ||
    !Number.isSafeInteger(input.requestSeq) || input.requestSeq < 0 ||
    !['hello', 'plugin-ready', 'probe', 'ready', 'capture'].includes(String(input.kind))) {
    return false;
  }
  if (input.kind === 'capture') {
    const result = validateCapture(input.capture);
    return result.ok && result.value.sessionId === input.sessionId && result.value.panel.grafanaOrigin === context.expectedOrigin;
  }
  return input.capture === undefined;
}

export function validateCapture(input: unknown): { ok: true; value: CaptureSnapshot } | { ok: false; reason: string } {
  if (!isRecord(input)) {
    return { ok: false, reason: 'Capture must be a JSON object.' };
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(input);
  } catch {
    return { ok: false, reason: 'Capture is not serializable JSON.' };
  }
  if (new TextEncoder().encode(encoded).byteLength > MAX_CAPTURE_BYTES) {
    return { ok: false, reason: 'Capture exceeds the 5 MB payload limit.' };
  }
  if (input.schema !== CAPTURE_SCHEMA || input.version !== 1 || input.integrationId !== INTEGRATION_ID ||
    input.selectionMethod !== 'grafana-native-range') {
    return { ok: false, reason: 'Capture schema or selection method is unsupported.' };
  }
  if (!isNonEmptyString(input.sessionId) || !isNonEmptyString(input.captureId) || !isNonEmptyString(input.revision) ||
    !isIsoDate(input.capturedAt) || !validPanel(input.panel)) {
    return { ok: false, reason: 'Capture identity or Grafana panel metadata is incomplete.' };
  }
  const range = parseAbsoluteRange(input.range);
  const resolution = input.resolution;
  if (!range || !Array.isArray(input.query) || input.query.length === 0 || !Array.isArray(input.series) || !Array.isArray(input.limitations) ||
    input.series.length > MAX_SERIES || input.limitations.some((item) => typeof item !== 'string') ||
    !isNonEmptyString(input.timezone) || !isRecord(resolution) ||
    !(resolution.queryInterval === undefined || typeof resolution.queryInterval === 'string') ||
    !(resolution.queryIntervalMs === undefined || Number.isFinite(resolution.queryIntervalMs)) ||
    !(resolution.sampleSpacingMs === null || typeof resolution.sampleSpacingMs === 'number' && Number.isFinite(resolution.sampleSpacingMs)) ||
    resolution.scrapeIntervalMs !== null || !Array.isArray(input.transformations) || input.transformations.length !== 0 ||
    !Array.isArray(input.variables) || !input.variables.every((item) => isRecord(item) && isNonEmptyString(item.name) &&
      Array.isArray(item.values) && item.values.every((value: unknown) => typeof value === 'string'))) {
    return { ok: false, reason: 'Capture range, candidates, queries, or limitations are invalid.' };
  }
  if (!input.query.every(validQuery) || !input.series.every(validSeries)) {
    return { ok: false, reason: 'Capture contains invalid query provenance or numeric series.' };
  }
  const queries = input.query as unknown as CaptureQuery[];
  const series = input.series as unknown as NumericSeries[];
  if (queries.some((query) => !query.expression && !query.executedQueryString) ||
    series.some((candidate) => !queries.some((query) => query.refId === candidate.refId)) ||
    queries.some((query) => query.datasourceUid && query.datasourceUid !== input.panel.datasourceUid)) {
    return { ok: false, reason: 'Capture is missing matching effective query provenance for its numeric series.' };
  }
  if (new Set(input.series.map((item) => isRecord(item) ? item.id : undefined)).size !== input.series.length) {
    return { ok: false, reason: 'Capture contains duplicate series identities.' };
  }
  if (input.visual !== undefined && (!isRecord(input.visual) || input.visual.mediaType !== 'image/png' ||
    input.visual.trustedForSelection !== false || typeof input.visual.dataUrl !== 'string' || !input.visual.dataUrl.startsWith('data:image/png;base64,'))) {
    return { ok: false, reason: 'Optional visual reference must be a non-authoritative PNG data URL.' };
  }
  return { ok: true, value: input as unknown as CaptureSnapshot };
}

export function confirmCapture(
  capture: CaptureSnapshot,
  seriesId: string,
  selection: AbsoluteRange,
  confirmedAt = new Date().toISOString()
): ConfirmedCapture {
  const result = validateCapture(capture);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  const interval = parseAbsoluteRange(selection);
  if (!interval || interval.from < capture.range.from || interval.to > capture.range.to) {
    throw new Error('Selected time must be a valid absolute interval inside the captured range.');
  }
  const candidate = capture.series.find((item) => item.id === seriesId);
  if (!candidate) {
    throw new Error('Choose an available numeric series before confirming.');
  }
  const points = candidate.points.filter((point) => point.time >= interval.from && point.time <= interval.to).map((point) => ({ ...point }));
  const limitations = [...capture.limitations];
  const spacing = minimumSpacing(candidate.points);
  if (points.length < 2 || spacing !== null && interval.to - interval.from < spacing) {
    limitations.push('The selected interval is shorter than the available sample spacing.');
  }
  const confirmed = cloneJson({
    ...capture,
    candidateCount: capture.series.length,
    series: [{ ...candidate, points }],
    confirmation: { seriesId, range: interval, confirmedAt },
    selected: { ...candidate, points },
    limitations: [...new Set(limitations)],
  }) as ConfirmedCapture;
  deepFreeze(confirmed);
  return confirmed;
}

function validPanel(value: unknown): value is CaptureSnapshot['panel'] {
  return isRecord(value) && isNonEmptyString(value.grafanaOrigin) && Number.isInteger(value.grafanaOrgId) && value.grafanaOrgId > 0 &&
    isNonEmptyString(value.dashboardUid) &&
    isNonEmptyString(value.dashboardTitle) && Number.isInteger(value.panelId) && value.panelId >= 0 &&
    isNonEmptyString(value.panelTitle) && isNonEmptyString(value.datasourceUid) && isNonEmptyString(value.datasourceType) &&
    (value.defaultUnit === undefined || typeof value.defaultUnit === 'string');
}

function validQuery(value: unknown): value is CaptureQuery {
  if (!isRecord(value)) return false;
  return [value.refId, value.expression, value.executedQueryString, value.datasourceUid].every((item) => item === undefined || typeof item === 'string');
}

function validSeries(value: unknown): value is NumericSeries {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isNonEmptyString(value.name) ||
    value.refId !== undefined && typeof value.refId !== 'string' || value.unit !== undefined && typeof value.unit !== 'string' ||
    !isRecord(value.labels) || !Array.isArray(value.points) ||
    value.points.length > MAX_POINTS_PER_SERIES) {
    return false;
  }
  return Object.values(value.labels).every((item) => typeof item === 'string') && value.points.every((point) =>
    isRecord(point) && typeof point.time === 'number' && Number.isFinite(point.time) && typeof point.value === 'number' && Number.isFinite(point.value));
}

function seriesIdentity(refId: string | undefined, frameName: string | undefined, fieldName: string, labels: Record<string, string>): string {
  const labelKey = Object.keys(labels).sort().map((key) => `${key}=${labels[key]}`).join(',');
  return [refId ?? 'frame', frameName ?? 'series', fieldName, labelKey].join(':');
}

function normalizeLabels(input: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string | number | boolean] =>
    typeof entry[1] === 'string' || typeof entry[1] === 'number' || typeof entry[1] === 'boolean')
    .map(([key, value]) => [key, String(value)])
    .sort(([left], [right]) => left.localeCompare(right)));
}

function queryExpression(target: Record<string, unknown>): string {
  return typeof target.expr === 'string' ? target.expr : typeof target.query === 'string' ? target.query : '';
}

function toMillis(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === 'object' && typeof (value as { valueOf?: unknown }).valueOf === 'function') {
    const result = (value as { valueOf: () => unknown }).valueOf();
    return typeof result === 'number' && Number.isFinite(result) ? result : null;
  }
  return null;
}

function normalizeTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function valueLength(values: unknown): number {
  if (Array.isArray(values)) return values.length;
  if (isRecord(values) && typeof values.length === 'number' && typeof values.get === 'function') return values.length;
  return 0;
}

function readValue(values: unknown, index: number): unknown {
  if (Array.isArray(values)) return values[index];
  if (isRecord(values) && typeof values.get === 'function') return (values.get as (index: number) => unknown)(index);
  return undefined;
}

function minimumSpacing(points: NumericPoint[]): number | null {
  let spacing: number | null = null;
  for (let index = 1; index < points.length; index += 1) {
    const delta = points[index].time - points[index - 1].time;
    if (delta > 0 && (spacing === null || delta < spacing)) spacing = delta;
  }
  return spacing;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && value.includes('T');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
