// This explicit deployment gate checks values unavailable to ordinary PR builds.
import { readFileSync } from 'node:fs';
const origin = process.env.PUBLIC_APP_URL;
const support = process.env.SUPPORT_EMAIL;
const errors = [];
try {
  const url = new URL(origin);
  if (
    url.protocol !== 'https:' ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    /localhost|127\.0\.0\.1|example\./.test(url.hostname)
  )
    throw new Error();
} catch {
  errors.push('PUBLIC_APP_URL must be the real HTTPS production origin.');
}
if (!support || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(support))
  errors.push('SUPPORT_EMAIL must be the monitored support/privacy address.');
for (const name of ['privacy', 'terms']) {
  const html = readFileSync(
    new URL(`../public/${name}.html`, import.meta.url),
    'utf8',
  );
  if (
    html.includes('Maintainers:') ||
    !support ||
    !html.includes(`mailto:${support}`)
  )
    errors.push(
      `${name}.html must contain the approved support email and no placeholders.`,
    );
}
if (
  !process.env.VITE_SUPABASE_URL ||
  !process.env.VITE_SUPABASE_PUBLISHABLE_KEY
)
  errors.push(
    'Set the production Supabase URL and public key in the deployment environment.',
  );
if (process.env.PRODUCTION_QUESTION_BANK_CONFIRMED !== 'yes')
  errors.push(
    'Import a private production question bank, then set PRODUCTION_QUESTION_BANK_CONFIRMED=yes. The public seed is practice content.',
  );
if (errors.length) {
  errors.forEach((error) => console.error(error));
  process.exitCode = 1;
} else
  console.log(
    'Deployment configuration checks passed. Run the documented staging acceptance checks before launch.',
  );
