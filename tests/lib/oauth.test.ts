import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserLogin, pkceChallenge, resolveCredential } from '../../src/lib/oauth.js';
import type { CliConfig, OAuthCredentials } from '../../src/types/index.js';
import { writeConfig } from '../../src/lib/config.js';

vi.mock('../../src/lib/config.js', async (original) => ({
  ...(await original<typeof import('../../src/lib/config.js')>()),
  writeConfig: vi.fn(),
  readConfig: () => ({ workspace_id: 'preserve-me' }),
}));
const nativeFetch = globalThis.fetch;
const settings = {
  client_id: 'test-cli',
  issuer: 'https://clerk.example.test',
  authorization_endpoint: 'https://clerk.example.test/oauth/authorize',
  token_endpoint: 'https://clerk.example.test/oauth/token',
  resource: 'https://app.supa-flow.io/api/cli/bootstrap',
  scopes: ['offline_access', 'user:org:read', 'supaflow:read', 'supaflow:write'],
};
const credentials: OAuthCredentials = {
  access_token: 'test-access',
  refresh_token: 'test-refresh',
  expires_at: Date.now() + 300_000,
  client_id: settings.client_id,
  issuer: settings.issuer,
  app_origin: 'https://app.supa-flow.io',
};
let tokenResponse: Record<string, unknown>;
let tokenRequests: URLSearchParams[];
beforeEach(() => {
  vi.stubEnv('SUPAFLOW_APP_URL', 'https://app.supa-flow.io');
  vi.stubEnv('SUPAFLOW_API_KEY', '');
  tokenRequests = [];
  tokenResponse = {
    access_token: 'new-access',
    refresh_token: 'rotated-refresh',
    expires_in: 3600,
    token_type: 'Bearer',
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      if (String(input).endsWith('/api/cli/oauth/config')) return Response.json(settings);
      if (String(input) === settings.token_endpoint) {
        tokenRequests.push(new URLSearchParams(init?.body as string));
        return Response.json(tokenResponse);
      }
      return nativeFetch(input, init);
    }),
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('browser PKCE login', () => {
  it('rejects forged callbacks and stores credentials before displaying success', async () => {
    let saved = false;
    await browserLogin(
      async (c) => {
        expect(c.access_token).toBe('new-access');
        saved = true;
      },
      async (url) => {
        const authorization = new URL(url);
        expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
        expect(authorization.searchParams.get('resource')).toBe(settings.resource);
        expect(authorization.searchParams.has('client_secret')).toBe(false);
        const callback = new URL(authorization.searchParams.get('redirect_uri')!);
        callback.searchParams.set('code', 'test-code');
        callback.searchParams.set('state', 'invalid-state');
        expect((await nativeFetch(callback)).status).toBe(400);
        expect(tokenRequests).toHaveLength(0);
        callback.searchParams.set('state', authorization.searchParams.get('state')!);
        const response = await nativeFetch(callback);
        expect(saved).toBe(true);
        expect(await response.text()).toContain('You’re connected to Supaflow');
        expect(pkceChallenge(tokenRequests[0].get('code_verifier')!)).toBe(
          authorization.searchParams.get('code_challenge'),
        );
        expect(tokenRequests[0].get('redirect_uri')).toBe(
          authorization.searchParams.get('redirect_uri'),
        );
      },
    );
  });
  it('does not store credentials after a denied grant', async () => {
    const save = vi.fn();
    await expect(
      browserLogin(save, async (url) => {
        const auth = new URL(url);
        const callback = new URL(auth.searchParams.get('redirect_uri')!);
        callback.searchParams.set('state', auth.searchParams.get('state')!);
        callback.searchParams.set('error', 'access_denied');
        expect((await nativeFetch(callback)).status).toBe(400);
      }),
    ).rejects.toThrow('declined');
    expect(save).not.toHaveBeenCalled();
    expect(tokenRequests).toHaveLength(0);
  });
  it('does not show success when credential storage fails', async () => {
    await expect(
      browserLogin(
        async () => {
          throw new Error('disk full');
        },
        async (url) => {
          const auth = new URL(url);
          const callback = new URL(auth.searchParams.get('redirect_uri')!);
          callback.searchParams.set('state', auth.searchParams.get('state')!);
          callback.searchParams.set('code', 'test-code');
          const response = await nativeFetch(callback);
          expect(response.status).toBe(400);
          expect(await response.text()).not.toContain('You’re connected');
        },
      ),
    ).rejects.toThrow('disk full');
  });
  it('times out and closes an unused listener', async () => {
    let callback = '';
    await expect(
      browserLogin(
        vi.fn(),
        async (url) => {
          callback = new URL(url).searchParams.get('redirect_uri')!;
        },
        20,
      ),
    ).rejects.toThrow('timed out');
    await expect(nativeFetch(callback)).rejects.toThrow();
  });
  it('keeps the timeout active while validating and saving credentials', async () => {
    let saving = false;
    let aborted = false;
    let callbackRequest: Promise<unknown> | undefined;
    await expect(
      browserLogin(
        async (_credentials, signal) => {
          saving = true;
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                reject(new Error('validation aborted'));
              },
              { once: true },
            ),
          );
        },
        async (url) => {
          const auth = new URL(url);
          const callback = new URL(auth.searchParams.get('redirect_uri')!);
          callback.searchParams.set('state', auth.searchParams.get('state')!);
          callback.searchParams.set('code', 'test-code');
          callbackRequest = nativeFetch(callback).catch(() => undefined);
        },
        100,
      ),
    ).rejects.toThrow('timed out');
    expect(saving).toBe(true);
    expect(aborted).toBe(true);
    await callbackRequest;
  });
});

