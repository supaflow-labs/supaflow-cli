import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Command } from 'commander';
import { formatGetJson, printOutput } from '../lib/output.js';
import { CliError, ErrorCode } from '../lib/errors.js';

const DOCS_URL = 'https://www.supa-flow.io/docs/llms/docs.txt';
const CACHE_FILE = path.join(os.tmpdir(), 'supaflow-docs.txt');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Section delimiter in the docs file
const SOURCE_REGEX = /^<!-- Source: https:\/\/www\.supa-flow\.io\/docs\/?(.*)? -->$/;

interface DocSection {
  path: string;
  title: string;
  content: string;
}

/**
 * Fetch docs.txt, using a 24h file cache in /tmp.
 */
async function getDocsContent(refresh: boolean): Promise<string> {
  // Check cache
  if (!refresh && fs.existsSync(CACHE_FILE)) {
    const stat = fs.statSync(CACHE_FILE);
    const age = Date.now() - stat.mtimeMs;
    if (age < CACHE_TTL_MS) {
      return fs.readFileSync(CACHE_FILE, 'utf-8');
    }
  }

  // Fetch fresh, but fall back to stale cache on network failure
  try {
    const response = await fetch(DOCS_URL);
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    const content = await response.text();
    fs.writeFileSync(CACHE_FILE, content, 'utf-8');
    return content;
  } catch (err) {
    // If we have a stale cache and --refresh wasn't explicitly requested, use it
    if (!refresh && fs.existsSync(CACHE_FILE)) {
      return fs.readFileSync(CACHE_FILE, 'utf-8');
    }
    throw new CliError(
      `Failed to fetch docs: ${err instanceof Error ? err.message : String(err)}`,
      ErrorCode.NETWORK_ERROR,
    );
  }
}

/**
 * Parse the monolithic docs.txt into sections by <!-- Source: URL --> delimiters.
 */
function parseSections(content: string): DocSection[] {
  const lines = content.split('\n');
  const sections: DocSection[] = [];
  let currentPath = '';
  let currentLines: string[] = [];
  let currentTitle = '';

  for (const line of lines) {
    const match = line.match(SOURCE_REGEX);
    if (match) {
      // Save previous section
      if (currentPath || currentLines.length > 0) {
        sections.push({
          path: currentPath,
          title: currentTitle,
          content: currentLines.join('\n').trim(),
        });
      }
      currentPath = match[1] || '';
      currentLines = [];
      currentTitle = '';
    } else {
      currentLines.push(line);
      // Capture the first H1 as the section title
      if (!currentTitle && line.startsWith('# ')) {
        currentTitle = line.slice(2).trim();
      }
    }
  }

  // Save last section
  if (currentPath || currentLines.length > 0) {
    sections.push({
      path: currentPath,
      title: currentTitle,
      content: currentLines.join('\n').trim(),
    });
  }

  return sections;
}

/**
 * Build a lookup map of keywords to section paths for matching.
 */
const TOPIC_ALIASES: Record<string, string[]> = {
  'sqlserver': ['sources/sqlserver'],
  'sql-server': ['sources/sqlserver'],
  'sql_server': ['sources/sqlserver'],
  'postgres': ['sources/postgres'],
  'postgresql': ['sources/postgres'],
  'salesforce': ['sources/salesforce', 'sources/salesforce/configure-salesforce-account'],
  'sfmc': ['sources/salesforce-marketing-cloud'],
  'salesforce-marketing-cloud': ['sources/salesforce-marketing-cloud'],
  'hubspot': ['sources/hubspot'],
  'airtable': ['sources/airtable'],
  'oracle-tm': ['sources/oracle-tm'],
  'oracle_tm': ['sources/oracle-tm'],
  'otm': ['sources/oracle-tm'],
  'sftp': ['sources/sftp'],
  'google-drive': ['sources/google-drive'],
  'google_drive': ['sources/google-drive'],
  'snowflake': ['destinations/snowflake'],
  's3': ['destinations/s3'],
  's3-data-lake': ['destinations/s3-data-lake'],
  's3_data_lake': ['destinations/s3-data-lake'],
  'iceberg': ['destinations/s3-data-lake'],
  'parquet': ['destinations/s3-data-lake'],
  'pipelines': ['ingestion-pipelines'],
  'ingestion': ['ingestion-pipelines'],
  'activation': ['activation-pipelines'],
  'schedules': ['schedules'],
  'activities': ['activities'],
  'tasks': ['tasks'],
  'orchestrations': ['orchestrations'],
  'deployments': ['deployments'],
  'projects': ['projects'],
  'workspaces': ['workspaces'],
  'getting-started': ['getting-started'],
  'quickstart': ['getting-started'],
  'sources': ['sources'],
  'destinations': ['destinations'],
  'agents': ['settings/agents'],
  'api-keys': ['settings/api-keys'],
  'billing': ['settings/billing', 'usage'],
  'notifications': ['settings/notifications'],
  'organization': ['settings/organization'],
  'public-keys': ['settings/public-keys'],
  'native-app': ['settings/snowflake-native-app'],
  'dbt': ['settings/dbt-integration'],
  'git': ['settings/git-integration'],
  'settings': ['settings'],
  'api': ['api-reference'],
};

