import { describe, expect, it } from 'vitest';
import { freehandPathAroundSamples, pointInPolygon } from './freehand-geometry.mjs';

const plot = { width: 835, height: 249 };

describe('sample-centered freehand test geometry', () => {
  it('centers on actual high CI CPU0 samples and misses them with the old bottom ellipse', () => {
    const range = { from: 1_791_556_754_928, to: 1_791_556_880_268 };
    const series = [
      { id: 'A:series:Value:cpu=0', refId: 'A', labels: { cpu: '0' }, points: [
        { time: 1_791_556_845_000, value: 72.16219000000001 },
        { time: 1_791_556_860_000, value: 56.783973333333314 },
        { time: 1_791_556_875_000, value: 37.48370111111111 },
      ] },
      { id: 'A:series:Value:cpu=1', refId: 'A', labels: { cpu: '1' }, points: [
        { time: 1_791_556_845_000, value: 71.9 },
        { time: 1_791_556_860_000, value: 48.2 },
        { time: 1_791_556_875_000, value: 21.4 },
      ] },
    ];
    const gesture = freehandPathAroundSamples(series, range, plot);
    expect(gesture.targets.map((target) => target.labels.cpu)).toContain('0');
    expect(gesture.targets.every((target) => pointInPolygon(target, gesture.vertices))).toBe(true);

    const oldBottomEllipse = Array.from({ length: 40 }, (_unused, index) => {
      const angle = index / 39 * Math.PI * 2;
      return { x: plot.width * (0.5 + 0.46 * Math.cos(angle)), y: plot.height * (0.92 + 0.079 * Math.sin(angle)) };
    });
    expect(gesture.targets.some((target) => pointInPolygon(target, oldBottomEllipse))).toBe(false);
  });

  it('keeps a low-CPU local sample near its real lower-chart position', () => {
    const range = { from: 10_000, to: 130_000 };
    const series = [
      { id: 'A:series:Value:cpu=0', refId: 'A', labels: { cpu: '0' }, points: [
        { time: 30_000, value: 8 }, { time: 70_000, value: 14 }, { time: 110_000, value: 26 },
      ] },
      { id: 'A:series:Value:cpu=1', refId: 'A', labels: { cpu: '1' }, points: [
        { time: 30_000, value: 12 }, { time: 70_000, value: 15 }, { time: 110_000, value: 44 },
      ] },
    ];
    const gesture = freehandPathAroundSamples(series, range, plot);
    expect(gesture.targets.map((target) => target.labels.cpu)).toContain('0');
    expect(gesture.targets.some((target) => target.y > plot.height / 2 && pointInPolygon(target, gesture.vertices))).toBe(true);
  });

  it('keeps a near-edge sample strictly inside an inset path', () => {
    const range = { from: 0, to: 120_000 };
    const series = [{ id: 'A:series:Value:cpu=0', refId: 'A', labels: { cpu: '0' }, points: [
      { time: 1_000, value: 60 },
    ] }];
    const gesture = freehandPathAroundSamples(series, range, plot);
    expect(gesture.targets[0].labels.cpu).toBe('0');
    expect(gesture.targets.every((target) => pointInPolygon(target, gesture.vertices))).toBe(true);
    expect(gesture.vertices.every((point) => point.x > 0 && point.x < plot.width && point.y > 0 && point.y < plot.height)).toBe(true);
  });

  it('contains zero- and one-percent samples and skips unusable timestamp edges', () => {
    const range = { from: 0, to: 120_000 };
    for (const value of [0, 1]) {
      const series = [{ id: 'A:series:Value:cpu=0', refId: 'A', labels: { cpu: '0' }, points: [
        { time: 1_000, value: 40 }, { time: 61_000, value }, { time: 119_000, value: 40 },
      ] }];
      const gesture = freehandPathAroundSamples(series, range, plot);
      expect(gesture.targets[0].labels.cpu).toBe('0');
      expect(gesture.targets[0].value).toBe(value);
      expect(gesture.targets[0].time).toBe(61_000);
      expect(pointInPolygon(gesture.targets[0], gesture.vertices)).toBe(true);
      expect(gesture.vertices.every((point) => point.x > 0 && point.x < plot.width && point.y >= 0 && point.y <= plot.height)).toBe(true);
    }
  });
});
