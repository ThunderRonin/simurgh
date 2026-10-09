import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ?? 'chromium';
const configurations = {
  chromium: {
    outDir: 'dist',
    manifest: 'manifest.json',
    entryPoint: 'src/content.tsx',
    output: 'content.js',
    esbuildTarget: ['chrome120'],
  },
  firefox: {
    outDir: 'dist-firefox',
    manifest: 'manifest.firefox.json',
    entryPoint: 'src/firefox-bootstrap.ts',
    output: 'firefox-bootstrap.js',
    esbuildTarget: ['firefox140'],
  },
};
const configuration = configurations[target];
if (!configuration) throw new Error(`Unknown extension target "${target}". Use "chromium" or "firefox".`);

const outDir = path.join(here, configuration.outDir);
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await build({
  entryPoints: [path.join(here, configuration.entryPoint)],
  outfile: path.join(outDir, configuration.output),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: configuration.esbuildTarget,
  minify: true,
});
await copyFile(path.join(here, configuration.manifest), path.join(outDir, 'manifest.json'));
await mkdir(path.join(outDir, 'icons'), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await copyFile(
    path.resolve(here, `../../assets/brand/clean/simurgh-mark-${size}.png`),
    path.join(outDir, `icons/simurgh-mark-${size}.png`),
  );
}
