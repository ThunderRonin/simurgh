import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export const SOURCE_SCHEMA = 'simurgh.source' as const;
export const MAX_SOURCE_TEXT_BYTES = 16_000;
export const MAX_SOURCE_SNAPSHOT_BYTES = 128_000;
export const MAX_SOURCE_SYMBOLS = 20;
export const MAX_SOURCE_DEFINITIONS = 10;
const MAX_METADATA_BYTES = 4_096;

export interface SourcePosition {
  line: number;
  character: number;
}

export interface SourceRange {
  start: SourcePosition;
  end: SourcePosition;
}

export interface SourceSnapshot {
  schema: typeof SOURCE_SCHEMA;
  version: 1;
  captureId: string;
  capturedAt: string;
  editor: 'vscode';
  document: {
    uri: string;
    languageId: string;
    version: number;
    dirty: boolean;
    contentHash: string;
  };
  workspace: {
    name: string;
    rootUri: string;
    relativePath: string;
    gitRevision: string | null;
  } | null;
  selection: SourceRange & { text: string };
  symbols: Array<{ name: string; kind: string; range: SourceRange }>;
  definitions: Array<{ uri: string; range: SourceRange }>;
  limitations: string[];
}

export type SourceValidation =
  | { ok: true; value: SourceSnapshot }
  | { ok: false; reason: string };

export function validateSourceSnapshot(input: unknown): SourceValidation {
  if (!isRecord(input)) return invalid('Source snapshot must be an object.');
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return invalid('Source snapshot must be serializable JSON.');
  }
  if (utf8Bytes(serialized) > MAX_SOURCE_SNAPSHOT_BYTES) return invalid('Source snapshot exceeds 128 KB.');

  if (input.schema !== SOURCE_SCHEMA || input.version !== 1 || input.editor !== 'vscode' ||
    !isUuid(input.captureId) || !isIsoDate(input.capturedAt)) {
    return invalid('Source snapshot identity is invalid.');
  }
  if (!isRecord(input.document) || !validDocument(input.document)) {
    return invalid('Source document metadata is invalid.');
  }
  if (input.workspace !== null && (!isRecord(input.workspace) || !validWorkspace(input.workspace))) {
    return invalid('Workspace metadata or relative path is invalid.');
  }
  if (!isRecord(input.selection) || !validRange(input.selection) || typeof input.selection.text !== 'string' ||
    utf8Bytes(input.selection.text) === 0 || utf8Bytes(input.selection.text) > MAX_SOURCE_TEXT_BYTES ||
    !rangeMatchesText(input.selection, input.selection.text) ||
    hashSelectedText(input.selection.text) !== input.document.contentHash) {
    return invalid('Selected source text, range, or content hash is invalid.');
  }
  if (!Array.isArray(input.symbols) || input.symbols.length > MAX_SOURCE_SYMBOLS || !input.symbols.every(validSymbol)) {
    return invalid('Source symbol results exceed their limit or contain invalid data.');
  }
  if (!Array.isArray(input.definitions) || input.definitions.length > MAX_SOURCE_DEFINITIONS || !input.definitions.every(validDefinition)) {
    return invalid('Source definition results exceed their limit or contain invalid data.');
  }
  if (!Array.isArray(input.limitations) || !input.limitations.every(validMetadataString)) {
    return invalid('Source limitations contain invalid metadata.');
  }

  const document = input.document as SourceSnapshot['document'];
  const workspace = input.workspace as SourceSnapshot['workspace'];
  const selection = input.selection as unknown as SourceSnapshot['selection'];
  const symbols = input.symbols as SourceSnapshot['symbols'];
  const definitions = input.definitions as SourceSnapshot['definitions'];
  const limitations = input.limitations as string[];
  const value: SourceSnapshot = {
    schema: SOURCE_SCHEMA,
    version: 1,
    captureId: input.captureId,
    capturedAt: input.capturedAt,
    editor: 'vscode',
    document: {
      uri: document.uri,
      languageId: document.languageId,
      version: document.version,
      dirty: document.dirty,
      contentHash: document.contentHash,
    },
    workspace: workspace === null ? null : {
      name: workspace.name,
      rootUri: workspace.rootUri,
      relativePath: workspace.relativePath,
      gitRevision: workspace.gitRevision,
    },
    selection: {
      start: { ...selection.start },
      end: { ...selection.end },
      text: selection.text,
    },
    symbols: symbols.map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      range: { start: { ...symbol.range.start }, end: { ...symbol.range.end } },
    })),
    definitions: definitions.map((definition) => ({
      uri: definition.uri,
      range: { start: { ...definition.range.start }, end: { ...definition.range.end } },
    })),
    limitations: [...limitations],
  };
  return { ok: true, value: deepFreeze(value) };
}

