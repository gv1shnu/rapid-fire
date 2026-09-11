/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    // The database suite runs in Node against PGlite; React component suites
    // opt into jsdom with a `// @vitest-environment jsdom` docblock.
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    css: false,
  },
});