function findSections(topic: string, allSections: DocSection[]): DocSection[] {
  const lower = topic.toLowerCase().trim();

  // Check alias map first
  const aliasPaths = TOPIC_ALIASES[lower];
  if (aliasPaths) {
    return allSections.filter((s) => aliasPaths.includes(s.path));
  }

  // Fuzzy match: check path contains topic, or title contains topic
  const matches = allSections.filter(
    (s) =>
      s.path.toLowerCase().includes(lower) ||
      s.title.toLowerCase().includes(lower),
  );

  return matches;
}

export function registerDocsCommand(program: Command): void {
  program
    .command('docs [topic]')
    .description('Show Supaflow documentation for a connector or topic')
    .option('--list', 'List all available topics')
    .option('--output <file>', 'Write documentation to a file instead of stdout')
    .option('--refresh', 'Force refresh the docs cache (normally cached for 24h)')
    .action(async (topic: string | undefined, opts: { list?: boolean; output?: string; refresh?: boolean }) => {
      const parentOpts = program.opts() as { json?: boolean };
      const json = parentOpts.json || false;

      const content = await getDocsContent(opts.refresh || false);
      const sections = parseSections(content);

      // --list: show all available topics with their aliases
      if (opts.list) {
        // Build reverse alias map: path -> aliases
        const pathAliases: Record<string, string[]> = {};
        for (const [alias, paths] of Object.entries(TOPIC_ALIASES)) {
          for (const p of paths) {
            if (!pathAliases[p]) pathAliases[p] = [];
            if (!pathAliases[p].includes(alias)) pathAliases[p].push(alias);
          }
        }

        const topics = sections
          .filter((s) => s.path && s.title)
          .map((s) => ({
            path: s.path,
            title: s.title,
            aliases: pathAliases[s.path] || [],
          }));

        if (json) {
          printOutput(JSON.stringify({ topics }, null, 2));
        } else {
          console.log('Available documentation topics:\n');
          for (const t of topics) {
            const aliasStr = t.aliases.length > 0 ? ` (aliases: ${t.aliases.join(', ')})` : '';
            console.log(`  ${t.path.padEnd(45)} ${t.title}${aliasStr}`);
          }
          console.log(`\nUsage: supaflow docs <topic-or-alias>`);
          console.log('Example: supaflow docs sqlserver');
        }
        return;
      }

      if (!topic) {
        throw new CliError(
          'Specify a topic (e.g., supaflow docs sqlserver). Use --list to see all topics.',
          ErrorCode.INVALID_INPUT,
        );
      }

      const matched = findSections(topic, sections);

      if (matched.length === 0) {
        const available = sections
          .filter((s) => s.path && s.title)
          .map((s) => s.path)
          .join(', ');
        throw new CliError(
          `No documentation found for "${topic}". Available: ${available}`,
          ErrorCode.NOT_FOUND,
        );
      }

      const combined = matched.map((s) => s.content).join('\n\n---\n\n');

      if (opts.output) {
        fs.writeFileSync(opts.output, combined, 'utf-8');
        if (json) {
          printOutput(formatGetJson({
            topic,
            sections: matched.map((s) => s.path),
            file: opts.output,
            lines: combined.split('\n').length,
          }));
        } else {
          console.log(`Wrote ${matched.length} section(s) to ${opts.output} (${combined.split('\n').length} lines)`);
        }
      } else {
        if (json) {
          printOutput(JSON.stringify({
            topic,
            sections: matched.map((s) => ({ path: s.path, title: s.title })),
            content: combined,
          }, null, 2));
        } else {
          console.log(combined);
        }
      }
    });
}
