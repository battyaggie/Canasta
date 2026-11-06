// Pass & play on emulated phones, using touch. Chromium engine with each phone's screen size and touch support.
//   npm run build:web && npx tsx web/e2e/phone.e2e.ts
import { chromium, devices, check, loadBuilt, startStatic, watchErrors } from './util.js';

const PORT = 8125;
const SHOTS = process.env.SHOTS ?? '/tmp/canasta-shots';
const errors: string[] = [];
const phones = ['iPhone SE', 'iPhone 13', 'Pixel 7', 'iPhone 13 landscape'] as const;

const server = await startStatic(PORT);
const browser = await chromium.launch();
try {
  for (const name of phones) {
    console.log(`\n${name}`);
    const { defaultBrowserType, ...device } = devices[name];
    const context = await browser.newContext(device);
    const page = await context.newPage();
    watchErrors(page, name, errors);
    const vh = page.viewportSize()!.height;
    const vw = page.viewportSize()!.width;
    const slug = name.replace(/\s+/g, '-').toLowerCase();

    await page.goto(`http://localhost:${PORT}/?seed=3`);
    await page.screenshot({ path: `${SHOTS}/p-${slug}-1-home.png`, fullPage: true });
    await page.tap('#local4');
    await page.screenshot({ path: `${SHOTS}/p-${slug}-2-cover.png` });
    await page.tap('#ready');
    await page.tap('#draw');
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check((await overflow()) <= 0, 'no sideways scrolling');

    // Selecting, and the controls staying reachable wherever the page is scrolled.
    const cards = page.locator('#hand .card');
    await cards.nth(0).tap();
    await cards.nth(1).tap();
    check((await page.locator('#hand .card.selected').count()) === 2, 'tapping selects cards');

    const inView = async (sel: string) => {
      const b = await page.locator(sel).first().boundingBox();
      return !!b && b.y >= -1 && b.y + b.height <= vh + 1 && b.x >= -1 && b.x + b.width <= vw + 1;
    };
    for (const where of ['top', 'bottom'] as const) {
      await page.evaluate((w) => window.scrollTo(0, w === 'top' ? 0 : document.body.scrollHeight), where);
      await page.waitForTimeout(100);
      check(await inView('#discard'), `Discard button is on screen with the page scrolled to the ${where}`);
      check(await inView('#hand .card >> nth=0'), `your hand is on screen with the page scrolled to the ${where}`);
      check(await inView('#hint'), `the instruction line is on screen with the page scrolled to the ${where}`);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${SHOTS}/p-${slug}-3-table.png` });

    // How much of the screen does the fixed bottom area take?
    const dock = await page.locator('.dock').boundingBox();
    check(!!dock && dock.height <= vh * (vh < 500 ? 0.6 : 0.55), `controls use at most ${vh < 500 ? 60 : 55}% of the screen height (${Math.round(dock?.height ?? 0)} of ${vh}px)`);

    // Tap targets.
    const small = await page.locator('.actions button, .topbar button').evaluateAll((els: Element[]) =>
      els.filter((e) => { const r = e.getBoundingClientRect(); return r.height < 40 || r.width < 40; }).map((e) => e.textContent));
    check(small.length === 0, `buttons are big enough to tap (${small.join(', ') || 'all ok'})`);
    const narrow = await page.locator('#hand .card').evaluateAll((els: Element[]) => {
      const out: number[] = [];
      els.forEach((e, i) => {
        const r = e.getBoundingClientRect();
        const next = els[i + 1]?.getBoundingClientRect();
        const visible = next && Math.abs(next.top - r.top) < 4 ? Math.min(r.width, next.left - r.left) : r.width;
        if (visible < 26) out.push(Math.round(visible));
      });
      return out;
    });
    check(narrow.length === 0, `every hand card shows at least 26px to tap (${narrow.length} too narrow)`);

    // A whole turn by touch only.
    await page.tap('#clear');
    await cards.nth(0).tap();
    await page.tap('#discard');
    await page.tap('#ready');
    check((await page.locator('#hand .card').count()) === 11, 'a full turn by touch hands over to the next player');
    check((await overflow()) <= 0, 'still no sideways scrolling');

    // The browser throws the page away (low memory, tab switch): the game must come back.
    await page.tap('#draw');
    const before = await page.locator('#hand .card').evaluateAll((els: Element[]) => els.map((e) => e.getAttribute('aria-label')).join('|'));
    await page.goto(`http://localhost:${PORT}/`);
    check((await page.locator('#resume').count()) === 1, 'after a reload the home page offers to resume the game');
    await page.screenshot({ path: `${SHOTS}/p-${slug}-4-resume.png`, fullPage: true });
    await page.tap('#resume');
    check((await page.locator('.card').count()) === 0, 'a resumed game starts on the cover screen, hands hidden');
    await page.tap('#ready');
    const after = await page.locator('#hand .card').evaluateAll((els: Element[]) => els.map((e) => e.getAttribute('aria-label')).join('|'));
    check(before === after, 'the same player, with the same hand, is back mid-turn');
    await page.tap('.topbar button:has-text("Leave")');
    check((await page.locator('#resume').count()) === 1, 'leaving keeps the game so it can be resumed');
    await page.tap('#discard-save');
    check((await page.locator('#resume').count()) === 0, 'the saved game can be thrown away');
    await context.close();
  }
  check(errors.length === 0, `no JavaScript errors (${errors.join('; ') || 'none'})`);
  console.log('\nPASS: phone');
} catch (e) {
  console.error(String(e));
  console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
