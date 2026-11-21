// Online play in real browsers, against the REAL worker.ts and GameRoom code.
// Only the Cloudflare runtime itself is faked: Playwright intercepts /api/* and WebSocket
// connections and hands them to worker.fetch() / GameRoom.webSocketMessage() running in Node.
//   npm run build:web && npx tsx web/e2e/online.e2e.ts
import { CloudflareSim } from './cfsim.js';
import { chromium, check, eventually, startStatic, watchErrors } from './util.js';

const PORT = 8124;
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
  const anna = await player('anna');
  const ben = await player('ben');

  // ---------------------------------------------------------------- create & join
  console.log('creating and joining a 2-player live table');
  await anna.page.goto(base);
  await anna.page.fill('#name', 'Anna');
  await anna.page.selectOption('#figure', 'woman');
  await anna.page.click('#create');
  const code = (await anna.page.locator('#table-code').innerText()).trim();
  check(/^[A-Z0-9]{4}$/.test(code), `Anna gets a 4-character table code (${code})`);
  check(/Waiting for 1 more/.test(await anna.page.locator('#start').innerText()), 'host sees she must wait for another player');
  check(await anna.page.locator('#start').isDisabled(), 'Start is disabled until the table is full');

  await ben.page.goto(`${base}/?room=${code}`);
  check((await ben.page.inputValue('#code')) === code, 'the invite link pre-fills the table code');
  await ben.page.fill('#name', 'Ben');
  await ben.page.click('#join');
  await ben.page.locator('#table-code').waitFor();
  await eventually(() => ben.page.locator('.seat.taken .seat-name').allInnerTexts(), (t) => t.join() === 'Anna,Ben', 'Ben sees both players in the lobby');
  await eventually(() => anna.page.locator('.seat.taken .seat-name').allInnerTexts(), (t) => t.join() === 'Anna,Ben', 'Anna sees Ben arrive without refreshing');
  check((await ben.page.locator('#start').count()) === 0, 'only the host gets a Start button');
  await anna.page.screenshot({ path: `${SHOTS}/10-lobby.png` });

  // ---------------------------------------------------------------- play
  console.log('playing');
  await anna.page.click('#start');
  await anna.page.locator('#hand .card').first().waitFor();
  await ben.page.locator('#hand .card').first().waitFor();
  const count = (p: any) => p.locator('#hand .card').count();
  check((await count(anna.page)) === 15 && (await count(ben.page)) === 15, 'both players hold 15 cards');

  // Anna chose to appear as a woman: Ben's 3D table shows her that way (the first seat is a man by default).
  await ben.page.click('#enter-3d');
  await eventually(
    () => ben.page.evaluate(() => (window as any).__canasta3d?.figures() ?? []),
    (f: { seat: number; build: string; loaded: boolean }[]) => f.length === 1 && f[0]!.seat === 0 && f[0]!.build === 'woman' && f[0]!.loaded,
    "Ben's 3D table shows Anna as the woman she chose",
    15000,
  );
  await ben.page.click('#exit-3d');
  await ben.page.locator('#hand .card').first().waitFor();
  const labelsOf = (p: any) => p.locator('#hand .card').evaluateAll((els: Element[]) => els.map((e) => e.getAttribute('aria-label')));
  check(JSON.stringify(await labelsOf(anna.page)) !== JSON.stringify(await labelsOf(ben.page)), 'the two players hold different cards');

  check((await anna.page.locator('.pile-all').count()) === 0 && (await ben.page.locator('.pile-all').count()) === 0, 'a live table does not offer to look through the pile');
  const meOf = async (p: any) => Number(await p.locator('.chip.me').getAttribute('data-seat'));
  const turnSeat = async () => Number(await anna.page.locator('.chip.turn').getAttribute('data-seat'));
  const seatAnna = await meOf(anna.page);
  const mover = (await turnSeat()) === seatAnna ? anna : ben;
  const waiter = mover === anna ? ben : anna;
  check(await waiter.page.locator('#draw').isDisabled(), 'the player who is not on turn cannot draw');
  check(/is about to draw|is playing/.test(await waiter.page.locator('#hint').innerText()), 'the waiting player is told whose turn it is');

  await mover.page.click('#draw');
  await eventually(() => count(mover.page), (n) => n === 16, 'mover draws one card');
  await eventually(() => waiter.page.locator('.chip:not(.me) .muted').innerText(), (t) => t === '16 cards', 'the other player sees the new card count, but not the cards');
  await anna.page.screenshot({ path: `${SHOTS}/11-online-table.png`, fullPage: true });

  await mover.page.locator('#hand .card').first().click();
  await mover.page.click('#discard');
  await eventually(() => waiter.page.locator('#hint').innerText(), (t) => /^Your turn/.test(t), 'turn passes to the other player instantly');
  await eventually(() => waiter.page.locator('#pile .card').count(), (n) => n >= 1, 'the discard shows on the other screen');
  await eventually(() => count(mover.page), (n) => n === 15, 'mover is back to 15 cards');

  // ---------------------------------------------------------------- reconnect
  console.log('reconnecting');
  await ben.page.reload();
  await ben.page.locator('#hand .card').first().waitFor();
  check(JSON.stringify(await labelsOf(ben.page)).length > 20, 'Ben reloads the page and is dealt straight back in');
  const benSeatAfter = await meOf(ben.page);
  check(benSeatAfter !== seatAnna, 'Ben is still in his own seat after reloading');
  await eventually(() => anna.page.locator('.chip:not(.me) .dot.on').count(), (n) => n === 1, 'Anna sees Ben as online again');

  // ---------------------------------------------------------------- full / started tables
  console.log('late joiners');
  const carl = await player('carl');
  await carl.page.goto(`${base}/?room=${code}`);
  await carl.page.fill('#name', 'Carl');
  await carl.page.click('#join');
  await carl.page.locator('.form-error').waitFor();
  check(/already started/.test(await carl.page.locator('.form-error').innerText()), 'a stranger cannot join a game in progress');

  await carl.page.goto(`${base}/?room=ZZZZ`);
  await carl.page.fill('#name', 'Carl');
  await carl.page.click('#join');
  await carl.page.locator('.form-error').waitFor();
  check(/no table with the code ZZZZ/.test(await carl.page.locator('.form-error').innerText()), 'a wrong code gives a clear message');

  // ---------------------------------------------------------------- 4-player, turn-based
  console.log('4-player turn-based table');
  const host = await player('host');
  await host.page.goto(base);
  await host.page.fill('#name', 'Hanna');
  await host.page.selectOption('#players', '4');
  await host.page.selectOption('#mode', 'async');
  await host.page.click('#create');
  await host.page.locator('#table-code').waitFor();
  check((await host.page.locator('.seat').count()) === 4, 'four seats in the lobby');
  check((await host.page.locator('.seat .tag.team').count()) === 4, 'every seat shows its team');
  check(/Take-turns game/.test(await host.page.locator('.lobby').innerText()), 'the lobby explains take-turns play');
  await host.page.screenshot({ path: `${SHOTS}/12-lobby-4p-async.png` });

  // Carl deliberately typed a wrong code, so the server's 404 is expected (Chromium logs every
  // failed request as a console error). Anything else is a genuine problem.
  const unexpected = errors.filter((e) => !(e.startsWith('carl') && /status of 404/.test(e)));
  check(unexpected.length === 0, `no unexpected JavaScript errors anywhere (${unexpected.join('; ') || 'none'})`);
  console.log('\nPASS: online');
} catch (e) {
  console.error(String(e));
  console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
