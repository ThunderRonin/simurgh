import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { validateSourceSnapshot, type SourceSnapshot } from '../packages/shared/src/source';

describe('source context contract', () => {
  it('accepts and detaches a bounded selected-source snapshot', () => {
    const input = validSnapshot();
    const result = validateSourceSnapshot(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    input.selection.text = 'mutated';
    expect(result.value.selection.text).toBe('const value = "λ";');
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.selection)).toBe(true);
    expect(Object.isFrozen(result.value.symbols[0].range.start)).toBe(true);
  });

  it('rejects unsupported URIs, invalid ranges, and mismatched selected-text hashes', () => {
    const input = validSnapshot();
    expect(validateSourceSnapshot({ ...input, document: { ...input.document, uri: 'vscode-remote://host/path.ts' } }).ok).toBe(false);
    expect(validateSourceSnapshot({ ...input, selection: { ...input.selection, start: { line: -1, character: 0 } } }).ok).toBe(false);
    expect(validateSourceSnapshot({ ...input, selection: { ...input.selection, end: { ...input.selection.start } } }).ok).toBe(false);
    expect(validateSourceSnapshot({ ...input, selection: { ...input.selection, start: { line: 1, character: 2 }, end: { line: 1, character: 1 } } }).ok).toBe(false);
    expect(validateSourceSnapshot({ ...input, selection: { ...input.selection, end: { line: 2, character: 21 } } }).ok).toBe(false);
    expect(validateSourceSnapshot({ ...input, selection: { ...input.selection, text: '' } }).ok).toBe(false);
    expect(validateSourceSnapshot({ ...input, document: { ...input.document, contentHash: '0'.repeat(64) } }).ok).toBe(false);
    expect(validateSourceSnapshot({ ...input, definitions: [{ ...input.definitions[0], uri: 'https://example.test/source.ts' }] }).ok).toBe(false);
  });

  it('rejects workspace traversal and oversized UTF-8 source text', () => {
    const input = validSnapshot();
    expect(validateSourceSnapshot({
      ...input,
      workspace: { ...input.workspace!, relativePath: '../secret.ts' },
    }).ok).toBe(false);
    expect(validateSourceSnapshot({
      ...input,
      selection: { ...input.selection, text: '😀'.repeat(4_100) },
    }).ok).toBe(false);
  });

  it('bounds provider results and the complete serialized record', () => {
    const input = validSnapshot();
    expect(validateSourceSnapshot({ ...input, symbols: Array.from({ length: 21 }, (_, index) => ({
      name: `symbol${index}`,
      kind: 'Function',
      range: input.selection,
    })) }).ok).toBe(false);
    expect(validateSourceSnapshot({ ...input, limitations: ['x'.repeat(130_000)] }).ok).toBe(false);
  });

  it('permits an untitled document without workspace authority when the limitation is explicit', () => {
    const input = validSnapshot();
    const snapshot = {
      ...input,
      document: { ...input.document, uri: 'untitled:Scratch-1' },
      workspace: null,
      limitations: ['Document is not inside a file-backed workspace. Workspace and Git revision are unavailable.'],
    };
    expect(validateSourceSnapshot(snapshot).ok).toBe(true);
  });

  it('can bundle source validation for a browser consumer without Node built-ins', async () => {
    const result = await build({
      entryPoints: ['packages/shared/src/source.ts'],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
    });
    expect(result.outputFiles[0].text).not.toMatch(/node:(crypto|buffer|path)/);
  });
});

function validSnapshot(): SourceSnapshot {
  const text = 'const value = "λ";';
  const hash = createHash('sha256').update(text, 'utf8').digest('hex');
  return {
    schema: 'simurgh.source',
    version: 1,
    captureId: 'f2a12a53-e616-4f3c-a408-231b4ad8b053',
    capturedAt: '2026-10-09T10:00:00.000Z',
    editor: 'vscode',
    document: {
      uri: 'file:///workspace/src/example.ts',
      languageId: 'typescript',
      version: 4,
      dirty: true,
      contentHash: hash,
    },
    workspace: {
      name: 'workspace',
      rootUri: 'file:///workspace',
      relativePath: 'src/example.ts',
      gitRevision: 'a'.repeat(40),
    },
    selection: {
      start: { line: 2, character: 4 },
      end: { line: 2, character: 22 },
      text,
    },
    symbols: [{
      name: 'value',
      kind: 'Variable',
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 23 } },
    }],
    definitions: [{
      uri: 'file:///workspace/src/example.ts',
      range: { start: { line: 2, character: 6 }, end: { line: 2, character: 11 } },
    }],
    limitations: [],
  };
}
