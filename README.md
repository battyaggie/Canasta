# Canasta online

Canasta for **2 or 4 players**, playable **live** (everyone online at once) or **turn by turn**
(each player comes back whenever it is their turn), or on **one shared device** (pass & play).

- **Rules engine** (`engine/`): plain TypeScript, no dependencies. See `engine/RULES.md` for every rule decision.
- **Game room** (`server/room.ts`): seats, secret tokens, who may do what. Pure logic, fully tested.
- **Server** (`server/worker.ts`): a Cloudflare Worker plus one Durable Object per table.
- **Web app** (`web/`): no framework, no bundler; compiled by `tsc` into plain ES modules.

## Try it on your Mac in two minutes (pass & play, nothing to sign up for)

1. Install Node.js 20 or newer from <https://nodejs.org> (or `brew install node`).
2. In Terminal, in this folder:

   ```
   npm install
   npm run local
   ```
3. Open <http://localhost:8080> and press **Pass & play**.

Online tables need the Cloudflare server (next section); pass & play does not.

## Play against the computer

On the home screen, *Play against the computer* starts a game on this device with no internet needed:
**You against the computer** (2 players) or **You and a partner against two** (4 players, your computer partner sits opposite).
Choose *Normal* or *Easy*. The computer players follow the same house rules, see only what a player in their seat would see,
and pause about a second before each move so you can follow along. How they decide is in `engine/src/bot.ts`.

## On a phone (pass & play, even underground)

A phone cannot reach `npm run local` (that runs on your Mac), so put the app on the internet once (next sections).
Then, on the phone:

1. Open your game's address (`https://canasta.<your-name>.workers.dev`) **while you have signal**.
2. Add it to the Home Screen: iPhone Safari: Share, then *Add to Home Screen*. Android Chrome: menu, then *Install app*.
3. Open it from the Home Screen. Pass & play now works with no connection at all.

An unfinished pass & play game is saved on the phone. If the browser reloads the page, press **Resume** on the home screen.
When you deploy a new version, the phone fetches it the next time it opens the app with a connection.

## Run the online version on your Mac

```
npm run dev
```

This builds the web app and starts Cloudflare's local simulator (`wrangler dev`). It prints an address,
usually <http://localhost:8787>. Open it in two browser windows to play against yourself. No account needed.

## Put it on the internet

1. Create a free account at <https://dash.cloudflare.com/sign-up>.
2. `npx wrangler login` (opens your browser once).
3. `npm run deploy`

Wrangler prints your game's address (`https://canasta.<your-name>.workers.dev`). Share that with your
friends. Everything it uses is on Cloudflare's free plan at this scale.

### Automatic deploys from GitHub

The Cloudflare worker is connected to this repository (branch `main`). Every push to `main` is built and deployed by Cloudflare
(build command `npm run build:web`, deploy command `npx wrangler deploy`), so you do not need `npm run deploy` on your Mac any more.

## 3D table and Meta Quest 3

In a game, press **3D table** (top bar). You sit at a card table in a virtual room, with an avatar for every other
player. It works with a mouse or touch on any screen, and in a headset:

1. Open your game's **https** address in the Quest Browser (WebXR only runs on https, or on `localhost`).
2. Join or start a game as usual, press **3D table**, then **Enter VR**.
3. **Controllers:** point and pull the trigger. **Hands:** point and pinch, or touch a card in your hand with your fingertip.
   - Stock: draw. Pile: take it before you draw, discard onto it after you draw (select one card first).
   - Cards in your hand: select. The cloth in front of you: set the selected cards aside for a meld. **Lay down**: send them.
   - A meld of yours, then cards: add those cards to it.
4. **Recentre** puts the table in front of you again. **Leave headset view** goes back to the screen.

Everyone at an online table can choose their own view: one person in a headset, the others on phones with the normal app.
Other players' avatars act out their moves (reaching for the stock or pile, leaning in on their turn); they do not follow
real head or hand movement yet.

To try the headset against `npm run dev` on your Mac: connect the Quest by USB with developer mode on, run
`adb reverse tcp:8787 tcp:8787`, and open `http://localhost:8787` in the Quest Browser.

three.js (MIT licence) is copied into the build by `npm run build:web` and loaded through an import map in `index.html`,
so there is still no bundler.

## Voice chat

Everyone at an online table can talk to each other, from a phone, a computer or a headset. At a **live** table voice
starts by itself when you join: the browser asks once for the microphone, and that's it. The microphone button (lobby,
top bar, 3D table and in the headset) mutes and unmutes you; at a take-turns table it says **Join voice chat**. A small 🎤
next to a name means that player is in the voice chat, and the name lights up green while they talk.

The sound goes straight from browser to browser (WebRTC); the game server only passes on the short setup messages
(`voice` and `signal` in `shared/protocol.ts`) and never hears anything. The code is in `web/voice.ts`.

Most home and mobile networks let browsers reach each other directly. A few (some office, school and mobile networks)
don't; for those a TURN relay can pass the sound along. Cloudflare's TURN service is used automatically if you give the
Worker a TURN key (Cloudflare dashboard → Realtime → TURN, create a key, then
`npx wrangler secret put TURN_KEY_ID` and `npx wrangler secret put TURN_KEY_API_TOKEN`). Without a key the app uses
public STUN servers only.

## Checks

```
npm test            # 87 tests: rules engine, computer players, game room, Durable Object and Worker
npm run typecheck
```

Browser tests (optional; they need Playwright, which the app itself does not use):

```
npm i -D playwright && npx playwright install chromium
npm run build:web
npx tsx web/e2e/passplay.e2e.ts
npx tsx web/e2e/online.e2e.ts
npx tsx web/e2e/phone.e2e.ts      # four emulated phones, touch only
npx tsx web/e2e/offline.e2e.ts    # network switched off
npx tsx web/e2e/table3d.e2e.ts    # the 3D table with a mouse, 2 and 4 players
npm i -D iwer && npx tsx web/e2e/table3d-xr.e2e.ts   # the 3D table in an emulated Quest 3 (controller and hands)
npx tsx web/e2e/vscomputer.e2e.ts # you against computer players, 2 and 4 players
npx tsx web/e2e/voice.e2e.ts      # voice chat between 2 and 4 browsers with fake microphones
```

## What has and has not been tested

- **Tested:** all rules; the game room; the Durable Object and Worker classes run in Node with fake storage and sockets
  (including restoring a game after the object was evicted from memory); and the whole web app in a real Chromium,
  for pass & play (2 and 4 players), on emulated phones with touch, and with the network switched off and for online play between two browsers, where the
  real Worker and Durable Object code was connected to the pages.
- **Not tested:** real phones (iPhone Safari in particular behaves a little differently from the emulation), and the code on Cloudflare itself. In particular the few lines that accept a WebSocket upgrade and the
  `wrangler.jsonc` settings were written from Cloudflare's documentation and have not been run, so expect the first
  `npm run dev` to be where any small mistake shows up.

## Not built yet

- Phone or email alerts when it is your turn in a take-turns game (for now: keep your personal link).
- A time limit per turn, text chat, video, accounts, and a spectator view.
- Computer players at online tables (for now they play only on one device: *Play against the computer*).
- Final scores are shown but not stored beyond the table's 30-day life.
