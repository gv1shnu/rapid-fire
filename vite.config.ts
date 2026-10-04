/// <reference types="vitest/config" />
import { copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { assertPublicKey } from './src/public-config';
import react from '@vitejs/plugin-react';

// Production is a GitHub Pages project site at
// https://www.vishnugandarapu.in/rapid-fire/. Dev stays at the root.
const BASE = '/rapid-fire/';

// GitHub Pages ignores public/_headers, so ship the security policy as meta
// tags. Build-only: the dev server injects an inline React refresh script that
// a strict script-src would block. frame-ancestors cannot be set by meta.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function pagesHosting(): Plugin {
  let outDir = 'dist';
  return {
    name: 'pages-hosting',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    // After charset/viewport, but ahead of every stylesheet and script.
    transformIndexHtml: (html) =>
      html.replace(
        /(<meta name="viewport"[^>]*>)/,
        `$1\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />` +
          '\n    <meta name="referrer" content="no-referrer" />',
      ),
    // Pages serves 404.html for unknown paths, so deep links such as
    // /rapid-fire/instructor (the OAuth return URL) load the app shell.
    closeBundle() {
      copyFileSync(`${outDir}/index.html`, `${outDir}/404.html`);
    },
  };
}

export default defineConfig(({ command, isPreview, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  assertPublicKey(
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
      env.VITE_SUPABASE_PUBLISHABLE_KEY,
  );
  return {
    base: command === 'build' || isPreview ? BASE : '/',
    plugins: [react(), pagesHosting()],
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
