import { describe, expect, it } from 'vitest';

import { hasSelfIntersection } from '../packages/grafana-plugin/src/native-polygon';

describe('native freehand polygon validation', () => {
  it('accepts a convex sampled circle with collinear or nearly collinear edges', () => {
    const circle = Array.from({ length: 40 }, (_unused, index) => {
      const angle = index / 39 * Math.PI * 2;
      return { x: 100 + 90 * Math.cos(angle), y: 100 + 80 * Math.sin(angle) };
    });
    expect(hasSelfIntersection(circle)).toBe(false);
  });

  it('rejects proper crossings and non-adjacent collinear overlaps', () => {
    expect(hasSelfIntersection([{ x: 0, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }, { x: 4, y: 0 }])).toBe(true);
    expect(hasSelfIntersection([
      { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 4 }, { x: 2, y: 0 }, { x: 0, y: 4 },
    ])).toBe(true);
  });
});
