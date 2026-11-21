// Voice chat in real browsers: two players at a live online table hear each other.
// Chromium's fake microphone plays a beeping tone, so we can check that sound really arrives.
// Uses the real worker.ts and GameRoom code, with the Cloudflare runtime faked (see cfsim.ts).
//   npm run build:web && npx tsx web/e2e/voice.e2e.ts
import { CloudflareSim } from './cfsim.js';
import { chromium, check, eventually, startStatic, watchErrors } from './util.js';

const PORT = 8126;
const SHOTS = process.env.SHOTS ?? '/tmp/canasta-shots';
const errors: string[] = [];

const sim = new CloudflareSim();
const server = await startStatic(PORT);
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });

async function player(label: string) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, permissions: ['microphone'] });
  await sim.attach(context);
  const page = await context.newPage();
  watchErrors(page, label, errors);
  return { context, page };
}

const debug = (p: any) => p.evaluate(() => (window as any).canastaVoice?.debug() ?? null);
/** Bytes of sound received from the other player so far. */
const received = (p: any) =>
  p.evaluate(async () => {
    const v = (window as any).canastaVoice;
    let bytes = 0;
    for (const peer of v?.peers?.values() ?? []) {
      const stats = await peer.pc.getStats();
      stats.forEach((r: any) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') bytes += r.bytesReceived ?? 0;
      });
    }
    return bytes;
  });
const connected = (d: any) => !!d && d.peers.length === 1 && d.peers[0].connection === 'connected' && d.peers[0].playing;

