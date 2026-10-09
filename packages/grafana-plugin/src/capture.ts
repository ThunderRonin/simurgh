import { getBackendSrv } from '@grafana/runtime';
import {
  extractNumericSeries,
  effectiveTargetsMatch,
  INTEGRATION_ID,
  MAX_POINTS_PER_SERIES,
  MAX_SERIES,
  parseGrafanaRange,
  type CaptureQuery,
  type CaptureSnapshot,
  type PanelDataLike,
} from '../../shared/src/index';

export interface CaptureContext {
  id: number;
  pluginId: string;
  title: string;
  timeRange: unknown;
  dashboard: { uid: string; title: string };
  timeZone: string;
  targets: Array<Record<string, unknown>>;
  scopedVars?: Record<string, unknown>;
  data?: PanelDataLike & { timeRange?: unknown; structureRev?: number; errors?: unknown[] };
  panelPathId?: string;
}

interface DashboardResponse {
  dashboard?: Record<string, unknown>;
  meta?: { provisioned?: boolean };
}

interface SavedPanel {
  id?: number;
  title?: string;
  type?: string;
  datasource?: { uid?: string; type?: string };
  targets?: Array<Record<string, unknown>>;
  transformations?: unknown[];
  repeat?: string | null;
  timeFrom?: string;
  timeShift?: string;
  fieldConfig?: { defaults?: { unit?: string }; overrides?: unknown[] };
  options?: Record<string, unknown>;
}

export async function buildPanelCapture(context: CaptureContext, origin: string, sessionId: string): Promise<CaptureSnapshot> {
  const data = context.data;
  if (!data || data.state !== 'Done' || (data.errors?.length ?? 0) > 0) {
    throw new Error('Panel data is still loading, streaming, or contains query errors. Wait for a complete panel result and try again.');
  }
  const range = parseGrafanaRange(data.request?.range);
  if (!range || !sameRange(range, data.timeRange) || !sameRange(range, context.timeRange)) {
    throw new Error('The panel request, panel data, and Grafana time range do not share matching absolute bounds. Use a native time-range selection and retry.');
  }
  const series = extractNumericSeries(data);
  if (series.length === 0) {
    throw new Error('This panel has no supported numeric samples or exceeds the capture limits.');
  }
  if (series.length > MAX_SERIES || series.some((item) => item.points.length > MAX_POINTS_PER_SERIES)) {
    throw new Error(`Capture exceeds the limit of ${MAX_SERIES} series or ${MAX_POINTS_PER_SERIES} samples per series.`);
  }

  const targets: Array<Record<string, unknown>> | undefined = data.request?.targets?.map(safeTarget);
  const menuTargets: Array<Record<string, unknown>> = context.targets.map(safeTarget);
  const frames = (data.series ?? []).map((frame) => ({ refId: frame.refId, meta: { executedQueryString: frame.meta?.executedQueryString } }));
  const executedByRef = Object.fromEntries(frames.map((frame) => [frame.refId ?? '', frame.meta.executedQueryString]));
  const scopedValues = extractSimpleScopedVariables(context, data, menuTargets);
  if (!targets || targets.length === 0 || !effectiveTargetsMatch(targets, menuTargets, executedByRef, scopedValues)) {
    throw new Error('Grafana did not provide matching effective query targets for this panel revision.');
  }
  const queries = buildQueries(targets, frames);
  if (queries.some((query) => (query.expression ?? '').includes('$') && !query.executedQueryString)) {
    throw new Error('Grafana did not provide the executed query text needed to resolve template variables safely.');
  }
  const variables = extractScopedVariables(context, data, queries);
  const queryInterval = typeof data.request?.interval === 'string' ? data.request.interval : undefined;
  const queryIntervalMs = typeof data.request?.intervalMs === 'number' && Number.isFinite(data.request.intervalMs) ? data.request.intervalMs : undefined;
  const structureRev = data.structureRev;
  const panelId = context.id;
  const panelTitle = context.title;
  const dashboardUid = context.dashboard.uid;
  const dashboardTitle = context.dashboard.title;
  const timezone = context.timeZone;
  const savedContext = { id: panelId, title: panelTitle, targets: menuTargets };
  if (typeof timezone !== 'string' || timezone.length === 0) {
    throw new Error('Grafana did not provide the panel timezone.');
  }
  const [saved, org] = await Promise.all([getSavedPanel(dashboardUid, panelId), getCurrentOrg()]);
  verifySavedPanel(saved, savedContext);
  const captureTime = new Date().toISOString();
  const panel = {
    grafanaOrigin: origin,
    grafanaOrgId: org.id,
    dashboardUid,
    dashboardTitle,
    panelId,
    panelTitle,
    datasourceUid: saved.datasource?.uid ?? '',
    datasourceType: saved.datasource?.type ?? '',
    ...(typeof saved.fieldConfig?.defaults?.unit === 'string' ? { defaultUnit: saved.fieldConfig.defaults.unit } : {}),
  };
  const revisionSeed = JSON.stringify({ structureRev, range, queries, series });
  const revision = await digest(revisionSeed);

  return {
    schema: 'simurgh.capture',
    version: 1,
    integrationId: INTEGRATION_ID,
    sessionId,
    captureId: crypto.randomUUID(),
    revision,
    capturedAt: captureTime,
    selectionMethod: 'grafana-native-range',
    panel,
    timezone,
    range,
    resolution: {
      ...(queryInterval ? { queryInterval } : {}),
      ...(queryIntervalMs !== undefined ? { queryIntervalMs } : {}),
      sampleSpacingMs: sampleSpacing(series),
      scrapeIntervalMs: null,
    },
    transformations: [],
    variables,
    query: queries,
    series,
    limitations: [
      'No panel image is captured; the selection uses Grafana native time-range zoom.',
      'The scrape interval was not available from public panel metadata and was not inferred from query resolution.',
      'The selected time range cannot establish event duration below the captured sample spacing.',
    ],
  };
}

