// Closing the page by mistake: the table code stays on screen during the game, and the start
// page offers "Rejoin your game", which puts you back in your own seat with your own cards.
//   npm run build:web && npx tsx web/e2e/rejoin.e2e.ts
import { CloudflareSim } from './cfsim.js';
import { chromium, check, eventually, startStatic, watchErrors } from './util.js';

const PORT = 8127;
const SHOTS = process.env.SHOTS ?? '/tmp/canasta-shots';
const errors: string[] = [];

const sim = new CloudflareSim();
const server = await startStatic(PORT);
const browser = await chromium.launch();

async function player(label: string) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  await sim.attach(context);
  const page = await context.newPage();
  watchErrors(page, label, errors);
  return { context, page };
}

try {
  const base = `http://localhost:${PORT}`;
  const mark = await player('mark');
  const mum = await player('mum');

  await mark.page.goto(base);
  check((await mark.page.locator('#rejoin').count()) === 0, 'a first visit offers no rejoin');
  await mark.page.fill('#name', 'Mark');
  await mark.page.click('#create');
  const code = (await mark.page.locator('#table-code').innerText()).trim();
  await mum.page.goto(`${base}/?room=${code}`);
  await mum.page.fill('#name', 'Mum');
  await mum.page.click('#join');
  await mum.page.locator('#table-code').waitFor();
  await eventually(() => mark.page.locator('#start').isEnabled(), (v) => v, 'the table fills');
  await mark.page.click('#start');
  await mark.page.locator('#hand .card').first().waitFor();
  await mum.page.locator('#hand .card').first().waitFor();

  check((await mark.page.locator('#room-code').innerText()).trim() === `Table ${code}`, 'the table code is shown during the game');
  check((await mum.page.locator('#room-code').isVisible()), 'the other player sees it too');
  const hand = await mark.page.locator('#hand .card').evaluateAll((els: Element[]) => els.map((e) => e.getAttribute('aria-label')).join());

  // Mark closes the page by mistake, then opens the plain address again.
  await mark.page.close();
  await eventually(() => mum.page.locator('.chip:not(.me) .dot.on').count(), (n) => n === 0, 'Mum sees Mark go offline');
  const again = await mark.context.newPage();
  watchErrors(again, 'mark again', errors);
  await again.goto(base);
  check((await again.locator('#rejoin-panel').innerText()).includes(code), 'the start page shows the table code of the last game');
  await again.screenshot({ path: `${SHOTS}/rejoin-home.png` });
  await again.click('#rejoin');
  await again.locator('#hand .card').first().waitFor();
  const handAgain = await again.locator('#hand .card').evaluateAll((els: Element[]) => els.map((e) => e.getAttribute('aria-label')).join());
  check(handAgain === hand, 'Mark is back in his own seat with the same cards');
  await eventually(() => mum.page.locator('.chip:not(.me) .dot.on').count(), (n) => n === 1, 'Mum sees Mark back online');

  // "Forget it" removes the offer.
  await again.goto(base);
  await again.locator('#forget-last').click();
  check((await again.locator('#rejoin').count()) === 0, '"Forget it" removes the offer');

  check(errors.length === 0, `no JavaScript errors (${errors.join('; ') || 'none'})`);
  console.log('\nPASS: rejoin');
} catch (e) {
  console.error(String(e));
  console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
