import { Command } from 'commander';
import fs from 'node:fs';
import { withAuth, type AuthContext } from '../lib/middleware.js';
import { formatTable, formatListJson, formatGetJson, printOutput, truncateUuid } from '../lib/output.js';
import { isUuid } from '../lib/resolve.js';
import { CliError, ErrorCode } from '../lib/errors.js';
import {
  fetchConnectors,
  fetchConnectorProperties,
  filterNonOAuth,
  isOAuthOnly,
  groupAndSortProperties,
  mergeEnvWithSchema,
  generateApiName,
  type ConnectorProperty,
} from '../lib/connector.js';
import { parseEnvFile, extractHeader, resolveEnvVars, writeEnvFile } from '../lib/envfile.js';
import { shouldShowProperty, filterVisibleFormValues, validateProperty } from '../lib/visibility.js';
import { pollJobUntilDone } from '../lib/polling.js';
import { resolveEncryptedConfigs, isEncryptedValue, encryptValue, encodeEnvelope } from '../lib/encryption.js';
import { softDeleteRecord } from '../lib/client.js';

// Exclude connector_icon (SVG markup) and configs -- wastes agent context in list output
const DATASOURCE_LIST_SELECT = `
  id, name, api_name, state, description,
  connector_name, connector_type, connector_vendor,
  workspace_id, created_at, updated_at, user_access_level,
  source_pipeline_count, destination_pipeline_count, total_pipeline_count
`;

// Get includes configs so agents can inspect datasource configuration.
// Sensitive values are stored as encrypted envelopes { v, fp, data } --
// only the pipeline agent has the private key, so they are safe to return as-is.
// This also enables edit to send unchanged envelopes back without re-encryption.
const DATASOURCE_GET_SELECT = `
  id, name, api_name, state, description,
  connector_name, connector_type, connector_vendor,
  connector_version_id,
  workspace_id, created_at, updated_at, user_access_level,
  source_pipeline_count, destination_pipeline_count, total_pipeline_count,
  configs
`;

