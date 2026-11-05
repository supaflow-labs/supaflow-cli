import type { SupabaseClient } from '@supabase/supabase-js';
import type { PropertyGroup } from './envfile.js';
import { CliError, ErrorCode } from './errors.js';
import { normalizeFileValue } from './file-value.js';
import { fetchAllRowsByKey } from './supabase-pagination.js';

export type ConnectionRole = 'SOURCE' | 'DESTINATION';

export function parseConnectionRole(value?: string | null): ConnectionRole | undefined {
  if (!value) return undefined;
  const role = value.toUpperCase();
  if (role !== 'SOURCE' && role !== 'DESTINATION') {
    throw new CliError('Connection role must be SOURCE or DESTINATION', ErrorCode.INVALID_INPUT);
  }
  return role;
}

export function propertyDefault(property: ConnectorProperty, role?: ConnectionRole): unknown {
  return role && property.defaultValueByRole && Object.hasOwn(property.defaultValueByRole, role)
    ? property.defaultValueByRole[role]
    : property.defaultValue;
}

export interface ConnectorInfo extends Record<string, unknown> {
  id: string;
  name: string;
  type: string;
  latest_version_id: string;
  latest_version: string;
  connector_capabilities: string[];
}

export interface ConnectorProperty {
  name: string;
  type: string;
  label: string;
  description: string;
  inputType: string;
  propertyGroup: string;
  displayOrder: number;
  required: boolean;
  encrypted: boolean;
  password: boolean;
  sensitive: boolean;
  hidden: boolean;
  readOnly: boolean;
  defaultValue: unknown;
  defaultValueByRole?: Partial<Record<ConnectionRole, unknown>>;
  enumValues: string[] | null;
  minValue: number | null;
  maxValue: number | null;
  minLength: number | null;
  maxLength: number | null;
  multiValue: boolean;
  relatedPropertyNameAndValue: [string, ...unknown[]] | null;
}

