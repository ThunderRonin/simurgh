import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiDownload, apiJson, apiWav, WorkspaceApiError, WorkspaceSessionExpiredError } from '../../packages/workspace/src/api';

const requests = [
  ['apiJson', () => apiJson('/api/references/missing')],
  ['apiDownload', () => apiDownload('/api/investigations/missing/export')],
  ['apiWav', () => apiWav('/api/investigations/missing/speech', new AbortController().signal)],
] as const;

describe('workspace API authorization errors', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(requests)('%s keeps a missing resource distinct from an expired session', async (_name, request) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'not_found', message: 'This item is unavailable.' } }, { status: 404 })));

    await expect(request()).rejects.toMatchObject({
      name: 'WorkspaceApiError',
      status: 404,
      code: 'not_found',
      message: 'This item is unavailable.',
    });
    await expect(request()).rejects.not.toBeInstanceOf(WorkspaceSessionExpiredError);
  });

  it.each(requests)('%s still identifies an unauthorized response as an expired session', async (_name, request) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'auth', message: 'Sign in required.' } }, { status: 401 })));

    await expect(request()).rejects.toBeInstanceOf(WorkspaceSessionExpiredError);
  });

  it('uses the regular API error type for unavailable resources', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));

    await expect(apiJson('/api/references/missing')).rejects.toBeInstanceOf(WorkspaceApiError);
  });
});
