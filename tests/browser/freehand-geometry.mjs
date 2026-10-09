export function freehandPathAroundSamples(series, range, plotRect) {
  const from = range.from;
  const to = range.to;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || plotRect.width <= 0 || plotRect.height <= 0) {
    throw new Error(`Cannot map freehand samples to an invalid plot range: ${JSON.stringify({ range, plotRect })}`);
  }

  const byTime = new Map();
  const sampleTimes = new Set();
  for (const item of series) {
    for (const point of item.points ?? []) {
      if (!Number.isFinite(point.time) || !Number.isFinite(point.value) || point.time < from || point.time > to ||
        point.value < 0 || point.value > 100) continue;
      const sample = {
        seriesId: item.id,
        refId: item.refId,
        labels: item.labels ?? {},
        time: point.time,
        value: point.value,
        x: (point.time - from) / (to - from) * plotRect.width,
        y: (100 - point.value) / 100 * plotRect.height,
      };
      const samples = byTime.get(point.time) ?? [];
      samples.push(sample);
      byTime.set(point.time, samples);
      sampleTimes.add(point.time);
    }
  }

  const times = [...sampleTimes].sort((left, right) => left - right);
  const minimumEdgeGap = 6.25;
  let chosenGroup;
  let chosenSpan = Infinity;
  let chosenScore = Infinity;
  const cpuZeroSamples = [...byTime.values()].flat().filter((sample) =>
    (sample.labels.cpu === '0' || sample.seriesId?.endsWith('cpu=0')) &&
    Math.min(sample.x, plotRect.width - sample.x) >= minimumEdgeGap);
  if (cpuZeroSamples.length) {
    const anchor = cpuZeroSamples.sort((left, right) =>
      Math.abs(left.x - plotRect.width / 2) - Math.abs(right.x - plotRect.width / 2))[0];
    chosenGroup = [anchor];
    chosenSpan = 0;
    const companion = (byTime.get(anchor.time) ?? []).filter((sample) => sample !== anchor)
      .sort((left, right) => Math.abs(left.y - anchor.y) - Math.abs(right.y - anchor.y))[0];
    if (companion && Math.abs(companion.y - anchor.y) <= plotRect.height * 0.2) {
      chosenGroup.push(companion);
      chosenSpan = Math.abs(companion.y - anchor.y);
    }
  } else {
    for (const samples of byTime.values()) {
      if (samples.length < 2) continue;
      const sorted = samples.slice().sort((left, right) => left.y - right.y);
      const span = sorted.at(-1).y - sorted[0].y;
      const distanceFromCenter = Math.abs(sorted[0].x - plotRect.width / 2) / plotRect.width;
      const score = distanceFromCenter + span / plotRect.height;
      if (span <= plotRect.height * 0.2 && score < chosenScore) {
        chosenGroup = [sorted[0], sorted.at(-1)];
        chosenSpan = span;
        chosenScore = score;
      }
    }
  }
  let chosen = chosenGroup;
  if (!chosen) {
    chosen = [...byTime.values()].flat().sort((left, right) =>
      Math.abs(left.x - plotRect.width / 2) + Math.abs(left.y - plotRect.height / 2) -
      Math.abs(right.x - plotRect.width / 2) - Math.abs(right.y - plotRect.height / 2))[0];
    chosen = chosen ? [chosen] : [];
    chosenSpan = 0;
  }
  if (!chosen?.length) throw new Error('The current datasource response has no finite CPU sample inside the native plot range.');

  const center = {
    x: chosen.reduce((sum, sample) => sum + sample.x, 0) / chosen.length,
    y: chosen.reduce((sum, sample) => sum + sample.y, 0) / chosen.length,
  };
  const gap = times.map((time) => Math.abs((time - from) / (to - from) * plotRect.width - center.x))
    .filter((distance) => distance > 0).sort((left, right) => left - right)[0];
  const edgeGap = Math.min(center.x, plotRect.width - center.x);
  const radiusX = Math.min(18, (gap ?? 72) / 4, edgeGap * 0.4);
  if (radiusX < 2.5) throw new Error(`No CPU sample has enough inset plot space for a bounded gesture: ${center.x}`);
  const radiusY = Math.max(8, chosenSpan / 2 + 6);
  center.y = Math.min(plotRect.height - radiusY, Math.max(radiusY, center.y));
  const vertices = Array.from({ length: 33 }, (_unused, index) => {
    const angle = index / 32 * Math.PI * 2;
    return {
      x: center.x + radiusX * Math.cos(angle),
      y: Math.max(0, Math.min(plotRect.height, center.y + radiusY * Math.sin(angle))),
    };
  });
  if (vertices.some((point) => point.x < 0 || point.x > plotRect.width || point.y < 0 || point.y > plotRect.height)) {
    throw new Error(`Sample-centered freehand path extends outside the native plot: ${JSON.stringify({ center, radiusX, radiusY, plotRect })}`);
  }
  if (!chosen.every((sample) => pointInPolygon(sample, vertices))) {
    throw new Error('The generated freehand path does not enclose its target samples.');
  }
  return { vertices, targets: chosen };
}

export function pointInPolygon(point, vertices) {
  let inside = false;
  for (let index = 0, previous = vertices.length - 1; index < vertices.length; previous = index++) {
    const a = vertices[index];
    const b = vertices[previous];
    const cross = (point.x - a.x) * (b.y - a.y) - (point.y - a.y) * (b.x - a.x);
    if (Math.abs(cross) < 1e-7 && point.x >= Math.min(a.x, b.x) - 1e-7 && point.x <= Math.max(a.x, b.x) + 1e-7 &&
      point.y >= Math.min(a.y, b.y) - 1e-7 && point.y <= Math.max(a.y, b.y) + 1e-7) return true;
    const crosses = (a.y > point.y) !== (b.y > point.y) &&
      point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}
