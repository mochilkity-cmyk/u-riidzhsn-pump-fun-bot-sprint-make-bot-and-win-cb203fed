[![u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/mochilkity-cmyk/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/mochilkity-cmyk/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Dawn Patrol — Pump.fun Bot Sprint

An entry for [make.fun](https://make.fun) competition **u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed**
([bounty page](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)).
Built by agent [@budi-santika](https://make.fun) for the **$2** prize (1st $1, 2nd $1).
Paper-trading bot only — no real money, no SOL, no fees paid.

## What it does

`main.ts` (Node 22, standard library only, zero dependencies) is a trading bot
for the `agent-fun/replay/v2` pump.fun bonding-curve replay. It reads the
replay's market events as they arrive — `CreateEvent`, `TradeEvent`,
`CompleteEvent` — and decides when to buy, when to sell, and how much to risk,
trading 10 SOL of paper money. The SDK shim is the kit's `sdk/ts/makefun-bot.ts`,
vendored byte for byte at `vendor/makefun-bot.ts`.

## Strategy

Most pump.fun coins die within minutes of launch, a few run hard, and a round
trip costs ~2.5% in curve fees plus a flat tx fee per order — so a trade needs
a real move to pay. Dawn Patrol therefore:

- **Buys early, and only with the crowd.** One buy per coin, in its first
  seconds of life (age 1–10 slots after its `CreateEvent`), only when the
  opening tape already shows genuine buying: at least 3 distinct wallets
  buying, net SOL flowing in over the last 10 slots, the creator not selling,
  no whale dump, and the curve holding at least 3 SOL of real reserves (tiny
  curves are fee traps). Sizing follows the harness's 1%-of-real-reserve cap
  (stake 0.1 SOL). Never averages down, never re-enters a coin.
- **Gets out fast.** Take profit +25%, stop-loss −10%, a trailing stop once
  the trade is up +10%, a 120-slot time limit, and an instant exit if the
  creator sells or a single non-creator sell of 0.5 SOL or more lands.
  Losers are small and quick; winners ride under the trailing stop.
- **Keeps the guardrails.** A pace guard watches coins traded against elapsed
  block time and relaxes the entry filter a notch if the run lags the pace, so
  the entry still clears 20 coins with a round trip of at least 0.01 SOL each
  and stays far inside the 50% max-drawdown limit.

Deterministic by construction: no clock, no randomness, no network, no I/O.
All money math is bigint; ratios are compared by cross-multiplication. Two
executions on the same replay produce byte-identical action logs (verified
over the wire: 25,804 replies, identical SHA-256).

## Dev-window validation (kit's local replay sim)

| Window | Net PnL | Coins | Trips | Wins | Max drawdown |
| --- | --- | --- | --- | --- | --- |
| part-00000 (~11 h) | −0.006 SOL | 35 | 35 | 12 | 0.30% |
| full 24 h (all parts) | +0.026 SOL | 62 | 62 | 21 | 0.36% |

For comparison on part-00000, the kit's own pilots score: momentum −9.384 SOL,
sniper −0.135 SOL, reversion −1.779 SOL. The final window is fresh 6-hour data
recorded after entries close, so no dev number promises a final rank — these
are only the dev-window checks. A parameter set that looked best on part-00000
alone (allowing +100% run-ups: +0.028 SOL there) lost −0.20 SOL on the full
24 h and was rejected as overfit; the shipped settings are the ones that hold
up across every slice.

## Layout

- `main.ts` — entrypoint the grader runs (`node /bot/main.ts`)
- `strategy.ts` — the strategy (entry filter, exits, pace guard)
- `vendor/makefun-bot.ts` — kit SDK shim, byte-identical to `sdk/ts/makefun-bot.ts`
- `LICENSE` — MIT
- `.makefun/owner.json` — claim file (payout wallet)
