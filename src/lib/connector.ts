import type { SupabaseClient } from '@supabase/supabase-js';
import type { PropertyForEnv, PropertyGroup } from './envfile.js';
import { CliError, ErrorCode } from './errors.js';

export interface ConnectorInfo {
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
  enumValues: string[] | null;
  minValue: number | null;
  maxValue: number | null;
  minLength: number | null;
  maxLength: number | null;
  multiValue: boolean;
  relatedPropertyNameAndValue: [string, ...unknown[]] | null;
}

export async function fetchConnectors(supabase: SupabaseClient): Promise<ConnectorInfo[]> {
  const { data, error } = await supabase.rpc('get_connectors');
  if (error) throw new CliError(`Failed to fetch connectors: ${error.message}`, ErrorCode.API_ERROR);
  return (data || []) as ConnectorInfo[];
}

export async function fetchConnectorProperties(
  supabase: SupabaseClient,
  connectorVersionId: string,
): Promise<ConnectorProperty[]> {
  const { data, error } = await supabase.rpc('get_connector_version', {
    connectorVersionId,
  });
  if (error || !data || data.length === 0) {
    throw new CliError(`Failed to fetch connector version: ${error?.message || 'not found'}`, ErrorCode.API_ERROR);
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

export function groupAndSortProperties(properties: ConnectorProperty[]): PropertyGroup[] {
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
        defaultValue: p.defaultValue,
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
    } else if (prop.defaultValue != null) {
      merged[prop.name] = prop.defaultValue;
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
    .replace(/\s+/g, '_')           // Replace spaces with underscores
    .replace(/[^a-z0-9_]/g, '');    // Remove any invalid characters
}
