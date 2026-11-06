# Canasta rules engine: decisions and open questions

A pure TypeScript engine for 2- and 4-player Canasta. No server, no UI, no
dependencies: it takes a game state plus one player's action and returns the new
state (or throws `IllegalMoveError`). The same engine can run in a Cloudflare
Durable Object, a Supabase edge function, a Node server, or a browser.

## Run it

```
npm test (from the app folder)
npm run typecheck   # tsc on src/
```

## What is implemented

| | 4 players (partnerships 0+2 vs 1+3) | 2 players (each alone) |
|---|---|---|
| Hand size | 11 | 15 |
| Draw from stock | 1 | 1 |
| Canastas needed to go out | 1 | 1 (Mark's house rule; the usual 2-player rule is 2) |

Shared: 108 cards; jokers and 2s wild; red 3s scored and replaced; black 3s block
the pile and may only be melded when going out; canasta = 7+ cards (natural 500,
mixed 300); initial-meld minimum by score band (15 / 50 / 90 / 120 / 150);
frozen-pile rules (the pile may only be taken once your side has a meld on the table); concealed going out (200 instead of 100); stock exhaustion;
scoring; first to the target score (default 5000) wins.

Players only ever see `viewFor(state, seat)`: other hands and the stock are
reduced to counts, so it is safe to send to a browser.

## Decisions I made (please confirm or change)

1. **The pile can only be taken once your side already has a meld on the table**
   (confirmed by Mark). The first meld must be made from the hand, so the pile
   can never be used to make it, and the question of whether the top card counts
   toward the initial minimum does not arise.
2. **Target score 5000** (some rule sets use 10,000). `targetScore` in the config.
3. **Wild cards cannot be added to a completed canasta** (7+ cards); naturals can.
4. **Red threes taken inside the discard pile** are laid down but not replaced
   (replacement happens only for red threes drawn from the stock).
5. **Dealt red threes** are laid down and replaced automatically at the deal.
6. **Opening upcard:** if it is wild or a three, it stays in the pile (freezing
   it) and cards are turned until a natural card is on top.
7. **Taking the pile is always optional** (confirmed by Mark), even when the top
   card matches one of your melds.
8. **Empty stock:** a draw attempt on an empty stock ends the hand. Because taking
   the pile is optional, there is no "must take the pile" rule on an empty stock.
9. **No "May I go out?" partner question** in the 4-player game; you may go out
   whenever the rules allow it.
10. **Going out with exactly one card and no canasta:** the discard is skipped
    (`skipDiscard`), as in the Britannica rules.
11. **Initial meld in several steps:** the minimum must be met within a single
    `meld` action. A concealed going-out waives the minimum.
12. **Looking through the discard pile** (confirmed by Mark): at a live online table only the
    top card is visible, as at a real table, and the server does not send the cards beneath it.
    Take-turns tables and pass & play may look through the whole pile, because remembering it
    over days or on a shared screen is hard. (Assumed: take-turns online games count as
    "not at the same time". Easy to change in `Room.viewFor` and `canLookThrough` in `web/app.ts`.)
13. **Frozen pile (house rule, Mark):** a pile frozen by a wild card can still be taken when its top
   card matches a meld the side already has; freezing only means wild cards may not be used to take
   it. With no such meld, a frozen pile needs two natural cards of the top rank from the hand.

## Testing notes

- Rules tests cover dealing, meld validity, frozen and unfrozen pile pickup,
  initial-meld minimums, red threes, going out (one canasta), concealed
  going out, scoring, and game end.
- 40 random-bot games per player count check that all 108 cards are always
  accounted for after every move and that games always finish.
- I could not install vitest because the package registry is blocked in this
  environment, so the tests use Node's built-in runner through `tsx`.

## Not built yet

Turn timers and reconnection, bots, accounts and lobby, the web interface, and the
server that holds each game. Those depend on the hosting choice.