async function getSavedPanel(uid: string, panelId: number): Promise<SavedPanel> {
  const result = await getBackendSrv().get<DashboardResponse>(`/api/dashboards/uid/${encodeURIComponent(uid)}`);
  if (!result?.dashboard || result.meta?.provisioned !== true || result.dashboard.editable !== false) {
    throw new Error('The dashboard configuration is not a provisioned, immutable saved dashboard.');
  }
  const panels = flattenPanels(result.dashboard.panels);
  const matches = panels.filter((panel) => panel.id === panelId);
  if (matches.length !== 1) {
    throw new Error('Saved panel identity is missing or ambiguous; repeated and unsaved panel instances are unsupported.');
  }
  return matches[0];
}

async function getCurrentOrg(): Promise<{ id: number }> {
  const org = await getBackendSrv().get<{ id?: number }>('/api/org');
  if (!Number.isInteger(org?.id) || Number(org?.id) < 1) {
    throw new Error('Grafana did not return an authorized organization identity.');
  }
  return { id: Number(org.id) };
}

function verifySavedPanel(panel: SavedPanel, context: Pick<CaptureContext, 'id' | 'title' | 'targets'>) {
  if (panel.type !== 'timeseries' || panel.id !== context.id || panel.title !== context.title) {
    throw new Error('Only a matching saved built-in time series panel is supported.');
  }
  if (panel.repeat || panel.timeFrom || panel.timeShift) {
    throw new Error('Repeated panels and panel-relative time overrides are unsupported.');
  }
  if ((panel.transformations?.length ?? 0) > 0) {
    throw new Error('Panels with transformations are unsupported because the displayed data cannot be matched safely.');
  }
  if ((panel.fieldConfig?.overrides?.length ?? 0) > 0) {
    throw new Error('Panels with field overrides are unsupported because displayed field semantics are not captured.');
  }
  if (!panel.datasource?.uid || !panel.datasource.type || !Array.isArray(panel.targets) || panel.targets.length === 0 ||
    JSON.stringify(panel.targets.map(targetIdentity)) !== JSON.stringify(context.targets.map(targetIdentity))) {
    throw new Error('Saved panel datasource or query definitions do not match the active panel context.');
  }
}

function flattenPanels(input: unknown): SavedPanel[] {
  if (!Array.isArray(input)) return [];
  const result: SavedPanel[] = [];
  for (const item of input) {
    if (!isRecord(item)) continue;
    result.push(item as SavedPanel);
    result.push(...flattenPanels(item.panels));
  }
  return result;
}

function targetIdentity(target: Record<string, unknown>) {
  const datasource = isRecord(target.datasource) ? target.datasource : {};
  return {
    refId: stringValue(target.refId),
    expr: stringValue(target.expr),
    query: stringValue(target.query),
    legendFormat: stringValue(target.legendFormat),
    datasource: { uid: stringValue(datasource.uid), type: stringValue(datasource.type) },
  };
}

