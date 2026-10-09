import * as path from 'node:path';
import * as vscode from 'vscode';

import {
  hashSelectedText,
  MAX_SOURCE_TEXT_BYTES,
  validateSourceSnapshot,
  type SourcePosition,
  type SourceRange,
  type SourceSnapshot,
} from '../../shared/src/source.js';

const providerDeadlineMs = 2_000;
const gitMetadataDeadlineMs = 500;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('simurgh.captureSelection', captureAndExport));
}

export function renderReadonlyPreview(json: string): string {
  const escaped = json.replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]!);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'"></head><body><pre>${escaped}</pre></body></html>`;
}

export async function captureActiveSelection(): Promise<SourceSnapshot> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) throw new Error('Open a source document and select text before capturing.');
  if (editor.selection.isEmpty) throw new Error('Select a non-empty source range before capturing.');

  const document = editor.document;
  if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
    throw new Error('Only file-backed and untitled VS Code documents can be captured.');
  }
  const selection = editor.selection;
  const selectedText = document.getText(selection);
  const textBytes = new TextEncoder().encode(selectedText).byteLength;
  if (textBytes === 0) throw new Error('The selected source range is empty.');
  if (textBytes > MAX_SOURCE_TEXT_BYTES) {
    throw new Error('Selected source exceeds the 16 KB capture limit. Select a smaller range and retry.');
  }

  const initialVersion = document.version;
  const initialDirty = document.isDirty;
  const selectedRange = copyRange(selection);
  const limitations: string[] = [];
  const deadline = Date.now() + providerDeadlineMs;
  const symbolsRequest = requestSymbols(document, deadline);
  const definitionsRequest = requestDefinitions(document, selection.active, deadline);
  const [symbolsResult, definitionsResult] = await Promise.all([symbolsRequest, definitionsRequest]);
  addProviderLimitations('Document-symbol', symbolsResult, limitations);
  addProviderLimitations('Definition', definitionsResult, limitations);

  const folder = document.uri.scheme === 'file' ? vscode.workspace.getWorkspaceFolder(document.uri) : undefined;
  let workspace: SourceSnapshot['workspace'] = null;
  if (folder) {
    const relativePath = path.relative(folder.uri.fsPath, document.uri.fsPath).split(path.sep).join('/');
    const git = await getGitRevision(document.uri);
    if (git.timedOut) limitations.push('Git metadata lookup exceeded its 500 ms deadline; the revision is unavailable.');
    else if (!git.revision) limitations.push('Git revision is unavailable from the VS Code Git extension.');
    const gitProvenance = gitHeadProvenanceLimitation(git.revision);
    if (gitProvenance) limitations.push(gitProvenance);
    workspace = { name: folder.name, rootUri: folder.uri.toString(), relativePath, gitRevision: git.revision };
  } else {
    limitations.push('Document is not inside a file-backed workspace. Workspace and Git revision are unavailable.');
  }

  if (document.version !== initialVersion || document.isDirty !== initialDirty || document.getText(selection) !== selectedText) {
    throw new Error('The source buffer changed while language context was loading. Capture again to use one document version.');
  }

  const normalizedSymbols = symbolsResult.kind === 'ok'
    ? normalizeSymbols(symbolsResult.value)
    : { items: [], truncated: false };
  const normalizedDefinitions = definitionsResult.kind === 'ok'
    ? normalizeDefinitions(definitionsResult.value)
    : { items: [], truncated: false };
  if (normalizedSymbols.truncated) limitations.push('Document-symbol results may be capped at 20 entries.');
  if (normalizedDefinitions.truncated) limitations.push('Definition results may be capped at 10 entries.');
  if (normalizedDefinitions.items.length > 0) {
    limitations.push('Definition locations are navigation hints; target-document version and content hash are not captured.');
  }
  const raw: SourceSnapshot = {
    schema: 'simurgh.source',
    version: 1,
    captureId: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    editor: 'vscode',
    document: {
      uri: document.uri.toString(),
      languageId: document.languageId,
      version: initialVersion,
      dirty: initialDirty,
      contentHash: hashSelectedText(selectedText),
    },
    workspace,
    selection: { ...selectedRange, text: selectedText },
    symbols: normalizedSymbols.items,
    definitions: normalizedDefinitions.items,
    limitations,
  };
  const validated = validateSourceSnapshot(raw);
  if (!validated.ok) throw new Error(`VS Code produced an unsupported source snapshot: ${validated.reason}`);
  return validated.value;
}

