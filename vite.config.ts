/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
import { assertPublicKey } from './src/public-config';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  assertPublicKey(
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
      env.VITE_SUPABASE_PUBLISHABLE_KEY,
  );
  return {
    plugins: [react()],
    test: {
      // The database suite runs in Node against PGlite; React component suites
      // opt into jsdom with a `// @vitest-environment jsdom` docblock.
      environment: 'node',
      globals: true,
      setupFiles: ['./tests/setup.ts'],
      css: false,
      // Keep the suite deterministic: the offline-preview tests must not pick up
      // a developer's .env.local Supabase connection.
      env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_PUBLISHABLE_KEY: '' },
    },
  };
});
