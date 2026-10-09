import { describe, expect, it } from 'vitest';

import { nativeVectorSignature, numericPointsSignature } from '../packages/grafana-plugin/src/native-vector-signature';

describe('native uPlot data-vector identity', () => {
  it('indexes each finite native sample once and ignores only nonnumeric gaps', () => {
    const signature = nativeVectorSignature([1000, 2000, 3000], [0.2, null, 0.8]);
    expect(signature).toBe(numericPointsSignature([{ time: 1000, value: 0.2 }, { time: 3000, value: 0.8 }]));
    expect(nativeVectorSignature([1000], [0.2, 0.3])).toBeNull();
  });

  it('preserves ordering and exact numeric identity', () => {
    const ordered = nativeVectorSignature([1000, 2000], [0.2, 0.8]);
    expect(ordered).not.toBe(nativeVectorSignature([2000, 1000], [0.8, 0.2]));
    expect(ordered).not.toBe(nativeVectorSignature([1000, 2000], [0.2, 0.8000000001]));
  });
});
