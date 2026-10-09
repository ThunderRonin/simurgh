import {
  CAPTURE_SCHEMA,
  MAX_CAPTURE_BYTES,
  MAX_SERIES,
  parseAbsoluteRange,
  validateCapture,
  type AbsoluteRange,
  type CaptureSnapshot,
  type ConfirmedCapture,
} from './index';
import type { SourceSnapshot } from './source';

export const MAX_INVESTIGATION_QUESTION_CHARS = 4_000;
export const MIN_INVESTIGATION_REFERENCES = 1;
export const MAX_INVESTIGATION_REFERENCES = 4;
export const MAX_VOICE_SECONDS = 30;
export const MAX_VOICE_BYTES = 2 * 1024 * 1024;

export type ReferenceKind = 'telemetry' | 'source';
export type InvestigationStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'limited' | 'failed';
export type FindingStrength = 'supported' | 'hypothesis' | 'inconclusive';

export interface WorkspaceUser {
  id: string;
  name: string;
}

export interface WorkspaceLimits {
  wallMs: number;
  queries: number;
  bytes: number;
  concurrency: number;
}

export interface WorkspaceConfig {
  users: WorkspaceUser[];
  limits: WorkspaceLimits;
  capabilities: { agent: boolean; voice: boolean; speech?: boolean };
  limitations: string[];
}

export interface WorkspaceReference {
  id: string;
  kind: ReferenceKind;
  title: string;
  createdAt: string;
  snapshot: ConfirmedCapture | SourceSnapshot;
  limitations: string[];
}

export interface Evidence {
  id: string;
  kind: 'metric' | 'source';
  title: string;
  origin: 'queried' | 'user-supplied';
  capturedAt: string;
  scope: string;
  data: unknown;
  limitations: string[];
}

export interface Finding {
  strength: FindingStrength;
  summary: string;
  citations: string[];
  limitations: string[];
  nextCheck: string;
}

export interface InvestigationUsage {
  elapsedMs: number;
  queries: number;
  bytes: number;
  inputTokens: number | null;
  outputTokens: number | null;
  modelUsageEnforcement: string;
}

export interface InvestigationRecord {
  id: string;
  ownerId: string;
  question: string;
  referenceIds: string[];
  references: WorkspaceReference[];
  createdAt: string;
  status: InvestigationStatus;
  stopReason: string | null;
  limits: WorkspaceLimits;
  usage: InvestigationUsage;
  evidence: Evidence[];
  finding: Finding | null;
  grants: string[];
  limitations: string[];
}

export interface InvestigationSubmission {
  question: string;
  referenceIds: readonly string[];
}

export interface ImportedSnapshotPreview {
  kind: ReferenceKind;
  title: string;
  details: string[];
  range?: AbsoluteRange;
  limitations: string[];
  origin: 'user-supplied';
  snapshot: ConfirmedCapture | SourceSnapshot;
}

export type SnapshotPreviewResult =
  | { ok: true; value: ImportedSnapshotPreview }
  | { ok: false; reason: string };

export type FindingPresentation =
  | { status: 'unavailable' }
  | { status: 'invalid'; reason: string }
  | { status: 'valid'; finding: Finding; evidence: Evidence[] };

export function createInvestigationSubmission(
  question: string,
  referenceIds: readonly string[],
  availableReferenceIds: readonly string[],
): InvestigationSubmission {
  const normalizedQuestion = question.trim();
  if (!normalizedQuestion) throw new Error('Enter a question before starting an investigation.');
  if (normalizedQuestion.length > MAX_INVESTIGATION_QUESTION_CHARS) {
    throw new Error(`Questions must be ${MAX_INVESTIGATION_QUESTION_CHARS} characters or fewer.`);
  }
  if (referenceIds.length < MIN_INVESTIGATION_REFERENCES || referenceIds.length > MAX_INVESTIGATION_REFERENCES) {
    throw new Error(`Choose one to ${MAX_INVESTIGATION_REFERENCES} references.`);
  }
  if (referenceIds.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new Error('Reference selection contains an invalid item.');
  }
  if (new Set(referenceIds).size !== referenceIds.length) {
    throw new Error('Reference selection contains a duplicate item.');
  }
  const available = new Set(availableReferenceIds);
  if (referenceIds.some((id) => !available.has(id))) {
    throw new Error('One or more selected references are no longer available. Refresh the workspace and try again.');
  }
  const frozenIds = Object.freeze([...referenceIds]);
  return Object.freeze({ question: normalizedQuestion, referenceIds: frozenIds });
}

