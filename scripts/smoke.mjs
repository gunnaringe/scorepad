// End-to-end check against `npx wrangler dev` (default http://localhost:8787):
// sticky table with 8 players x 20 rounds, an Amerikaner round, and two
// devices sharing a session (live update, offline queue, device list).
// Screenshots go to /tmp/shots. Needs `npm i --no-save playwright`; set
// PWCHROME to a chromium/headless-shell binary if Playwright's own isn't there.
//   BASE=http://localhost:8787 node scripts/smoke.mjs
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
const BASE = process.env.BASE ?? 'http://localhost:8787';
mkdirSync('/tmp/shots', { recursive: true });
const b = await chromium.launch({ executablePath: process.env.PWCHROME });
const mk = async (opts = {}) => {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'nb-NO', ...opts });
  const p = await ctx.newPage();
  p.on('console', (m) => m.type() === 'error' && console.log('console:', m.text()));
  p.on('pageerror', (e) => console.log('pageerror:', e.message));
  return { ctx, p };
};
const addPlayers = async (p, names) => { for (const n of names) { await p.fill('#pname', n); await p.press('#pname', 'Enter'); } };

// A) Free mode, 8 players, 20 rounds: sticky header/footer/first column.
{
  const { p } = await mk();
  await p.goto(`${BASE}/`);
  await p.click('#new-session');
  await p.click('[data-preset="free"]');
  await addPlayers(p, ['Kari Nordmann', 'Ola', 'Per', 'Lise', 'Mona', 'Trond', 'Anne', 'Bjørn']);
  await p.click('#start');
  for (let r = 0; r < 20; r++) {
    await p.click('#primary');
    const inputs = await p.$$('#sheet [data-score]');
    for (let i = 0; i < inputs.length; i++) await inputs[i].fill(String(((r * 7 + i * 3) % 25) - 5));
    await p.click('#sheet-save');
  }
  const sc = await p.$('#gt');
  await sc.evaluate((el) => { el.scrollTop = el.scrollHeight / 2; el.scrollLeft = 200; });
  await p.waitForTimeout(100);
  const r = await p.evaluate(() => {
    const box = (s) => document.querySelector(s).getBoundingClientRect();
    const scr = box('#gt');
    return { scroller: [scr.top, scr.bottom, scr.left], head: box('thead th:nth-child(3)').top, foot: box('tfoot td').bottom, rn: box('tbody tr:nth-child(10) .rn').left, scrollTop: document.querySelector('#gt').scrollTop, scrollLeft: document.querySelector('#gt').scrollLeft };
  });
  console.log('sticky', JSON.stringify(r));
  await p.screenshot({ path: '/tmp/shots/free-scrolled.png' });
}

// B) Amerikaner contract + tricks.
{
  const { p } = await mk();
  await p.goto(`${BASE}/`);
  await p.click('#new-session');
  await p.click('[data-preset="amerikaner"]');
  await addPlayers(p, ['Kari', 'Ola', 'Per', 'Lise']);
  await p.click('#start');
  await p.click('#primary');
  await p.click('#sheet [data-g="kurtier"][data-pid]:nth-child(2)');
  await p.click('#sheet [data-g="bid"][data-v="8"]');
  await p.click('#sheet [data-g="partner"]:nth-child(2)');
  await p.screenshot({ path: '/tmp/shots/am-contract.png' });
  await p.click('#sheet-save');
  await p.click('#primary');
  const rows = await p.$$('#sheet .entry');
  await rows[0].$$eval('.nchip', (cs) => cs[3].click());
  await rows[1].$$eval('.nchip', (cs) => cs[2].click());
  await p.screenshot({ path: '/tmp/shots/am-tricks.png' });
  await p.click('#sheet-save');
  await p.screenshot({ path: '/tmp/shots/am-table.png' });
}

// C) Share between two devices, live update, offline queue, dashboard.
{
  const A = await mk();
  const B = await mk({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, locale: 'en-GB' });
  await A.p.goto(`${BASE}/`);
  await A.p.click('#new-session');
  await addPlayers(A.p, ['Kari', 'Ola', 'Per']);
  await A.p.click('#start');
  await A.p.click('#game-menu');
  await A.p.click('#m-share');
  await A.p.click('#do-share');
  await A.p.waitForSelector('.big-code');
  const code = await A.p.textContent('.big-code');
  await A.p.screenshot({ path: '/tmp/shots/share.png' });
  await A.p.click('#dlg [data-close]');
  await B.p.goto(`${BASE}/s/${code}?view=dashboard`);
  await B.p.waitForSelector('.board', { timeout: 15000 });
  // A enters bids; B's dashboard should show them.
  await A.p.click('#primary');
  for (const row of await A.p.$$('#sheet .entry')) await row.$$eval('.nchip', (cs) => cs[0].click());
  await A.p.click('#sheet-save');
  await B.p.waitForSelector('.board .pill', { timeout: 10000 });
  await A.p.click('#primary');
  const rows = await A.p.$$('#sheet .entry');
  for (let i = 0; i < rows.length; i++) await rows[i].$$eval('.nchip', (cs, v) => cs[v].click(), i === 0 ? 1 : 0);
  await A.p.click('#sheet-save');
  await B.p.waitForFunction(() => document.querySelector('.board .d-total')?.textContent === '10', null, { timeout: 10000 });
  await B.p.screenshot({ path: '/tmp/shots/dash.png' });
  // B offline: change queued, then delivered.
  await B.p.goto(B.p.url().replace('/dash', ''));
  await B.p.waitForSelector('.game-card');
  await B.p.click('.game-card');
  await B.ctx.setOffline(true);
  await B.p.waitForTimeout(500);
  await B.p.click('#primary');
  for (const row of await B.p.$$('#sheet .entry')) await row.$$eval('.nchip', (cs) => cs[1].click());
  await B.p.click('#sheet-save');
  const pendingCount = await B.p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('scorepad-session-v1-')).map((k) => JSON.parse(localStorage[k]).pending.length));
  console.log('B pending while offline', pendingCount);
  await B.ctx.setOffline(false);
  await A.p.waitForSelector('.pending-row', { timeout: 30000 });
  console.log('A got B\'s offline bids');
  await A.p.click('#game-menu');
  await A.p.click('#m-settings');
  await A.p.waitForTimeout(300);
  await A.p.screenshot({ path: '/tmp/shots/settings.png', fullPage: false });
  console.log('devices', await A.p.$$eval('.devices li', (l) => l.map((x) => x.textContent.trim().replace(/\s+/g, ' '))));
}
await b.close();