export function hashSelectedText(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

function validDocument(input: Record<string, unknown>): boolean {
  return typeof input.uri === 'string' && validDocumentUri(input.uri) &&
    validMetadataString(input.languageId) && Number.isSafeInteger(input.version) && Number(input.version) > 0 &&
    typeof input.dirty === 'boolean' && typeof input.contentHash === 'string' && /^[a-f0-9]{64}$/.test(input.contentHash);
}

function validWorkspace(input: Record<string, unknown>): boolean {
  return validMetadataString(input.name) && typeof input.rootUri === 'string' && isUri(input.rootUri) &&
    input.rootUri.startsWith('file:') && typeof input.relativePath === 'string' && validRelativePath(input.relativePath) &&
    (input.gitRevision === null || validMetadataString(input.gitRevision));
}

function validSymbol(input: unknown): input is Record<string, unknown> {
  return isRecord(input) && validMetadataString(input.name) && validMetadataString(input.kind) &&
    isRecord(input.range) && validRange(input.range);
}

function validDefinition(input: unknown): input is Record<string, unknown> {
  return isRecord(input) && typeof input.uri === 'string' && validDocumentUri(input.uri) &&
    isRecord(input.range) && validRange(input.range);
}

function validRange(input: Record<string, unknown>): boolean {
  if (!isRecord(input.start) || !isRecord(input.end) || !validPosition(input.start) || !validPosition(input.end)) return false;
  return comparePositions(input.start as unknown as SourcePosition, input.end as unknown as SourcePosition) < 0;
}

function rangeMatchesText(range: Record<string, unknown>, text: string): boolean {
  const start = range.start as SourcePosition;
  const end = range.end as SourcePosition;
  const lines = text.split(/\r\n|\n|\r/);
  if (end.line - start.line !== lines.length - 1) return false;
  return lines.length === 1
    ? end.character - start.character === lines[0].length
    : end.character === lines[lines.length - 1].length;
}

function validPosition(input: Record<string, unknown>): boolean {
  return Number.isSafeInteger(input.line) && Number(input.line) >= 0 &&
    Number.isSafeInteger(input.character) && Number(input.character) >= 0;
}

function validDocumentUri(input: string): boolean {
  return isUri(input) && (input.startsWith('file:') || input.startsWith('untitled:'));
}

function isUri(input: string): boolean {
  if (!validMetadataString(input)) return false;
  try {
    const parsed = new URL(input);
    return parsed.protocol.length > 1;
  } catch {
    return false;
  }
}

function validRelativePath(input: string): boolean {
  if (!validMetadataString(input) || input.startsWith('/') || input.startsWith('\\') ||
    /^[a-zA-Z]:/.test(input) || input.includes('\\')) return false;
  const segments = input.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function validMetadataString(input: unknown): input is string {
  return typeof input === 'string' && input.length > 0 && utf8Bytes(input) <= MAX_METADATA_BYTES;
}

function isUuid(input: unknown): input is string {
  return typeof input === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input);
}

function isIsoDate(input: unknown): input is string {
  if (typeof input !== 'string') return false;
  const parsed = new Date(input);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === input;
}

function utf8Bytes(input: string): number {
  return new TextEncoder().encode(input).byteLength;
}

function comparePositions(left: SourcePosition, right: SourcePosition): number {
  return left.line - right.line || left.character - right.character;
}

function copyPosition(input: Record<string, unknown>): SourcePosition {
  return { line: input.line as number, character: input.character as number };
}

function copyRange(input: Record<string, unknown>): SourceRange {
  return {
    start: copyPosition(input.start as Record<string, unknown>),
    end: copyPosition(input.end as Record<string, unknown>),
  };
}

function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === 'object' && !Object.isFrozen(input)) {
    Object.freeze(input);
    for (const value of Object.values(input as Record<string, unknown>)) deepFreeze(value);
  }
  return input;
}

function invalid(reason: string): SourceValidation {
  return { ok: false, reason };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}
