import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import type { CliConfig, OAuthCredentials } from '../types/index.js';
import { readConfig, resolveApiKey, writeConfig } from './config.js';

export function appOrigin(): string {
  const url = new URL(process.env.SUPAFLOW_APP_URL || 'https://app.supa-flow.io');
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
  ) {
    throw new Error('SUPAFLOW_APP_URL must be an HTTPS origin (HTTP is allowed for localhost).');
  }
  return url.origin;
}

export interface OAuthConfig {
  client_id: string;
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  resource: string;
  scopes: string[];
}

export async function loadOAuthConfig(): Promise<OAuthConfig> {
  const origin = appOrigin();
  const response = await fetch(`${origin}/api/cli/oauth/config`, {
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!response.ok)
    throw new Error(
      'Browser login is not configured for this Supaflow app. Use --key or SUPAFLOW_API_KEY.',
    );
  const config = (await response.json()) as OAuthConfig;
  if (!config || typeof config.client_id !== 'string' || /\s/.test(config.client_id)) {
    throw new Error('Invalid OAuth configuration returned by Supaflow.');
  }
  const issuer = new URL(config.issuer);
  if (
    issuer.protocol !== 'https:' ||
    issuer.username ||
    issuer.password ||
    issuer.pathname !== '/' ||
    issuer.search ||
    issuer.hash ||
    !config.client_id ||
    config.resource !== `${origin}/api/cli/bootstrap` ||
    !Array.isArray(config.scopes) ||
    !config.scopes.every((s) => typeof s === 'string') ||
    config.authorization_endpoint !== `${issuer.origin}/oauth/authorize` ||
    config.token_endpoint !== `${issuer.origin}/oauth/token`
  ) {
    throw new Error('Invalid OAuth configuration returned by Supaflow.');
  }
  return config;
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export async function exchangeTokens(
  config: OAuthConfig,
  parameters: Record<string, string>,
  previousRefresh?: string,
): Promise<OAuthCredentials> {
  const response = await fetch(config.token_endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      ...parameters,
      client_id: config.client_id,
      resource: config.resource,
    }),
  });
  // Never include the upstream response in errors: it can contain credentials.
  if (!response.ok)
    throw new Error('OAuth authentication failed. Run "supaflow auth login" to sign in again.');
  const body = await response.json().catch(() => {
    throw new Error('Invalid OAuth token response.');
  });
  if (
    !body ||
    typeof body !== 'object' ||
    typeof body.access_token !== 'string' ||
    !body.access_token ||
    typeof body.token_type !== 'string' ||
    body.token_type.toLowerCase() !== 'bearer' ||
    typeof body.expires_in !== 'number' ||
    !Number.isFinite(body.expires_in) ||
    body.expires_in <= 0 ||
    (body.refresh_token !== undefined &&
      (typeof body.refresh_token !== 'string' || !body.refresh_token))
  ) {
    throw new Error('Invalid OAuth token response.');
  }
  const refreshToken = body.refresh_token ?? previousRefresh;
  if (!refreshToken) throw new Error('OAuth did not return offline access. Please sign in again.');
  return {
    access_token: body.access_token,
    refresh_token: refreshToken,
    expires_at: Date.now() + body.expires_in * 1000,
    app_origin: appOrigin(),
    issuer: config.issuer,
    client_id: config.client_id,
  };
}

function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Could not open browser.')),
    );
  });
}

