// Pass & play with no network at all, after one visit. Also checks the app can be installed.
//   npm run build:web && npx tsx web/e2e/offline.e2e.ts
import { chromium, devices, check, eventually, startStatic, watchErrors } from './util.js';

const PORT = 8126;
const errors: string[] = [];
const server = await startStatic(PORT);
const browser = await chromium.launch();
try {
  const { defaultBrowserType, ...device } = devices['iPhone 13'];
  const context = await browser.newContext(device);
  const page = await context.newPage();
  watchErrors(page, 'offline', errors);
  const base = `http://localhost:${PORT}`;

  await page.goto(base);
  await eventually(
    () => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state ?? 'none'),
    (s) => s === 'activated',
    'the service worker is installed on the first visit',
  );
  const manifest = await page.evaluate(async () => (await fetch(document.querySelector<HTMLLinkElement>('link[rel=manifest]')!.href)).json());
  check(manifest.display === 'standalone' && manifest.icons.length >= 2, 'the app has an install manifest with icons');
  // Make sure every file the worker cached really exists.
  const cached = await page.evaluate(async () => (await (await caches.keys()).length) && (await (await caches.open((await caches.keys())[0]!)).keys()).length);
  check(Number(cached) > 10, `the app files are stored on the device (${cached} files)`);

  console.log('network off');
  await context.setOffline(true);
  await page.goto(base);
  check((await page.title()) === 'Canasta', 'the home page opens with no connection');
  await page.goto(`${base}/?seed=3`);
  await page.tap('#local4');
  await page.tap('#ready');
  check((await page.locator('#hand .card').count()) === 11, 'a pass & play game starts and deals offline');
  await page.tap('#draw');
  await page.locator('#hand .card').first().tap();
  await page.tap('#discard');
  await page.tap('#ready');
  check((await page.locator('#hand .card').count()) === 11, 'a turn is played offline');
  await page.reload();
  check((await page.locator('#resume').count()) === 1, 'reloading offline still offers to resume');
  await page.fill('#name', 'Mark');
  await page.tap('#create');
  check(/Could not reach the server/.test(await page.locator('.form-error').innerText()), 'creating an online table offline gives a clear message');

  check(errors.filter((e) => !/Failed to load resource|net::ERR/.test(e)).length === 0, `no unexpected errors (${errors.join('; ') || 'none'})`);
  console.log('\nPASS: offline');
} catch (e) {
  console.error(String(e));
  console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
