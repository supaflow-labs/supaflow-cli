import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { CliConfig } from '../types/index.js';

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.supaflow');
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_CONFIG_DIR, 'config.json');

export function readConfig(configPath: string = DEFAULT_CONFIG_PATH): CliConfig {
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as CliConfig;
  } catch {
    return {};
  }
}

export function writeConfig(config: CliConfig, configPath: string = DEFAULT_CONFIG_PATH): void {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

export function clearConfig(configPath: string = DEFAULT_CONFIG_PATH): void {
  try {
    fs.unlinkSync(configPath);
  } catch {
    // File doesn't exist, nothing to clear
  }
}

export function resolveApiKey(
  flag: string | undefined,
  env: string | undefined,
  config: CliConfig,
): string | undefined {
  return flag ?? env ?? config.api_key;
}

export function resolveWorkspaceId(
  flag: string | undefined,
  env: string | undefined,
  config: CliConfig,
): string | undefined {
  return flag ?? env ?? config.workspace_id;
}
