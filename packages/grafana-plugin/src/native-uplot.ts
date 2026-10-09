import { UPlotConfigBuilder } from '@grafana/ui';
import type { DataFrame } from '@grafana/data';
import type uPlot from 'uplot';
import { nativeScaleSignature } from './native-scale-signature';
import { nativeVectorSignature, numericPointsSignature } from './native-vector-signature';
import { hasSelfIntersection } from './native-polygon';

import {
  FREEHAND_GRAFANA_VERSION,
  FREEHAND_UPLOT_VERSION,
  MAX_FREEHAND_VERTICES,
  extractNumericSeries,
  parseGrafanaRange,
  type CaptureSnapshot,
  type FreehandPlotBinding,
  type FreehandSelection,
  type NumericSeries,
  type PanelDataLike,
} from '../../shared/src/index';
import type { CaptureContext } from './capture';

const MAX_FRAME_VALUES = 10_000;
const MAX_POINT_TESTS = 100_000;
const MAX_GESTURE_MS = 200;
const MAX_NATIVE_BINDING_VALUES = 250_000;
const registry = new Map<string, NativePlotRecord>();
const preparedFrames = new WeakMap<UPlotConfigBuilder, FrameSnapshot[]>();
const hookedBuilders = new WeakSet<UPlotConfigBuilder>();
let adapterInstalled = false;
let builderSetupCount = 0;
let preparedDataCount = 0;
let readyHookCount = 0;

interface NativePlotRecord {
  uid: string;
  builder: UPlotConfigBuilder;
  plot: uPlot;
  frames: FrameSnapshot[];
  mismatch?: string;
}

interface FrameSnapshot {
  refId?: string;
  name?: string;
  fields: Array<{ name?: string; type?: string; labels: Record<string, string>; values: unknown[]; origin?: { frameIndex: number; fieldIndex: number } }>;
}

interface NativeSeriesBinding {
  source: NumericSeries;
  dataIndex: number;
  scale: string;
}

interface NativeMatch {
  record: NativePlotRecord;
  rect: DOMRect;
  series: NativeSeriesBinding[];
  signature: string;
}

export function installNativeUPlotAdapter(): boolean {
  const grafanaVersion = getGrafanaVersion();
  if (grafanaVersion !== FREEHAND_GRAFANA_VERSION || adapterInstalled) return false;

  const prototype = UPlotConfigBuilder.prototype;
  const originalSetPrepData = prototype.setPrepData;
  const originalGetConfig = prototype.getConfig;
  prototype.setPrepData = function (prepData) {
    const builder = this;
    builderSetupCount += 1;
    return originalSetPrepData.call(builder, (frames, groups) => {
      preparedDataCount += 1;
      if (frames.length > 100 || frames.some((frame) => frame.length > MAX_FRAME_VALUES) || !frameValuesWithinLimit(frames)) {
        preparedFrames.delete(builder);
        const current = registry.get(builder.uid);
        if (current?.builder === builder) registry.set(builder.uid, { ...current, frames: [] });
      } else {
        const snapshot = snapshotFrames(frames);
        preparedFrames.set(builder, snapshot);
        const current = registry.get(builder.uid);
        if (current?.builder === builder) registry.set(builder.uid, { ...current, frames: snapshot });
      }
      return prepData(frames, groups);
    });
  };
  prototype.getConfig = function (...args) {
    const builder = this;
    if (!hookedBuilders.has(builder)) {
      hookedBuilders.add(builder);
      builder.addHook('ready', (plot) => {
        readyHookCount += 1;
        const frames = preparedFrames.get(builder);
        if (!frames || !plot.root?.isConnected || !plot.over?.isConnected) return;
        registry.set(builder.uid, { uid: builder.uid, builder, plot, frames });
      });
      builder.addHook('destroy', (plot) => {
        const current = registry.get(builder.uid);
        if (current?.plot === plot) {
          registry.delete(builder.uid);
          preparedFrames.delete(builder);
        }
      });
    }
    return originalGetConfig.apply(builder, args);
  };
  adapterInstalled = true;
  return true;
}

