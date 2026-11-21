// Automatic updates: a new version reloads the start page by itself, but never interrupts a game.
//   npm run build:web && npx tsx web/e2e/update.e2e.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium, check, eventually, startStatic, watchErrors } from './util.js';

const PORT = 8127;
const SW = 'dist/public/sw.js';
const original = readFileSync(SW, 'utf8');
let version = 0;
/** Pretend a new version was deployed: the service worker file changes. */
const deploy = () => writeFileSync(SW, original.replace(/const BUILD = '([^']*)'/, (_, b) => `const BUILD = '${b}-v${++version}'`));

const errors: string[] = [];
const server = await startStatic(PORT);
const browser = await chromium.launch();
try {
  const page = await (await browser.newContext()).newPage();
  watchErrors(page, 'update', errors);
  const base = `http://localhost:${PORT}`;
  const controller = () => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? '').catch(() => '');
  const cacheName = () => page.evaluate(async () => (await caches.keys()).join(',')).catch(() => '');
  await page.goto(base);
  await eventually(controller, (u) => u.endsWith('/sw.js'), 'the first visit installs the app');
  await page.reload();
  await eventually(controller, (u) => u !== '', 'the page runs under the installed version');

  // On the start page: a new version reloads the page by itself.
  let loads = 0;
  page.on('load', () => loads++);
  deploy();
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());
  await eventually(async () => loads, (n) => n >= 1, 'on the start page, the new version loads by itself', 10000);
  await eventually(cacheName, (c) => c.endsWith('-v1'), 'and it is the new version that is stored');

  // During a game: only a note, the game carries on; going back to the start page loads it.
  await page.click('#local2');
  await page.click('#ready');
  const before = loads;
  deploy();
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());
  await eventually(() => page.locator('.update-note').count(), (n) => n === 1, 'during a game a note says a new version is ready', 10000);
  check(loads === before && (await page.locator('#hand .card').count()) === 15, 'the game is not interrupted');
  await page.locator('button', { hasText: 'Leave' }).first().click();
  await eventually(async () => loads, (n) => n > before, 'back at the start page, the new version loads', 10000);
  check((await page.locator('.update-note').count()) === 0, 'the note is gone after the update');

  check(errors.length === 0, `no JavaScript errors (${errors.join(' | ') || 'none'})`);
} finally {
  writeFileSync(SW, original);
  await browser.close();
  server.close();
}
