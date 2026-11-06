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

## Checks

```
npm test            # 65 tests: rules engine, game room, Durable Object and Worker
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
- A time limit per turn, chat, accounts, computer players, and a spectator view.
- Final scores are shown but not stored beyond the table's 30-day life.