export function bindNativeUPlot(context: CaptureContext, capture: CaptureSnapshot): {
  descriptor: FreehandPlotBinding;
  resolve: (vertices: Array<{ x: number; y: number }>) => FreehandSelection;
} {
  if (!adapterInstalled || getGrafanaVersion() !== FREEHAND_GRAFANA_VERSION) {
    throw new Error(`Freehand capture requires the verified Grafana ${FREEHAND_GRAFANA_VERSION} renderer.`);
  }
  const bindStarted = performance.now();
  const bindDeadline = bindStarted + MAX_GESTURE_MS;
  const records = [...registry.values()];
  const matches = records.flatMap((record) => {
    const match = matchNativePlot(record, context, capture, bindDeadline);
    return match ? [match] : [];
  });
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `The panel data could not be matched to one live native timeseries renderer (registry=${records.length}, reason=${records[0]?.mismatch ?? 'none'}, adapter=${adapterInstalled}, builders=${builderSetupCount}, preparations=${preparedDataCount}, readyHooks=${readyHookCount}). Refresh once and try again.`
      : 'More than one identical native timeseries plot matched this panel; freehand binding is ambiguous.');
  }
  if (performance.now() - bindStarted > MAX_GESTURE_MS) {
    throw new Error('Matching the native chart exceeded the supported 200 ms work budget. Reduce the visible series or sample count and retry.');
  }

  const initial = matches[0];
  const descriptor: FreehandPlotBinding = {
    id: crypto.randomUUID(),
    captureId: capture.captureId,
    grafanaVersion: FREEHAND_GRAFANA_VERSION,
    uPlotVersion: FREEHAND_UPLOT_VERSION,
    plotRect: { left: initial.rect.left, top: initial.rect.top, width: initial.rect.width, height: initial.rect.height },
  };

  return {
    descriptor,
    resolve(vertices) {
      const resolveStarted = performance.now();
      const current = matchNativePlot(initial.record, context, capture, resolveStarted + MAX_GESTURE_MS);
      if (performance.now() - resolveStarted > MAX_GESTURE_MS) {
        throw new Error('Matching the native chart exceeded the supported 200 ms gesture budget. No selection was accepted.');
      }
      if (!current || !sameSignature(initial.signature, current.signature) || !sameRect(initial.rect, current.rect)) {
        throw new Error('The native chart data, visibility, scale, or layout changed during the gesture. Draw again on the current chart.');
      }
      validatePolygon(vertices, current.rect.width, current.rect.height);
      const plot = current.record.plot;
      const path = polygonPath(vertices);
      const pathContext = document.createElement('canvas').getContext('2d');
      if (!pathContext) throw new Error('The browser canvas geometry API is unavailable.');
      const xValues = vertices.map((point) => plot.posToVal(point.x, 'x'));
      const from = Math.max(capture.range.from, Math.floor(Math.min(...xValues)));
      const to = Math.min(capture.range.to, Math.ceil(Math.max(...xValues)));
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
        throw new Error('The freehand path did not span an absolute time interval inside the captured request range.');
      }

      const started = resolveStarted;
      let tested = 0;
      const candidates: FreehandSelection['candidates'] = [];
      for (const binding of current.series) {
        const pointIndexes: number[] = [];
        for (let index = 0; index < binding.source.points.length; index += 1) {
          if (++tested > MAX_POINT_TESTS || performance.now() - started > MAX_GESTURE_MS) {
            throw new Error('The chart has too many samples to resolve this freehand selection within the supported work limit.');
          }
          const point = binding.source.points[index];
          if (point.time < from || point.time > to) continue;
          const x = plot.valToPos(point.time, 'x');
          const y = plot.valToPos(point.value, binding.scale);
          if (Number.isFinite(x) && Number.isFinite(y) && plot.over?.isConnected && pathContext.isPointInPath(path, x, y)) {
            pointIndexes.push(index);
          }
        }
        if (pointIndexes.length > 0) candidates.push({ seriesId: binding.source.id, sampleCount: binding.source.points.length, pointIndexes });
      }
      if (candidates.length === 0) {
        throw new Error('The freehand path did not enclose any available native data samples. Draw around one or more visible points.');
      }
      const latest = matchNativePlot(initial.record, context, capture, started + MAX_GESTURE_MS);
      if (performance.now() - started > MAX_GESTURE_MS) {
        throw new Error('Checking the native chart exceeded the supported 200 ms gesture budget. No selection was accepted.');
      }
      if (!latest || !sameSignature(initial.signature, latest.signature) || !sameRect(initial.rect, latest.rect)) {
        throw new Error('The chart changed while Simurgh was checking samples. No freehand selection was accepted.');
      }
      return {
        renderer: 'grafana-uplot',
        grafanaVersion: FREEHAND_GRAFANA_VERSION,
        uPlotVersion: FREEHAND_UPLOT_VERSION,
        plotSize: { width: current.rect.width, height: current.rect.height },
        vertices: vertices.map(({ x, y }) => ({ x, y })),
        interval: { from, to },
        candidates,
      };
    },
  };
}

