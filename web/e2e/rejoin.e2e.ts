// Closing the page by mistake: the table code stays on screen during the game, and the start
// page offers "Rejoin your game", which puts you back in your own seat with your own cards.
//   npm run build:web && npx tsx web/e2e/rejoin.e2e.ts
import { CloudflareSim } from './cfsim.js';
import { chromium, check, eventually, startStatic, watchErrors } from './util.js';

const PORT = 8133;
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

  // ------------------------------------------------ both leave; days later both come back
  console.log('both players leave the unfinished game');
  await again.close();
  await mum.page.close();
  await eventually(async () => sim.rooms.get(code)!.state.getWebSockets().length, (n) => n === 0, 'nobody is left at the table');

  // A second, newer table on Mark's device: both games are offered, newest first.
  const m2 = await mark.context.newPage();
  watchErrors(m2, 'mark later', errors);
  await m2.goto(base);
  await m2.click('#create');
  const code2 = (await m2.locator('#table-code').innerText()).trim();
  await m2.goto(base);
  await eventually(() => m2.locator('.saved-game').count(), (n) => n === 2, 'Mark sees both of his unfinished games');
  await eventually(
    () => m2.locator(`.saved-game[data-code="${code}"]`).innerText(),
    (t) => /Your game with Mum/.test(t) && /Hand 1/.test(t) && /You 0, Mum 0/.test(t) && /last played/.test(t),
    'the game with Mum is described with names, hand and score',
  );
  check((await m2.locator('.saved-game').first().getAttribute('data-code')) === code2, 'the newest table comes first');
  await m2.screenshot({ path: `${SHOTS}/saved-games-home.png` });
  await m2.locator(`.saved-game[data-code="${code}"] .continue`).click();
  await m2.locator('#hand .card').first().waitFor();
  const handLater = await m2.locator('#hand .card').evaluateAll((els: Element[]) => els.map((e) => e.getAttribute('aria-label')).join());
  check(handLater === hand, 'Mark picks the game up again with the same cards');

  // Mum's phone has forgotten everything (new phone, or the browser cleared its memory).
  console.log("Mum's phone forgot the game");
  const mumNew = await player('mum new phone');
  await mumNew.page.goto(base);
  check((await mumNew.page.locator('#rejoin-panel').count()) === 0, 'a wiped phone has no saved games');
  await mumNew.page.fill('#code', code);
  await mumNew.page.click('#join');
  await mumNew.page.locator('#claim-panel').waitFor();
  check(await mumNew.page.locator('.claim-seat', { hasText: 'Mark' }).isDisabled(), 'Mark is at the table, so his seat cannot be taken');
  await mumNew.page.screenshot({ path: `${SHOTS}/which-player.png` });
  await mumNew.page.locator('.claim-seat', { hasText: 'Mum' }).click();
  await mumNew.page.locator('#hand .card').first().waitFor();
  check((await mumNew.page.locator('.chip.me').innerText()).includes('Mum'), 'Mum is back in her own seat');
  await eventually(() => m2.locator('.chip:not(.me) .dot.on').count(), (n) => n === 1, 'Mark sees Mum back online');
  // From now on her phone remembers the game again.
  await mumNew.page.goto(base);
  await eventually(() => mumNew.page.locator('.saved-game').innerText(), (t) => /Your game with Mark/.test(t), "Mum's phone offers the game again");

  // "Remove from list" removes the offer.
  await m2.goto(base);
  await eventually(() => m2.locator('.saved-game').count(), (n) => n === 2, 'both games listed');
  await m2.locator(`.saved-game[data-code="${code2}"] .forget`).click();
  check((await m2.locator('.saved-game').count()) === 1, '"Remove from list" removes that game only');

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
