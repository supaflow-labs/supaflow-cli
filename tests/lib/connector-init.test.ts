import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VERSION } from '../../src/version.js';
import {
  ConnectorInitConflictError,
  initializeConnectorProject,
} from '../../src/lib/connector-init.js';
import {
  renderApiSourceTemplate,
  renderCustomSourceTemplate,
  renderSqlSourceTemplate,
} from '../../src/lib/connector-templates.js';

const input = {
  connectorName: 'ACME_RECORDS',
  displayName: 'Acme café records',
  groupId: 'com.acme',
  version: '1.2.3.dev1',
  requiresPython: '>=3.11,<3.15',
  sdkVersion: '1.0.73.dev0',
  testkitVersion: '0.1.0',
  runtimeVersion: '0.1.0',
};
let root: string;
let target: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'supaflow init ; '));
  target = join(root, 'connector');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('staged connector initialization', () => {
  it.each([renderCustomSourceTemplate, renderApiSourceTemplate, renderSqlSourceTemplate])(
    'publishes a bundled template only after staged preparation and validation: %s',
    async (render) => {
      const template = render(input);
      let metadataBytes: string | undefined;
      const validate = vi.fn(async (staging: string) => {
        expect(dirname(dirname(staging))).toBe(root);
        expect(staging).not.toBe(target);
        await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
        for (const [path, contents] of Object.entries(template.files)) {
          expect(await readFile(join(staging, path), 'utf8')).toBe(contents);
        }
        metadataBytes = await readFile(join(staging, '.supaflow/template.json'), 'utf8');
        const metadata = JSON.parse(metadataBytes);
        expect(new Date(metadata.createdAt).toISOString()).toBe(metadata.createdAt);
        expect(metadata).toEqual({
          schemaVersion: 1,
          templateId: template.templateId,
          templateVersion: template.templateVersion,
          cliVersion: VERSION,
          toolchainVersion: '0.1.0',
          createdAt: expect.any(String),
          files: Object.fromEntries(
            Object.entries(template.files)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([path, contents]) => [
                path,
                createHash('sha256').update(Buffer.from(contents, 'utf8')).digest('hex'),
              ]),
          ),
        });
        // The caller composes the real manifest/lock/check services here. Generated
        // files are project inputs, not original template-owned upgrade baselines.
        await writeFile(join(staging, 'connector.yaml'), 'validated generated manifest\n');
      });
      await initializeConnectorProject(target, template, '0.1.0', validate);
      expect(validate).toHaveBeenCalledOnce();
      expect(await readFile(join(target, '.supaflow/template.json'), 'utf8')).toBe(metadataBytes);
      expect(await readFile(join(target, 'connector.yaml'), 'utf8')).toBe(
        'validated generated manifest\n',
      );
      expect(await readdir(root)).toEqual(['connector']);
    },
  );

  it('records deterministic baselines independent of file insertion order', async () => {
    const template = renderCustomSourceTemplate(input);
    await initializeConnectorProject(target, template, '0.1.0', async () => {});
    const other = join(root, 'other');
    await initializeConnectorProject(
      other,
      { ...template, files: Object.fromEntries(Object.entries(template.files).reverse()) },
      '0.1.0',
      async () => {},
    );
    const first = JSON.parse(await readFile(join(target, '.supaflow/template.json'), 'utf8'));
    const second = JSON.parse(await readFile(join(other, '.supaflow/template.json'), 'utf8'));
    expect({ ...first, createdAt: undefined }).toEqual({ ...second, createdAt: undefined });
  });

  it.each(['empty directory', 'nonempty directory', 'file', 'link', 'dangling link'])(
    'rejects an existing %s before writing or validating',
    async (kind) => {
      if (kind.includes('directory')) {
        await mkdir(target);
        if (kind === 'nonempty directory') await writeFile(join(target, 'keep'), 'keep');
      } else if (kind === 'file') {
        await writeFile(target, 'keep');
      } else {
        const linked = join(root, 'linked');
        if (kind === 'link') await mkdir(linked);
        await symlink(linked, target, 'dir');
      }
      const before = await lstat(target);
      const validate = vi.fn();
      await expect(
        initializeConnectorProject(target, renderCustomSourceTemplate(input), '0.1.0', validate),
      ).rejects.toBeInstanceOf(ConnectorInitConflictError);
      expect(validate).not.toHaveBeenCalled();
      expect((await lstat(target)).ino).toBe(before.ino);
      expect((await readdir(root)).filter((name) => name.startsWith('.supaflow-init-'))).toEqual(
        [],
      );
      if (kind === 'file') expect(await readFile(target, 'utf8')).toBe('keep');
      if (kind === 'nonempty directory') {
        expect(await readdir(target)).toEqual(['keep']);
        expect(await readFile(join(target, 'keep'), 'utf8')).toBe('keep');
      }
    },
  );

  it('removes only its own staging directory after validation fails', async () => {
    const existing = join(root, 'another-operation');
    await mkdir(existing);
    await writeFile(join(existing, 'keep'), 'untouched');
    const failure = new Error('project check failed');
    await expect(
      initializeConnectorProject(
        target,
        renderCustomSourceTemplate(input),
        '0.1.0',
        async (staging) => {
          await writeFile(join(staging, 'generated.lock'), 'temporary');
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(root)).toEqual(['another-operation']);
    expect(await readFile(join(existing, 'keep'), 'utf8')).toBe('untouched');
  });

  it('preserves a target created during validation', async () => {
    await expect(
      initializeConnectorProject(target, renderCustomSourceTemplate(input), '0.1.0', async () => {
        await mkdir(target);
        await writeFile(join(target, 'keep'), 'created independently');
      }),
    ).rejects.toBeInstanceOf(ConnectorInitConflictError);
    expect(await readdir(root)).toEqual(['connector']);
    expect(await readdir(target)).toEqual(['keep']);
    expect(await readFile(join(target, 'keep'), 'utf8')).toBe('created independently');
  });

  it.each(['../escape', '/absolute', 'a\\b', 'C:relative', '.supaflow/template.json'])(
    'rejects invalid bundled paths before work: %s',
    async (path) => {
      const validate = vi.fn();
      const template = renderCustomSourceTemplate(input);
      template.files[path] = 'invalid';
      await expect(initializeConnectorProject(target, template, '0.1.0', validate)).rejects.toThrow(
        'invalid file path',
      );
      expect(validate).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual([]);
    },
  );

  it('publishes normal project permissions, rather than the private scratch mode', async () => {
    const ordinary = join(root, 'ordinary');
    await mkdir(ordinary);
    await initializeConnectorProject(
      target,
      renderCustomSourceTemplate(input),
      '0.1.0',
      async () => {},
    );
    expect((await lstat(target)).mode & 0o777).toBe((await lstat(ordinary)).mode & 0o777);
  });

  it('keeps the temporary prefix independent of a long legal target name', async () => {
    const longTarget = join(root, 'c'.repeat(240));
    await initializeConnectorProject(
      longTarget,
      renderCustomSourceTemplate(input),
      '0.1.0',
      async () => {},
    );
    expect(await readdir(root)).toEqual(['c'.repeat(240)]);
  });

  it.each(['', '/machine/path', 'file://toolchain', '0.1.0 with spaces'])(
    'rejects invalid provenance version %j before writing',
    async (version) => {
      await expect(
        initializeConnectorProject(
          target,
          renderCustomSourceTemplate(input),
          version,
          async () => {},
        ),
      ).rejects.toThrow('toolchain distribution version');
      expect(await readdir(root)).toEqual([]);
    },
  );

  it('requires an absolute project target', async () => {
    await expect(
      initializeConnectorProject(
        'relative',
        renderCustomSourceTemplate(input),
        '0.1.0',
        async () => {},
      ),
    ).rejects.toThrow('absolute connector project target');
    expect(await readdir(root)).toEqual([]);
  });
});