const resultPage = (success: boolean) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Supaflow CLI</title><style>body{margin:0;background:#141414;color:#f5f5f5;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;text-align:center}main{padding:32px}h1{font-size:32px;font-weight:500}p{color:#aaa;line-height:1.7;font-size:18px}</style><main><h1>${success ? 'You’re connected to Supaflow' : 'Connection was not completed'}</h1><p>${success ? 'Return to your terminal to continue.<br>You can close this window.' : 'Return to your terminal for details.<br>You can close this window.'}</p></main></html>`;

/** One-shot loopback listener. Success is sent only after validation and storage. */
export async function browserLogin(
  saveAction: (credentials: OAuthCredentials, signal: AbortSignal) => Promise<void>,
  openAction: (url: string) => Promise<void> = openBrowser,
  timeoutMs = 180_000,
): Promise<void> {
  const config = await loadOAuthConfig();
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  let redirectUri = '';
  let processing = false;
  const controller = new AbortController();
  let resolveLogin!: () => void;
  let rejectLogin!: (error: Error) => void;
  const completed = new Promise<void>((resolve, reject) => {
    resolveLogin = resolve;
    rejectLogin = reject;
  });
  // Attach a handler before opening the browser, including when opening fails.
  void completed.catch(() => {});
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    );
    let callback: URL;
    try {
      callback = new URL(req.url || '/', redirectUri);
    } catch {
      res.writeHead(400).end('Invalid callback URL.');
      return;
    }
    if (
      req.method !== 'GET' ||
      callback.pathname !== '/callback' ||
      req.headers.host !== new URL(redirectUri).host
    ) {
      res.writeHead(404).end();
      return;
    }
    const receivedState = callback.searchParams.get('state') || '';
    if (
      callback.searchParams.getAll('state').length !== 1 ||
      !/^[A-Za-z0-9_-]{43}$/.test(receivedState) ||
      !timingSafeEqual(Buffer.from(receivedState), Buffer.from(state))
    ) {
      res.writeHead(400).end('Invalid login state.');
      return;
    }
    if (processing) {
      res.writeHead(409).end('Login already in progress.');
      return;
    }
    processing = true;
    try {
      const code = callback.searchParams.get('code');
      if (
        callback.searchParams.has('error') ||
        !code ||
        callback.searchParams.getAll('code').length !== 1
      ) {
        throw new Error('Browser authorization was declined or did not return a code.');
      }
      const credentials = await exchangeTokens(config, {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      });
      controller.signal.throwIfAborted();
      await saveAction(credentials, controller.signal);
      controller.signal.throwIfAborted();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(resultPage(true));
      resolveLogin();
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(resultPage(false));
      rejectLogin(error instanceof Error ? error : new Error('Browser login failed.'));
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Could not start login callback.');
    redirectUri = `http://127.0.0.1:${address.port}/callback`;
    const authorization = new URL(config.authorization_endpoint);
    authorization.search = new URLSearchParams({
      response_type: 'code',
      client_id: config.client_id,
      redirect_uri: redirectUri,
      scope: config.scopes.join(' '),
      resource: config.resource,
      state,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
    }).toString();
    timer = setTimeout(() => {
      controller.abort();
      rejectLogin(new Error('Browser login timed out. Try again or use an API key.'));
    }, timeoutMs);
    console.error('Opening your browser to sign in to Supaflow…');
    await openAction(authorization.toString()).catch(() => {
      // This URL contains no code or token; stderr keeps JSON stdout clean.
      console.error(`Open this URL in your browser to continue:\n${authorization}`);
    });
    await completed;
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}

export async function resolveCredential(
  flag: string | undefined,
  config: CliConfig,
): Promise<string | undefined> {
  const key = resolveApiKey(flag, process.env.SUPAFLOW_API_KEY || undefined, config);
  if (key) return key;
  const oauth = config.oauth;
  if (!oauth) return undefined;
  if (oauth.app_origin !== appOrigin())
    throw new Error(
      'Stored OAuth login belongs to another Supaflow app. Run "supaflow auth login".',
    );
  if (oauth.expires_at > Date.now() + 60_000) return oauth.access_token;
  const settings = await loadOAuthConfig();
  if (settings.issuer !== oauth.issuer || settings.client_id !== oauth.client_id) {
    throw new Error('OAuth client configuration changed. Run "supaflow auth login" again.');
  }
  const refreshed = await exchangeTokens(
    settings,
    { grant_type: 'refresh_token', refresh_token: oauth.refresh_token },
    oauth.refresh_token,
  );
  writeConfig({ ...readConfig(), oauth: refreshed });
  return refreshed.access_token;
}
