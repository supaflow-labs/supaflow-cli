import { Command } from 'commander';
import fs from 'node:fs';
import { withAuth, type AuthContext } from '../lib/middleware.js';
import { printOutput, formatGetJson } from '../lib/output.js';
import { CliError, ErrorCode } from '../lib/errors.js';
import { encryptValue, encodeEnvelope } from '../lib/encryption.js';
import { parseEnvFile, extractHeader } from '../lib/envfile.js';
import { fetchConnectors, fetchConnectorProperties, filterNonOAuth } from '../lib/connector.js';

export function registerEncryptCommand(program: Command): void {
  program
    .command('encrypt [value]')
    .description('Encrypt a value or all sensitive fields in an env file')
    .option('--file <path>', 'Encrypt sensitive fields in an env file in-place')
    .action(
      withAuth(async (ctx: AuthContext, value?: string, opts?: { file?: string }) => {
        const { supabase, outputOptions } = ctx;

        if (opts?.file) {
          // Mode 2: Encrypt sensitive fields in env file
          const filePath = opts.file;
          if (!fs.existsSync(filePath)) {
            throw new CliError(`File "${filePath}" not found.`, ErrorCode.NOT_FOUND);
          }

          const fileContent = fs.readFileSync(filePath, 'utf-8');
          const header = extractHeader(fileContent);
          if (!header.connector) {
            throw new CliError(
              `File "${filePath}" is missing the "# Connector: <type>" header.`,
              ErrorCode.INVALID_INPUT,
            );
          }

          // Fetch connector properties to identify sensitive fields
          const connectors = await fetchConnectors(supabase);
          const connector = connectors.find(
            (c) => c.type.toLowerCase() === header.connector!.toLowerCase(),
          );
          if (!connector) {
            throw new CliError(`Connector "${header.connector}" not found.`, ErrorCode.NOT_FOUND);
          }

          const properties = await fetchConnectorProperties(supabase, connector.latest_version_id);
          const nonOAuth = filterNonOAuth(properties);
          const sensitiveNames = new Set(
            nonOAuth
              .filter((p) => p.sensitive || p.encrypted || p.password)
              .map((p) => p.name),
          );

          // Parse, encrypt sensitive values, rewrite
          const envValues = parseEnvFile(fileContent);
          const encrypted: string[] = [];
          const lines = fileContent.split('\n');
          const newLines: string[] = [];

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) {
              newLines.push(line);
              continue;
            }
            const eqIndex = trimmed.indexOf('=');
            if (eqIndex === -1) {
              newLines.push(line);
              continue;
            }
            const key = trimmed.slice(0, eqIndex).trim();
            const val = trimmed.slice(eqIndex + 1).trim();

            if (sensitiveNames.has(key) && val && !val.startsWith('enc:') && !val.startsWith('${')) {
              // Encrypt this value
              const envelope = await encryptValue(supabase, val);
              const encoded = encodeEnvelope(envelope);
              newLines.push(`${key}=${encoded}`);
              encrypted.push(key);
            } else {
              newLines.push(line);
            }
          }

          // Suppress unused variable warning
          void envValues;

          fs.writeFileSync(filePath, newLines.join('\n'), 'utf-8');

          if (outputOptions.json) {
            printOutput(formatGetJson({ file: filePath, encrypted_fields: encrypted }));
          } else {
            if (encrypted.length === 0) {
              console.log('No sensitive fields with plaintext values found.');
            } else {
              console.log(`Encrypted ${encrypted.length} sensitive field${encrypted.length === 1 ? '' : 's'} in ${filePath} (${encrypted.join(', ')})`);
            }
          }
        } else if (value) {
          // Mode 1: Encrypt a single value
          const envelope = await encryptValue(supabase, value);
          const encoded = encodeEnvelope(envelope);

          if (outputOptions.json) {
            printOutput(formatGetJson({ encrypted: encoded }));
          } else {
            console.log(encoded);
          }
        } else {
          throw new CliError(
            'Provide a value to encrypt, or use --file to encrypt sensitive fields in an env file.',
            ErrorCode.INVALID_INPUT,
          );
        }
      }),
    );
}