function safeTarget(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of ['refId', 'expr', 'query', 'legendFormat', 'interval', 'intervalMs', 'instant', 'range', 'format', 'queryType', 'hide', 'exemplar']) {
    const value = input[key];
    if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) {
      output[key] = value;
    }
  }
  if (isRecord(input.datasource)) {
    const datasource: Record<string, string> = {};
    if (typeof input.datasource.uid === 'string') datasource.uid = input.datasource.uid;
    if (typeof input.datasource.type === 'string') datasource.type = input.datasource.type;
    if (Object.keys(datasource).length) output.datasource = datasource;
  }
  return output;
}

function buildQueries(targets: Array<Record<string, unknown>>, frames: NonNullable<PanelDataLike['series']>): CaptureQuery[] {
  return targets.map((target) => {
    const datasource = isRecord(target.datasource) ? target.datasource : {};
    const frame = frames.find((item) => item.refId === target.refId);
    const expression = stringValue(target.expr) || stringValue(target.query);
    return {
      ...(typeof target.refId === 'string' ? { refId: target.refId } : {}),
      ...(expression ? { expression } : {}),
      ...(typeof frame?.meta?.executedQueryString === 'string' ? { executedQueryString: frame.meta.executedQueryString } : {}),
      ...(typeof datasource.uid === 'string' ? { datasourceUid: datasource.uid } : {}),
    };
  });
}

function sameRange(expected: { from: number; to: number }, input: unknown): boolean {
  const range = parseGrafanaRange(input);
  return range?.from === expected.from && range.to === expected.to;
}

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function stringValue(input: unknown): string {
  return typeof input === 'string' ? input : '';
}

function isRecord(input: unknown): input is Record<string, any> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

function sampleSpacing(series: ReturnType<typeof extractNumericSeries>): number | null {
  let spacing: number | null = null;
  for (const candidate of series) {
    for (let index = 1; index < candidate.points.length; index += 1) {
      const next = candidate.points[index].time - candidate.points[index - 1].time;
      if (next > 0 && (spacing === null || next < spacing)) spacing = next;
    }
  }
  return spacing;
}

function extractScopedVariables(context: CaptureContext, data: NonNullable<CaptureContext['data']>, queries: CaptureQuery[]) {
  const names = new Set<string>();
  for (const query of queries) {
    const source = `${query.expression ?? ''} ${query.executedQueryString ?? ''}`;
    for (const match of source.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) names.add(match[1]);
  }
  const requestScopes = isRecord(data.request?.scopedVars) ? data.request?.scopedVars : {};
  const contextScopes = isRecord(context.scopedVars) ? context.scopedVars : {};
  const scope = { ...contextScopes, ...requestScopes };
  const result: Array<{ name: string; values: string[] }> = [];
  for (const name of names) {
    const entry = scope[name];
    const value = isRecord(entry) ? entry.value : undefined;
    const rawValues = Array.isArray(value) ? value : [value];
    const values = rawValues.filter((item): item is string | number | boolean =>
      typeof item === 'string' || typeof item === 'number' && Number.isFinite(item) || typeof item === 'boolean')
      .map((item) => String(item).slice(0, 256)).slice(0, 50);
    if (values.length > 0) result.push({ name, values });
  }
  return result;
}

function extractSimpleScopedVariables(
  context: CaptureContext,
  data: NonNullable<CaptureContext['data']>,
  targets: Array<Record<string, unknown>>
): Record<string, string> {
  const refs = new Set<string>();
  for (const target of targets) {
    const expression = stringValue(target.expr) || stringValue(target.query);
    for (const match of expression.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) refs.add(match[1]);
  }
  const requestScopes = isRecord(data.request?.scopedVars) ? data.request?.scopedVars : {};
  const contextScopes = isRecord(context.scopedVars) ? context.scopedVars : {};
  const scopes = { ...contextScopes, ...requestScopes };
  const values: Record<string, string> = {};
  for (const name of refs) {
    const entry = scopes[name];
    const raw = isRecord(entry) ? entry.value : undefined;
    if (typeof raw === 'string' || typeof raw === 'number' && Number.isFinite(raw) || typeof raw === 'boolean') {
      values[name] = String(raw);
    }
  }
  return values;
}
