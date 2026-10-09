import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extension = path.join(root, 'packages/chromium-extension');

describe('browser extension builds', () => {
  it('builds a Firefox MV3 target with loopback-host permissions and exact-port execution', async () => {
    execFileSync(process.execPath, ['build.mjs', 'firefox'], { cwd: extension, stdio: 'pipe' });

    const manifest = JSON.parse(readFileSync(path.join(extension, 'dist-firefox/manifest.json'), 'utf8'));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.name, 'Simurgh Context Inspector');
    assert.deepEqual(manifest.host_permissions, [
      'http://localhost/*',
      'http://127.0.0.1/*',
    ]);
    assert.deepEqual(manifest.content_scripts, [{
      matches: ['http://localhost/*', 'http://127.0.0.1/*'],
      include_globs: ['http://localhost:3300/*', 'http://127.0.0.1:3300/*'],
      js: ['firefox-bootstrap.js'],
      run_at: 'document_idle',
    }]);
    assert.deepEqual(manifest.permissions, []);
    assert.equal(manifest.background, undefined);
    assert.deepEqual(manifest.browser_specific_settings, {
      gecko: {
        id: 'simurgh-context-inspector@simurgh.dev',
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['none'] },
      },
    });
    const bootstrap = readFileSync(path.join(extension, 'dist-firefox/firefox-bootstrap.js'), 'utf8');
    assert.ok(bootstrap.length > 0);
    for (const origin of [
      'http://localhost:3301',
      'http://127.0.0.1:3301',
      'https://localhost:3300',
      'http://localhost',
      'http://localhost.evil:3300',
    ]) {
      const documentReads: string[] = [];
      const networkCalls: unknown[][] = [];
      runInNewContext(bootstrap, {
        window: { location: { origin } },
        document: new Proxy({}, {
          get(_target, property) {
            documentReads.push(String(property));
            throw new Error(`Unexpected DOM access: ${String(property)}`);
          },
        }),
        fetch: (...args: unknown[]) => networkCalls.push(args),
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.deepEqual(documentReads, [], `Firefox bundle accessed the DOM at ${origin}`);
      assert.deepEqual(networkCalls, [], `Firefox bundle made a network request at ${origin}`);
    }
  });

  it('keeps the default Chromium manifest separate and unchanged', () => {
    execFileSync(process.execPath, ['build.mjs'], { cwd: extension, stdio: 'pipe' });
    const source = JSON.parse(readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
    const output = JSON.parse(readFileSync(path.join(extension, 'dist/manifest.json'), 'utf8'));
    assert.deepEqual(source.host_permissions, [
      'http://localhost:3300/*',
      'http://127.0.0.1:3300/*',
    ]);
    assert.deepEqual(source.permissions, []);
    assert.deepEqual(source.content_scripts, [{
      matches: ['http://localhost:3300/*', 'http://127.0.0.1:3300/*'],
      js: ['content.js'],
      run_at: 'document_idle',
    }]);
    assert.equal(source.browser_specific_settings, undefined);
    assert.deepEqual(output, source);
  });
});
