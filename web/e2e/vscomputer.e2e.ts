// Playing against computer players in a real browser, for 2 and 4 players.
//   npm run build:web && npx tsx web/e2e/vscomputer.e2e.ts
import { chromium, check, eventually, startStatic, watchErrors } from './util.js';

const PORT = 8126;
const SHOTS = process.env.SHOTS ?? '/tmp/canasta-shots';
const errors: string[] = [];

const server = await startStatic(PORT);
const browser = await chromium.launch();
try {
  const base = `http://localhost:${PORT}`;
  for (const players of [2, 4] as const) {
    console.log(`${players} players against the computer`);
    const page = await (await browser.newContext({ viewport: { width: 1100, height: 800 } })).newPage();
    watchErrors(page, `${players}p`, errors);
    await page.goto(`${base}/?seed=11&botdelay=30`);
    await page.fill('#name', 'Mark').catch(() => {});
    await page.click(players === 2 ? '#vs2' : '#vs4');

    const handCount = () => page.locator('#hand .card').count();
    await eventually(handCount, (n) => n > 0, 'the table opens straight away, with no "pass the device" screen');
    check((await page.locator('#ready').count()) === 0, 'no cover screen');
    check((await page.locator('.tag', { hasText: 'vs computer' }).count()) === 1, 'the table is labelled "vs computer"');
    const chips = await page.locator('.chips .chip').allInnerTexts();
    check(chips.length === players, `${players} seats shown (${chips.map((t) => t.split('\n')[0]).join(', ')})`);
    if (players === 4) check(chips.some((t) => /Partner/.test(t)), 'a computer partner sits opposite');

    // Play ten of our own turns the simple way: draw, then discard the first card.
    // In between, the computer players must take their turns by themselves.
    const myTurn = async () => /^Your turn/.test(await page.locator('#hint').innerText().catch(() => ''));
    let turns = 0;
    let sawNote = false;
    for (; turns < 10; turns++) {
      const ok = await eventually(async () => (await myTurn()) || (await page.locator('#overlay-title').count()) > 0, Boolean, `turn ${turns + 1}: it comes back to us`, 15000);
      if (!ok || (await page.locator('#overlay-title').count()) > 0) break;
      await page.click('#draw');
      await page.locator('#hand .card').first().click();
      await page.click('#discard');
      const note = await page.locator('.toast').innerText({ timeout: 3000 }).catch(() => '');
      if (/Computer|Partner/.test(note)) sawNote = true;
    }
    check(turns >= 5, `played ${turns} turns against the computer`);
    check(sawNote, 'the screen says what the computer players did');
    await page.screenshot({ path: `${SHOTS}/vs-${players}p.png`, fullPage: true });

    if (players === 2) {
      await page.reload();
      await page.locator('#resume').waitFor();
      check((await page.locator('.panel h2', { hasText: 'Unfinished game against the computer' }).count()) === 1, 'an unfinished game can be resumed after a reload');
      await page.click('#resume');
      await eventually(handCount, (n) => n > 0, 'the resumed game shows our hand again');
      check((await page.locator('#ready').count()) === 0, 'still no cover screen after resuming');
    }
    await page.context().close();
  }
  if (errors.length) throw new Error(`Browser errors:\n${errors.join('\n')}`);
  console.log('vs computer: all browser checks passed');
} finally {
  await browser.close();
  server.close();
}
