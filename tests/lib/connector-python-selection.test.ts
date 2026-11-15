import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/connector-python-process.js', async (original) => {
  const module = await original<typeof import('../../src/lib/connector-python-process.js')>();
  return { ...module, runPythonProcess: vi.fn() };
});
vi.mock('../../src/lib/connector-python-probe.js', () => ({ probeConnectorPython: vi.fn() }));

import { runPythonProcess } from '../../src/lib/connector-python-process.js';
import { probeConnectorPython } from '../../src/lib/connector-python-probe.js';
import { selectConnectorPython } from '../../src/lib/connector-python-selection.js';

const facts = { executable: '/installed/python', version: [3, 14, 8], implementation: 'cpython' };

function output(raw: string | Buffer, status = 0) {
  vi.mocked(runPythonProcess).mockImplementation(async (_uv, _args, _input, validate) =>
    validate(Buffer.from(raw), status),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(probeConnectorPython).mockResolvedValue({ ...facts, version: [3, 14, 8] });
});

describe('installed Python selection', () => {
  it('delegates compatibility to uv and inspects its selected absolute interpreter', async () => {
    output('/installed/python\n');
    const controller = new AbortController();
    const options = { signal: controller.signal, timeoutMs: 1234 };
    expect(await selectConnectorPython('/tools/uv', '>=3.11,!=3.12.*,<3.15', options)).toEqual(
      facts,
    );
    expect(runPythonProcess).toHaveBeenCalledWith(
      '/tools/uv',
      [
        'python',
        'find',
        '--no-project',
        '--system',
        '--no-python-downloads',
        '--offline',
        '--no-config',
        '--no-cache',
        '--',
        '>=3.11,!=3.12.*,<3.15',
      ],
      null,
      expect.any(Function),
      { ...options, stderr: 'ignore' },
    );
    expect(probeConnectorPython).toHaveBeenCalledWith('/installed/python', options);
  });

  it('accepts an absolute path containing spaces and CRLF output', async () => {
    output('/installed Python/bin/python\r\n');
    await selectConnectorPython('/tools/uv', '>=3.11');
    expect(probeConnectorPython).toHaveBeenCalledWith('/installed Python/bin/python', {});
  });

  it.each(['', '   ', 'bad\0requirement'])(
    'rejects an invalid requirement before starting uv: %j',
    async (requirement) => {
      await expect(selectConnectorPython('/tools/uv', requirement)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      expect(runPythonProcess).not.toHaveBeenCalled();
      expect(probeConnectorPython).not.toHaveBeenCalled();
    },
  );

  it('passes an option-like request as data rather than a uv option', async () => {
    output('PRIVATE_UV_ERROR\n', 2);
    await expect(selectConnectorPython('/tools/uv', '--managed-python')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    expect(vi.mocked(runPythonProcess).mock.calls[0][1].slice(-2)).toEqual([
      '--',
      '--managed-python',
    ]);
    expect(probeConnectorPython).not.toHaveBeenCalled();
  });

  it.each([
    'relative/python\n',
    '/installed/python',
    '/installed/python\nPRIVATE_UV_OUTPUT\n',
    '/installed/\0python\n',
    '/installed/\rpython\n',
    '\n',
    Buffer.from([0xff, 10]),
  ])('rejects invalid output without executing it (%#)', async (raw) => {
    output(raw);
    const error = await selectConnectorPython('/tools/uv', '>=3.11').catch((caught) => caught);
    expect(error).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(error.message).not.toContain('PRIVATE_UV_OUTPUT');
    expect(probeConnectorPython).not.toHaveBeenCalled();
  });

  it('reports selection failure without exposing uv output', async () => {
    output('PRIVATE_UV_ERROR\n', 2);
    const error = await selectConnectorPython('/tools/uv', '>=99').catch((caught) => caught);
    expect(error).toMatchObject({ code: 'UNAVAILABLE' });
    expect(error.message).toContain('Python requirement');
    expect(error.message).not.toContain('PRIVATE_UV_ERROR');
    expect(probeConnectorPython).not.toHaveBeenCalled();
  });

  it('preserves a cancellation between selection and the interpreter probe', async () => {
    output('/installed/python\n');
    const error = Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
    vi.mocked(probeConnectorPython).mockRejectedValue(error);
    await expect(selectConnectorPython('/tools/uv', '>=3.11')).rejects.toBe(error);
  });
});
