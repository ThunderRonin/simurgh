import { describe, expect, it } from 'vitest';

import { nativeScaleSignature } from '../packages/grafana-plugin/src/native-scale-signature';

describe('native uPlot scale revision', () => {
  it('changes when x bounds or scale conversion semantics change', () => {
    const base = { min: 1_000, max: 5_000, time: true, distr: 1, dir: 1, ori: 0 };
    expect(nativeScaleSignature(base)).not.toBe(nativeScaleSignature({ ...base, min: 2_000 }));
    expect(nativeScaleSignature(base)).not.toBe(nativeScaleSignature({ ...base, max: 6_000 }));
    expect(nativeScaleSignature(base)).not.toBe(nativeScaleSignature({ ...base, distr: 2 }));
    expect(nativeScaleSignature(base)).not.toBe(nativeScaleSignature({ ...base, time: false }));
  });

  it('tracks native forward and inverse transform identity', () => {
    const fwdA = (value: number) => value;
    const fwdB = (value: number) => value * 2;
    const bwd = (value: number) => value;
    const base = { min: 1, max: 5, fwd: fwdA, bwd };
    expect(nativeScaleSignature(base)).not.toBe(nativeScaleSignature({ ...base, fwd: fwdB }));
    expect(nativeScaleSignature(base)).not.toBe(nativeScaleSignature({ ...base, bwd: (value: number) => value / 2 }));
  });
});
