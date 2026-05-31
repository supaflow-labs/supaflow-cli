// tests/fixtures/stub-cli.mjs -- emits deterministic JSON for `auth status`.
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ authenticated: true, workspace_id: 'ws_test', workspace_name: 'Test' }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ ok: true, argv: args }));
process.exit(0);
