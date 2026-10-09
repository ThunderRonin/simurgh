export interface NativeScaleState {
  min?: number;
  max?: number;
  time?: boolean;
  auto?: unknown;
  range?: unknown;
  from?: string;
  distr?: number;
  log?: number;
  clamp?: unknown;
  asinh?: number;
  dir?: number;
  ori?: number;
  fwd?: (value: number) => number;
  bwd?: (value: number) => number;
}

const transformIds = new WeakMap<Function, number>();
let nextTransformId = 1;

export function nativeScaleSignature(scale: NativeScaleState | undefined): string {
  if (!scale) return 'missing';
  return JSON.stringify({
    min: scale.min,
    max: scale.max,
    time: scale.time,
    auto: scale.auto,
    range: scale.range,
    from: scale.from,
    distr: scale.distr,
    log: scale.log,
    clamp: scale.clamp,
    asinh: scale.asinh,
    dir: scale.dir,
    ori: scale.ori,
    fwd: transformId(scale.fwd),
    bwd: transformId(scale.bwd),
  });
}

function transformId(transform: Function | undefined): number | undefined {
  if (!transform) return undefined;
  let id = transformIds.get(transform);
  if (id === undefined) {
    id = nextTransformId++;
    transformIds.set(transform, id);
  }
  return id;
}
