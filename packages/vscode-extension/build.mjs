import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, 'dist');
await mkdir(out, { recursive: true });

await Promise.all([
  build({
    entryPoints: [path.join(root, 'src/extension.ts')],
    outfile: path.join(out, 'extension.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
    sourcemap: true,
  }),
  build({
    entryPoints: [path.join(root, 'test/suite/index.ts')],
    outfile: path.join(out, 'test/suite/index.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
    sourcemap: true,
  }),
]);
