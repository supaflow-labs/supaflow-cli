import fs from 'node:fs';

export interface EnvHeader {
  name: string | null;
  connector: string | null;
  api_name: string | null;
  description: string | null;
}

export interface PropertyForEnv {
  name: string;
  label: string;
  required: boolean;
  defaultValue: unknown;
  enumValues: string[] | null;
  sensitive: boolean;
  hidden: boolean;
}

export interface PropertyGroup {
  name: string;
  properties: PropertyForEnv[];
}

export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    result[key] = value;
  }
  return result;
}

export function extractHeader(content: string): EnvHeader {
  let name: string | null = null;
  let connector: string | null = null;
  let api_name: string | null = null;
  let description: string | null = null;
  for (const line of content.split('\n')) {
    const nameMatch = line.match(/^#\s*Supaflow Datasource:\s*(.+)/);
    if (nameMatch) name = nameMatch[1].trim();
    const connMatch = line.match(/^#\s*Connector:\s*(.+)/);
    if (connMatch) connector = connMatch[1].trim();
    const apiMatch = line.match(/^#\s*API Name:\s*(.+)/);
    if (apiMatch) api_name = apiMatch[1].trim();
    const descMatch = line.match(/^#\s*Description:\s*(.+)/);
    if (descMatch) description = descMatch[1].trim();
  }
  return { name, connector, api_name, description };
}

export function resolveEnvVars(values: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    result[key] = resolveValue(value);
  }
  return result;
}

function resolveValue(value: string): string {
  // Replace $$ with a placeholder, resolve vars, then restore literal $
  const placeholder = '\x00DOLLAR\x00';
  let s = value.replace(/\$\$/g, placeholder);

  s = s.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
    const defaultIndex = expr.indexOf(':-');
    if (defaultIndex !== -1) {
      const varName = expr.slice(0, defaultIndex);
      const defaultVal = expr.slice(defaultIndex + 2);
      return process.env[varName] ?? defaultVal;
    }
    const envVal = process.env[expr];
    if (envVal === undefined) {
      throw new Error(`Environment variable ${expr} is not set. Set it or use \${${expr}:-default} syntax.`);
    }
    return envVal;
  });

  return s.replace(new RegExp(placeholder, 'g'), '$');
}

export function writeEnvFile(
  filePath: string,
  dsName: string,
  connectorType: string,
  connectorDisplayName: string,
  groups: PropertyGroup[],
): void {
  const lines: string[] = [];
  lines.push(`# Supaflow Datasource: ${dsName}`);
  lines.push(`# Connector: ${connectorType}`);
  // Generate default api_name and description; user can edit these
  const defaultApiName = dsName.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  lines.push(`# API Name: ${defaultApiName}`);
  lines.push(`# Description: ${connectorDisplayName} datasource`);

  for (const group of groups) {
    lines.push('');
    lines.push(`# === ${group.name} ===`);
    lines.push('');
    for (const prop of group.properties) {
      const annotations: string[] = [];
      annotations.push(prop.required ? 'required' : 'optional');
      if (prop.sensitive) annotations.push('sensitive');
      if (prop.hidden) annotations.push('hidden');
      if (prop.defaultValue != null) annotations.push(`default: ${prop.defaultValue}`);
      if (prop.enumValues && prop.enumValues.length > 0) {
        annotations.push(`values: ${prop.enumValues.join('|')}`);
      }
      lines.push(`# ${prop.label} (${annotations.join(', ')})`);
      if (prop.sensitive) {
        lines.push(`# Use \${VAR} to avoid storing secrets in this file, or run: supaflow encrypt --file <this-file>`);
      }
      const defaultStr = prop.defaultValue != null ? String(prop.defaultValue) : '';
      lines.push(`${prop.name}=${defaultStr}`);
    }
  }

  lines.push('');
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
}
