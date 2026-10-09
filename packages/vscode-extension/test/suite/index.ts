import assert = require('node:assert/strict');
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

import {
  captureActiveSelection,
  gitHeadProvenanceLimitation,
  renderReadonlyPreview,
  runCaptureCommand,
  withOptionalMetadataDeadline,
} from '../../src/extension';
import { hashSelectedText, type SourceSnapshot } from '../../../shared/src/source';

type HostTest = { name: string; run: () => Promise<void> };

const tests: HostTest[] = [
  {
    name: 'captures a selected TypeScript symbol using real VS Code symbol and definition providers',
    run: async () => {
      const fixture = await openTypescriptFixture();
      const { editor, helperRange } = fixture;
      try {
        editor.selection = new vscode.Selection(helperRange.start, helperRange.end);
        const snapshot = await captureActiveSelection();

        assert.equal(snapshot.selection.text, 'helper');
        assert.equal(snapshot.document.languageId, 'typescript');
        assert.equal(snapshot.workspace?.relativePath.replace(/\\/g, '/'), 'test/fixtures/selected.ts');
        assert.ok(snapshot.symbols.some((symbol) => symbol.name === 'helper' && symbol.kind === 'Function'));
        assert.ok(snapshot.definitions.some((definition) => definition.uri === editor.document.uri.toString()));
        assert.ok(snapshot.limitations.some((item) => /definition locations are navigation hints/i.test(item)));
        if (snapshot.workspace?.gitRevision) {
          assert.ok(snapshot.limitations.some((item) => /revision identifies repository head/i.test(item)));
        }
        assert.ok(snapshot.definitions.length <= 10);
        assert.ok(snapshot.symbols.length <= 20);

        const artifactPath = path.resolve(__dirname, '../../../../../test-results/editor/source-capture.json');
        await mkdir(path.dirname(artifactPath), { recursive: true });
        await writeFile(artifactPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

        await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), '// later edit\n'));
        assert.equal(snapshot.selection.text, 'helper');
        assert.equal(snapshot.document.version, 1);
      } finally {
        await fixture.cleanup();
      }
    },
  },
  {
    name: 'preserves UTF-16 editor positions for a supplementary Unicode character',
    run: async () => {
      const fixture = await openTypescriptFixture();
      try {
        const { editor, faceRange } = fixture;
        editor.selection = new vscode.Selection(faceRange.start, faceRange.end);
        const snapshot = await captureActiveSelection();

        assert.equal(snapshot.selection.text, '😀');
        assert.equal(snapshot.selection.end.character - snapshot.selection.start.character, 2);
      } finally {
        await fixture.cleanup();
      }
    },
  },
  {
    name: 'rejects missing editor selection and empty ranges',
    run: async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await assert.rejects(captureActiveSelection(), /Open a source document/);

      const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'some text' });
      const editor = await vscode.window.showTextDocument(document);
      editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));
      await assert.rejects(captureActiveSelection(), /Select a non-empty source range/);
    },
  },
  {
    name: 'reports language-provider unavailability for an untitled plaintext selection',
    run: async () => {
      const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'sample' });
      const editor = await vscode.window.showTextDocument(document);
      editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 6));
      const snapshot = await captureActiveSelection();

      assert.equal(snapshot.workspace, null);
      assert.ok(snapshot.limitations.some((item) => /symbol context/.test(item) || /document-symbol/.test(item)));
      assert.ok(snapshot.limitations.some((item) => /definition context/i.test(item) || /definition provider/i.test(item)));
    },
  },
  {
    name: 'caps excessive provider results and discloses truncation',
    run: async () => {
      let symbolCalls = 0;
      let definitionCalls = 0;
      const range = new vscode.Range(new vscode.Position(0, 6), new vscode.Position(0, 12));
      const symbols = vscode.languages.registerDocumentSymbolProvider({ language: 'typescript' }, {
        provideDocumentSymbols: () => {
          symbolCalls += 1;
          return Array.from({ length: 25 }, (_, index) => new vscode.DocumentSymbol(
            `symbol${index}`, '', vscode.SymbolKind.Function, range, range
          ));
        },
      });
      const definitions = vscode.languages.registerDefinitionProvider({ language: 'typescript' }, {
        provideDefinition: (document) => {
          definitionCalls += 1;
          return Array.from({ length: 12 }, (_, index) => new vscode.Location(document.uri,
            new vscode.Range(new vscode.Position(0, index), new vscode.Position(0, index + 1))));
        },
      });
      try {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const target = 1;' });
        const editor = await vscode.window.showTextDocument(document);
        editor.selection = new vscode.Selection(range.start, range.end);
        const snapshot = await captureActiveSelection();

        assert.equal(snapshot.symbols.length, 20);
        assert.equal(snapshot.definitions.length, 10);
        assert.equal(symbolCalls, 1);
        assert.equal(definitionCalls, 1);
        assert.ok(snapshot.limitations.some((item) => /symbol results may be capped/.test(item)));
        assert.ok(snapshot.limitations.some((item) => /definition results may be capped/i.test(item)));
      } finally {
        symbols.dispose();
        definitions.dispose();
      }
    },
  },
  {
    name: 'discards a capture if the buffer changes while a real language-provider request is pending',
    run: async () => {
      let providerStarted = false;
      let notifyProviderStarted!: () => void;
      const providerStart = new Promise<void>((resolve) => { notifyProviderStarted = resolve; });
      let editor!: vscode.TextEditor;
      const provider = vscode.languages.registerDocumentSymbolProvider({ language: 'typescript' }, {
        provideDocumentSymbols: () => {
          providerStarted = true;
          notifyProviderStarted();
          return new Promise<vscode.DocumentSymbol[]>((resolve) => setTimeout(() => resolve([]), 500));
        },
      });
      try {
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const target = 1;' });
        editor = await vscode.window.showTextDocument(document);
        editor.selection = new vscode.Selection(new vscode.Position(0, 6), new vscode.Position(0, 12));
        const pending = captureActiveSelection();
        const didStart = await Promise.race([
          providerStart.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
        ]);
        assert.equal(didStart, true);
        await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), 'changed '));
        await assert.rejects(pending, /buffer changed while language context was loading/);
        assert.equal(providerStarted, true);
      } finally {
        provider.dispose();
      }
    },
  },
  {
    name: 'bounds an optional metadata lookup that never resolves',
    run: async () => {
      let calls = 0;
      const started = Date.now();
      const result = await withOptionalMetadataDeadline(() => {
        calls += 1;
        return new Promise<string | null>(() => {});
      }, 25);

      assert.deepEqual(result, { value: null, timedOut: true });
      assert.equal(calls, 1);
      assert.ok(Date.now() - started < 500);
    },
  },
  {
    name: 'labels a Git revision as repository HEAD rather than verified file contents',
    run: async () => {
      const limitation = gitHeadProvenanceLimitation('0123456789abcdef');
      assert.match(limitation ?? '', /repository HEAD/);
      assert.match(limitation ?? '', /not verified commit contents/);
      assert.equal(gitHeadProvenanceLimitation(null), null);
    },
  },
  {
    name: 'cancel leaves the read-only source preview unexported',
    run: async () => {
      const snapshot = makeSnapshot();
      const previews: string[] = [];
      const exports: string[] = [];
      const panels: vscode.WebviewPanel[] = [];
      try {
        await runCaptureCommand(createCommandAdapter(snapshot, panels, previews, exports, 'cancel'));
        assert.equal(exports.length, 0);
        assert.equal(previews.length, 1);
        assert.equal(previews[0], JSON.stringify(snapshot, null, 2));
      } finally {
        panels.forEach((panel) => panel.dispose());
      }
    },
  },
  {
    name: 'exports exactly the immutable JSON shown in the read-only preview',
    run: async () => {
      const snapshot = makeSnapshot();
      const previews: string[] = [];
      const exports: string[] = [];
      const panels: vscode.WebviewPanel[] = [];
      try {
        await runCaptureCommand(createCommandAdapter(snapshot, panels, previews, exports, 'export'));
        assert.equal(previews.length, 1);
        assert.deepEqual(exports, previews);
      } finally {
        panels.forEach((panel) => panel.dispose());
      }
    },
  },
];

