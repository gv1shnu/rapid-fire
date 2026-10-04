import { readFileSync, existsSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { assertPublicKey } from '../src/public-config';
const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
describe('deployment assets and browser configuration', () => {
  it.each([
    'sb_secret_do_not_bundle',
    `header.${btoa(JSON.stringify({ role: 'service_role' }))}.signature`,
  ])('rejects privileged browser keys %#', (key) => {
    expect(() => assertPublicKey(key)).toThrow();
  });
  it('accepts publishable/anon keys and unconfigured previews', () => {
    expect(() => assertPublicKey(undefined)).not.toThrow();
    expect(() => assertPublicKey('sb_publishable_example')).not.toThrow();
    expect(() =>
      assertPublicKey(
        `header.${btoa(JSON.stringify({ role: 'anon' }))}.signature`,
      ),
    ).not.toThrow();
  });
  it('ships every manifest icon at the declared dimensions', () => {
    const manifest = JSON.parse(read('public/site.webmanifest'));
    for (const icon of manifest.icons) {
      const path = new URL(`../public/${icon.src}`, import.meta.url);
      expect(existsSync(path)).toBe(true);
      if (icon.type === 'image/png') {
        const data = readFileSync(path);
        const [w, h] = icon.sizes.split('x').map(Number);
        expect(data.readUInt32BE(16)).toBe(w);
        expect(data.readUInt32BE(20)).toBe(h);
      }
    }
    expect(
      readFileSync(
        new URL('../public/favicon.ico', import.meta.url),
      ).readUInt16LE(2),
    ).toBe(1);
  });
  it.each(['privacy', 'terms'])(
    'serves public %s with base-relative links and real contact details',
    (name) => {
      const html = read(`public/${name}.html`);
      expect(html).not.toContain('example.edu');
      expect(html).not.toContain('Maintainers:');
      expect(html).not.toContain('shared countdown');
      expect(html).toContain('href="./"');
      expect(html).not.toMatch(/(href|src)="\/(?!\/)/);
    },
  );
  it('links legal pages from the public homepage and forbids framing', () => {
    const home = read('src/Home.tsx');
    expect(home).toContain("href={appPath('privacy.html')}");
    expect(home).toContain("href={appPath('terms.html')}");
    const headers = read('public/_headers');
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).toContain('X-Content-Type-Options: nosniff');
  });
  it('ships absolute share metadata and a 1200x630 card for the Pages URL', () => {
    const html = read('index.html');
    const origin = 'https://www.vishnugandarapu.in/rapid-fire/';
    expect(html).toContain(`<link rel="canonical" href="${origin}" />`);
    expect(html).toContain(`content="${origin}og-image.png"`);
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    const card = readFileSync(
      new URL('../public/og-image.png', import.meta.url),
    );
    expect([card.readUInt32BE(16), card.readUInt32BE(20)]).toEqual([1200, 630]);
  });
});
