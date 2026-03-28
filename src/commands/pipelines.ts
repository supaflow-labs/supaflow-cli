import fs from 'node:fs';
import { Command } from 'commander';
import { withAuth, type AuthContext } from '../lib/middleware.js';
import {
  formatTable,
  formatListJson,
  formatGetJson,
  printOutput,
  truncateUuid,
  relativeTime,
} from '../lib/output.js';
import { resolveIdentifier, isUuid } from '../lib/resolve.js';
import { softDeleteRecord } from '../lib/client.js';
import { CliError, ErrorCode } from '../lib/errors.js';
import { createPipelineConfig, generateCapabilityAwareConfig, generateConfigJson, generateConfigReference } from '../lib/pipeline-config.js';
import { generateApiName } from '../lib/connector.js';
import { pollJobUntilDone } from '../lib/polling.js';

interface PipelineRow {
  pipeline_id: string;
  pipeline_name: string;
  pipeline_api_name: string;
  pipeline_state: string;
  pipeline_configs: unknown;
  pipeline_created_at: string;
  pipeline_updated_at: string;
  source_datasource_id: string | null;
  source_name: string | null;
  source_connector_name: string | null;
  destination_datasource_id: string | null;
  destination_name: string | null;
  destination_connector_name: string | null;
  project_id: string | null;
  project_name: string | null;
  last_sync_at: string | null;
  last_job_status: string | null;
  schedules: unknown;
}

const SORT_MAP: Record<string, string> = {
  name: 'pipeline_name',
  state: 'pipeline_state',
  created_at: 'pipeline_created_at',
  updated_at: 'pipeline_updated_at',
  last_sync_at: 'last_sync_at',
};

function normalizePipeline(row: PipelineRow) {
  return {
    id: row.pipeline_id,
    name: row.pipeline_name,
    api_name: row.pipeline_api_name,
    state: row.pipeline_state,
    created_at: row.pipeline_created_at,
    updated_at: row.pipeline_updated_at,
    source: {
      datasource_id: row.source_datasource_id,
      name: row.source_name,
      connector_name: row.source_connector_name,
    },
    destination: {
      datasource_id: row.destination_datasource_id,
      name: row.destination_name,
      connector_name: row.destination_connector_name,
    },
    project: { id: row.project_id, name: row.project_name },
    last_sync_at: row.last_sync_at,
    last_job_status: row.last_job_status,
    schedules: row.schedules,
  };
}

// Full normalization including configs (for get/single pipeline)
function normalizePipelineFull(row: PipelineRow) {
  return {
    ...normalizePipeline(row),
    configs: row.pipeline_configs,
  };
}

// Shared helper: resolve source, project, and destination datasource.
// Used by both `init` and `create` to guarantee same destination resolution.
const DS_CAPS_SELECT = 'id, name, api_name, connector_type, connector_version_capabilities_config';

async function resolveSourceProjectDestination(
  supabase: ReturnType<typeof import('@supabase/supabase-js').createClient>,
  workspaceId: string,
  sourceIdentifier: string,
  projectIdentifier: string,
) {
  // Resolve source
  let srcQuery = supabase
    .from('datasources_with_access')
    .select(DS_CAPS_SELECT)
    .eq('workspace_id', workspaceId);
  srcQuery = isUuid(sourceIdentifier) ? srcQuery.eq('id', sourceIdentifier) : srcQuery.eq('api_name', sourceIdentifier);
  const { data: src, error: srcError } = await srcQuery.single();
  if (srcError || !src) {
    throw new CliError(`Source datasource "${sourceIdentifier}" not found.`, ErrorCode.NOT_FOUND);
  }

  // Resolve project
  let projQuery = supabase
    .from('projects')
    .select('id, name, api_name, warehouse_datasource_id')
    .eq('workspace_id', workspaceId)
    .neq('state', 'deleted');
  projQuery = isUuid(projectIdentifier) ? projQuery.eq('id', projectIdentifier) : projQuery.eq('api_name', projectIdentifier);
  const { data: proj, error: projError } = await projQuery.single();
  if (projError || !proj) {
    throw new CliError(`Project "${projectIdentifier}" not found.`, ErrorCode.NOT_FOUND);
  }

  // Resolve destination from project
  const destId = proj.warehouse_datasource_id;
  if (!destId) {
    throw new CliError(`Project "${proj.name}" has no destination datasource configured.`, ErrorCode.INVALID_INPUT);
  }
  const { data: dest, error: destError } = await supabase
    .from('datasources_with_access')
    .select(DS_CAPS_SELECT)
    .eq('id', destId)
    .single();
  if (destError || !dest) {
    throw new CliError(`Project destination datasource not found (ID: ${destId}).`, ErrorCode.NOT_FOUND);
  }

  return { src, proj, dest };
}

