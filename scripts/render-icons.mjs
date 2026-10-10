// Renders the PNG icons from public/icons/icon.svg (and a padded maskable
// variant written to /tmp/maskable.svg by hand: same art scaled to 80 %).
// Run from the repo root: PWCHROME=/path/to/chrome-headless-shell node scripts/render-icons.mjs
// (playwright installed with npm i --no-save playwright).
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const b = await chromium.launch({ executablePath: process.env.PWCHROME });
const p = await b.newPage();
for (const [src, out, size] of [['public/icons/icon.svg','public/icons/icon-192.png',192],['public/icons/icon.svg','public/icons/icon-512.png',512],['public/icons/icon.svg','public/icons/apple-touch-icon.png',180],['/tmp/maskable.svg','public/icons/maskable-512.png',512]]) {
  await p.setViewportSize({ width: size, height: size });
  const svg = readFileSync(src, 'utf8').replace('<svg ', `<svg width="${size}" height="${size}" `);
  await p.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`);
  await p.screenshot({ path: out, omitBackground: true });
}
await b.close();
