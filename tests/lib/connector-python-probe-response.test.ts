import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/connector-python-process.js', async (original) => {
  const module = await original<typeof import('../../src/lib/connector-python-process.js')>();
  return { ...module, runPythonProcess: vi.fn() };
});

import { runPythonProcess } from '../../src/lib/connector-python-process.js';
import { probeConnectorPython } from '../../src/lib/connector-python-probe.js';

function response(raw: string | Buffer, status = 0) {
  vi.mocked(runPythonProcess).mockImplementation(async (_python, _arguments, _request, validate) =>
    validate(Buffer.from(raw), status),
  );
}

describe('interpreter probe response boundary', () => {
  it('returns facts without enforcing toolchain or agent compatibility', async () => {
    const value = { executable: '/candidate/python', version: [3, 8, 1], implementation: 'pypy' };
    response(JSON.stringify(value) + '\n');
    expect(await probeConnectorPython('/candidate/python')).toEqual(value);
    const [, args, input, , options] = vi.mocked(runPythonProcess).mock.calls.at(-1)!;
    expect(args.slice(0, 4)).toEqual(['-I', '-S', '-B', '-c']);
    expect(input).toBeNull();
    expect(options).toMatchObject({ stderr: 'ignore', timeoutMs: 5000 });
  });

  it.each([
    ['PRIVATE_STARTUP_OUTPUT\n', 0],
    ['{}\n', 0],
    ['[]\n', 0],
    ['{"executable":"/python","version":[3,14,0],"implementation":"cpython"}', 0],
    ['{"executable":"/python","version":[3,14,0],"implementation":"cpython"}\n{}\n', 0],
    [Buffer.from([0xff, 10]), 0],
    [
      JSON.stringify({ executable: 'relative', version: [3, 14, 0], implementation: 'cpython' }) +
        '\n',
      0,
    ],
    [
      JSON.stringify({ executable: '/bad\0path', version: [3, 14, 0], implementation: 'cpython' }) +
        '\n',
      0,
    ],
    [
      JSON.stringify({ executable: '/python', version: [3, 14], implementation: 'cpython' }) + '\n',
      0,
    ],
    [
      JSON.stringify({ executable: '/python', version: [3, true, 0], implementation: 'cpython' }) +
        '\n',
      0,
    ],
    [
      JSON.stringify({ executable: '/python', version: [0, 14, 0], implementation: 'cpython' }) +
        '\n',
      0,
    ],
    [
      JSON.stringify({ executable: '/python', version: [3, -1, 0], implementation: 'cpython' }) +
        '\n',
      0,
    ],
    [JSON.stringify({ executable: '/python', version: [3, 14, 0], implementation: '' }) + '\n', 0],
    [
      JSON.stringify({
        executable: '/python',
        version: [3, 14, 0],
        implementation: 'cpython',
        extra: true,
      }) + '\n',
      0,
    ],
    [
      JSON.stringify({ executable: '/python', version: [3, 14, 0], implementation: 'cpython' }) +
        '\n',
      1,
    ],
  ] as const)(
    'rejects malformed or failed probes without echoing captured output (%#)',
    async (raw, status) => {
      response(raw, status);
      const error = await probeConnectorPython('/candidate/python').catch(
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({ code: 'INVALID_RESPONSE' });
      expect((error as Error).message).not.toContain('PRIVATE_STARTUP_OUTPUT');
    },
  );
});
