import type { SupabaseClient } from '@supabase/supabase-js';
import { CliError, ErrorCode } from './errors.js';

const ENC_PREFIX = 'enc:';

export interface EncryptionEnvelope {
  v: number;
  fp: string;
  data: string;
}

export function isEncryptedValue(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}

export function encodeEnvelope(envelope: EncryptionEnvelope): string {
  const json = JSON.stringify(envelope);
  return ENC_PREFIX + Buffer.from(json, 'utf-8').toString('base64');
}

export function decodeEnvelope(encoded: string): EncryptionEnvelope {
  if (!encoded.startsWith(ENC_PREFIX)) {
    throw new Error('Value is not an encrypted envelope (missing enc: prefix)');
  }
  try {
    const base64 = encoded.slice(ENC_PREFIX.length);
    const json = Buffer.from(base64, 'base64').toString('utf-8');
    return JSON.parse(json) as EncryptionEnvelope;
  } catch {
    throw new Error('Invalid encrypted envelope: failed to decode');
  }
}

/**
 * Encrypt a single plaintext value using the workspace's active encryption key.
 * Calls the existing encrypt_with_fingerprint RPC.
 */
export async function encryptValue(
  supabase: SupabaseClient,
  plaintext: string,
): Promise<EncryptionEnvelope> {
  const { data, error } = await supabase.rpc('encrypt_with_fingerprint', {
    p_plaintext: plaintext,
    p_use_system_key: false,
    p_fingerprint: null,
    p_tenant_id: null,
    p_workspace_id: null,
  });

  if (error) {
    throw new CliError(`Encryption failed: ${error.message}`, ErrorCode.API_ERROR);
  }

  return data as EncryptionEnvelope;
}

/**
 * Process config values before submission: decode enc: prefixed values
 * back to their JSONB envelope form so the DB recognizes them as pre-encrypted.
 */
export function resolveEncryptedConfigs(
  configs: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(configs)) {
    if (typeof value === 'string' && isEncryptedValue(value)) {
      result[key] = decodeEnvelope(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}
