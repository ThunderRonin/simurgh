export interface FreehandSample {
  seriesId?: string;
  refId?: string;
  labels: Record<string, string>;
  time: number;
  value: number;
  x: number;
  y: number;
}

export interface FreehandRange {
  from: number;
  to: number;
}

export interface FreehandPlotRect {
  width: number;
  height: number;
}

export function freehandPathAroundSamples(
  series: Array<{ id?: string; refId?: string; labels?: Record<string, string>; points?: Array<{ time: number; value: number }> }>,
  range: FreehandRange,
  plotRect: FreehandPlotRect,
): { vertices: Array<{ x: number; y: number }>; targets: FreehandSample[] };

export function pointInPolygon(point: { x: number; y: number }, vertices: Array<{ x: number; y: number }>): boolean;
