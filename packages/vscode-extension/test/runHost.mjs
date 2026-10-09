import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isolated = await mkdtemp(path.join(os.tmpdir(), 'simurgh-vscode-host-'));
try {
  await runTests({
    version: '1.137.0',
    extensionDevelopmentPath: extensionRoot,
    extensionTestsPath: path.join(extensionRoot, 'dist/test/suite/index'),
    launchArgs: [
      extensionRoot,
      `--user-data-dir=${path.join(isolated, 'user-data')}`,
      `--extensions-dir=${path.join(isolated, 'extensions')}`,
      '--disable-workspace-trust',
    ],
  });
} finally {
  await rm(isolated, { recursive: true, force: true });
}