export function presentFinding(input: unknown, evidence: readonly Evidence[]): FindingPresentation {
  if (input === null || input === undefined) return { status: 'unavailable' };
  if (!isRecord(input) || !isFindingStrength(input.strength) || typeof input.summary !== 'string' ||
    !Array.isArray(input.citations) || !input.citations.every((id) => typeof id === 'string') ||
    !Array.isArray(input.limitations) || !input.limitations.every((item) => typeof item === 'string') ||
    typeof input.nextCheck !== 'string') {
    return { status: 'invalid', reason: 'The finding does not match the supported response format.' };
  }
  const finding = input as unknown as Finding;
  if (finding.strength !== 'inconclusive' && finding.citations.length === 0) {
    return { status: 'invalid', reason: 'The finding has no evidence citations.' };
  }
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const citedEvidence = finding.citations.map((id) => evidenceById.get(id));
  if (citedEvidence.some((item) => !item)) {
    return { status: 'invalid', reason: 'The finding contains a citation outside this investigation.' };
  }
  return { status: 'valid', finding, evidence: citedEvidence as Evidence[] };
}

export async function previewImportedSnapshot(input: unknown): Promise<SnapshotPreviewResult> {
  if (!isRecord(input)) return { ok: false, reason: 'Choose a JSON export containing a confirmed reference.' };
  let bytes: number;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
  } catch {
    return { ok: false, reason: 'The selected file is not valid JSON data.' };
  }
  if (input.schema === CAPTURE_SCHEMA) {
    if (bytes > MAX_CAPTURE_BYTES) return { ok: false, reason: 'The telemetry reference exceeds the 5 MB import limit.' };
    const validated = validateCapture(input);
    if (!validated.ok) return { ok: false, reason: validated.reason };
    const confirmed = validateConfirmedCapture(input, validated.value);
    if (!confirmed) return { ok: false, reason: 'Import a confirmed telemetry bundle, not an unconfirmed candidate capture.' };
    const labels = Object.entries(confirmed.selected.labels).map(([name, value]) => `${name}=${value}`);
    return {
      ok: true,
      value: {
        kind: 'telemetry',
        title: `${confirmed.panel.dashboardTitle} · ${confirmed.panel.panelTitle}`,
        details: [
          `Series: ${confirmed.selected.name}${labels.length ? ` · ${labels.join(', ')}` : ''}`,
          `Dashboard: ${confirmed.panel.dashboardTitle} (${confirmed.panel.dashboardUid})`,
          `Panel: ${confirmed.panel.panelTitle} (${confirmed.panel.panelId})`,
          `Datasource: ${confirmed.panel.datasourceType} · ${confirmed.panel.datasourceUid}`,
          `Range: ${new Date(confirmed.confirmation.range.from).toISOString()} – ${new Date(confirmed.confirmation.range.to).toISOString()}`,
        ],
        range: { ...confirmed.confirmation.range },
        limitations: [...confirmed.limitations],
        origin: 'user-supplied',
        snapshot: deepFreeze(cloneJson(confirmed)),
      },
    };
  }
  if (input.schema !== 'simurgh.source' || bytes > 128_000) {
    return { ok: false, reason: 'The source export is unsupported or exceeds the 128 KB import limit.' };
  }
  const validation = await validateSourceSnapshotForBrowser(input);
  if (!validation.ok) return validation;
  const source = validation.value;
  const path = source.workspace?.relativePath ?? source.document.uri;
  const sourceLine = source.selection.start.line + 1;
  return {
    ok: true,
    value: {
      kind: 'source',
      title: path,
      details: [
        `Language: ${source.document.languageId}`,
        `Selected lines: ${sourceLine}–${source.selection.end.line + 1}`,
        `Document version: ${source.document.version}`,
        `Git revision: ${source.workspace?.gitRevision ?? 'not available'}`,
      ],
      limitations: [...source.limitations],
      origin: 'user-supplied',
      snapshot: deepFreeze(cloneJson(source)),
    },
  };
}