function makeSnapshot(): SourceSnapshot {
  const text = 'code';
  return {
    schema: 'simurgh.source',
    version: 1,
    captureId: '8cc9a77e-4865-4cd7-9f59-dfc5e2b99cf2',
    capturedAt: '2026-10-09T00:00:00.000Z',
    editor: 'vscode',
    document: {
      uri: 'untitled:preview.ts',
      languageId: 'typescript',
      version: 1,
      dirty: true,
      contentHash: hashSelectedText(text),
    },
    workspace: null,
    selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 }, text },
    symbols: [],
    definitions: [],
    limitations: [],
  };
}

function createCommandAdapter(
  snapshot: SourceSnapshot,
  panels: vscode.WebviewPanel[],
  previews: string[],
  exports: string[],
  choice: 'cancel' | 'export'
) {
  return {
    captureSnapshot: async () => snapshot,
    openPreview: async (_captureId: string, json: string) => {
      const panel = vscode.window.createWebviewPanel(
        'simurgh.sourcePreviewTest',
        'Selected Source Snapshot',
        vscode.ViewColumn.Active,
        { enableScripts: false }
      );
      const html = renderReadonlyPreview(json);
      panel.webview.html = html;
      assert.equal(panel.webview.options.enableScripts, false);
      assert.match(html, /<pre>/);
      assert.doesNotMatch(html, /<script\b|contenteditable|<textarea\b/i);
      const escaped = json.replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]!);
      assert.ok(html.includes(`<pre>${escaped}</pre>`));
      panels.push(panel);
      previews.push(json);
    },
    chooseAction: async () => choice,
    exportJson: async (json: string) => { exports.push(json); },
    copyJson: async () => { throw new Error('Unexpected clipboard operation'); },
  };
}