function matchNativePlot(record: NativePlotRecord, context: CaptureContext, capture: CaptureSnapshot, deadline: number): NativeMatch | null {
  const reject = (reason: string): null => {
    record.mismatch = reason;
    return null;
  };
  record.mismatch = undefined;
  const plot = record.plot;
  const data = context.data;
  const frames = data?.series;
  if (!data || data.state !== 'Done' || !Array.isArray(frames) || frames.length === 0) return reject('panel data is incomplete');
  if (performance.now() > deadline) return reject('native binding exceeded the 200 ms work budget');
  if (!frameValuesWithinLimit(frames)) return reject('panel frames exceed the bounded sample-matching work limit');
  if (!plot.root?.isConnected || !plot.over?.isConnected) return reject('the registered native plot is disconnected');
  if (!Array.isArray(plot.data) || !Array.isArray(plot.series) || plot.data.length !== capture.series.length + 1 ||
    plot.series.length !== plot.data.length) return reject('native plot vectors differ from the captured candidate count');
  if (!Array.isArray(record.frames) || record.frames.length === 0) return reject('renderer frames are no longer available');
  const frameMismatch = frameMetadataMismatch(record.frames, frames, deadline);
  if (frameMismatch) return reject(frameMismatch);
  if (performance.now() > deadline) return reject('native binding exceeded the 200 ms work budget');

  const requestRange = parseGrafanaRange(data.request?.range);
  if (!requestRange || requestRange.from !== capture.range.from || requestRange.to !== capture.range.to) return reject('request bounds differ from the captured range');
  const expectedSeries = extractNumericSeries(data as PanelDataLike);
  if (performance.now() > deadline) return reject('native candidate extraction exceeded the 200 ms work budget');
  if (!sameNumericSeries(expectedSeries, capture.series)) return reject('extracted numeric candidates differ from the capture');
  const rect = plot.over.getBoundingClientRect();
  if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width < 100 || rect.height < 60) return reject('native plot has no usable interaction rectangle');
  const xValues = readValues(plot.data[0]);
  if (!xValues || xValues.length < 2 || !xValues.every((value) => typeof value === 'number' && Number.isFinite(value))) return reject('native x values are unavailable');
  if (xValues.length * (plot.data.length - 1) > MAX_NATIVE_BINDING_VALUES) {
    return reject('the native chart exceeds the bounded sample-matching work limit');
  }

  const vectorIndexes = new Map<string, number[]>();
  for (let dataIndex = 1; dataIndex < plot.data.length; dataIndex += 1) {
    if (performance.now() > deadline) return reject('native vector indexing exceeded the 200 ms work budget');
    const values = readValues(plot.data[dataIndex]);
    if (!values) return reject('a native sample vector is unavailable');
    const signature = nativeVectorSignature(xValues, values);
    if (signature === null) return reject('native sample vector lengths differ');
    const indexes = vectorIndexes.get(signature) ?? [];
    indexes.push(dataIndex);
    vectorIndexes.set(signature, indexes);
  }

  const seriesBindings: NativeSeriesBinding[] = [];
  const usedDataIndexes = new Set<number>();
  const fields = frames.flatMap((frame) => (frame.fields ?? []).map((field) => ({ frame, refId: frame.refId, field })));
  for (const candidate of capture.series) {
    if (performance.now() > deadline) return reject('native field matching exceeded the 200 ms work budget');
    const sourceFields = fields.filter(({ refId, field }) => refId === candidate.refId && field.type === 'number' &&
      field.name === candidate.name && sameLabels(field.labels, candidate.labels));
    if (sourceFields.length !== 1) return reject('a captured series does not map to exactly one native numeric field');
    const { frame: sourceFrame, field } = sourceFields[0];
    const fieldValues = readValues(field.values);
    const timeFields = (sourceFrame.fields ?? []).filter((item) =>
      item.type === 'time' || item.type === 'string' && item.name?.toLowerCase() === 'time');
    if (timeFields.length !== 1) return reject('a captured series does not have exactly one source time field');
    const times = readValues(timeFields[0].values);
    if (!fieldValues || !times || fieldValues.length !== times.length ||
      finitePointSignature(times, fieldValues, deadline) !== numericPointsSignature(candidate.points)) {
      return reject('native source field samples differ from the captured series');
    }
    const signature = numericPointsSignature(candidate.points);
    const possibleIndexes = (vectorIndexes.get(signature) ?? []).filter((dataIndex) => !usedDataIndexes.has(dataIndex));
    if (possibleIndexes.length !== 1) return reject('a native data vector does not uniquely match its captured samples');
    const dataIndex = possibleIndexes[0];
    const plotted = plot.series[dataIndex];
    const scale = plotted?.scale;
    const nativeScale = typeof scale === 'string' ? plot.scales[scale] : undefined;
    if (plotted?.show !== true || typeof plotted.label !== 'string' || !scale || !nativeScale ||
      typeof nativeScale.min !== 'number' || !Number.isFinite(nativeScale.min) ||
      typeof nativeScale.max !== 'number' || !Number.isFinite(nativeScale.max) || nativeScale.min >= nativeScale.max) return reject('a captured series is hidden or has no finite native scale');
    usedDataIndexes.add(dataIndex);
    seriesBindings.push({ source: candidate, dataIndex, scale });
  }
  if (usedDataIndexes.size !== capture.series.length || seriesBindings.length !== capture.series.length) return reject('not every captured series maps to a unique native vector');
  return { record, rect, series: seriesBindings, signature: nativeSignature(plot, record.frames, seriesBindings, xValues) };
}

