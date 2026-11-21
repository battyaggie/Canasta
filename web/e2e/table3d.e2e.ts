// The 3D table on a normal screen (mouse clicks), in pass & play. WebXR itself needs a headset.
//   npm run build:web && npx tsx web/e2e/table3d.e2e.ts
import { chromium, check, eventually, loadBuilt, startStatic, watchErrors } from './util.js';

const PORT = 8126;
const SHOTS = process.env.SHOTS ?? '/tmp/canasta-shots';
const errors: string[] = [];

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
    if (aces.length === 3) return seed;
  }
  throw new Error('no suitable seed');
}

const { ALL_CARDS } = await loadBuilt('engine/src/index.js');
const server = await startStatic(PORT);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const seed = await findSeed();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  watchErrors(page, '3d', errors);
  await page.goto(`http://localhost:${PORT}/?seed=${seed}&nosw`);
  await page.click('#local2');
  await page.click('#ready');
  await page.click('#enter-3d');
  await page.waitForFunction(() => (window as any).__canasta3d?.names().some((n: string) => n.startsWith('card:')));
  const names = (): Promise<string[]> => page.evaluate(() => (window as any).__canasta3d.names());
  const hand = async () => (await names()).filter((n) => n.startsWith('card:')).map((n) => Number(n.slice(5)));
  const click = async (name: string) => {
    const p = await page.evaluate((n: string) => (window as any).__canasta3d.point(n), name);
    if (!p) throw new Error(`nothing called ${name} on the table`);
    await page.mouse.click(p.x, p.y);
  };

  check((await hand()).length === 15, 'the 3D table shows 15 cards in my hand');
  check((await names()).includes('stock') && (await names()).includes('pile'), 'stock and discard pile are on the table');
  await page.screenshot({ path: `${SHOTS}/3d-01-start.png` });

  await click('stock');
  await eventually(async () => (await hand()).length, (n) => n === 16, 'clicking the stock draws a card');
  check((await names()).filter((n) => n.startsWith('new:')).length === 1, 'the card just drawn is marked as new');

  const aces = (await hand()).filter((id) => ALL_CARDS[id].rank === 'A').slice(0, 3);
  for (const id of aces) await click(`card:${id}`);
  check((await names()).includes('button:layDown'), 'selecting cards offers "Lay down"');
  await page.screenshot({ path: `${SHOTS}/3d-02-selected.png` });
  await click('cloth');
  await eventually(async () => (await hand()).length, (n) => n === 13, 'clicking the cloth sets the aces aside for a meld');
  await page.screenshot({ path: `${SHOTS}/3d-03-staged.png` });
  await click('button:layDown');
  await eventually(async () => (await names()).includes('meld:mine:A'), (x) => x, 'the aces are laid down as a meld');
  await page.screenshot({ path: `${SHOTS}/3d-04-melded.png` });

  const [discard] = await hand();
  await click(`card:${discard}`);
  await click('pile');
  await eventually(async () => (await names()).includes('button:reveal'), (x) => x, 'discarding ends the turn and hides the cards for the next player');
  await page.screenshot({ path: `${SHOTS}/3d-05-cover.png` });
  await click('button:reveal');
  await eventually(async () => (await hand()).length, (n) => n === 15, 'the second player sees their 15 cards');
  await page.screenshot({ path: `${SHOTS}/3d-06-player2.png` });

  await click('pile');
  await eventually(() => page.locator('.toast').innerText().catch(() => ''), (t) => /meld/i.test(t), 'taking the pile without a meld explains why not');

  await page.click('#exit-3d');
  await page.locator('#hand').waitFor();
  check((await page.locator('#hand .card').count()) === 15, '"2D view" returns to the normal table');

  // Dragging: pick two aces, drag the third onto the cloth: all three are laid down as a meld.
  const pageD = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  watchErrors(pageD, '3d-drag', errors);
  await pageD.goto(`http://localhost:${PORT}/?seed=${seed}&nosw`);
  await pageD.click('#local2');
  await pageD.click('#ready');
  await pageD.click('#enter-3d');
  await pageD.waitForFunction(() => (window as any).__canasta3d?.names().some((n: string) => n.startsWith('card:')));
  const namesD = (): Promise<string[]> => pageD.evaluate(() => (window as any).__canasta3d.names());
  const handD = async () => (await namesD()).filter((n) => n.startsWith('card:')).map((n) => Number(n.slice(5)));
  const pointD = async (name: string) => {
    const p = await pageD.evaluate((n: string) => (window as any).__canasta3d.point(n), name);
    if (!p) throw new Error(`nothing called ${name} on the table`);
    return p as { x: number; y: number };
  };
  const drag = async (from: string, to: string, shot?: string) => {
    const a = await pointD(from);
    const b = await pointD(to);
    await pageD.mouse.move(a.x, a.y);
    await pageD.mouse.down();
    for (let i = 1; i <= 8; i++) await pageD.mouse.move(a.x + ((b.x - a.x) * i) / 8, a.y + ((b.y - a.y) * i) / 8);
    if (shot) await pageD.screenshot({ path: shot });
    check((await pageD.evaluate(([x, y]) => (window as any).__canasta3d.at(x, y), [b.x, b.y])) === to, `while carrying, the ${to} is under the pointer`);
    check((await namesD()).includes('carry'), `dragging ${from} carries it`);
    await pageD.mouse.up();
  };
  await pageD.mouse.click((await pointD('stock')).x, (await pointD('stock')).y);
  await eventually(async () => (await handD()).length, (n) => n === 16, 'drag test: drew a card');
  const acesD = (await handD()).filter((id) => ALL_CARDS[id].rank === 'A').slice(0, 3);
  for (const id of acesD.slice(0, 2)) {
    const p = await pointD(`card:${id}`);
    await pageD.mouse.click(p.x, p.y);
  }
  await drag(`card:${acesD[2]}`, 'cloth', `${SHOTS}/3d-07-dragging.png`);
  await eventually(async () => (await namesD()).includes('meld:mine:A'), (x) => x, 'dragging the third ace onto the cloth lays down all three aces');
  check(!(await namesD()).includes('carry'), 'the carried cards are gone once laid down');
  const [lastD] = await handD();
  await drag(`card:${lastD}`, 'pile');
  await eventually(async () => (await namesD()).includes('button:reveal'), (x) => x, 'dragging a card onto the pile discards it');

  // Four players: three avatars round the table.
  const page4 = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  watchErrors(page4, '3d-4p', errors);
  await page4.goto(`http://localhost:${PORT}/?seed=${seed}&nosw`);
  await page4.click('#local4');
  await page4.click('#ready');
  await page4.click('#enter-3d');
  await page4.waitForFunction(() => (window as any).__canasta3d?.names().some((n: string) => n.startsWith('card:')));
  const cards4 = (await page4.evaluate(() => (window as any).__canasta3d.names())).filter((n: string) => n.startsWith('card:')).length;
  check(cards4 === 11, 'four players: 11 cards in my hand on the 3D table');
  await page4.waitForTimeout(500);
  await page4.screenshot({ path: `${SHOTS}/3d-07-four-players.png` });

  check(errors.length === 0, `no JavaScript errors (${errors.join('; ') || 'none'})`);
  console.log('\nPASS: 3D table');
} finally {
  await browser.close();
  server.close();
}
