export interface Point2D {
  x: number;
  y: number;
}

const EPSILON = 1e-9;

export function hasSelfIntersection(input: Point2D[]): boolean {
  const points = input.length > 3 && samePoint(input[0], input[input.length - 1]) ? input.slice(0, -1) : input;
  for (let left = 0; left < points.length; left += 1) {
    const leftNext = (left + 1) % points.length;
    for (let right = left + 1; right < points.length; right += 1) {
      const rightNext = (right + 1) % points.length;
      if (left === right || leftNext === right || rightNext === left) continue;
      if (segmentsIntersect(points[left], points[leftNext], points[right], points[rightNext])) return true;
    }
  }
  return false;
}

function segmentsIntersect(a: Point2D, b: Point2D, c: Point2D, d: Point2D): boolean {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  if (opposite(abC, abD) && opposite(cdA, cdB)) return true;
  return Math.abs(abC) <= EPSILON && onSegment(a, b, c) ||
    Math.abs(abD) <= EPSILON && onSegment(a, b, d) ||
    Math.abs(cdA) <= EPSILON && onSegment(c, d, a) ||
    Math.abs(cdB) <= EPSILON && onSegment(c, d, b);
}

function cross(a: Point2D, b: Point2D, c: Point2D): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function opposite(left: number, right: number): boolean {
  return left > EPSILON && right < -EPSILON || left < -EPSILON && right > EPSILON;
}

function onSegment(a: Point2D, b: Point2D, point: Point2D): boolean {
  return point.x >= Math.min(a.x, b.x) - EPSILON && point.x <= Math.max(a.x, b.x) + EPSILON &&
    point.y >= Math.min(a.y, b.y) - EPSILON && point.y <= Math.max(a.y, b.y) + EPSILON;
}

function samePoint(left: Point2D, right: Point2D): boolean {
  return Math.abs(left.x - right.x) <= EPSILON && Math.abs(left.y - right.y) <= EPSILON;
}
