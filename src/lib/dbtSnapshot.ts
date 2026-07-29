import { CliError, ErrorCode } from './errors.js';

/**
 * Input to buildDbtTestSnapshot. `row` is a raw `datasources_with_access`
 * row (see supaflow-platform 2e-views.sql `datasources_and_connectors`);
 * `tenantId` comes from a direct `workspaces` lookup the caller performs
 * because `datasources_with_access` / `workspaces_with_access` do not
 * expose it.
 */
export interface DbtSnapshotInput {
  row: Record<string, unknown>;
  tenantId: string;
}

interface ConnectorPropertyFlags {
  name: string;
  encrypted: boolean;
  sensitive: boolean;
  password: boolean;
}

// Mirrors io.supaflow.utils.crypto.EncryptionEnvelope#POSTGRES_HEX_PATTERN
// ("^\\x([0-9a-f]{2})+$", CASE_INSENSITIVE) -- the legacy Postgres bytea hex
// literal form (e.g. "\x0a1b2c").
const POSTGRES_HEX_PATTERN = /^\\x([0-9a-f]{2})+$/i;

/**
 * Ports io.supaflow.utils.crypto.EncryptionEnvelope#looksEncrypted
 * (supaflow-utils/src/main/java/io/supaflow/utils/crypto/EncryptionEnvelope.java:258)
 * EXACTLY -- criterion for criterion, in the same order:
 *
 *   1. null -> false.
 *   2. A Map/object -> true iff it has all three of "v", "fp", "data" keys.
 *   3. A String:
 *      a. true if the trimmed value starts with "{" AND the (untrimmed)
 *         string contains the literal substrings `"fp"` and `"data"`
 *         (a JSON envelope, checked as a cheap substring test -- not a
 *         full JSON parse, matching the Java implementation).
 *      b. else true iff it matches the legacy hex-bytea pattern above.
 *   4. Anything else -> false.
 *
 * This is the CLI's only authority for "is this value already encrypted
 * at rest" -- do not extend or loosen it beyond the Java source, since a
 * false positive here would let a plaintext secret leave the platform in
 * the exported snapshot.
 *
 * IMPORTANT: the CLI's own `enc:` prefix (src/lib/encryption.ts) is a
 * SUBMISSION-time transport marker that gets decoded back into the `{v,
 * fp, data}` envelope before a value is ever written to `datasources.configs`
 * (see `resolveEncryptedConfigs`). A value read back out of storage never
 * carries that prefix, so `enc:...` correctly falls through every branch
 * above to `false` here -- it is not, and must never become, a signal for
 * "encrypted at rest".
 */
export function looksEncrypted(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return 'v' in obj && 'fp' in obj && 'data' in obj;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') && value.includes('"fp"') && value.includes('"data"')) {
      return true;
    }
    return POSTGRES_HEX_PATTERN.test(value);
  }

  return false;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isConnectorPropertyMetadata(prop: unknown): prop is ConnectorPropertyFlags {
  if (!isObjectRecord(prop)) {
    return false;
  }
  return (
    typeof prop.name === 'string' &&
    prop.name.trim() !== '' &&
    typeof prop.encrypted === 'boolean' &&
    typeof prop.sensitive === 'boolean' &&
    typeof prop.password === 'boolean'
  );
}

function isSensitiveProperty(prop: ConnectorPropertyFlags): boolean {
  return prop.encrypted || prop.sensitive || prop.password;
}

/**
 * Builds the version-1 dbt E2E snapshot document for a single datasource.
 * Pure function -- no I/O, no network, no filesystem. Throws CliError on
 * any violation; property-metadata violations name only the property, never
 * the offending value, since that value may be a live plaintext secret.
 */
export function buildDbtTestSnapshot(input: DbtSnapshotInput): Record<string, unknown> {
  const { row, tenantId } = input;

  if (typeof tenantId !== 'string' || tenantId.trim() === '') {
    throw new CliError('Could not resolve workspace tenant.', ErrorCode.NOT_FOUND);
  }

  if (row.state !== 'active') {
    throw new CliError(
      `Datasource is not active (state: "${String(row.state)}"). Only active datasources can be exported for the dbt E2E harness.`,
      ErrorCode.INVALID_INPUT,
    );
  }

  if (!isObjectRecord(row.configs)) {
    throw new CliError(
      'Datasource encrypted config metadata is missing or malformed. Refusing to export the dbt test snapshot.',
      ErrorCode.INVALID_INPUT,
    );
  }
  const configs = row.configs;

  const properties = row.connector_version_properties;
  if (
    !Array.isArray(properties) ||
    properties.length === 0 ||
    !properties.every(isConnectorPropertyMetadata)
  ) {
    throw new CliError(
      'Connector property metadata is missing or malformed. Refusing to export the dbt test snapshot.',
      ErrorCode.INVALID_INPUT,
    );
  }

  for (const prop of properties) {
    if (!isSensitiveProperty(prop)) {
      continue;
    }
    const name = prop.name;
    if (typeof name !== 'string' || !(name in configs)) {
      continue;
    }
    const value = configs[name];
    if (value === null || value === undefined) {
      continue;
    }
    if (!looksEncrypted(value)) {
      throw new CliError(
        `Datasource config property "${name}" is marked encrypted/sensitive but its stored value is not an encrypted envelope. Refusing to export a plaintext secret.`,
        ErrorCode.INVALID_INPUT,
      );
    }
  }

  return {
    format_version: 1,
    datasource: {
      id: row.id,
      tenant_id: tenantId,
      workspace_id: row.workspace_id,
      state: row.state,
      connector: {
        version_id: row.connector_version_id,
        type: row.connector_type,
        group_id: row.connector_group_id,
        artifact_id: row.connector_artifact_id,
        version: row.connector_version,
        java_class: row.connector_java_class,
        capabilities: row.connector_capabilities,
        properties: row.connector_version_properties,
        capabilities_config: row.connector_version_capabilities_config,
      },
      encrypted_configs: configs,
    },
  };
}