function validateConfirmedCapture(input: Record<string, unknown>, capture: CaptureSnapshot): ConfirmedCapture | null {
  const confirmation = input.confirmation;
  const selected = input.selected;
  if (!isRecord(confirmation) || !isRecord(selected) || !Number.isSafeInteger(input.candidateCount) ||
    Number(input.candidateCount) < 1 || Number(input.candidateCount) > MAX_SERIES ||
    typeof confirmation.seriesId !== 'string' || !isIsoDate(confirmation.confirmedAt)) return null;
  const range = parseAbsoluteRange(confirmation.range);
  if (!range || range.from < capture.range.from || range.to > capture.range.to ||
    selected.id !== confirmation.seriesId || capture.series.length !== 1 || capture.series[0].id !== selected.id ||
    !Array.isArray(selected.points) || JSON.stringify(selected) !== JSON.stringify(capture.series[0])) return null;
  const candidate = capture.series[0];
  if (candidate.points.some((point) => point.time < range.from || point.time > range.to)) return null;
  return input as unknown as ConfirmedCapture;
}

async function validateSourceSnapshotForBrowser(input: Record<string, unknown>): Promise<
  { ok: true; value: SourceSnapshot } | { ok: false; reason: string }
> {
  const document = input.document;
  const selection = input.selection;
  if (input.version !== 1 || input.editor !== 'vscode' || !isUuid(input.captureId) || !isIsoDate(input.capturedAt) ||
    !isRecord(document) || !isRecord(selection) || typeof selection.text !== 'string' ||
    utf8Bytes(selection.text) === 0 || utf8Bytes(selection.text) > 16_000 ||
    !isRecord(selection.start) || !isRecord(selection.end) || !validPosition(selection.start) || !validPosition(selection.end) ||
    comparePosition(selection.start, selection.end) > 0 || !Array.isArray(input.limitations) ||
    !input.limitations.every((item) => typeof item === 'string')) {
    return { ok: false, reason: 'The source selection, version, or limitations are invalid.' };
  }
  if (!validDocument(document) || !validWorkspace(input.workspace)) {
    return { ok: false, reason: 'The source document or workspace metadata is invalid.' };
  }
  const hash = await sha256(selection.text);
  if (hash !== document.contentHash) return { ok: false, reason: 'The source text does not match its exported content hash.' };
  return { ok: true, value: input as unknown as SourceSnapshot };
}

function validDocument(value: Record<string, unknown>): boolean {
  if (typeof value.uri !== 'string' || typeof value.languageId !== 'string' || !value.languageId.trim() ||
    !Number.isSafeInteger(value.version) || Number(value.version) < 1 || typeof value.dirty !== 'boolean' ||
    typeof value.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.contentHash)) return false;
  try {
    const uri = new URL(value.uri);
    return uri.protocol === 'file:' || uri.protocol === 'untitled:';
  } catch {
    return false;
  }
}

function validWorkspace(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name.trim() || typeof value.rootUri !== 'string' ||
    typeof value.relativePath !== 'string' || !value.relativePath || value.relativePath.startsWith('/') ||
    value.relativePath.startsWith('\\') || value.relativePath.includes('\\') || /^[a-zA-Z]:/.test(value.relativePath) ||
    value.relativePath.split('/').some((part) => !part || part === '.' || part === '..') ||
    !(value.gitRevision === null || typeof value.gitRevision === 'string')) return false;
  try {
    return new URL(value.rootUri).protocol === 'file:';
  } catch {
    return false;
  }
}

function validPosition(value: Record<string, unknown>): boolean {
  return Number.isSafeInteger(value.line) && Number(value.line) >= 0 &&
    Number.isSafeInteger(value.character) && Number(value.character) >= 0;
}

function comparePosition(left: Record<string, unknown>, right: Record<string, unknown>): number {
  return Number(left.line) - Number(right.line) || Number(left.character) - Number(right.character);
}

function isFindingStrength(value: unknown): value is FindingStrength {
  return value === 'supported' || value === 'hypothesis' || value === 'inconclusive';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