function frameMetadataMismatch(nativeFrames: FrameSnapshot[], contextFrames: NonNullable<CaptureContext['data']>['series'], deadline: number): string | null {
  if (!contextFrames || (contextFrames.some((frame) => (frame.meta?.transformations?.length ?? 0) > 0))) return 'panel transformations are unsupported';
  const nativeNumeric = nativeFrames.flatMap((frame) => frame.fields
    .filter((field) => field.type === 'number').map((field) => ({ frame, field })));
  const contextNumeric = contextFrames.flatMap((frame, frameIndex) => (frame.fields ?? [])
    .map((field, fieldIndex) => ({ frame, frameIndex, field, fieldIndex }))
    .filter(({ field }) => field.type === 'number'));
  if (nativeNumeric.length === 0 || nativeNumeric.length !== contextNumeric.length) {
    return `native/context numeric field counts differ (${nativeNumeric.length}/${contextNumeric.length})`;
  }
  const matchedNativeFields = new Set<(typeof nativeNumeric)[number]['field']>();
  for (const { frame: contextFrame, frameIndex, field, fieldIndex } of contextNumeric) {
    if (performance.now() > deadline) return 'native field comparison exceeded the 200 ms work budget';
    const contextTimeFields = (contextFrame.fields ?? []).filter((item) => item.type === 'time' ||
      item.type === 'string' && item.name?.toLowerCase() === 'time');
    if (contextTimeFields.length !== 1) return 'a context numeric field does not have exactly one source time field';
    const contextTimes = readValues(contextTimeFields[0].values);
    const contextValues = readValues(field.values);
    if (!contextTimes || !contextValues || contextTimes.length !== contextValues.length) return 'a context numeric field vector is unavailable';
    const sameNameAndType = nativeNumeric.filter(({ frame, field: nativeField }) => {
      const origin = nativeField.origin;
      const sourceMatches = origin
        ? origin.frameIndex === frameIndex && origin.fieldIndex === fieldIndex
        : frame.refId === contextFrame.refId;
      return sourceMatches && nativeField.name === field.name && nativeField.type === field.type;
    });
    const sameIdentity = sameNameAndType.filter(({ field: nativeField }) => sameLabels(nativeField.labels, field.labels ?? {}));
    if (performance.now() > deadline) return 'native field comparison exceeded the 200 ms work budget';
    const identity = `${contextFrame.refId ?? 'unknown'}:${field.name ?? 'unknown'} labels=${JSON.stringify(normalizeLabels(field.labels))}`;
    if (sameIdentity.length !== 1) return sameIdentity.length === 0
      ? `native numeric field identity differs for ${identity} (${sameNameAndType.length} same-name/type renderer fields)`
      : `native numeric field identity is ambiguous for ${identity} (${sameIdentity.length} exact renderer matches)`;
    const match = sameIdentity[0];
    if (matchedNativeFields.has(match.field)) return `native numeric field identity is ambiguous for ${identity} (renderer field was already matched)`;
    const nativeTimeFields = match.frame.fields.filter((item) => item.type === 'time');
    if (nativeTimeFields.length !== 1) return `native numeric field has ${nativeTimeFields.length} source time fields for ${identity}`;
    const nativeSignature = finitePointSignature(nativeTimeFields[0].values, match.field.values, deadline);
    const contextSignature = finitePointSignature(contextTimes, contextValues, deadline);
    if (performance.now() > deadline) return 'native field comparison exceeded the 200 ms work budget';
    if (nativeSignature === null || contextSignature === null || nativeSignature !== contextSignature) {
      return `native numeric field samples differ for ${identity}`;
    }
    matchedNativeFields.add(match.field);
  }
  return null;
}

