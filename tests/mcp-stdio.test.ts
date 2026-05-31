import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '../dist/index.js');
const STUB = path.resolve(HERE, 'fixtures/stub-cli.mjs');

const rpc = (obj: unknown) => JSON.stringify(obj) + '\n';
const init = rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
const initialized = rpc({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

function collect(stream: NodeJS.ReadableStream): { value: string } {
  const acc = { value: '' };
  stream.on('data', (d) => (acc.value += d.toString()));
  return acc;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('supaflow mcp stdio', () => {
  it('emits only valid JSON-RPC and lists 44 tools', async () => {
    const child = spawn(process.execPath, [DIST, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = collect(child.stdout);
    child.stdin.write(init); child.stdin.write(initialized);
    child.stdin.write(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
    await sleep(1500); child.kill();

    const lines = out.value.split('\n').filter((l) => l.trim());
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(JSON.parse(l).jsonrpc).toBe('2.0'); // throws if non-JSON leaked
    expect(lines.map((l) => JSON.parse(l)).find((m) => m.id === 2)?.result?.tools?.length).toBe(44);
  }, 10000);

  it('runs a real tools/call through self-invocation (stub CLI)', async () => {
    const child = spawn(process.execPath, [DIST, 'mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SUPAFLOW_CLI_ENTRY: STUB },
    });
    const out = collect(child.stdout);
    child.stdin.write(init); child.stdin.write(initialized);
    child.stdin.write(rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'auth_status', arguments: {} } }));
    await sleep(1500); child.kill();

    const resp = out.value.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).find((m) => m.id === 3);
    const text = resp?.result?.content?.[0]?.text ?? '';
    expect(text).toContain('authenticated');
    expect(text).toContain('ws_test');
  }, 10000);

  it('does NOT act as an MCP server when run as a plain CLI command', async () => {
    // Catches a reintroduced import-time auto-run guard: a plain invocation must never
    // answer JSON-RPC. `connectors list` errors offline but must not server-respond.
    const child = spawn(process.execPath, [DIST, 'connectors', 'list'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = collect(child.stdout);
    child.stdin.write(rpc({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }));
    await sleep(1500); child.kill();

    const sawServerResponse = out.value.split('\n').filter((l) => l.trim()).some((l) => {
      try { const m = JSON.parse(l); return m.id === 9 && m.result?.tools; } catch { return false; }
    });
    expect(sawServerResponse).toBe(false);
  }, 10000);
});