export async function run(): Promise<void> {
  const failures: string[] = [];
  for (const test of tests) {
    try {
      await test.run();
      console.log(`PASS ${test.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      failures.push(`${test.name}\n${message}`);
      console.error(`FAIL ${test.name}\n${message}`);
    }
  }
  if (failures.length) throw new Error(`${failures.length} VS Code host tests failed.\n${failures.join('\n\n')}`);
}

async function openTypescriptFixture(): Promise<{
  editor: vscode.TextEditor;
  helperRange: vscode.Range;
  faceRange: vscode.Range;
  cleanup: () => Promise<void>;
}> {
  const fixturePath = path.resolve(__dirname, '../../../test/fixtures/selected.ts');
  const fixtureUri = vscode.Uri.file(fixturePath);
  const document = await vscode.workspace.openTextDocument(fixtureUri);
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const callLine = document.lineAt(0).text;
  const helperStart = callLine.indexOf('helper');
  const faceLine = document.lineAt(6).text;
  const faceStart = faceLine.indexOf('😀');
  const helperRange = new vscode.Range(new vscode.Position(0, helperStart), new vscode.Position(0, helperStart + 'helper'.length));
  const faceRange = new vscode.Range(new vscode.Position(6, faceStart), new vscode.Position(6, faceStart + 2));

  const symbols = await waitForSymbolProvider(document);
  assert.ok(symbols.some((symbol) => symbol.name === 'helper'));
  return {
    editor,
    helperRange,
    faceRange,
    cleanup: async () => {
      if (editor.document.isDirty) await vscode.commands.executeCommand('workbench.action.files.revert');
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    },
  };
}

async function waitForSymbolProvider(document: vscode.TextDocument): Promise<vscode.DocumentSymbol[]> {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    const result = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
      'vscode.executeDocumentSymbolProvider', document.uri
    );
    if (result?.some((symbol) => symbol.name === 'helper')) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('The built-in TypeScript language feature provider did not return fixture symbols.');
}
