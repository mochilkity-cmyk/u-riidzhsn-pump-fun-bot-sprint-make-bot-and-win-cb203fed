// Dawn Patrol: an early-entry momentum bot for the pump.fun bonding-curve replay.
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the SDK
// shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
//
// Approach (see strategy.ts for the full reasoning):
//   - Buy only in a coin's first seconds of life (age 1-10 slots after its
//     CreateEvent), and only when the opening tape already shows genuine crowd
//     buying: at least 3 distinct wallets buying, net SOL flowing in over the
//     last 10 slots, the creator not selling, no whale dump, and the curve
//     holding at least 3 SOL of real reserves (tiny curves are fee traps).
//   - One buy per coin, sized by the harness's 1%-of-real-reserve cap (stake
//     0.1 SOL); never average down, never re-enter a coin.
//   - Get out fast: take profit +25%, stop -10%, a trailing stop once up +10%,
//     a 120-slot time limit, and an instant exit if the creator sells or a
//     single non-creator sell of 0.5 SOL or more lands. Losers are small and
//     quick; winners ride under the trailing stop.
//   - A pace guard keeps the run above the guardrails (a round trip of at least
//     0.01 SOL on each of at least 20 coins): if coins traded lag the pace
//     implied by elapsed block time, the entry filter relaxes a notch.
//   - Deterministic by construction: no clock, no randomness, no I/O; all money
//     math is bigint and ratios are compared by cross-multiplication.
//
// Dev-window validation (kit's local replay sim, part-00000 + full 24h):
//   part-00000: net -0.006 SOL, 35 coins, 12 wins / 35 trips, max drawdown 0.3%
//   full 24h:   net +0.026 SOL, 62 coins, 21 wins / 62 trips, max drawdown 0.4%
// The final window is fresh 6h data recorded after entries close, so no dev
// number promises a final rank — these are only the dev-window checks.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
