// tests/fixtures/stub-cli.mjs -- emits deterministic JSON for `auth status`.
const args = process.argv.slice(2);
// Detect the subcommand by content, not position: forwarded global flags
// (e.g. --supabase-url) may be prepended ahead of the `auth status` tokens.
if (args.includes('auth') && args.includes('status')) {
  // Echo the forwarded context so the override-forwarding test can assert it.
  process.stdout.write(JSON.stringify({
    authenticated: true,
    workspace_id: process.env.SUPAFLOW_WORKSPACE_ID ?? 'ws_test',
    workspace_name: 'Test',
    api_key_seen: process.env.SUPAFLOW_API_KEY ?? null,
    argv: args,
  }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ ok: true, argv: args }));
process.exit(0);