export async function fetchConnectors(supabase: SupabaseClient): Promise<ConnectorInfo[]> {
  try {
    return await fetchAllRowsByKey<ConnectorInfo>(() => supabase.rpc('get_connectors'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Failed to fetch connectors: ${message}`, ErrorCode.API_ERROR);
  }
}

export async function fetchConnectorProperties(
  supabase: SupabaseClient,
  connectorVersionId: string,
): Promise<ConnectorProperty[]> {
  const { data, error } = await supabase.rpc('get_connector_version', {
    connectorVersionId,
  });
  if (error || !data || data.length === 0) {
    throw new CliError(
      `Failed to fetch connector version: ${error?.message || 'not found'}`,
      ErrorCode.API_ERROR,
    );
  }
  return (data[0].properties || []) as ConnectorProperty[];
}

export function filterNonOAuth(properties: ConnectorProperty[]): ConnectorProperty[] {
  return properties.filter((p) => p.type !== 'OAUTH_CONFIG');
}

export function isOAuthOnly(properties: ConnectorProperty[]): boolean {
  const nonOAuth = filterNonOAuth(properties);
  // If no required non-OAuth properties exist without OAuth dependency, it's OAuth-only
  const hasIndependentRequired = nonOAuth.some((p) => {
    if (!p.required) return false;
    if (!p.relatedPropertyNameAndValue) return true;
    // Check if dependency is on an OAUTH_CONFIG property
    const parentName = p.relatedPropertyNameAndValue[0];
    const parent = properties.find((pp) => pp.name === parentName);
    return !parent || parent.type !== 'OAUTH_CONFIG';
  });
  return !hasIndependentRequired;
}

export function groupAndSortProperties(
  properties: ConnectorProperty[],
  role?: ConnectionRole,
): PropertyGroup[] {
  const groupMap = new Map<string, ConnectorProperty[]>();
  for (const p of properties) {
    const group = p.propertyGroup || 'General';
    if (!groupMap.has(group)) groupMap.set(group, []);
    groupMap.get(group)!.push(p);
  }

  const groups: PropertyGroup[] = [];
  for (const [name, props] of groupMap) {
    props.sort((a, b) => a.displayOrder - b.displayOrder);
    groups.push({
      name,
      properties: props.map((p) => ({
        name: p.name,
        label: p.label || p.name,
        required: p.required,
        defaultValue: propertyDefault(p, role),
        enumValues: p.enumValues,
        sensitive: p.sensitive || p.encrypted || p.password,
        hidden: p.hidden,
      })),
    });
  }
  return groups;
}

export interface MergeResult {
  merged: Record<string, unknown>;
  warnings: string[];
  errors: string[];
}

/**
 * Coerce a string env value to the correct type for the connector config JSON.
 * The frontend coerces form inputs to typed values before submission; the CLI
 * must do the same to avoid sending "5432" (string) where 5432 (number) is expected.
 */
function coerceValue(value: string, property: ConnectorProperty): unknown {
  if (value === '') return value;
  // Pre-encrypted values (from `supaflow encrypt`) pass through as-is.
  // They are base64-encoded encryption envelopes prefixed with "enc:".
  // The decodeEncryptedValue() function in encryption.ts handles decoding.
  if (value.startsWith('enc:')) return value;
  if (property.inputType === 'FILE' || property.type === 'FILE') {
    return normalizeFileValue(value, property);
  }
  switch (property.type) {
    case 'INTEGER':
    case 'NUMERIC': {
      const n = Number(value);
      return isNaN(n) ? value : n;
    }
    case 'FLOAT': {
      const f = parseFloat(value);
      return isNaN(f) ? value : f;
    }
    case 'BOOLEAN': {
      const lower = value.toLowerCase();
      if (lower === 'true') return true;
      if (lower === 'false') return false;
      return value; // Invalid -- will be caught by validateProperty
    }
    default:
      return value;
  }
}

export function mergeEnvWithSchema(
  envValues: Record<string, string>,
  schemaProperties: ConnectorProperty[],
  role?: ConnectionRole,
): MergeResult {
  const nonOAuth = filterNonOAuth(schemaProperties);
  const schemaNames = new Set(nonOAuth.map((p) => p.name));
  const merged: Record<string, unknown> = {};
  const warnings: string[] = [];
  const errors: string[] = [];

  // Map env values onto schema, coercing types
  for (const prop of nonOAuth) {
    if (prop.name in envValues) {
      merged[prop.name] = coerceValue(envValues[prop.name], prop);
      if (
        role &&
        prop.defaultValueByRole &&
        Object.hasOwn(prop.defaultValueByRole, role) &&
        merged[prop.name] !== coerceValue(String(propertyDefault(prop, role)), prop)
      ) {
        warnings.push(
          `File value for "${prop.name}" overrides its ${role} role default. ` +
            '--role only fills omitted properties; edit or remove this entry to use the role default.',
        );
      }
    } else if (propertyDefault(prop, role) != null) {
      const value = propertyDefault(prop, role);
      merged[prop.name] =
        role &&
        prop.defaultValueByRole &&
        Object.hasOwn(prop.defaultValueByRole, role) &&
        typeof value === 'string'
          ? coerceValue(value, prop)
          : typeof value === 'string'
            ? normalizeFileValue(value, prop)
            : value;
    } else if (prop.required) {
      errors.push(
        `Connector updated since init. Missing required property: "${prop.name}". ` +
          `Re-run "supaflow datasources init" to update your env file.`,
      );
    }
    // Optional without default and not in env: skip (will be omitted from configs)
  }

  // Warn about unknown env keys
  for (const key of Object.keys(envValues)) {
    if (!schemaNames.has(key)) {
      warnings.push(`Ignoring unknown property: "${key}" (not in latest connector version)`);
    }
  }

  return { merged, warnings, errors };
}

export function generateApiName(name: string): string {
  if (!name) return '';
  // Must match the app's exact logic in supaflow-app/src/utils/apiName/apiNameUtils.ts
  return name
    .toLowerCase()
    .replace(/\s+/g, '_') // Replace spaces with underscores
    .replace(/[^a-z0-9_]/g, ''); // Remove any invalid characters
}