describe('credential resolution', () => {
  it('keeps explicit API keys and the environment ahead of stored credentials', async () => {
    const config: CliConfig = { api_key: 'stored-key', oauth: credentials };
    vi.stubEnv('SUPAFLOW_API_KEY', 'env-key');
    expect(await resolveCredential('flag-key', config)).toBe('flag-key');
    expect(await resolveCredential(undefined, config)).toBe('env-key');
    vi.stubEnv('SUPAFLOW_API_KEY', '');
    // Empty environment values must not shadow stored authentication.
    expect(await resolveCredential(undefined, config)).toBe('stored-key');
  });
  it('reuses an unexpired OAuth token without exchanging it', async () => {
    expect(await resolveCredential(undefined, { oauth: credentials })).toBe('test-access');
    expect(tokenRequests).toHaveLength(0);
  });
  it('refreshes expired OAuth credentials and persists rotation without losing workspace selection', async () => {
    expect(await resolveCredential(undefined, { oauth: { ...credentials, expires_at: 0 } })).toBe(
      'new-access',
    );
    expect(tokenRequests[0].get('grant_type')).toBe('refresh_token');
    expect(tokenRequests[0].get('resource')).toBe(settings.resource);
    expect(writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: 'preserve-me',
        oauth: expect.objectContaining({ refresh_token: 'rotated-refresh' }),
      }),
    );
  });
  it('retains a refresh token when the provider does not rotate it', async () => {
    delete tokenResponse.refresh_token;
    await resolveCredential(undefined, { oauth: { ...credentials, expires_at: 0 } });
    expect(writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        oauth: expect.objectContaining({ refresh_token: 'test-refresh' }),
      }),
    );
  });
  it('refuses to send stored OAuth credentials to a different app', async () => {
    vi.stubEnv('SUPAFLOW_APP_URL', 'https://another.example.test');
    await expect(resolveCredential(undefined, { oauth: credentials })).rejects.toThrow(
      'another Supaflow app',
    );
    expect(tokenRequests).toHaveLength(0);
  });
  it('fails closed for invalid token responses without persisting them', async () => {
    tokenResponse.token_type = 'MAC';
    await expect(
      resolveCredential(undefined, { oauth: { ...credentials, expires_at: 0 } }),
    ).rejects.toThrow('Invalid OAuth');
    expect(writeConfig).not.toHaveBeenCalled();
  });
});