interface CaptureCommandAdapter {
  captureSnapshot: () => Promise<SourceSnapshot>;
  openPreview: (captureId: string, json: string) => Promise<void>;
  chooseAction: () => Promise<'export' | 'copy' | 'cancel' | undefined>;
  exportJson: (json: string) => Promise<void>;
  copyJson: (json: string) => Promise<void>;
}

export async function runCaptureCommand(adapter: CaptureCommandAdapter): Promise<void> {
  const snapshot = await adapter.captureSnapshot();
  const json = JSON.stringify(snapshot, null, 2);
  await adapter.openPreview(snapshot.captureId, json);
  const choice = await adapter.chooseAction();
  if (choice === 'export') await adapter.exportJson(json);
  else if (choice === 'copy') await adapter.copyJson(json);
}

async function captureAndExport(): Promise<void> {
  try {
    await runCaptureCommand({
      captureSnapshot: captureActiveSelection,
      openPreview: async (_captureId, json) => {
        const preview = vscode.window.createWebviewPanel(
          'simurgh.sourcePreview',
          'Selected Source Snapshot',
          vscode.ViewColumn.Active,
          { enableScripts: false }
        );
        preview.webview.html = renderReadonlyPreview(json);
      },
      chooseAction: async () => {
        const choice = await vscode.window.showInformationMessage(
          'Review the selected-source snapshot. It has not been exported or sent anywhere.',
          'Export JSON',
          'Copy JSON',
          'Cancel'
        );
        if (choice === 'Export JSON') return 'export';
        if (choice === 'Copy JSON') return 'copy';
        return 'cancel';
      },
      exportJson: async (json) => {
        const destination = await vscode.window.showSaveDialog({
          saveLabel: 'Export source snapshot',
          filters: { JSON: ['json'] },
        });
        if (destination) await vscode.workspace.fs.writeFile(destination, Buffer.from(json, 'utf8'));
      },
      copyJson: async (json) => {
        await vscode.env.clipboard.writeText(json);
        void vscode.window.showInformationMessage('Selected-source snapshot copied to the clipboard.');
      },
    });
  } catch (error) {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Source capture failed.');
  }
}

type ProviderResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'unavailable' }
  | { kind: 'timeout' }
  | { kind: 'error' };

function requestSymbols(document: vscode.TextDocument, deadline: number): Promise<ProviderResult<vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined>> {
  try {
    return withinDeadline(vscode.commands.executeCommand<vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined>(
      'vscode.executeDocumentSymbolProvider', document.uri
    ), deadline);
  } catch {
    return Promise.resolve({ kind: 'error' });
  }
}

type DefinitionResult = vscode.Definition | vscode.DefinitionLink | vscode.DefinitionLink[];

function requestDefinitions(document: vscode.TextDocument, position: vscode.Position, deadline: number): Promise<ProviderResult<DefinitionResult | undefined>> {
  try {
    return withinDeadline(vscode.commands.executeCommand<DefinitionResult | undefined>(
      'vscode.executeDefinitionProvider', document.uri, position
    ), deadline);
  } catch {
    return Promise.resolve({ kind: 'error' });
  }
}

function withinDeadline<T>(request: Thenable<T>, deadline: number): Promise<ProviderResult<T>> {
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      finished = true;
      resolve({ kind: 'timeout' });
    }, Math.max(0, deadline - Date.now()));
    Promise.resolve(request).then((value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(value === undefined || Array.isArray(value) && value.length === 0 ? { kind: 'unavailable' } : { kind: 'ok', value });
    }, () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ kind: 'error' });
    });
  });
}

function addProviderLimitations<T>(label: string, result: ProviderResult<T>, limitations: string[]): void {
  if (result.kind === 'timeout') limitations.push(`${label} provider exceeded the shared two-second deadline.`);
  if (result.kind === 'error') limitations.push(`${label} provider failed; context may be incomplete.`);
  if (result.kind === 'unavailable') limitations.push(`${label} context was unavailable for this language or selection.`);
}

