import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@grafana/ui', () => {
  class TestUPlotConfigBuilder {
    uid = 'cpu-panel';
    hooks: Record<string, (plot: any) => void> = {};
    prepData?: (frames: any[], groups: any[]) => void;

    setPrepData(prepData: (frames: any[], groups: any[]) => void) {
      this.prepData = prepData;
      return this;
    }

    getConfig() {
      return {};
    }

    addHook(name: string, callback: (plot: any) => void) {
      this.hooks[name] = callback;
    }
  }
  return { UPlotConfigBuilder: TestUPlotConfigBuilder };
});

const from = 1_791_554_340_000;
const times = [from, from + 20_000, from + 40_000];
const rendererTimes = [from, from + 5_000, from + 10_000, from + 15_000, from + 20_000,
  from + 25_000, from + 30_000, from + 35_000, from + 40_000];
const valuesByCpu = [
  [86.55213333333332, 63.7465, 47.233761428571384],
  [79.1124, 70.3842, 56.9911],
  [88.0421, 72.7723, 60.3451],
  [83.7712, 68.1152, 50.9422],
];
const rendererValuesByCpu = valuesByCpu.map(([first, middle, last]) =>
  [first, null, null, null, middle, null, null, null, last]);

describe('native uPlot short-history binding', () => {
  let bindNativeUPlot: typeof import('../packages/grafana-plugin/src/native-uplot').bindNativeUPlot;
  let installNativeUPlotAdapter: typeof import('../packages/grafana-plugin/src/native-uplot').installNativeUPlotAdapter;
  let builder: any;
  let context: any;
  let capture: any;
  let rendererFrame: any;
  let nativePlot: any;

  beforeAll(async () => {
    vi.resetModules();
    const ui = await import('@grafana/ui');
    const Builder = ui.UPlotConfigBuilder as unknown as new () => any;
    builder = new Builder();
    vi.stubGlobal('window', { grafanaBootData: { settings: { buildInfo: { version: '13.2.3' } } } });
    ({ bindNativeUPlot, installNativeUPlotAdapter } = await import('../packages/grafana-plugin/src/native-uplot'));
    expect(installNativeUPlotAdapter()).toBe(true);

    const frames = valuesByCpu.map((values, cpu) => ({
      refId: 'A',
      fields: [
        { name: 'Time', type: 'time', values: times },
        { name: 'Value', type: 'number', labels: { cpu: String(cpu) }, values },
      ],
    }));
    rendererFrame = {
      // Grafana's joined/aligned frame carries source field indexes rather than a frame refId.
      fields: [
        { name: 'Time', type: 'time', values: rendererTimes },
        ...rendererValuesByCpu.map((values, cpu) => ({
          name: 'Value', type: 'number', labels: { cpu: String(cpu) }, values,
          state: { origin: { frameIndex: cpu, fieldIndex: 1 } },
        })),
      ],
    };
    builder.setPrepData(() => {});
    builder.prepData([rendererFrame], []);
    builder.getConfig();
    builder.hooks.ready(makePlot());

    context = {
      data: {
        state: 'Done',
        series: frames,
        request: { range: { from, to: times[2] } },
      },
    };
    capture = {
      captureId: 'short-history-capture',
      range: { from, to: times[2] },
      series: valuesByCpu.map((values, cpu) => ({
        id: `A:series:Value:cpu=${cpu}`,
        refId: 'A',
        name: 'Value',
        labels: { cpu: String(cpu) },
        points: times.map((time, index) => ({ time, value: values[index] })),
      })),
    };
  });

  afterAll(() => vi.unstubAllGlobals());

  it('matches sparse context samples to Grafana native vectors with null gap padding', () => {
    prepareNativePlot();
    expect(() => bindNativeUPlot(context, capture)).not.toThrow();
    const missing = structuredClone(context);
    missing.data.series[0].fields[1].values[1] += 1;
    expect(() => bindNativeUPlot(missing, capture)).toThrow(/native numeric field samples differ/);
  });

  it('rejects extra finite renderer samples and duplicate renderer timestamps', () => {
    const extraSample = structuredClone(rendererFrame);
    extraSample.fields[1].values[1] = 12;
    prepareNativePlot(extraSample);
    expect(() => bindNativeUPlot(context, capture)).toThrow(/native numeric field samples differ/);

    const missingSample = structuredClone(rendererFrame);
    missingSample.fields[1].values[0] = null;
    prepareNativePlot(missingSample);
    expect(() => bindNativeUPlot(context, capture)).toThrow(/native numeric field samples differ/);

    const nonFiniteGap = structuredClone(rendererFrame);
    nonFiniteGap.fields[1].values[1] = Number.NaN;
    prepareNativePlot(nonFiniteGap);
    expect(() => bindNativeUPlot(context, capture)).toThrow(/native numeric field samples differ/);

    const duplicateTime = structuredClone(rendererFrame);
    duplicateTime.fields[0].values[1] = duplicateTime.fields[0].values[0];
    prepareNativePlot(duplicateTime);
    expect(() => bindNativeUPlot(context, capture)).toThrow(/native numeric field samples differ/);

    prepareNativePlot();
  });

  it('still requires the plotted vector to match the captured finite samples exactly', () => {
    prepareNativePlot();
    nativePlot.data[1][1] = 12;
    expect(() => bindNativeUPlot(context, capture)).toThrow(/native data vector does not uniquely match its captured samples/);
    prepareNativePlot();
  });

  it('rejects native field origins that do not identify the captured source field', () => {
    const invalidOrigin = structuredClone(rendererFrame);
    invalidOrigin.fields[1].state.origin.frameIndex = 1;
    prepareNativePlot(invalidOrigin);
    expect(() => bindNativeUPlot(context, capture)).toThrow(/native numeric field identity differs/);
    prepareNativePlot();
  });

  it('uses strict frame refIds when native fields have no origin metadata', () => {
    const originless = structuredClone(rendererFrame);
    originless.refId = 'A';
    for (const field of originless.fields) delete field.state;
    prepareNativePlot(originless);
    expect(() => bindNativeUPlot(context, capture)).not.toThrow();

    originless.refId = 'B';
    prepareNativePlot(originless);
    expect(() => bindNativeUPlot(context, capture)).toThrow(/native numeric field identity differs/);
    prepareNativePlot();
  });

  it('rejects duplicate native origins with ambiguous field identity', () => {
    const duplicateOrigin = structuredClone(rendererFrame);
    duplicateOrigin.fields[2].labels = { cpu: '0' };
    duplicateOrigin.fields[2].state.origin = { frameIndex: 0, fieldIndex: 1 };
    prepareNativePlot(duplicateOrigin);
    expect(() => bindNativeUPlot(context, capture)).toThrow(/native numeric field identity is ambiguous/);
    prepareNativePlot();
  });

  function prepareNativePlot(frame = rendererFrame) {
    builder.prepData([frame], []);
    nativePlot = makePlot();
    builder.hooks.ready(nativePlot);
  }
});

function makePlot() {
  const rect = { left: 100, top: 100, width: 800, height: 400, right: 900, bottom: 500, x: 100, y: 100, toJSON: () => ({}) };
  const plot = {
    root: { isConnected: true },
    over: { isConnected: true, getBoundingClientRect: () => rect },
    data: [rendererTimes.slice(), ...rendererValuesByCpu.map((values) => values.slice())],
    series: [{}, ...valuesByCpu.map((_values, cpu) => ({ show: true, label: `CPU ${cpu}`, scale: 'y' }))],
    scales: { x: { min: from, max: times[2], time: true }, y: { min: 0, max: 100 } },
  };
  return plot;
}
