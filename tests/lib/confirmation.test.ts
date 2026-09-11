import { describe, expect, it, vi } from 'vitest';
import { confirmDestructiveAction } from '../../src/lib/confirmation.js';
import { ErrorCode } from '../../src/lib/errors.js';

const baseOptions = {
  json: false,
  question: 'Delete it? [y/N] ',
  nonInteractiveMessage: 'Refusing to delete without --yes in non-interactive mode.',
};

describe('confirmDestructiveAction', () => {
  it('accepts --yes without prompting in automation', async () => {
    const prompt = vi.fn();

    await expect(
      confirmDestructiveAction(
        {
          ...baseOptions,
          yes: true,
          json: true,
          interactive: false,
        },
        prompt,
      ),
    ).resolves.toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('fails closed for JSON and non-interactive execution without --yes', async () => {
    for (const options of [
      { ...baseOptions, json: true, interactive: true },
      { ...baseOptions, json: false, interactive: false },
    ]) {
      await expect(confirmDestructiveAction(options)).rejects.toMatchObject({
        code: ErrorCode.INVALID_INPUT,
        message: baseOptions.nonInteractiveMessage,
      });
    }
  });

  it.each([
    ['y', true],
    [' YES ', true],
    ['n', false],
    ['', false],
  ])('maps interactive answer %j to %s', async (answer, expected) => {
    const prompt = vi.fn().mockResolvedValue(answer);

    await expect(
      confirmDestructiveAction(
        {
          ...baseOptions,
          interactive: true,
        },
        prompt,
      ),
    ).resolves.toBe(expected);
    expect(prompt).toHaveBeenCalledWith(baseOptions.question);
  });
});