function normalizeSymbols(input?: vscode.DocumentSymbol[] | vscode.SymbolInformation[]): { items: SourceSnapshot['symbols']; truncated: boolean } {
  const output: SourceSnapshot['symbols'] = [];
  if (!input) return { items: output, truncated: false };
  const initialCount = Math.min(input.length, 20);
  const pending: Array<vscode.DocumentSymbol | vscode.SymbolInformation> = input.slice(0, initialCount).reverse();
  let truncated = input.length > initialCount;
  while (pending.length > 0 && output.length < 20) {
    const symbol = pending.pop()!;
    const range = 'location' in symbol ? symbol.location.range : symbol.range;
    output.push({
      name: truncateUtf8(symbol.name, 1_024),
      kind: vscode.SymbolKind[symbol.kind] ?? String(symbol.kind),
      range: copyRange(range),
    });
    if ('children' in symbol && symbol.children.length) {
      const room = 20 - output.length;
      if (symbol.children.length > room) truncated = true;
      pending.push(...symbol.children.slice(0, room).reverse());
    }
  }
  return { items: output, truncated: truncated || pending.length > 0 || output.length === 20 };
}

function normalizeDefinitions(input?: DefinitionResult): { items: SourceSnapshot['definitions']; truncated: boolean } {
  const output: SourceSnapshot['definitions'] = [];
  if (!input) return { items: output, truncated: false };
  const values: unknown[] = Array.isArray(input) ? input : [input];
  for (const item of values) {
    if (output.length >= 10) break;
    if (item instanceof vscode.Location) {
      output.push({ uri: item.uri.toString(), range: copyRange(item.range) });
    } else if (isLocationLink(item)) {
      output.push({
        uri: item.targetUri.toString(),
        range: copyRange(item.targetSelectionRange ?? item.targetRange),
      });
    }
  }
  return { items: output, truncated: output.length >= 10 };
}

function isLocationLink(input: unknown): input is vscode.DefinitionLink {
  return typeof input === 'object' && input !== null && 'targetUri' in input && 'targetRange' in input;
}

function truncateUtf8(input: string, maxBytes: number): string {
  let output = '';
  let size = 0;
  for (const character of input) {
    const nextSize = new TextEncoder().encode(character).byteLength;
    if (size + nextSize > maxBytes) break;
    output += character;
    size += nextSize;
  }
  return output;
}

function copyRange(range: vscode.Range): SourceRange {
  return { start: copyPosition(range.start), end: copyPosition(range.end) };
}

function copyPosition(position: vscode.Position): SourcePosition {
  return { line: position.line, character: position.character };
}

interface GitExtension {
  getAPI(version: 1): GitApi;
}

interface GitApi {
  getRepository(uri: vscode.Uri): GitRepository | undefined;
}

interface GitRepository {
  state: { HEAD?: { commit?: string } };
}

async function getGitRevision(uri: vscode.Uri): Promise<{ revision: string | null; timedOut: boolean }> {
  const result = await withOptionalMetadataDeadline(async () => {
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!extension) return null;
    const api = extension.isActive ? extension.exports : await extension.activate();
    const commit = api.getAPI(1).getRepository(uri)?.state.HEAD?.commit;
    return typeof commit === 'string' && commit.length > 0 ? commit : null;
  }, gitMetadataDeadlineMs);
  return { revision: result.value, timedOut: result.timedOut };
}

export async function withOptionalMetadataDeadline<T>(
  lookup: () => Promise<T>,
  timeoutMs: number
): Promise<{ value: T | null; timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const completed = Promise.resolve().then(lookup).then(
    (value) => ({ kind: 'value' as const, value }),
    () => ({ kind: 'error' as const })
  );
  const outcome = await Promise.race([
    completed,
    new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), Math.max(0, timeoutMs));
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (outcome.kind === 'timeout') return { value: null, timedOut: true };
  return { value: outcome.kind === 'value' ? outcome.value : null, timedOut: false };
}

export function gitHeadProvenanceLimitation(revision: string | null): string | null {
  return revision
    ? 'Git revision identifies repository HEAD; selected text is bound to the captured editor buffer version and content hash, not verified commit contents.'
    : null;
}