export function registerDatasourcesCommands(program: Command): void {
  const datasources = program.command('datasources').description('Manage datasources');

  datasources
    .command('list')
    .description('List datasources in workspace')
    .option('--limit <n>', 'Max results', '25')
    .option('--offset <n>', 'Pagination offset', '0')
    .option('--filter <field=value>', 'Filter by field', (val: string, acc: string[]) => [...acc, val], [])
    .action(
      withAuth(async (ctx: AuthContext, opts: Record<string, unknown>) => {
        const { supabase, workspaceId, outputOptions } = ctx;
        const limit = parseInt(opts.limit as string, 10);
        const offset = parseInt(opts.offset as string, 10);

        let query = supabase
          .from('datasources_with_access')
          .select(DATASOURCE_LIST_SELECT, { count: 'exact' })
          .eq('workspace_id', workspaceId)
          .neq('state', 'deleted')
          .range(offset, offset + limit - 1)
          .order('updated_at', { ascending: false });

        const filters = opts.filter as string[];
        for (const f of filters) {
          const [key, value] = f.split('=');
          if (key === 'type') query = query.eq('connector_type', value.toUpperCase());
          if (key === 'state' || key === 'status') query = query.eq('state', value);
        }

        const { data, error, count } = await query;
        if (error) throw new CliError(error.message, ErrorCode.API_ERROR);
        const rows = data || [];

        if (outputOptions.json) {
          printOutput(formatListJson(rows, count ?? rows.length, limit, offset));
        } else {
          if (rows.length === 0) { console.log('No datasources found.'); return; }
          const headers = ['ID', 'NAME', 'TYPE', 'CONNECTOR', 'STATE', 'PIPELINES'];
          const tableRows = rows.map((d) => [
            truncateUuid(d.id),
            d.name || d.api_name || '',
            d.connector_type || '',
            d.connector_name || '',
            d.state || '',
            String(d.total_pipeline_count || 0),
          ]);
          printOutput(formatTable(headers, tableRows));
        }
      }),
    );

  datasources
    .command('get <identifier>')
    .description('Get datasource details')
    .option('--output <file>', 'Export as env file (for editing with datasources edit)')
    .action(
      withAuth(async (ctx: AuthContext, identifier: string, opts: { output?: string }) => {
        const { supabase, workspaceId, outputOptions } = ctx;

        let query = supabase
          .from('datasources_with_access')
          .select(DATASOURCE_GET_SELECT)
          .eq('workspace_id', workspaceId);

        if (isUuid(identifier)) {
          query = query.eq('id', identifier);
        } else {
          query = query.eq('api_name', identifier);
        }

        const { data, error } = await query.single();
        if (error || !data) {
          throw new CliError(`Datasource "${identifier}" not found.`, ErrorCode.NOT_FOUND);
        }

        // --output: export as env file with current values pre-filled
        if (opts.output) {
          const properties = await fetchConnectorProperties(supabase, data.connector_version_id);
          const nonOAuth = filterNonOAuth(properties);
          const groups = groupAndSortProperties(nonOAuth);
          const configs = (data.configs || {}) as Record<string, unknown>;

          // Build env file with current values filled in
          const lines: string[] = [];
          lines.push(`# Supaflow Datasource: ${data.name}`);
          lines.push(`# Connector: ${data.connector_type}`);
          lines.push(`# API Name: ${data.api_name}`);
          lines.push(`# Description: ${data.description || `${data.connector_name} datasource`}`);

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

              // Fill with current value from configs
              const currentValue = configs[prop.name];
              let valueStr = '';
              if (currentValue !== null && currentValue !== undefined) {
                if (
                  typeof currentValue === 'object' &&
                  !Array.isArray(currentValue) &&
                  'v' in (currentValue as Record<string, unknown>) &&
                  'fp' in (currentValue as Record<string, unknown>) &&
                  'data' in (currentValue as Record<string, unknown>)
                ) {
                  // Encrypted envelope -- encode as enc: format so edit can send it back
                  valueStr = encodeEnvelope(currentValue as { v: number; fp: string; data: string });
                } else {
                  valueStr = String(currentValue);
                }
              } else if (prop.defaultValue != null) {
                valueStr = String(prop.defaultValue);
              }

              lines.push(`${prop.name}=${valueStr}`);
            }
          }
          lines.push('');

          const filePath = opts.output;
          fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

          if (outputOptions.json) {
            printOutput(formatGetJson({
              file: filePath,
              name: data.name,
              api_name: data.api_name,
              connector: data.connector_type,
            }));
          } else {
            console.log(`Exported ${filePath} with current configuration.`);
            console.log(`Edit values, then run: supaflow datasources edit ${data.api_name} --from ${filePath}`);
          }
          return;
        }

        if (outputOptions.json) {
          // Exclude connector_version_id from JSON output (internal field)
          const { connector_version_id: _, ...rest } = data;
          printOutput(formatGetJson(rest));
        } else {
          console.log(`Name:       ${data.name}`);
          console.log(`ID:         ${data.id}`);
          console.log(`API Name:   ${data.api_name}`);
          console.log(`Connector:  ${data.connector_name} (${data.connector_type})`);
          console.log(`State:      ${data.state}`);
          console.log(`Pipelines:  ${data.total_pipeline_count || 0}`);
          if (data.configs && typeof data.configs === 'object') {
            console.log(`\nConfiguration:`);
            for (const [key, value] of Object.entries(data.configs as Record<string, unknown>)) {
              if (value === null || value === undefined || value === '') continue;
              if (typeof value === 'object' && !Array.isArray(value)) {
                const obj = value as Record<string, unknown>;
                if ('v' in obj && 'fp' in obj && 'data' in obj) {
                  console.log(`  ${key}: [encrypted]`);
                  continue;
                }
              }
              console.log(`  ${key}: ${value}`);
            }
          }
        }
      }),
    );

  datasources
    .command('init')
    .description('Scaffold a .env file for a new datasource')
    .requiredOption('--connector <type>', 'Connector type (e.g., postgres, snowflake, s3)')
    .requiredOption('--name <name>', 'Datasource name')
    .option('--output <file>', 'Output file path (default: <api_name>.env)')
    .action(
      withAuth(async (ctx: AuthContext, opts: { connector: string; name: string; output?: string }) => {
        const { supabase, outputOptions } = ctx;
        const connectorType = opts.connector.toLowerCase();
        const dsName = opts.name;
        const apiName = generateApiName(dsName);
        const filePath = opts.output || `${apiName}.env`;

        // 1. Find connector by type
        const connectors = await fetchConnectors(supabase);
        const connector = connectors.find((c) => c.type.toLowerCase() === connectorType);
        if (!connector) {
          const available = connectors.map((c) => c.type).sort().join(', ');
          throw new CliError(
            `Unknown connector type "${connectorType}". Available: ${available}`,
            ErrorCode.NOT_FOUND,
          );
        }

        // 2. Fetch properties for latest version
        const properties = await fetchConnectorProperties(supabase, connector.latest_version_id);

        // 3. Check for OAuth-only
        if (isOAuthOnly(properties)) {
          throw new CliError(
            'This connector requires OAuth authentication. Use the Supaflow web UI to create this datasource.',
            ErrorCode.INVALID_INPUT,
          );
        }

        // 4. Filter and group
        const nonOAuth = filterNonOAuth(properties);
        const groups = groupAndSortProperties(nonOAuth);

        // 5. Write env file
        writeEnvFile(filePath, dsName, connector.type, connector.name, groups);

        const requiredCount = nonOAuth.filter((p) => p.required).length;
        const optionalCount = nonOAuth.length - requiredCount;

        if (outputOptions.json) {
          printOutput(formatGetJson({
            file: filePath,
            name: dsName,
            api_name: apiName,
            connector: connector.type,
            connector_version: connector.latest_version,
            required_properties: requiredCount,
            optional_properties: optionalCount,
          }));
        } else {
          console.log(`Created ${filePath} (${requiredCount} required, ${optionalCount} optional)`);
          const requiredNames = nonOAuth.filter((p) => p.required).map((p) => p.name);
          if (requiredNames.length > 0) {
            console.log(`Required: ${requiredNames.join(', ')}`);
          }
          console.log(`Fill in the values and run: supaflow datasources create --from ${filePath}`);
        }
      }),
    );

  datasources
    .command('create')
    .description('Create a datasource from an env file (test connection first)')
    .requiredOption('--from <file>', 'Path to env file')
    .action(
      withAuth(async (ctx: AuthContext, opts: { from: string }) => {
        const { supabase, workspaceId, outputOptions, conn } = ctx;
        const filePath = opts.from;

        // Step 1: Read and parse env file
        if (!fs.existsSync(filePath)) {
          throw new CliError(
            `File "${filePath}" not found. Run "supaflow datasources init --connector <type> --name <name>" first.`,
            ErrorCode.NOT_FOUND,
          );
        }

        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const header = extractHeader(fileContent);
        if (!header.connector) {
          throw new CliError(
            `File "${filePath}" is missing the "# Connector: <type>" header.`,
            ErrorCode.INVALID_INPUT,
          );
        }

        // Datasource name comes from file header
        const dsName = header.name;
        if (!dsName) {
          throw new CliError(
            'File is missing the "# Supaflow Datasource: <name>" header.',
            ErrorCode.INVALID_INPUT,
          );
        }

        const rawValues = parseEnvFile(fileContent);
        const envValues = resolveEnvVars(rawValues);

        // Step 2: Resolve latest connector version
        const connectors = await fetchConnectors(supabase);
        const connector = connectors.find((c) => c.type.toLowerCase() === header.connector!.toLowerCase());
        if (!connector) {
          throw new CliError(
            `Connector type "${header.connector}" not found.`,
            ErrorCode.NOT_FOUND,
          );
        }

        const properties = await fetchConnectorProperties(supabase, connector.latest_version_id);
        const nonOAuth = filterNonOAuth(properties);

        // Step 3: Merge env values into latest schema
        const { merged, warnings, errors: mergeErrors } = mergeEnvWithSchema(envValues, properties);

        if (!outputOptions.json) {
          for (const w of warnings) {
            console.error(`Warning: ${w}`);
          }
        }
        if (mergeErrors.length > 0) {
          throw new CliError(mergeErrors.join('\n'), ErrorCode.INVALID_INPUT);
        }

        // Step 4: Apply visibility rules and validate
        const filtered = filterVisibleFormValues(
          nonOAuth.map((p) => ({
            name: p.name,
            type: p.type,
            required: p.required,
            sensitive: p.sensitive || p.encrypted || p.password,
            hidden: p.hidden,
            defaultValue: p.defaultValue,
            enumValues: p.enumValues,
            minValue: p.minValue,
            maxValue: p.maxValue,
            minLength: p.minLength,
            maxLength: p.maxLength,
            relatedPropertyNameAndValue: p.relatedPropertyNameAndValue,
          })),
          merged,
        );

        // Validate visible required properties
        const validationErrors: string[] = [];
        for (const prop of nonOAuth) {
          if (!shouldShowProperty(
            { ...prop, sensitive: prop.sensitive || prop.encrypted || prop.password },
            merged,
            nonOAuth.map((p) => ({ ...p, sensitive: p.sensitive || p.encrypted || p.password })),
          )) continue;
          const value = String(filtered[prop.name] ?? '');
          const propErrors = validateProperty(
            { ...prop, sensitive: prop.sensitive || prop.encrypted || prop.password },
            value,
          );
          validationErrors.push(...propErrors);
        }

        if (validationErrors.length > 0) {
          throw new CliError(
            `Validation failed:\n${validationErrors.map((e) => `  - ${e}`).join('\n')}`,
            ErrorCode.INVALID_INPUT,
          );
        }

        // Build clean configs object (only non-null visible values)
        const rawConfigs: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(filtered)) {
          if (value !== null && value !== undefined) {
            rawConfigs[key] = value;
          }
        }

        // Auto-encrypt the env file in-place before submission.
        // This ensures plaintext secrets never remain on disk.
        const sensitiveNames = new Set(
          nonOAuth
            .filter((p) => p.sensitive || p.encrypted || p.password)
            .map((p) => p.name),
        );
        let fileModified = false;
        const fileLines = fileContent.split('\n');
        const newLines: string[] = [];
        for (const line of fileLines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) { newLines.push(line); continue; }
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx === -1) { newLines.push(line); continue; }
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim();
          if (sensitiveNames.has(key) && val && !val.startsWith('enc:') && !val.startsWith('${')) {
            if (!outputOptions.json) {
              process.stderr.write(`Encrypting ${key} in ${filePath}...\n`);
            }
            const envelope = await encryptValue(supabase, val, workspaceId);
            const encoded = encodeEnvelope(envelope);
            newLines.push(`${key}=${encoded}`);
            rawConfigs[key] = encoded; // Update in-memory too
            fileModified = true;
          } else {
            newLines.push(line);
          }
        }
        if (fileModified) {
          fs.writeFileSync(filePath, newLines.join('\n'), 'utf-8');
        }

        // Decode any enc: prefixed values back to JSONB envelopes for submission
        const configs = resolveEncryptedConfigs(rawConfigs);

        // Step 5: Test connection
        if (!outputOptions.json) {
          process.stderr.write('Testing connection... (this may take up to a minute)\n');
        }

        const { data: jobId, error: jobError } = await supabase.rpc('create_datasource_test_job', {
          p_workspace_id: workspaceId,
          p_connector_version_id: connector.latest_version_id,
          p_configs: configs,
          p_job_name: `CLI test: ${dsName}`,
          p_datasource_id: null,
        });

        if (jobError) {
          throw new CliError(`Failed to create test job: ${jobError.message}`, ErrorCode.API_ERROR);
        }

        const result = await pollJobUntilDone(supabase, jobId as string);

        if (!result.success) {
          const msg = result.statusMessage || result.jobStatus;
          throw new CliError(
            `Connection failed: ${msg}\nDatasource was not saved. Fix the config in ${filePath} and try again.`,
            ErrorCode.API_ERROR,
          );
        }

        // Step 6: Create datasource
        const apiName = header.api_name || generateApiName(dsName);
        const description = header.description || `${connector.name} datasource`;
        // Extract user_id from the JWT for created_by/updated_by
        const jwtPayload = JSON.parse(atob(conn.bearerToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        const userId = jwtPayload.user_id || jwtPayload.sub;

        const { data: ds, error: insertError } = await supabase
          .from('datasources')
          .insert({
            workspace_id: workspaceId,
            connector_version_id: connector.latest_version_id,
            name: dsName,
            api_name: apiName,
            description,
            configs,
            state: 'active',
            created_by: userId,
            updated_by: userId,
          })
          .select('id')
          .single();

        if (insertError) {
          throw new CliError(`Failed to create datasource: ${insertError.message}`, ErrorCode.API_ERROR);
        }

        if (outputOptions.json) {
          printOutput(formatGetJson({
            id: ds.id,
            name: dsName,
            api_name: apiName,
            connector: connector.type,
            state: 'active',
          }));
        } else {
          console.log('Connection successful.');
          console.log(`Datasource "${dsName}" created. ID: ${ds.id}`);
        }
      }),
    );

  // -----------------------------------------------------------------------
  // datasources catalog
  // -----------------------------------------------------------------------
  datasources
    .command('catalog <identifier>')
    .description('List discovered objects for a datasource (or export as objects.json)')
    .option('--output <file>', 'Write selectable objects JSON file for pipeline creation')
    .option('--refresh', 'Trigger schema refresh before listing')
    .action(
      withAuth(async (ctx: AuthContext, identifier: string, opts: { output?: string; refresh?: boolean }) => {
        const { supabase, workspaceId, outputOptions } = ctx;

        // Resolve datasource
        let dsQuery = supabase
          .from('datasources_with_access')
          .select('id, name, api_name, state')
          .eq('workspace_id', workspaceId);

        if (isUuid(identifier)) {
          dsQuery = dsQuery.eq('id', identifier);
        } else {
          dsQuery = dsQuery.eq('api_name', identifier);
        }

        const { data: ds, error: dsError } = await dsQuery.single();
        if (dsError || !ds) {
          throw new CliError(`Datasource "${identifier}" not found.`, ErrorCode.NOT_FOUND);
        }

        // Optional: trigger schema refresh first
        if (opts.refresh) {
          if (!outputOptions.json) {
            process.stderr.write('Refreshing schema...\n');
          }

          const { data: refreshJobId, error: refreshError } = await supabase.rpc('create_datasource_job', {
            p_datasource_id: ds.id,
            p_job_type: 'datasource_schema_refresh',
            p_force_refresh: true,
          });

          if (refreshError) {
            throw new CliError(`Schema refresh failed: ${refreshError.message}`, ErrorCode.API_ERROR);
          }

          if (refreshJobId) {
            const refreshResult = await pollJobUntilDone(supabase, refreshJobId as string);
            if (!refreshResult.success) {
              throw new CliError(
                `Schema refresh failed: ${refreshResult.statusMessage || refreshResult.jobStatus}`,
                ErrorCode.API_ERROR,
              );
            }
          }
        }

        // Fetch discovered objects using the same RPC as the FE wizard
        // p_pipeline_id = null means "no pipeline yet, just show discovered catalog"
        const allObjects: Array<Record<string, unknown>> = [];
        const batchSize = 100;
        let offset = 0;
        let hasMore = true;

        while (hasMore) {
          const { data, error } = await supabase.rpc('get_pipeline_metadata_mappings', {
            p_pipeline_id: null,
            p_datasource_id: ds.id,
            p_limit: batchSize,
            p_offset: offset,
            p_include_fields: false,
          });

          if (error) {
            throw new CliError(`Failed to fetch catalog: ${error.message}`, ErrorCode.API_ERROR);
          }

          const batch = data || [];
          allObjects.push(...batch);
          offset += batchSize;
          hasMore = batch.length === batchSize;
        }

        if (allObjects.length === 0) {
          if (outputOptions.json) {
            printOutput(formatListJson([], 0, 0, 0));
          } else {
            console.log(`No objects discovered for "${ds.name}". Run with --refresh to trigger schema discovery.`);
          }
          return;
        }

        // If --output: write selectable objects JSON for pipeline creation
        if (opts.output) {
          const selectableObjects = allObjects.map((obj) => ({
            fully_qualified_name: obj.fully_qualified_source_object_name,
            selected: true,
            fields: null, // null = snapshot all fields from catalog
          }));

          fs.writeFileSync(opts.output, JSON.stringify(selectableObjects, null, 2) + '\n', 'utf-8');

          if (outputOptions.json) {
            printOutput(formatGetJson({
              file: opts.output,
              datasource: ds.name,
              objects: selectableObjects.length,
            }));
          } else {
            console.log(`Wrote ${selectableObjects.length} objects to ${opts.output}`);
            console.log(`Edit the file to set "selected": false for objects you want to exclude.`);
            console.log(`Then use: supaflow pipelines create ... --objects ${opts.output}`);
          }
          return;
        }

        // Default: list objects in table/JSON format
        if (outputOptions.json) {
          const objects = allObjects.map((obj) => ({
            fully_qualified_name: obj.fully_qualified_source_object_name,
            catalog_version: obj.catalog_version,
            updated_at: obj.catalog_updated_at,
          }));
          printOutput(formatListJson(objects, objects.length, objects.length, 0));
        } else {
          const headers = ['OBJECT', 'VERSION', 'UPDATED'];
          const { relativeTime } = await import('../lib/output.js');
          const rows = allObjects.map((obj) => [
            String(obj.fully_qualified_source_object_name || ''),
            String(obj.catalog_version || ''),
            relativeTime(obj.catalog_updated_at as string | null),
          ]);
          printOutput(formatTable(headers, rows));
        }
      }),
    );

  // -----------------------------------------------------------------------
  // datasources test
  // -----------------------------------------------------------------------
  datasources
    .command('test <identifier>')
    .description('Test connection for an existing datasource')
    .action(
      withAuth(async (ctx: AuthContext, identifier: string) => {
        const { supabase, workspaceId, outputOptions } = ctx;

        // Resolve datasource
        let dsQuery = supabase
          .from('datasources_with_access')
          .select('id, name, api_name, state, connector_version_id')
          .eq('workspace_id', workspaceId);

        if (isUuid(identifier)) {
          dsQuery = dsQuery.eq('id', identifier);
        } else {
          dsQuery = dsQuery.eq('api_name', identifier);
        }

        const { data: ds, error: dsError } = await dsQuery.single();
        if (dsError || !ds) {
          throw new CliError(`Datasource "${identifier}" not found.`, ErrorCode.NOT_FOUND);
        }

        if (!outputOptions.json) {
          process.stderr.write('Testing connection... (this may take up to a minute)\n');
        }

        // Read stored configs from base datasources table (unredacted, for RPC submission)
        const { data: dsRow, error: configError } = await supabase
          .from('datasources')
          .select('configs')
          .eq('id', ds.id)
          .single();

        if (configError || !dsRow) {
          throw new CliError(`Failed to read datasource configs: ${configError?.message || 'not found'}`, ErrorCode.API_ERROR);
        }

        const { data: jobId, error: jobError } = await supabase.rpc('create_datasource_test_job', {
          p_workspace_id: workspaceId,
          p_connector_version_id: ds.connector_version_id,
          p_configs: dsRow.configs,
          p_job_name: `CLI test: ${ds.name}`,
          p_datasource_id: ds.id,
        });

        if (jobError) {
          throw new CliError(`Failed to create test job: ${jobError.message}`, ErrorCode.API_ERROR);
        }

        const result = await pollJobUntilDone(supabase, jobId as string);

        if (!result.success) {
          throw new CliError(
            `Connection failed: ${result.statusMessage || result.jobStatus}`,
            ErrorCode.API_ERROR,
          );
        }

        if (outputOptions.json) {
          printOutput(formatGetJson({
            id: ds.id,
            name: ds.name,
            status: 'connected',
            job_id: jobId,
          }));
        } else {
          console.log(`Connection successful for "${ds.name}".`);
        }
      }),
    );

  // -----------------------------------------------------------------------
  // datasources delete
  // -----------------------------------------------------------------------
  datasources
    .command('delete <identifier>')
    .description('Delete a datasource')
    .action(
      withAuth(async (ctx: AuthContext, identifier: string) => {
        const { supabase, workspaceId, outputOptions, conn } = ctx;

        let query = supabase
          .from('datasources_with_access')
          .select('id, name, api_name')
          .eq('workspace_id', workspaceId);

        if (isUuid(identifier)) {
          query = query.eq('id', identifier);
        } else {
          query = query.eq('api_name', identifier);
        }

        const { data: ds, error } = await query.single();
        if (error || !ds) {
          throw new CliError(`Datasource "${identifier}" not found.`, ErrorCode.NOT_FOUND);
        }

        await softDeleteRecord(conn, 'datasources', ds.id);

        if (outputOptions.json) {
          printOutput(formatGetJson({ id: ds.id, name: ds.name, state: 'deleted' }));
        } else {
          console.log(`Datasource "${ds.name}" deleted.`);
        }
      }),
    );

  // -----------------------------------------------------------------------
  // datasources disable
  // -----------------------------------------------------------------------
  datasources
    .command('disable <identifier>')
    .description('Disable a datasource (set state to inactive)')
    .action(
      withAuth(async (ctx: AuthContext, identifier: string) => {
        const { supabase, workspaceId, outputOptions } = ctx;

        let query = supabase
          .from('datasources_with_access')
          .select('id, name, api_name, state')
          .eq('workspace_id', workspaceId);

        if (isUuid(identifier)) {
          query = query.eq('id', identifier);
        } else {
          query = query.eq('api_name', identifier);
        }

        const { data: ds, error } = await query.single();
        if (error || !ds) {
          throw new CliError(`Datasource "${identifier}" not found.`, ErrorCode.NOT_FOUND);
        }

        if (ds.state !== 'active') {
          throw new CliError(
            `Datasource "${ds.name}" is "${ds.state}", can only disable active datasources.`,
            ErrorCode.INVALID_INPUT,
          );
        }

        const { error: updateError } = await supabase
          .from('datasources')
          .update({ state: 'inactive' })
          .eq('id', ds.id)
          .eq('workspace_id', workspaceId);

        if (updateError) {
          throw new CliError(`Failed to disable datasource: ${updateError.message}`, ErrorCode.API_ERROR);
        }

        if (outputOptions.json) {
          printOutput(formatGetJson({ id: ds.id, name: ds.name, state: 'inactive' }));
        } else {
          console.log(`Datasource "${ds.name}" disabled.`);
        }
      }),
    );

  // -----------------------------------------------------------------------
  // datasources enable
  // -----------------------------------------------------------------------
  datasources
    .command('enable <identifier>')
    .description('Enable a datasource (set state to active)')
    .action(
      withAuth(async (ctx: AuthContext, identifier: string) => {
        const { supabase, workspaceId, outputOptions } = ctx;

        let query = supabase
          .from('datasources_with_access')
          .select('id, name, api_name, state')
          .eq('workspace_id', workspaceId);

        if (isUuid(identifier)) {
          query = query.eq('id', identifier);
        } else {
          query = query.eq('api_name', identifier);
        }

        const { data: ds, error } = await query.single();
        if (error || !ds) {
          throw new CliError(`Datasource "${identifier}" not found.`, ErrorCode.NOT_FOUND);
        }

        if (ds.state !== 'inactive') {
          throw new CliError(
            `Datasource "${ds.name}" is "${ds.state}", can only enable inactive datasources.`,
            ErrorCode.INVALID_INPUT,
          );
        }

        const { error: updateError } = await supabase
          .from('datasources')
          .update({ state: 'active' })
          .eq('id', ds.id)
          .eq('workspace_id', workspaceId);

        if (updateError) {
          throw new CliError(`Failed to enable datasource: ${updateError.message}`, ErrorCode.API_ERROR);
        }

        if (outputOptions.json) {
          printOutput(formatGetJson({ id: ds.id, name: ds.name, state: 'active' }));
        } else {
          console.log(`Datasource "${ds.name}" enabled.`);
        }
      }),
    );

  // -----------------------------------------------------------------------
  // datasources refresh
  // -----------------------------------------------------------------------
  datasources
    .command('refresh <identifier>')
    .description('Trigger a schema refresh for a datasource')
    .action(
      withAuth(async (ctx: AuthContext, identifier: string) => {
        const { supabase, workspaceId, outputOptions } = ctx;

        let query = supabase
          .from('datasources_with_access')
          .select('id, name, api_name, state')
          .eq('workspace_id', workspaceId);

        if (isUuid(identifier)) {
          query = query.eq('id', identifier);
        } else {
          query = query.eq('api_name', identifier);
        }

        const { data: ds, error } = await query.single();
        if (error || !ds) {
          throw new CliError(`Datasource "${identifier}" not found.`, ErrorCode.NOT_FOUND);
        }

        if (ds.state !== 'active') {
          throw new CliError(
            `Datasource "${ds.name}" is "${ds.state}". Schema refresh requires active state.`,
            ErrorCode.INVALID_INPUT,
          );
        }

        const { data: jobId, error: jobError } = await supabase.rpc('create_datasource_job', {
          p_datasource_id: ds.id,
          p_job_type: 'datasource_schema_refresh',
          p_force_refresh: true,
        });

        if (jobError) {
          throw new CliError(`Failed to trigger schema refresh: ${jobError.message}`, ErrorCode.API_ERROR);
        }

        // RPC can return NULL for destination-only connectors with no SOURCE capability
        if (!jobId) {
          if (outputOptions.json) {
            printOutput(formatGetJson({ id: ds.id, name: ds.name, status: 'skipped', message: 'No schema refresh available for this connector type.' }));
          } else {
            console.log(`No schema refresh available for "${ds.name}". This connector may not support schema discovery.`);
          }
          return;
        }

        if (!outputOptions.json) {
          process.stderr.write('Refreshing schema... (this may take up to a minute)\n');
        }

        const result = await pollJobUntilDone(supabase, jobId as string);

        if (!result.success) {
          throw new CliError(
            `Schema refresh failed: ${result.statusMessage || result.jobStatus}`,
            ErrorCode.API_ERROR,
          );
        }

        if (outputOptions.json) {
          printOutput(formatGetJson({
            id: ds.id,
            name: ds.name,
            job_id: jobId,
            status: 'completed',
            message: result.statusMessage,
          }));
        } else {
          console.log(`Schema refresh completed for "${ds.name}".`);
        }
      }),
    );

  // -----------------------------------------------------------------------
  // datasources edit
  // -----------------------------------------------------------------------
  datasources
    .command('edit <identifier>')
    .description('Update a datasource from an env file')
    .requiredOption('--from <file>', 'Path to env file')
    .option('--skip-test', 'Save without testing connection')
    .action(
      withAuth(async (ctx: AuthContext, identifier: string, opts: { from: string; skipTest?: boolean }) => {
        const { supabase, workspaceId, outputOptions, conn } = ctx;
        const filePath = opts.from;

        // Step 1: Read and parse env file
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

        // Find existing datasource by identifier (UUID or api_name)
        let findQuery = supabase
          .from('datasources_with_access')
          .select('id, name, api_name, state, connector_version_id')
          .eq('workspace_id', workspaceId);

        if (isUuid(identifier)) {
          findQuery = findQuery.eq('id', identifier);
        } else {
          findQuery = findQuery.eq('api_name', identifier);
        }

        const { data: existingDs, error: findError } = await findQuery.single();
        if (findError || !existingDs) {
          throw new CliError(
            `Datasource "${identifier}" not found. Use "datasources create" for new datasources.`,
            ErrorCode.NOT_FOUND,
          );
        }

        const rawValues = parseEnvFile(fileContent);
        const envValues = resolveEnvVars(rawValues);

        // Step 2: Resolve latest connector version
        const connectors = await fetchConnectors(supabase);
        const connector = connectors.find(
          (c) => c.type.toLowerCase() === header.connector!.toLowerCase(),
        );
        if (!connector) {
          throw new CliError(`Connector type "${header.connector}" not found.`, ErrorCode.NOT_FOUND);
        }

        const properties = await fetchConnectorProperties(supabase, connector.latest_version_id);
        const nonOAuth = filterNonOAuth(properties);

        // Step 3: Merge and validate
        const { merged, warnings, errors: mergeErrors } = mergeEnvWithSchema(envValues, properties);

        if (!outputOptions.json) {
          for (const w of warnings) {
            console.error(`Warning: ${w}`);
          }
        }
        if (mergeErrors.length > 0) {
          throw new CliError(mergeErrors.join('\n'), ErrorCode.INVALID_INPUT);
        }

        // Step 4: Visibility rules and validation
        const filtered = filterVisibleFormValues(
          nonOAuth.map((p) => ({
            name: p.name,
            type: p.type,
            required: p.required,
            sensitive: p.sensitive || p.encrypted || p.password,
            hidden: p.hidden,
            defaultValue: p.defaultValue,
            enumValues: p.enumValues,
            minValue: p.minValue,
            maxValue: p.maxValue,
            minLength: p.minLength,
            maxLength: p.maxLength,
            relatedPropertyNameAndValue: p.relatedPropertyNameAndValue,
          })),
          merged,
        );

        const validationErrors: string[] = [];
        for (const prop of nonOAuth) {
          const propShape = { ...prop, sensitive: prop.sensitive || prop.encrypted || prop.password };
          if (!shouldShowProperty(propShape, merged, nonOAuth.map((p) => ({ ...p, sensitive: p.sensitive || p.encrypted || p.password })))) continue;
          const value = String(filtered[prop.name] ?? '');
          const propErrors = validateProperty(propShape, value);
          validationErrors.push(...propErrors);
        }

        if (validationErrors.length > 0) {
          throw new CliError(
            `Validation failed:\n${validationErrors.map((e) => `  - ${e}`).join('\n')}`,
            ErrorCode.INVALID_INPUT,
          );
        }

        // Auto-encrypt sensitive fields on disk
        const sensitiveNames = new Set(
          nonOAuth.filter((p) => p.sensitive || p.encrypted || p.password).map((p) => p.name),
        );
        const rawConfigs: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(filtered)) {
          if (value !== null && value !== undefined) {
            rawConfigs[key] = value;
          }
        }

        let fileModified = false;
        const fileLines = fileContent.split('\n');
        const newLines: string[] = [];
        for (const line of fileLines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) { newLines.push(line); continue; }
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx === -1) { newLines.push(line); continue; }
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim();
          if (sensitiveNames.has(key) && val && !val.startsWith('enc:') && !val.startsWith('${')) {
            if (!outputOptions.json) {
              process.stderr.write(`Encrypting ${key} in ${filePath}...\n`);
            }
            const envelope = await encryptValue(supabase, val, workspaceId);
            const encoded = encodeEnvelope(envelope);
            newLines.push(`${key}=${encoded}`);
            rawConfigs[key] = encoded;
            fileModified = true;
          } else {
            newLines.push(line);
          }
        }
        if (fileModified) {
          fs.writeFileSync(filePath, newLines.join('\n'), 'utf-8');
        }

        const configs = resolveEncryptedConfigs(rawConfigs);

        // Step 5: Optional connection test
        if (!opts.skipTest) {
          if (!outputOptions.json) {
            process.stderr.write('Testing connection... (this may take up to a minute)\n');
          }

          const { data: jobId, error: jobError } = await supabase.rpc('create_datasource_test_job', {
            p_workspace_id: workspaceId,
            p_connector_version_id: connector.latest_version_id,
            p_configs: configs,
            p_job_name: `CLI edit test: ${existingDs.name}`,
            p_datasource_id: existingDs.id,
          });

          if (jobError) {
            throw new CliError(`Failed to create test job: ${jobError.message}`, ErrorCode.API_ERROR);
          }

          const result = await pollJobUntilDone(supabase, jobId as string);
          if (!result.success) {
            throw new CliError(
              `Connection failed: ${result.statusMessage || result.jobStatus}\nDatasource was not updated. Fix the config and try again.`,
              ErrorCode.API_ERROR,
            );
          }

          if (!outputOptions.json) {
            console.log('Connection successful.');
          }
        }

        // Step 6: Update datasource
        const dsName = header.name || existingDs.name;
        const description = header.description || undefined;
        const jwtPayload = JSON.parse(atob(conn.bearerToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        const userId = jwtPayload.user_id || jwtPayload.sub;

        // Only update configs, name, state, and audit fields.
        // Do NOT update connector_version_id -- connector identity is locked
        // on create, matching the web app behavior.
        const updateData: Record<string, unknown> = {
          configs,
          name: dsName,
          updated_by: userId,
          state: opts.skipTest ? existingDs.state : 'active',
        };
        if (description) {
          updateData.description = description;
        }

        const { error: updateError } = await supabase
          .from('datasources')
          .update(updateData)
          .eq('id', existingDs.id)
          .eq('workspace_id', workspaceId);

        if (updateError) {
          throw new CliError(`Failed to update datasource: ${updateError.message}`, ErrorCode.API_ERROR);
        }

        if (outputOptions.json) {
          printOutput(formatGetJson({
            id: existingDs.id,
            name: dsName,
            api_name: existingDs.api_name,
            state: opts.skipTest ? existingDs.state : 'active',
            tested: !opts.skipTest,
          }));
        } else {
          console.log(`Datasource "${dsName}" updated.${opts.skipTest ? '' : ' Connection tested.'}`);
        }
      }),
    );
}
