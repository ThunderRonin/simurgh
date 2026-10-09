export interface NumericPoint {
  time: number;
  value: number;
}

export function nativeVectorSignature(times: unknown[], values: unknown[]): string | null {
  if (times.length !== values.length) return null;
  const points: Array<[number, number]> = [];
  for (let index = 0; index < times.length; index += 1) {
    const time = times[index];
    const value = values[index];
    if (typeof time === 'number' && Number.isFinite(time) && typeof value === 'number' && Number.isFinite(value)) {
      points.push([time, value]);
    }
  }
  return JSON.stringify(points);
}

export function numericPointsSignature(points: NumericPoint[]): string {
  return JSON.stringify(points.map((point) => [point.time, point.value]));
}
