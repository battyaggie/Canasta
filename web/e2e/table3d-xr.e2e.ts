// The 3D table inside an emulated Meta Quest 3 (Meta's IWER WebXR emulator), with a controller and with hands.
// Needs IWER, which the app does not use:  npm i -D iwer   then
//   npm run build:web && npx tsx web/e2e/table3d-xr.e2e.ts
import { createRequire } from 'node:module';
import { chromium, check, eventually, loadBuilt, startStatic, watchErrors } from './util.js';

const require = createRequire(import.meta.url);
const IWER_PATH = process.env.IWER_PATH ?? require.resolve('iwer/build/iwer.min.js');
const PORT = 8127;
const SHOTS = process.env.SHOTS ?? '/tmp/canasta-shots';
const errors: string[] = [];
const { ALL_CARDS } = await loadBuilt('engine/src/index.js');

const server = await startStatic(PORT);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  watchErrors(page, 'xr', errors);
  await page.addInitScript({ path: IWER_PATH });
  await page.addInitScript(() => {
    const IWER = (window as any).IWER;
    const device = new IWER.XRDevice(IWER.metaQuest3);
    device.installRuntime({ forceInstall: true });
    (window as any).__device = device;
  });
  await page.goto(`http://localhost:${PORT}/?seed=7&nosw`);
  await page.click('#local2');
  await page.click('#ready');
  await page.click('#enter-3d');
  await page.locator('#enter-vr').waitFor();
  check(true, 'an "Enter VR" button appears when the browser supports WebXR');
  await page.click('#enter-vr');
  await eventually(() => page.evaluate(() => (window as any).__canasta3d.presenting()), (x) => x === true, 'the headset view starts');
  await eventually(() => page.evaluate(() => (window as any).__canasta3d.names()), (n: string[]) => n.includes('button:recentre'), 'in the headset the table offers Recentre');

  const names = (): Promise<string[]> => page.evaluate(() => (window as any).__canasta3d.names());
  const hand = async () => (await names()).filter((n) => n.startsWith('card:')).map((n) => Number(n.slice(5)));

  /** Point an input (controller or hand) at a named thing from 25 cm away and squeeze/pinch. */
  async function pointAndSelect(name: string, input: 'controller' | 'hand'): Promise<void> {
    await page.waitForTimeout(150);
    const target = await page.evaluate((n: string) => (window as any).__canasta3d.world(n), name);
    if (!target) throw new Error(`nothing called ${name}`);
    const from = [target[0] + 0.05, target[1] + 0.2, target[2] + 0.2];
    const d = [target[0] - from[0]!, target[1] - from[1]!, target[2] - from[2]!];
    const len = Math.hypot(d[0]!, d[1]!, d[2]!);
    const b = d.map((x) => x / len);
    // Rotation taking -z onto b.
    const a = [0, 0, -1];
    const cross = [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
    const w = 1 + (a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!);
    const n = Math.hypot(cross[0]!, cross[1]!, cross[2]!, w);
    const q = [cross[0]! / n, cross[1]! / n, cross[2]! / n, w / n];
    await page.evaluate(
      ({ from, q, input }) => {
        const dev = (window as any).__device;
        const thing = input === 'hand' ? dev.hands.right : dev.controllers.right;
        thing.position.set(from[0], from[1], from[2]);
        thing.quaternion.set(q[0], q[1], q[2], q[3]);
      },
      { from, q, input },
    );
    await page.waitForTimeout(150);
    await page.evaluate((input) => {
      const dev = (window as any).__device;
      if (input === 'hand') dev.hands.right.updatePinchValue(1);
      else dev.controllers.right.updateButtonValue('trigger', 1);
    }, input);
    await page.waitForTimeout(150);
    await page.evaluate((input) => {
      const dev = (window as any).__device;
      if (input === 'hand') dev.hands.right.updatePinchValue(0);
      else dev.controllers.right.updateButtonValue('trigger', 0);
    }, input);
    await page.waitForTimeout(150);
  }

  const start = (await hand()).length;
  await pointAndSelect('stock', 'controller');
  await eventually(async () => (await hand()).length, (n) => n === start + 1, 'controller: pointing at the stock and pulling the trigger draws a card');

  const first = (await hand()).find((id) => ALL_CARDS[id].rank !== 'JOKER')!;
  await pointAndSelect(`card:${first}`, 'controller');
  await eventually(async () => (await names()).includes('button:clear'), (x) => x, 'controller: the trigger selects a card in the hand');
  await pointAndSelect('button:clear', 'controller');
  await eventually(async () => (await names()).includes('button:clear'), (x) => !x, 'controller: the Clear button works');

  await page.evaluate(() => ((window as any).__device.primaryInputMode = 'hand'));
  await page.waitForTimeout(300);
  await pointAndSelect(`card:${first}`, 'hand');
  await eventually(async () => (await names()).includes('button:clear'), (x) => x, 'hands: a pinch while pointing selects a card');
  await pointAndSelect('pile', 'hand');
  await eventually(async () => (await names()).includes('button:reveal'), (x) => x, 'hands: pinching at the pile discards and ends the turn');

  await page.screenshot({ path: `${SHOTS}/3d-xr-mirror.png` });
  await page.evaluate(() => (window as any).__device.primaryInputMode = 'controller');
  await page.waitForTimeout(300);
  await pointAndSelect('button:exit', 'controller');
  await eventually(() => page.evaluate(() => (window as any).__canasta3d.presenting()), (x) => x === false, '"Leave headset view" ends the session');

  check(errors.length === 0, `no JavaScript errors (${errors.join('; ') || 'none'})`);
  console.log('\nPASS: 3D table in an emulated Quest 3');
} finally {
  await browser.close();
  server.close();
}
