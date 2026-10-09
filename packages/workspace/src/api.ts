export class WorkspaceApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = 'WorkspaceApiError';
    this.status = status;
    this.code = code;
  }
}

export class WorkspaceSessionExpiredError extends WorkspaceApiError {
  constructor(status: number) {
    super(status, 'Your local session expired or this item is no longer available. Sign in again to refresh access.');
    this.name = 'WorkspaceSessionExpiredError';
  }
}

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  if (response.status === 401) throw new WorkspaceSessionExpiredError(response.status);
  if (!response.ok) throw await responseError(response);
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

export async function apiDownload(path: string): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(path, { credentials: 'same-origin' });
  if (response.status === 401) throw new WorkspaceSessionExpiredError(response.status);
  if (!response.ok) throw await responseError(response);
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] ?? 'simurgh-investigation.json';
  return { blob: await response.blob(), filename };
}

export async function apiWav(path: string, signal: AbortSignal): Promise<{ blob: Blob; truncated: boolean }> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    credentials: 'same-origin',
    signal,
  });
  if (response.status === 401) throw new WorkspaceSessionExpiredError(response.status);
  if (!response.ok) throw await responseError(response);
  const contentType = (response.headers.get('Content-Type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'audio/wav' && contentType !== 'audio/x-wav') {
    throw new WorkspaceApiError(response.status, 'Speech returned an unsupported audio format.');
  }
  const declaredLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SPEECH_BYTES) {
    throw new WorkspaceApiError(response.status, 'Speech audio exceeded the 4 MiB response limit.');
  }
  const blob = await response.blob();
  if (blob.size === 0 || blob.size > MAX_SPEECH_BYTES) {
    throw new WorkspaceApiError(response.status, blob.size === 0
      ? 'Speech returned an empty audio file.'
      : 'Speech audio exceeded the 4 MiB response limit.');
  }
  return { blob, truncated: response.headers.get('X-Simurgh-Audio-Truncated') === 'true' };
}

export function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

async function responseError(response: Response): Promise<WorkspaceApiError> {
  let message = `The local workspace returned HTTP ${response.status}.`;
  let code: string | null = null;
  try {
    const body = await response.json() as { error?: { code?: unknown; message?: unknown } };
    if (typeof body.error?.message === 'string' && body.error.message.trim()) message = body.error.message;
    if (typeof body.error?.code === 'string') code = body.error.code;
  } catch {
    // Do not display arbitrary response bodies or provider details.
  }
  return new WorkspaceApiError(response.status, message, code);
}

const MAX_SPEECH_BYTES = 4 * 1024 * 1024;
