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
const times = [from - 15_000, from, from + 15_000, from + 30_000];
const valuesByCpu = [
  [null, 86.55213333333332, 63.7465, 47.233761428571384],
  [null, 79.1124, 70.3842, 56.9911],
  [null, 88.0421, 72.7723, 60.3451],
  [null, 83.7712, 68.1152, 50.9422],
];

describe('native uPlot short-history binding', () => {
  let bindNativeUPlot: typeof import('../packages/grafana-plugin/src/native-uplot').bindNativeUPlot;
  let installNativeUPlotAdapter: typeof import('../packages/grafana-plugin/src/native-uplot').installNativeUPlotAdapter;
  let builder: any;
  let context: any;
  let capture: any;

  beforeAll(async () => {
    vi.resetModules();
    const ui = await import('@grafana/ui');
    const Builder = ui.UPlotConfigBuilder as unknown as new () => any;
    builder = new Builder();
    vi.stubGlobal('window', { grafanaBootData: { settings: { buildInfo: { version: '13.2.3' } } } });
    ({ bindNativeUPlot, installNativeUPlotAdapter } = await import('../packages/grafana-plugin/src/native-uplot'));
    expect(installNativeUPlotAdapter()).toBe(true);

    const frame = {
      refId: 'A',
      fields: [
        { name: 'Time', type: 'time', values: times },
        ...valuesByCpu.map((values, cpu) => ({ name: 'Value', type: 'number', labels: { cpu: String(cpu) }, values })),
      ],
    };
    builder.setPrepData(() => {});
    builder.prepData([frame], []);
    builder.getConfig();
    builder.hooks.ready(makePlot());

    context = {
      data: {
        state: 'Done',
        series: [frame],
        request: { range: { from, to: times[3] } },
      },
    };
    capture = {
      captureId: 'short-history-capture',
      range: { from, to: times[3] },
      series: valuesByCpu.map((values, cpu) => ({
        id: `A:series:Value:cpu=${cpu}`,
        refId: 'A',
        name: 'Value',
        labels: { cpu: String(cpu) },
        points: times.flatMap((time, index) => typeof values[index] === 'number'
          ? [{ time, value: values[index] }]
          : []),
      })),
    };
  });

  afterAll(() => vi.unstubAllGlobals());

  it('binds four uniquely labeled short series and rejects a shifted leading-null vector', () => {
    expect(() => bindNativeUPlot(context, capture)).not.toThrow();
    const changed = structuredClone(context);
    changed.data.series[0].fields[1].values = valuesByCpu[0].slice(1);
    expect(() => bindNativeUPlot(changed, capture)).toThrow(/native numeric field values differ.*context=3 values\/0 nulls; renderer=4 values\/1 nulls/);
  });
});

function makePlot() {
  const rect = { left: 100, top: 100, width: 800, height: 400, right: 900, bottom: 500, x: 100, y: 100, toJSON: () => ({}) };
  const plot = {
    root: { isConnected: true },
    over: { isConnected: true, getBoundingClientRect: () => rect },
    data: [times, ...valuesByCpu],
    series: [{}, ...valuesByCpu.map((_values, cpu) => ({ show: true, label: `CPU ${cpu}`, scale: 'y' }))],
    scales: { x: { min: from - 15_000, max: times[3], time: true }, y: { min: 0, max: 100 } },
  };
  return plot;
}
