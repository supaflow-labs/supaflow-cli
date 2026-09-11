import { createInterface } from 'node:readline/promises';
import { CliError, ErrorCode } from './errors.js';

export interface DestructiveConfirmationOptions {
  yes?: boolean;
  json: boolean;
  question: string;
  nonInteractiveMessage: string;
  interactive?: boolean;
}

type Prompt = (question: string) => Promise<string>;

async function promptFromTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** Require explicit acknowledgement before a CLI command performs a destructive action. */
export async function confirmDestructiveAction(
  options: DestructiveConfirmationOptions,
  prompt: Prompt = promptFromTerminal,
): Promise<boolean> {
  if (options.yes) return true;

  const interactive = options.interactive ?? process.stdin.isTTY === true;
  if (options.json || !interactive) {
    throw new CliError(options.nonInteractiveMessage, ErrorCode.INVALID_INPUT);
  }

  const answer = (await prompt(options.question)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}
