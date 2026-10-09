import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(packageRoot, 'dist');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await copyFile(path.join(packageRoot, 'index.html'), path.join(output, 'index.html'));
await build({
  entryPoints: [path.join(packageRoot, 'src/main.tsx')],
  bundle: true,
  minify: true,
  sourcemap: false,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  loader: { '.svg': 'dataurl' },
  outfile: path.join(output, 'workspace.js'),
  logLevel: 'info',
});
