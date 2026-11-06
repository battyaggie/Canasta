// Pass & play in a real browser, for 2 and 4 players.
//   npm run build:web && npx tsx web/e2e/passplay.e2e.ts
import { chromium, check, eventually, loadBuilt, startStatic, watchErrors } from './util.js';

const PORT = 8123;
const SHOTS = process.env.SHOTS ?? '/tmp/canasta-shots';
const errors: string[] = [];

// Find a shuffle where the player who moves first is dealt at least three natural aces
// (3 x 20 = 60 points, enough for the 50-point first meld) and a wild card, so we can test melding by hand.
async function findSeed(): Promise<number> {
  const { Room, defaultDeps } = await loadBuilt('server/room.js');
  const { ALL_CARDS } = await loadBuilt('engine/src/index.js');
  for (let seed = 1; seed < 5000; seed++) {
    const room = Room.create('X', { players: 2, mode: 'live', targetScore: 5000 }, { ...defaultDeps, randomSeed: () => seed });
    room.join('a', undefined);
    room.join('b', undefined);
    room.start(0);
    const g = room.data.game;
    const aces = g.hands[g.turn.player].filter((id: number) => ALL_CARDS[id].rank === 'A');
    const wilds = g.hands[g.turn.player].filter((id: number) => ALL_CARDS[id].rank === '2' || ALL_CARDS[id].rank === 'JOKER');
    if (aces.length === 3 && wilds.length >= 2) return seed;
  }
  throw new Error('no suitable seed');
}