export function registerPipelinesCommands(program: Command): void {
  const pipelines = program.command('pipelines').description('Manage pipelines');

  // list
  pipelines
    .command('list')
    .description('List pipelines in the current workspace')
    .option('-l, --limit <n>', 'Maximum number of results', '25')
    .option('-o, --offset <n>', 'Offset for pagination', '0')
    .option('-s, --state <state>', 'Filter by pipeline state (e.g. active, inactive)')
    .option('--sort <field>', 'Sort field: name, state, created_at, updated_at, last_sync_at', 'name')
    .option('--order <dir>', 'Sort direction: asc, desc', 'asc')
    .action(
      withAuth(async (ctx: AuthContext, opts: unknown) => {
        const options = opts as {
          limit: string;
          offset: string;
          state?: string;
          sort: string;
          order: string;
        };

        const limit = Math.min(parseInt(options.limit, 10) || 25, 200);
        const offset = parseInt(options.offset, 10) || 0;
        const sortField = SORT_MAP[options.sort] ?? 'pipeline_name';
        const ascending = options.order !== 'desc';

        let query = ctx.supabase
          .from('pipelines_and_datasources')
          .select('*', { count: 'exact' })
          .eq('workspace_id', ctx.workspaceId)
          .order(sortField, { ascending })
          .range(offset, offset + limit - 1);

        if (options.state) {
          query = query.eq('pipeline_state', options.state);
        }

        const { data, error, count } = await query;

        if (error) {
          throw new CliError(`Failed to list pipelines: ${error.message}`, ErrorCode.API_ERROR);
        }

        const rows = (data as PipelineRow[]) ?? [];
        const total = count ?? 0;

        if (ctx.outputOptions.json) {
          printOutput(formatListJson(rows.map(normalizePipeline), total, limit, offset));
          return;
        }

        if (rows.length === 0) {
          console.log('No pipelines found.');
          return;
        }

        const headers = ['ID', 'NAME', 'STATE', 'SOURCE', 'DESTINATION', 'LAST SYNC'];
        const tableRows = rows.map((row) => [
          truncateUuid(row.pipeline_id),
          row.pipeline_name ?? '-',
          row.pipeline_state ?? '-',
          row.source_connector_name ?? '-',
          row.destination_connector_name ?? '-',
          relativeTime(row.last_sync_at),
        ]);

        printOutput(formatTable(headers, tableRows));
        if (total > offset + rows.length) {
          console.log(`\nShowing ${offset + 1}-${offset + rows.length} of ${total}. Use --offset to page.`);
        }
      }),
    );

  // get
  pipelines
    .command('get <identifier>')
    .description('Get details of a pipeline by UUID or api_name')
    .action(
      withAuth(async (ctx: AuthContext, identifier: unknown) => {
        const id = identifier as string;

        let query = ctx.supabase
          .from('pipelines_and_datasources')
          .select('*')
          .eq('workspace_id', ctx.workspaceId);

        if (isUuid(id)) {
          query = query.eq('pipeline_id', id);
        } else {
          query = query.eq('pipeline_api_name', id);
        }

        const { data, error } = await query.limit(1).single();

        if (error || !data) {
          throw new CliError(
            `Pipeline "${id}" not found.`,
            ErrorCode.NOT_FOUND,
          );
        }

        const normalized = normalizePipelineFull(data as PipelineRow);

        if (ctx.outputOptions.json) {
          printOutput(formatGetJson(normalized));
          return;
        }

        const row = data as PipelineRow;
        console.log(`ID:          ${row.pipeline_id}`);
        console.log(`Name:        ${row.pipeline_name}`);
        console.log(`API Name:    ${row.pipeline_api_name}`);
        console.log(`State:       ${row.pipeline_state}`);
        console.log(`Source:      ${row.source_name ?? '-'} (${row.source_connector_name ?? '-'})`);
        console.log(`Destination: ${row.destination_name ?? '-'} (${row.destination_connector_name ?? '-'})`);
        console.log(`Project:     ${row.project_name ?? '-'}`);
        console.log(`Last Sync:   ${relativeTime(row.last_sync_at)}`);
        console.log(`Last Job:    ${row.last_job_status ?? '-'}`);
        console.log(`Created:     ${relativeTime(row.pipeline_created_at)}`);
        console.log(`Updated:     ${relativeTime(row.pipeline_updated_at)}`);
      }),
    );

  // disable
  pipelines
    .command('disable <identifier>')
    .description('Disable a pipeline (set state to inactive)')
    .action(
      withAuth(async (ctx: AuthContext, identifier: unknown) => {
        const id = await resolveIdentifier(
          ctx.supabase,
          'pipelines_and_datasources',
          identifier as string,
          'pipeline_id',
          'pipeline_api_name',
          ctx.workspaceId,
        );

        // pipelines table has no workspace_id column; workspace scoping
        // was already enforced by resolveIdentifier on the view.
        // RLS on the base table enforces editor access.
        const { error } = await ctx.supabase
          .from('pipelines')
          .update({ state: 'inactive' })
          .eq('id', id);

        if (error) {
          throw new CliError(`Failed to disable pipeline: ${error.message}`, ErrorCode.API_ERROR);
        }

        if (ctx.outputOptions.json) {
          printOutput(formatGetJson({ id, state: 'inactive' }));
        } else {
          console.log(`Pipeline ${truncateUuid(id)} disabled.`);
        }
      }),
    );

  // enable
  pipelines
    .command('enable <identifier>')
    .description('Enable a pipeline (set state to active)')
    .action(
      withAuth(async (ctx: AuthContext, identifier: unknown) => {
        const id = await resolveIdentifier(
          ctx.supabase,
          'pipelines_and_datasources',
          identifier as string,
          'pipeline_id',
          'pipeline_api_name',
          ctx.workspaceId,
        );

        // pipelines table has no workspace_id column; workspace scoping
        // was already enforced by resolveIdentifier on the view.
        const { error } = await ctx.supabase
          .from('pipelines')
          .update({ state: 'active' })
          .eq('id', id);

        if (error) {
          throw new CliError(`Failed to enable pipeline: ${error.message}`, ErrorCode.API_ERROR);
        }

        if (ctx.outputOptions.json) {
          printOutput(formatGetJson({ id, state: 'active' }));
        } else {
          console.log(`Pipeline ${truncateUuid(id)} enabled.`);
        }
      }),
    );

  // delete
  pipelines
    .command('delete <identifier>')
    .description('Delete a pipeline (soft delete)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(
      withAuth(async (ctx: AuthContext, identifier: unknown, opts: unknown) => {
        const options = opts as { yes?: boolean };

        const id = await resolveIdentifier(
          ctx.supabase,
          'pipelines_and_datasources',
          identifier as string,
          'pipeline_id',
          'pipeline_api_name',
          ctx.workspaceId,
        );

        if (!options.yes && !ctx.outputOptions.json && process.stdin.isTTY) {
          const { createInterface } = await import('node:readline/promises');
          const rl = createInterface({ input: process.stdin, output: process.stderr });
          const answer = await rl.question(
            `Delete pipeline ${truncateUuid(id)}? This cannot be undone. [y/N] `,
          );
          rl.close();
          if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
            console.log('Aborted.');
            process.exit(0);
          }
        }

        await softDeleteRecord(ctx.conn, 'pipelines', id);

        if (ctx.outputOptions.json) {
          printOutput(formatGetJson({ id, state: 'deleted' }));
        } else {
          console.log(`Pipeline ${truncateUuid(id)} deleted.`);
        }
      }),
    );

  // init -- generate capability-aware pipeline config
  pipelines
    .command('init')
    .description('Generate a pipeline config file based on source and project destination capabilities')
    .requiredOption('--source <identifier>', 'Source datasource (ID or api_name)')
    .requiredOption('--project <identifier>', 'Project (ID or api_name; destination resolved from project)')
    .option('--output <file>', 'Output file path (default: pipeline-config.json)', 'pipeline-config.json')
    .action(
      withAuth(async (ctx: AuthContext, opts: { source: string; project: string; output: string }) => {
        const { supabase, workspaceId, outputOptions } = ctx;

        // Resolve source, project, and destination (same path as create)
        const { src, dest, proj } = await resolveSourceProjectDestination(supabase, workspaceId, opts.source, opts.project);

        const srcCaps = src.connector_version_capabilities_config || null;
        const destCaps = dest.connector_version_capabilities_config || null;

        // Generate capability-aware config
        const config = generateCapabilityAwareConfig(srcCaps, destCaps, src.connector_type);

        // Write valid JSON config file
        const configJson = generateConfigJson(config);
        fs.writeFileSync(opts.output, configJson, 'utf-8');

        // Write reference file with comments explaining each field
        const refPath = opts.output.endsWith('.json')
          ? opts.output.replace(/\.json$/, '-reference.txt')
          : `${opts.output}-reference.txt`;
        const reference = generateConfigReference(config, srcCaps, destCaps);
        fs.writeFileSync(refPath, reference, 'utf-8');

        if (outputOptions.json) {
          printOutput(formatGetJson({
            file: opts.output,
            reference: refPath,
            source: src.name,
            source_type: src.connector_type,
            destination: dest.name,
            project: proj.name,
            pipeline_prefix: config.pipeline_prefix,
            config,
          }));
        } else {
          console.log(`Generated ${opts.output} for ${src.name} -> ${dest.name} (project: ${proj.name})`);
          console.log(`Reference: ${refPath} (explains each field and valid options)`);
          console.log(`Default prefix: ${config.pipeline_prefix}`);
          console.log(`Edit the config, then: supaflow pipelines create --source ${src.api_name} --project ${proj.api_name} --config ${opts.output}`);
        }
      }),
    );

  // create
  pipelines
    .command('create')
    .description('Create a new pipeline')
    .requiredOption('--name <name>', 'Pipeline name')
    .requiredOption('--source <identifier>', 'Source datasource (ID or api_name)')
    .requiredOption('--project <identifier>', 'Project (ID or api_name; destination comes from project)')
    .option('--config <file>', 'JSON file with pipeline config overrides')
    .option('--objects <file>', 'JSON file with object selections (default: select all discovered)')
    .option('--description <desc>', 'Pipeline description')
    .action(
      withAuth(async (ctx: AuthContext, opts: {
        name: string;
        source: string;
        project: string;
        config?: string;
        objects?: string;
        description?: string;
      }) => {
        const { supabase, workspaceId, outputOptions, conn } = ctx;

        // 1-3. Resolve source, project, and destination (shared with init)
        const { src, proj, dest } = await resolveSourceProjectDestination(supabase, workspaceId, opts.source, opts.project);

        // 4. Get active pipeline version
        const { data: versionData, error: versionError } = await supabase.rpc('get_active_pipeline_version');
        if (versionError || !versionData || versionData.length === 0) {
          throw new CliError('No active pipeline version found.', ErrorCode.API_ERROR);
        }
        const versionId = (versionData as Array<{ id: string }>)[0].id;

        // 5. Build pipeline config (defaults + optional overrides from file)
        let configOverrides: Record<string, unknown> = {};
        if (opts.config) {
          if (!fs.existsSync(opts.config)) {
            throw new CliError(`Config file "${opts.config}" not found.`, ErrorCode.NOT_FOUND);
          }
          configOverrides = JSON.parse(fs.readFileSync(opts.config, 'utf-8')) as Record<string, unknown>;
        }
        const pipelineConfig = createPipelineConfig(configOverrides);

        // 6. Generate api_name and extract user ID from JWT
        const apiName = generateApiName(opts.name);
        const jwtPayload = JSON.parse(
          Buffer.from(conn.bearerToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'),
        ) as { user_id?: string; sub?: string };
        const userId = jwtPayload.user_id || jwtPayload.sub;

        // 7. Insert pipeline in DRAFT state
        if (!outputOptions.json) {
          process.stderr.write('Creating pipeline...\n');
        }

        const { data: pipeline, error: createError } = await supabase
          .from('pipelines')
          .insert({
            project_id: proj.id,
            name: opts.name,
            api_name: apiName,
            description: opts.description || `${src.name} to ${dest.name}`,
            source_datasource_id: src.id,
            destination_datasource_id: dest.id,
            version_id: versionId,
            configs: pipelineConfig,
            state: 'draft',
            created_by: userId,
            updated_by: userId,
          })
          .select('id')
          .single();

        if (createError) {
          throw new CliError(`Failed to create pipeline: ${createError.message}`, ErrorCode.API_ERROR);
        }

        // Steps 8-10 can fail after the draft insert. Wrap in try/catch
        // to clean up the orphaned draft pipeline on any failure.
        let objectMappings: Array<{ fully_qualified_name: string; selected: boolean; fields: unknown }>;
        try {
          // 8. Trigger schema discovery on source datasource
          if (!outputOptions.json) {
            process.stderr.write('Discovering source schema...\n');
          }

          const { data: discoveryJobId, error: discoveryError } = await supabase.rpc('create_datasource_job', {
            p_datasource_id: src.id,
            p_job_type: 'datasource_schema_refresh',
            p_force_refresh: false,
          });

          if (discoveryError) {
            throw new CliError(`Schema discovery failed: ${discoveryError.message}`, ErrorCode.API_ERROR);
          }

          if (discoveryJobId) {
            const discoveryResult = await pollJobUntilDone(supabase, discoveryJobId as string);
            if (!discoveryResult.success) {
              throw new CliError(
                `Schema discovery failed: ${discoveryResult.statusMessage || discoveryResult.jobStatus}`,
                ErrorCode.API_ERROR,
              );
            }
          }

          // 9. Fetch object selections and save schema mappings
          if (!outputOptions.json) {
            process.stderr.write('Selecting objects...\n');
          }

          if (opts.objects) {
            // User-provided object selection
            if (!fs.existsSync(opts.objects)) {
              throw new CliError(`Objects file "${opts.objects}" not found.`, ErrorCode.NOT_FOUND);
            }
            objectMappings = JSON.parse(fs.readFileSync(opts.objects, 'utf-8')) as typeof objectMappings;
          } else {
            // Default: select all discovered objects (fields: null means snapshot all fields from catalog)
            const { data: catalog, error: catalogError } = await supabase
              .from('source_metadata_catalog')
              .select('fully_qualified_name, source_metadata')
              .eq('datasource_id', src.id)
              .eq('deleted', false);

            if (catalogError) {
              throw new CliError(`Failed to fetch source catalog: ${catalogError.message}`, ErrorCode.API_ERROR);
            }

            objectMappings = (catalog || []).map((obj) => ({
              fully_qualified_name: obj.fully_qualified_name as string,
              selected: true,
              fields: null,
            }));

            if (objectMappings.length === 0) {
              throw new CliError(
                'No objects discovered in source. Run "supaflow datasources refresh <source>" first.',
                ErrorCode.INVALID_INPUT,
              );
            }
          }

          const { error: mappingError } = await supabase.rpc('save_pipeline_metadata_mappings', {
            p_pipeline_id: pipeline.id,
            p_datasource_id: src.id,
            p_mappings: objectMappings,
          });

          if (mappingError) {
            throw new CliError(`Failed to save object selections: ${mappingError.message}`, ErrorCode.API_ERROR);
          }

          // 10. Activate pipeline (draft -> active)
          const { error: activateError } = await supabase
            .from('pipelines')
            .update({ state: 'active', updated_by: userId })
            .eq('id', pipeline.id);

          if (activateError) {
            throw new CliError(`Failed to activate pipeline: ${activateError.message}`, ErrorCode.API_ERROR);
          }
        } catch (err) {
          // Clean up the orphaned draft pipeline using softDeleteRecord
          // (direct PostgREST PATCH with return=minimal avoids RLS/RETURNING issue)
          try {
            await softDeleteRecord(conn, 'pipelines', pipeline.id);
          } catch {
            // Cleanup is best-effort; the original error is more important
          }
          throw err;
        }

        if (outputOptions.json) {
          printOutput(formatGetJson({
            id: pipeline.id,
            name: opts.name,
            api_name: apiName,
            source: src.name,
            destination: dest.name,
            project: proj.name,
            pipeline_prefix: pipelineConfig.pipeline_prefix || src.connector_type.toLowerCase(),
            objects_selected: objectMappings.filter((o: Record<string, unknown>) => o.selected !== false).length,
            state: 'active',
          }));
        } else {
          console.log(`Pipeline "${opts.name}" created. ID: ${pipeline.id}`);
          console.log(`Objects selected: ${objectMappings.length}`);
          console.log(`Trigger sync: supaflow pipelines sync ${apiName}`);
        }
      }),
    );

  // edit
  pipelines
    .command('edit <identifier>')
    .description('Update pipeline configuration')
    .option('--config <file>', 'JSON file with config overrides')
    .option('--name <name>', 'Update pipeline name')
    .option('--description <desc>', 'Update pipeline description')
    .action(
      withAuth(async (ctx: AuthContext, identifier: string, opts: {
        config?: string;
        name?: string;
        description?: string;
      }) => {
        const { supabase, workspaceId, outputOptions, conn } = ctx;

        // Find pipeline by UUID or api_name via the view
        let query = supabase
          .from('pipelines_and_datasources')
          .select('pipeline_id, pipeline_name, pipeline_api_name, pipeline_state, pipeline_configs, workspace_id')
          .eq('workspace_id', workspaceId);

        if (isUuid(identifier)) {
          query = query.eq('pipeline_id', identifier);
        } else {
          query = query.eq('pipeline_api_name', identifier);
        }

        const { data, error } = await query.single();
        if (error || !data) {
          throw new CliError(`Pipeline "${identifier}" not found.`, ErrorCode.NOT_FOUND);
        }

        const pipelineId = (data as PipelineRow).pipeline_id;
        const currentConfigs = (data as PipelineRow).pipeline_configs as Record<string, unknown>;

        // Build update payload
        const jwtPayload = JSON.parse(
          Buffer.from(conn.bearerToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'),
        ) as { user_id?: string; sub?: string };
        const userId = jwtPayload.user_id || jwtPayload.sub;

        const updateData: Record<string, unknown> = {
          updated_by: userId,
        };

        if (opts.name) {
          updateData.name = opts.name;
        }

        if (opts.description) {
          updateData.description = opts.description;
        }

        if (opts.config) {
          if (!fs.existsSync(opts.config)) {
            throw new CliError(`Config file "${opts.config}" not found.`, ErrorCode.NOT_FOUND);
          }
          const configOverrides = JSON.parse(fs.readFileSync(opts.config, 'utf-8')) as Record<string, unknown>;
          // Shallow merge: preserve unchanged fields, apply overrides on top
          updateData.configs = { ...currentConfigs, ...configOverrides };
        }

        if (Object.keys(updateData).length === 1) {
          // Only updated_by set -- nothing substantive to change
          throw new CliError('Nothing to update. Provide --config, --name, or --description.', ErrorCode.INVALID_INPUT);
        }

        // pipelines table has no workspace_id column; RLS enforces access
        const { error: updateError } = await supabase
          .from('pipelines')
          .update(updateData)
          .eq('id', pipelineId);

        if (updateError) {
          throw new CliError(`Failed to update pipeline: ${updateError.message}`, ErrorCode.API_ERROR);
        }

        const displayName = opts.name || (data as PipelineRow).pipeline_name;

        if (outputOptions.json) {
          printOutput(formatGetJson({
            id: pipelineId,
            name: displayName,
            api_name: (data as PipelineRow).pipeline_api_name,
            updated: Object.keys(updateData).filter((k) => k !== 'updated_by'),
          }));
        } else {
          console.log(`Pipeline "${displayName}" updated.`);
        }
      }),
    );

  // schema subcommand group
  const schema = pipelines.command('schema').description('Manage pipeline schema/object selection');

  schema
    .command('list <identifier>')
    .description('List selected objects for a pipeline')
    .option('--all', 'Include deselected objects')
    .action(
      withAuth(async (ctx: AuthContext, identifier: string, opts: { all?: boolean }) => {
        const { supabase, workspaceId, outputOptions } = ctx;

        // Resolve pipeline
        let query = supabase
          .from('pipelines_and_datasources')
          .select('pipeline_id, pipeline_name, workspace_id')
          .eq('workspace_id', workspaceId);

        query = isUuid(identifier) ? query.eq('pipeline_id', identifier) : query.eq('pipeline_api_name', identifier);

        const { data: pipeline, error } = await query.single();
        if (error || !pipeline) {
          throw new CliError(`Pipeline "${identifier}" not found.`, ErrorCode.NOT_FOUND);
        }

        // Fetch metadata mappings
        const { data: mappings, error: mappingError } = await supabase
          .from('pipeline_metadata_mappings')
          .select('source_fully_qualified_name, selected_source_metadata, selection_origin')
          .eq('pipeline_id', (pipeline as { pipeline_id: string }).pipeline_id);

        if (mappingError) {
          throw new CliError(`Failed to fetch schema: ${mappingError.message}`, ErrorCode.API_ERROR);
        }

        const rows = (mappings || []).filter((m) => {
          if (opts.all) return true;
          const meta = m.selected_source_metadata as Record<string, unknown> | null;
          return meta?.selected !== false;
        });

        if (outputOptions.json) {
          // Compact JSON: object name, selected status, field counts -- no full field arrays
          const compact = rows.map((r) => {
            const meta = r.selected_source_metadata as Record<string, unknown> | null;
            return {
              object: r.source_fully_qualified_name,
              selected: meta?.selected !== false,
              total_fields: meta?.total_field_count ?? null,
              selected_fields: meta?.selected_field_count ?? null,
              origin: r.selection_origin || null,
            };
          });
          printOutput(formatListJson(compact, compact.length, compact.length, 0));
        } else {
          if (rows.length === 0) { console.log('No objects selected.'); return; }
          const headers = ['OBJECT', 'ORIGIN'];
          const tableRows = rows.map((r) => [
            r.source_fully_qualified_name as string,
            (r.selection_origin as string) || '',
          ]);
          printOutput(formatTable(headers, tableRows));
        }
      }),
    );

  schema
    .command('select <identifier>')
    .description('Update object selections for a pipeline')
    .requiredOption('--from <file>', 'JSON file with object selections')
    .action(
      withAuth(async (ctx: AuthContext, identifier: string, opts: { from: string }) => {
        const { supabase, workspaceId, outputOptions } = ctx;

        // Resolve pipeline
        let query = supabase
          .from('pipelines_and_datasources')
          .select('pipeline_id, pipeline_name, source_datasource_id, workspace_id')
          .eq('workspace_id', workspaceId);

        query = isUuid(identifier) ? query.eq('pipeline_id', identifier) : query.eq('pipeline_api_name', identifier);

        const { data: pipeline, error } = await query.single();
        if (error || !pipeline) {
          throw new CliError(`Pipeline "${identifier}" not found.`, ErrorCode.NOT_FOUND);
        }

        if (!fs.existsSync(opts.from)) {
          throw new CliError(`File "${opts.from}" not found.`, ErrorCode.NOT_FOUND);
        }

        const objectMappings = JSON.parse(fs.readFileSync(opts.from, 'utf-8')) as unknown;

        const pipelineRow = pipeline as { pipeline_id: string; pipeline_name: string; source_datasource_id: string };

        const { data: result, error: saveError } = await supabase.rpc('save_pipeline_metadata_mappings', {
          p_pipeline_id: pipelineRow.pipeline_id,
          p_datasource_id: pipelineRow.source_datasource_id,
          p_mappings: objectMappings,
        });

        if (saveError) {
          throw new CliError(`Failed to save selections: ${saveError.message}`, ErrorCode.API_ERROR);
        }

        if (outputOptions.json) {
          printOutput(formatGetJson(result as Record<string, unknown>));
        } else {
          console.log(`Schema selections updated for "${pipelineRow.pipeline_name}".`);
        }
      }),
    );

  schema
    .command('add <identifier> <object>')
    .description('Add a single object to a pipeline by name')
    .action(
      withAuth(async (ctx: AuthContext, identifier: string, objectName: string) => {
        const { supabase, workspaceId, outputOptions } = ctx;

        let query = supabase
          .from('pipelines_and_datasources')
          .select('pipeline_id, pipeline_name, source_datasource_id, workspace_id')
          .eq('workspace_id', workspaceId);

        query = isUuid(identifier) ? query.eq('pipeline_id', identifier) : query.eq('pipeline_api_name', identifier);

        const { data: pipeline, error } = await query.single();
        if (error || !pipeline) {
          throw new CliError(`Pipeline "${identifier}" not found.`, ErrorCode.NOT_FOUND);
        }

        const pipelineRow = pipeline as { pipeline_id: string; pipeline_name: string; source_datasource_id: string };

        const mapping = [{ fully_qualified_name: objectName, selected: true, fields: null }];

        const { data: result, error: saveError } = await supabase.rpc('save_pipeline_metadata_mappings', {
          p_pipeline_id: pipelineRow.pipeline_id,
          p_datasource_id: pipelineRow.source_datasource_id,
          p_mappings: mapping,
        });

        if (saveError) {
          throw new CliError(`Failed to add object: ${saveError.message}`, ErrorCode.API_ERROR);
        }

        if (outputOptions.json) {
          printOutput(formatGetJson({ object: objectName, ...((result as Record<string, unknown>[])?.[0] || {}) }));
        } else {
          console.log(`Added "${objectName}" to pipeline "${pipelineRow.pipeline_name}".`);
        }
      }),
    );

  // sync
  pipelines
    .command('sync <identifier>')
    .description('Trigger a pipeline sync')
    .option('--full-resync', 'Reset cursors and re-sync all data from scratch')
    .option('--reset-target', 'Drop and recreate destination tables (use with --full-resync)')
    .action(
      withAuth(async (ctx: AuthContext, identifier: string, opts: { fullResync?: boolean; resetTarget?: boolean }) => {
        const { supabase, workspaceId, outputOptions } = ctx;

        if (opts.resetTarget && !opts.fullResync) {
          throw new CliError(
            '--reset-target requires --full-resync. Use: supaflow pipelines sync <identifier> --full-resync --reset-target',
            ErrorCode.INVALID_INPUT,
          );
        }

        const pipelineId = await resolveIdentifier(
          supabase, 'pipelines_and_datasources', identifier,
          'pipeline_id', 'pipeline_api_name', workspaceId,
        );

        const { data, error } = await supabase.rpc('create_pipeline_run_job', {
          p_pipeline_id: pipelineId,
          p_job_type: 'pipeline_run',
          p_reset_target: opts.resetTarget ?? false,
          p_full_resync: opts.fullResync ?? false,
        });

        if (error) throw new CliError(error.message, ErrorCode.API_ERROR);

        const jobId = data as string;

        if (outputOptions.json) {
          printOutput(formatGetJson({ job_id: jobId, pipeline_id: pipelineId, status: 'queued' }));
        } else {
          console.log(`Sync triggered for pipeline ${truncateUuid(pipelineId)}.`);
          console.log(`Job ID: ${jobId}`);
          console.log(`Track progress: supaflow jobs get ${jobId}`);
        }
      }),
    );
}
