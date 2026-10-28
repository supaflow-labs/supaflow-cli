import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthenticatedClient } from '../../src/lib/client.js';

const success = () =>
  Response.json({
    token: 'fixture-session',
    supabase_url: 'https://regional.example.test',
    supabase_anon_key: 'fixture-anon',
  });
const connect = () => createAuthenticatedClient('fixture-access', undefined, 'oauth');

describe('bootstrap retry boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('SUPAFLOW_APP_URL', 'http://localhost:3000');
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([408, 425, 429, 500, 502, 503, 504])(
    'recovers HTTP %s without changing the credential or endpoint',
    async (status) => {
      const request = vi
        .fn()
        .mockResolvedValueOnce(new Response('private detail', { status }))
        .mockImplementation(async () => success());
      vi.stubGlobal('fetch', request);
      const result = connect();
      await vi.runAllTimersAsync();
      expect((await result).conn.bearerToken).toBe('fixture-session');
      expect(request).toHaveBeenCalledTimes(2);
      for (const [url, init] of request.mock.calls) {
        expect(url).toBe('http://localhost:3000/api/cli/bootstrap');
        expect(init).toMatchObject({
          method: 'POST',
          redirect: 'error',
          headers: { Authorization: 'Bearer fixture-access' },
        });
      }
      expect(request.mock.calls[0][1].signal).not.toBe(request.mock.calls[1][1].signal);
    },
  );

  it('recovers a network failure', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementation(async () => success());
    vi.stubGlobal('fetch', request);
    const result = connect();
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBeDefined();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404])(
    'does not retry HTTP %s or expose its response body',
    async (status) => {
      const request = vi
        .fn()
        .mockResolvedValue(new Response('private upstream detail', { status }));
      vi.stubGlobal('fetch', request);
      await expect(connect()).rejects.toThrow(`Bootstrap failed (${status})`);
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it('limits repeated transient failures to three attempts', async () => {
    const request = vi
      .fn()
      .mockImplementation(async () => new Response('private detail', { status: 503 }));
    vi.stubGlobal('fetch', request);
    const check = expect(connect()).rejects.toThrow(/^Bootstrap failed \(503\)$/);
    await vi.runAllTimersAsync();
    await check;
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['cli_oauth_disabled', 'CLI OAuth access is disabled', 'OAuth applications'],
    ['api_disabled', 'API access is disabled', 'enable API access'],
    ['api_keys_disabled', 'API key access is disabled', 'Allow API keys'],
    [
      'organization_administrator_required',
      'CLI access requires',
      'Sign in with an eligible account',
    ],
  ])('explains %s without retrying or exposing diagnostics', async (code, reason, action) => {
    const request = vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: code, details: 'private upstream detail' }, { status: 403 }),
      );
    vi.stubGlobal('fetch', request);
    const error = await connect().catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Bootstrap failed (403)');
    expect((error as Error).message).toContain(reason);
    expect((error as Error).message).toContain(action);
    expect((error as Error).message).not.toContain('private upstream detail');
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    null,
    [],
    'private upstream detail',
    {},
    { error: 'private upstream detail' },
    { error: { message: 'private upstream detail' } },
    { error: 'constructor' },
    { error: 'cli_oauth_disabled\nprivate upstream detail' },
  ])('keeps unknown or malformed access errors private: %j', async (body) => {
    const request = vi.fn().mockResolvedValue(Response.json(body, { status: 403 }));
    vi.stubGlobal('fetch', request);
    await expect(connect()).rejects.toThrow(/^Bootstrap failed \(403\)$/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(['seconds', 'date'])('honors Retry-After %s', async (format) => {
    const retryAfter = format === 'seconds' ? '2' : new Date(Date.now() + 2_000).toUTCString();
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('', { status: 429, headers: { 'Retry-After': retryAfter } }),
      )
      .mockImplementation(async () => success());
    vi.stubGlobal('fetch', request);
    const result = connect();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toBeDefined();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not wait beyond the budget for Retry-After', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '120' } }));
    vi.stubGlobal('fetch', request);
    await expect(connect()).rejects.toThrow('Bootstrap failed (429)');
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts hung attempts and stops within the total 30-second budget', async () => {
    const request = vi.fn().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        }),
    );
    vi.stubGlobal('fetch', request);
    const check = expect(connect()).rejects.toThrow('Bootstrap endpoint unavailable');
    await vi.advanceTimersByTimeAsync(30_000);
    await check;
    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry malformed successful JSON', async () => {
    const request = vi.fn().mockResolvedValue(new Response('not-json'));
    vi.stubGlobal('fetch', request);
    await expect(connect()).rejects.toThrow(/^Bootstrap returned invalid JSON$/);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