const server = await startStatic(PORT);
const browser = await chromium.launch();
try {
  const base = `http://localhost:${PORT}`;
  const seed = await findSeed();

  // ---------------------------------------------------------------- 2 players
  console.log('2-player pass & play');
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 800 } })).newPage();
  watchErrors(page, '2p', errors);
  await page.goto(`${base}/?seed=${seed}`);
  await page.screenshot({ path: `${SHOTS}/01-home.png`, fullPage: true });
  check((await page.title()) === 'Canasta', 'home page loads');

  await page.click('#local2');
  await page.locator('#ready').waitFor();
  check((await page.locator('.card').count()) === 0, 'cover screen shows no cards at all');
  await page.screenshot({ path: `${SHOTS}/02-cover.png` });
  await page.click('#ready');

  const handCount = () => page.locator('#hand .card').count();
  check((await handCount()) === 15, 'first player holds 15 cards');
  check(await page.locator('#take').isDisabled(), '"Take pile" is disabled before the side has a meld');
  check(await page.locator('#discard').isDisabled(), 'cannot discard before drawing');
  check(/Draw from the stock\.$/.test(await page.locator('#hint').innerText()), 'hint says to draw (no mention of the pile)');

  check((await page.locator('.pile-all').count()) === 1, 'pass & play offers "Look through the pile"');
  await page.click('#draw');
  await eventually(handCount, (n) => n === 16, 'drawing takes one card in the 2-player game');
  check(/first meld needs 50 points/.test(await page.locator('#hint').innerText()), 'hint explains the first-meld minimum');
  await page.screenshot({ path: `${SHOTS}/03-2p-table.png`, fullPage: true });

  // Error handling in the UI.
  await page.click('#discard');
  check(/exactly one card/.test(await page.locator('.toast').innerText()), 'discarding with nothing selected shows a helpful message');
  const labels: string[] = await page.locator('#hand .card').evaluateAll((els: Element[]) => els.map((e) => e.getAttribute('aria-label') ?? ''));
  const firstTwoDifferent = labels.map((l, i) => [l.split(' of ')[0], i] as const).filter(([rank], i, arr) => rank !== arr[0]![0]).slice(0, 1);
  await page.locator('#hand .card').nth(0).click();
  await page.locator('#hand .card').nth(firstTwoDifferent[0]![1]).click();
  await page.click('#stage');
  check(/one rank/.test(await page.locator('.toast').innerText()), 'mixing ranks in one meld is refused');
  await page.click('#clear');

  // A real meld: three aces for 60 points.
  const aces = page.locator('#hand .card[aria-label^="Ace of"]');
  for (let i = 0; i < 3; i++) await aces.nth(i).click();
  check((await page.locator('#hand .card.selected').count()) === 3, 'three aces selected');
  await page.click('#meld');
  await page.locator('.side:has(.score) .meld[data-rank="A"]').first().waitFor();
  const meldTitle = await page.locator('.meld[data-rank="A"] .meld-title').first().innerText();
  check(/A ×3/.test(meldTitle), `the aces appear as a meld on the table (${meldTitle.replace(/\n/g, ' ')})`);
  await eventually(handCount, (n) => n === 13, 'melded cards leave the hand');
  check(/Meld what you can/.test(await page.locator('#hint').innerText()), 'hint moves on after the first meld');
  await page.screenshot({ path: `${SHOTS}/04-after-meld.png`, fullPage: true });

  // Wild cards alone can be added to a meld that is already on the table, by tapping that meld.
  await page.locator('#hand .card[aria-label^="Joker"], #hand .card[aria-label^="2 of"]').first().click();
  await page.click('#meld');
  check(/tap that meld on the table, then press Meld/.test(await page.locator('.toast').innerText()), 'a wild card on its own cannot start a new meld, and the message says how to add it');
  await page.locator('.side:has(.score) .meld[data-rank="A"]').first().click();
  check((await page.locator('#staged').count()) === 1, 'tapping the meld sets the wild card aside for it');
  await page.click('#meld');
  await eventually(() => page.locator('.meld[data-rank="A"] .meld-title').first().innerText(), (t) => /A ×4/.test(t), 'tapping the aces adds the wild card to them');
  await eventually(handCount, (n) => n === 12, 'the wild card leaves the hand');

  // The quicker way: tap the meld, then tap a wild card, and it goes straight on.
  await page.locator('.side:has(.score) .meld[data-rank="A"]').first().click();
  check(/Adding to As/.test(await page.locator('#hint').innerText()), 'tapping a meld with nothing selected chooses it, and the hint says so');
  await page.locator('#hand .card[aria-label^="2 of"], #hand .card[aria-label^="Joker"]').first().click();
  await eventually(() => page.locator('.meld[data-rank="A"] .meld-title').first().innerText(), (t) => /A ×5/.test(t), 'a single tapped wild card is added to the chosen meld');
  check((await page.locator('.meld.target').count()) === 1, 'the meld stays chosen so more cards can be added');
  await page.click('#clear');
  check((await page.locator('.meld.target').count()) === 0, 'Clear stops adding to the meld');

  // Discard ends the turn and the device is passed on.
  await page.locator('#hand .card').first().click();
  await page.click('#discard');
  await page.locator('#ready').waitFor();
  check(/Pass the device to Player/.test(await page.locator('.cover-text').innerText()), 'cover screen names the next player');
  check((await page.locator('.card').count()) === 0, 'no cards are in the page while the device is being passed');
  await page.click('#ready');
  check((await handCount()) === 15, 'second player holds 15 cards');
  check(await page.locator('#take').isDisabled(), 'second player (no meld yet) also cannot take the pile');
  check((await page.locator('.meld[data-rank="A"]').count()) === 1, 'the first player’s aces are visible to everyone');

  // Play on quickly: draw, discard, pass, for many turns. Any exception ends up in `errors`.
  for (let turn = 0; turn < 24; turn++) {
    if (await page.locator('#next-hand').count()) break;
    if (await page.locator('#draw').isEnabled()) await page.click('#draw');
    await page.locator('#hand .card').first().click();
    await page.click('#discard');
    if (await page.locator('#ready').count()) await page.click('#ready');
  }
  check(errors.length === 0, 'no JavaScript errors across 24 more turns');

  // ---------------------------------------------------------------- 4 players
  console.log('4-player pass & play');
  const page4 = await (await browser.newContext({ viewport: { width: 1100, height: 800 } })).newPage();
  watchErrors(page4, '4p', errors);
  await page4.goto(base);
  await page4.click('#local4');
  await page4.click('#ready');
  check((await page4.locator('#hand .card').count()) === 11, 'each of 4 players holds 11 cards');
  check((await page4.locator('.chip').count()) === 4, 'four seats shown');
  check((await page4.locator('.chip .tag.team').count()) === 1, 'one seat is marked as your partner');
  await page4.click('#draw');
  await eventually(() => page4.locator('#hand .card').count(), (n) => n === 12, 'drawing takes one card in the 4-player game');
  await page4.screenshot({ path: `${SHOTS}/05-4p-table.png`, fullPage: true });
  await page4.locator('#hand .card').first().click();
  await page4.click('#discard');
  await page4.click('#ready');
  check((await page4.locator('#hand .card').count()) === 11, 'next player holds 11 cards');

  // ---------------------------------------------------------------- phone
  console.log('phone layout');
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
  watchErrors(phone, 'phone', errors);
  await phone.goto(base);
  await phone.screenshot({ path: `${SHOTS}/06-phone-home.png`, fullPage: true });
  await phone.click('#local4');
  await phone.click('#ready');
  await phone.click('#draw');
  await phone.screenshot({ path: `${SHOTS}/07-phone-table.png`, fullPage: true });
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, `no sideways scrolling on a phone (overflow ${overflow}px)`);

  check(errors.length === 0, `no JavaScript errors anywhere (${errors.join('; ') || 'none'})`);
  console.log('\nPASS: pass & play');
} catch (e) {
  console.error(String(e));
  console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