function frameValuesWithinLimit(frames: Array<{ fields?: Array<{ values?: { length?: unknown } }> }>): boolean {
  let total = 0;
  for (const frame of frames) {
    for (const field of frame.fields ?? []) {
      const length = field.values?.length;
      if (typeof length !== 'number' || !Number.isInteger(length) || length < 0) return false;
      total += length;
      if (total > MAX_NATIVE_BINDING_VALUES) return false;
    }
  }
  return true;
}

function finitePointSignature(times: unknown[], values: unknown[], deadline: number): string | null {
  if (times.length !== values.length) return null;
  const points: Array<[number, number]> = [];
  let previousTime = -Infinity;
  for (let index = 0; index < times.length; index += 1) {
    if ((index & 255) === 0 && performance.now() > deadline) return null;
    const time = times[index];
    const value = values[index];
    if (typeof time !== 'number' || !Number.isFinite(time) || time <= previousTime) return null;
    previousTime = time;
    if (value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    points.push([time, value]);
  }
  return JSON.stringify(points);
}

function nativeSignature(plot: uPlot, frames: FrameSnapshot[], series: NativeSeriesBinding[], xValues: unknown[]): string {
  return JSON.stringify({
    data: plot.data.map((values) => readValues(values)),
    xScale: nativeScaleSignature(plot.scales.x),
    series: series.map((item) => ({ id: item.source.id, index: item.dataIndex, scale: item.scale,
      show: plot.series[item.dataIndex]?.show, label: plot.series[item.dataIndex]?.label,
      scaleState: nativeScaleSignature(plot.scales[item.scale]) })),
    frames: frames.map((frame) => ({ refId: frame.refId, name: frame.name, fields: frame.fields.map((field) => ({
      name: field.name, type: field.type, labels: field.labels, values: field.values,
    })) })),
    x: xValues,
  });
}

function sameNumericSeries(left: NumericSeries[], right: NumericSeries[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((series, index) => series.id === right[index]?.id && series.points.length === right[index]?.points.length &&
    series.points.every((point, pointIndex) => point.time === right[index].points[pointIndex].time && point.value === right[index].points[pointIndex].value));
}

function sameLabels(left: unknown, right: Record<string, unknown>): boolean {
  const actual = normalizeLabels(left);
  const keys = Object.keys(actual).sort();
  return keys.length === Object.keys(right).length && keys.every((key) => actual[key] === right[key]);
}

function normalizeLabels(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  return Object.fromEntries(Object.entries(input).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .map(([key, value]) => [key, String(value)]).sort(([left], [right]) => left.localeCompare(right)));
}

function readValues(input: unknown): unknown[] | null {
  if (Array.isArray(input)) return input.length <= MAX_FRAME_VALUES ? input.slice() : null;
  if (ArrayBuffer.isView(input)) return (input as ArrayBufferView).byteLength /
    ((input as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1) <= MAX_FRAME_VALUES
    ? Array.from(input as unknown as ArrayLike<unknown>) : null;
  if (!input || typeof input !== 'object') return null;
  const vector = input as { length?: unknown; get?: (index: number) => unknown; toArray?: () => unknown[] };
  if (typeof vector.length !== 'number' || !Number.isInteger(vector.length) || vector.length < 0 || vector.length > MAX_FRAME_VALUES) return null;
  if (typeof vector.toArray === 'function') return vector.toArray().slice();
  if (typeof vector.get === 'function') return Array.from({ length: vector.length }, (_unused, index) => vector.get!(index));
  return null;
}

function snapshotFrames(frames: DataFrame[]): FrameSnapshot[] {
  return frames.map((frame) => ({
    refId: frame.refId,
    name: frame.name,
    fields: frame.fields.map((field) => ({
      name: field.name,
      type: field.type,
      labels: normalizeLabels(field.labels),
      values: readValues(field.values) ?? [],
      origin: field.state?.origin && Number.isInteger(field.state.origin.frameIndex) && Number.isInteger(field.state.origin.fieldIndex)
        ? { frameIndex: field.state.origin.frameIndex, fieldIndex: field.state.origin.fieldIndex }
        : undefined,
    })),
  }));
}

function getGrafanaVersion(): string | undefined {
  return (window as Window & { grafanaBootData?: { settings?: { buildInfo?: { version?: string } } } })
    .grafanaBootData?.settings?.buildInfo?.version;
}

function sameRect(left: DOMRect, right: DOMRect): boolean {
  return left.left === right.left && left.top === right.top && left.width === right.width && left.height === right.height;
}

function sameSignature(left: string, right: string): boolean {
  return left === right;
}

function validatePolygon(vertices: Array<{ x: number; y: number }>, width: number, height: number) {
  if (!Array.isArray(vertices) || vertices.length < 3 || vertices.length > MAX_FREEHAND_VERTICES ||
    vertices.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > width || point.y < 0 || point.y > height)) {
    throw new Error('Draw a polygon with at least three points entirely inside the active native chart.');
  }
  let twiceArea = 0;
  for (let index = 0; index < vertices.length; index += 1) {
    const point = vertices[index];
    const next = vertices[(index + 1) % vertices.length];
    twiceArea += point.x * next.y - next.x * point.y;
  }
  if (Math.abs(twiceArea) < 4 || hasSelfIntersection(vertices)) {
    throw new Error('The freehand polygon is empty, too small, or self-intersecting. Draw a simple closed shape.');
  }
}

function polygonPath(vertices: Array<{ x: number; y: number }>): Path2D {
  const path = new Path2D();
  path.moveTo(vertices[0].x, vertices[0].y);
  for (const point of vertices.slice(1)) path.lineTo(point.x, point.y);
  path.closePath();
  return path;
}