const anna = await player('anna');
const ben = await player('ben');
try {
  const base = `http://localhost:${PORT}`;

  console.log('two players join a live table');
  await anna.page.goto(base);
  await anna.page.fill('#name', 'Anna');
  await anna.page.click('#create');
  const code = (await anna.page.locator('#table-code').innerText()).trim();
  await ben.page.goto(`${base}/?room=${code}`);
  await ben.page.fill('#name', 'Ben');
  await ben.page.click('#join');
  await ben.page.locator('#table-code').waitFor();

  console.log('voice starts by itself');
  await eventually(() => anna.page.locator('#mic').innerText(), (t) => /Mic on/.test(t), 'Anna is in the voice chat without pressing anything');
  await eventually(() => ben.page.locator('#mic').innerText(), (t) => /Mic on/.test(t), 'Ben is in the voice chat without pressing anything');
  await eventually(() => anna.page.locator('.seat .tag.voice').count(), (n) => n === 2, 'the lobby shows both players with a microphone');
  await eventually(() => debug(anna.page), connected, 'Anna is connected to Ben and playing his sound', 10000);
  await eventually(() => debug(ben.page), connected, 'Ben is connected to Anna and playing her sound', 10000);
  const first = await received(ben.page);
  await eventually(() => received(ben.page), (b) => b > first + 2000, 'sound from Anna keeps arriving at Ben');
  await eventually(() => anna.page.locator('.seat.speaking').count(), (n) => n >= 1, 'a name lights up while that player is talking');
  await anna.page.screenshot({ path: `${SHOTS}/40-voice-lobby.png` });

  console.log('mute');
  await ben.page.click('#mic');
  check(/Muted/.test(await ben.page.locator('#mic').innerText()), 'tapping the button mutes Ben');
  check(await ben.page.evaluate(() => (window as any).canastaVoice.stream.getAudioTracks().every((t: any) => !t.enabled)), "Ben's microphone sends silence while muted");
  await ben.page.click('#mic');
  check(/Mic on/.test(await ben.page.locator('#mic').innerText()), 'tapping again unmutes');

  console.log('in the game');
  await anna.page.click('#start');
  await anna.page.locator('#hand .card').first().waitFor();
  check((await anna.page.locator('.topbar #mic').count()) === 1, 'the game screen has the microphone button');
  check((await anna.page.locator('.chip .tag.voice').count()) === 2, 'the player list shows who is in the voice chat');
  check(connected(await debug(anna.page)), 'starting the game does not interrupt the call');
  await anna.page.screenshot({ path: `${SHOTS}/41-voice-game.png` });

  console.log('3D table');
  await anna.page.click('#enter-3d');
  await anna.page.locator('#exit-3d').waitFor();
  check((await anna.page.locator('.three-controls #mic').count()) === 1, 'the 3D table has the microphone button too');
  check(connected(await debug(anna.page)), 'opening the 3D table does not interrupt the call');
  await anna.page.waitForTimeout(800);
  await anna.page.screenshot({ path: `${SHOTS}/42-voice-3d.png` });
  await anna.page.click('#exit-3d');

  console.log('reload');
  await ben.page.reload();
  await ben.page.locator('#hand .card').first().waitFor();
  await eventually(() => debug(ben.page), connected, 'after reloading, Ben is back in the call by himself', 10000);
  await eventually(() => debug(anna.page), connected, 'and Anna hears him again', 10000);
  const again = await received(anna.page);
  await eventually(() => received(anna.page), (b) => b > again + 2000, 'sound flows again after the reload');

  console.log('leaving');
  await ben.page.click('text=Leave');
  await eventually(() => debug(anna.page), (d) => !!d && d.peers.length === 0, 'when Ben leaves, Anna hangs up on him');

  console.log('4 players');
  const four = [await player('p1'), await player('p2'), await player('p3'), await player('p4')];
  await four[0]!.page.goto(base);
  await four[0]!.page.fill('#name', 'P1');
  await four[0]!.page.selectOption('#players', '4');
  await four[0]!.page.click('#create');
  const code4 = (await four[0]!.page.locator('#table-code').innerText()).trim();
  for (const [i, p] of four.slice(1).entries()) {
    await p.page.goto(`${base}/?room=${code4}`);
    await p.page.fill('#name', `P${i + 2}`);
    await p.page.click('#join');
    await p.page.locator('#table-code').waitFor();
  }
  for (const [i, p] of four.entries()) {
    await eventually(
      () => debug(p.page),
      (d) => !!d && d.peers.length === 3 && d.peers.every((x: any) => x.connection === 'connected' && x.playing),
      `player ${i + 1} hears all three others`,
      15000,
    );
  }

  console.log('a browser that only asks for the microphone after a tap');
  const eve = await player('eve');
  const dan = await player('dan');
  // Dan's first microphone request never answers (as when a headset holds the question back until a tap).
  await dan.context.addInitScript(() => {
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    let first = true;
    navigator.mediaDevices.getUserMedia = (c?: MediaStreamConstraints) => {
      if (first) {
        first = false;
        return new Promise(() => {});
      }
      return real(c);
    };
  });
  await eve.page.goto(base);
  await eve.page.fill('#name', 'Eve');
  await eve.page.click('#create');
  const code5 = (await eve.page.locator('#table-code').innerText()).trim();
  await dan.page.goto(`${base}/?room=${code5}`);
  await dan.page.fill('#name', 'Dan');
  await dan.page.click('#join');
  await eventually(() => dan.page.locator('#mic').innerText(), (t) => /Tap to turn on voice/.test(t), 'after a few seconds the button asks Dan to tap', 8000);
  await dan.page.click('#mic');
  await eventually(() => dan.page.locator('#mic').innerText(), (t) => /Mic on/.test(t), 'one tap and Dan is in the voice chat');
  await eventually(() => debug(eve.page), connected, 'Eve hears Dan', 10000);

  check(errors.length === 0, `no JavaScript errors (${errors.join('; ') || 'none'})`);
  console.log('\nPASS: voice');
} catch (e) {
  console.error(String(e));
  console.error(errors.join('\n'));
  for (const [n, p] of [['anna', anna], ['ben', ben]] as const) console.error(n, JSON.stringify(await debug(p.page).catch(() => null)), JSON.stringify(await p.page.evaluate(() => (window as any).canastaVoice?.session).catch(() => null)), '\n' + (await p.page.evaluate(() => (window as any).canastaVoice?.log.join('\n')).catch(() => '')));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
