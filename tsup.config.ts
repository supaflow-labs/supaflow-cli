import { defineConfig } from 'tsup';
import { cpSync, existsSync } from 'node:fs';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  clean: true,
  dts: true,
  sourcemap: true,
  shims: true,
  onSuccess: async () => {
    if (existsSync('assets/connectors'))
      cpSync('assets/connectors', 'dist/connectors', { recursive: true });
  },
});
