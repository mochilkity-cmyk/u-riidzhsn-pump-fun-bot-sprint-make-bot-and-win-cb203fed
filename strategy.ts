// Dawn Patrol: an early-entry momentum bot for the pump.fun bonding-curve replay
// (agent-fun/replay/v2).
//
// Idea: most pump.fun coins die within minutes of launch, a few run hard, and the
// round-trip cost (1.25% curve fees each way plus a flat tx fee per order) means a
// trade needs a real move to pay. So this bot only buys coins in their first seconds
// of life, and only when the opening tape already shows genuine crowd buying —
// several distinct wallets buying, net SOL flowing in, no creator dump, no single
// whale dominating — then it gets out fast: a fixed take-profit, a tight stop, a
// trailing stop once the trade is working, a hard time limit, and an instant exit
// the moment the creator sells or a whale dumps. One buy per coin, ever: no
// revenge-trading a loser, no averaging down. Losers are small and quick; winners
// are left to run under the trailing stop.
//
// A pace guard keeps the run above the guardrails (a round trip of at least
// 0.01 SOL on each of at least 20 coins): if the coins traded so far lag the pace
// implied by elapsed block time, the entry filter relaxes a notch so the bot still
// covers enough coins. The relaxation is a pure function of the batches seen, so
// both graded executions decide identically.
//
// Deterministic by construction: no clock, no randomness, no I/O, iteration only
// over insertion-ordered maps fed by the batch stream. All money math is bigint;
// ratios are compared by cross-multiplication, never by float division.

import { BPS, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest / oldest age (slots since CreateEvent) at which a first buy may be decided. */
  minAge: number;
  maxAge: number;
  /** Lamports to spend on one coin (each buy is still capped at 1% of real SOL). */
  stakeLamports: bigint;
  /** Smallest buy worth paying the tx fee for; kept above the 0.01 SOL guardrail. */
  minBuyLamports: bigint;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: bigint;
  maxRealSol: bigint;
  /** Creator's own buys in the create slot: at most this (a dev holding a huge bag dumps). */
  maxDevBuy: bigint;
  /** Distinct non-creator buyers seen before entry: window. */
  minBuyers: number;
  maxBuyers: number;
  /** Lamports sold by others / lamports bought, at most, in bps. */
  maxSellRatioBps: bigint;
  /** Price now over the create price, in bps: window (don't chase an already-run coin). */
  minRunupBps: bigint;
  maxRunupBps: bigint;
  /** Recent-flow window (slots) and what it must show: net SOL in and distinct buyers. */
  flowWindow: number;
  minFlowLamports: bigint;
  minRecentBuyers: number;
  /** Exit when the position is worth this much over its cost, in bps. */
  tpBps: bigint;
  /** Exit when it is worth this much under its cost, in bps. */
  slBps: bigint;
  /** Trailing stop: once up at least trailArmBps, exit on a fall of trailBps from the peak. */
  trailArmBps: bigint;
  trailBps: bigint;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit at once when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when a single non-creator sell of at least this many lamports lands. */
  bigSellLamports: bigint;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Slippage allowed on buys and sells (bps): wide open so a fill is never refused. */
  buySlippageBps: number;
  sellSlippageBps: number;
  /** Most new entries decided in one reply. */
  maxEntriesPerBatch: number;
  /** Pace guard: target coins over windowSeconds of block time; relax when behind. */
  paceTargetCoins: number;
  paceWindowSeconds: number;
  /** Relaxed entry thresholds used while behind pace. */
  relaxedMaxAge: number;
  relaxedMaxBuyers: number;
  relaxedMinFlowLamports: bigint;
  relaxedMinRecentBuyers: number;
  relaxedMaxRunupBps: bigint;
  relaxedMinRealSol: bigint;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 1,
  maxAge: 10,
  stakeLamports: 100_000_000n,
  minBuyLamports: 12_000_000n,
  minRealSol: 3_000_000_000n,
  maxRealSol: 40_000_000_000n,
  maxDevBuy: 2_000_000_000n,
  minBuyers: 3,
  maxBuyers: 8,
  maxSellRatioBps: 4_000n,
  minRunupBps: -1_000n,
  maxRunupBps: 3_000n,
  flowWindow: 10,
  minFlowLamports: 50_000_000n,
  minRecentBuyers: 3,
  tpBps: 2_500n,
  slBps: 1_000n,
  trailArmBps: 1_000n,
  trailBps: 1_000n,
  maxHold: 120,
  exitOnDevSell: true,
  bigSellLamports: 500_000_000n,
  staleSlots: 600,
  buySlippageBps: 10_000,
  sellSlippageBps: 10_000,
  maxEntriesPerBatch: 4,
  paceTargetCoins: 30,
  paceWindowSeconds: 21_600,
  relaxedMaxAge: 40,
  relaxedMaxBuyers: 20,
  relaxedMinFlowLamports: 0n,
  relaxedMinRecentBuyers: 0,
  relaxedMaxRunupBps: 6_000n,
  relaxedMinRealSol: 100_000_000n,
};

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create-time reserves: the run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  devSold: boolean;
  bigSell: boolean;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  lastTradeSlot: number;
  /** Trades of the last flowWindow slots (older ones dropped as new ones come). */
  recent: Tick[];
  /** Never buy it again (entered, exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  /** Tx fees paid on this position's orders (buy fills), added to the cost basis. */
  txPaid: bigint;
  /** Best liquidation value seen (lamports), for the trailing stop. */
  best: bigint;
  devSoldAtOpen: boolean;
}

const FEE_BPS = 125n;

/** What selling `tokens` against (vq, vt) would pay after curve fees (95 + 30 bps). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): { onBatch(state: BotState, batch: Batch): OrderInput[] } {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  /** Mints with a filled buy: the coins counted toward the guardrail pace. */
  const traded = new Set<Pubkey>();
  let firstTime: number | null = null;
  let nowTime = 0;

  /** Behind pace when the coins traded so far lag the prorated target. */
  function relaxed(): boolean {
    if (firstTime === null) return false;
    const elapsed = Math.max(0, Math.min(p.paceWindowSeconds, nowTime - firstTime));
    const due = Math.ceil((p.paceTargetCoins * elapsed) / p.paceWindowSeconds);
    return traded.size < due;
  }

  /** Net lamports bought minus sold and the distinct buyers, over the last flowWindow slots. */
  function flow(c: Coin, slot: number): { net: bigint; buyers: number } {
    const from = slot - p.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.isBuy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else {
        net -= t.sol;
      }
    }
    return { net, buyers: buyers.size };
  }

  function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const po of state.pending.values()) {
      if (po.order.mint === mint && po.order.side === side) return true;
    }
    return false;
  }

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          devSold: false,
          bigSell: false,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          lastTradeSlot: e.slot,
          recent: [],
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          if (sol >= p.bigSellLamports) c.bigSell = true;
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      for (const e of batch.events) {
        if (e.block_time === null) continue;
        if (firstTime === null) firstTime = e.block_time;
        if (e.block_time > nowTime) nowTime = e.block_time;
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }

      // Fold the fills in: count traded coins, track tx fees on held positions, open
      // Held records on buy fills, drop records the harness closed for us.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        if (f.status === 'filled') {
          if (f.side === 'buy') {
            traded.add(f.mint);
            const h = held.get(f.mint);
            if (h === undefined) {
              held.set(f.mint, {
                openedSlot: f.slot,
                txPaid: BigInt(f.tx_fee_lamports),
                best: 0n,
                devSoldAtOpen: coins.get(f.mint)?.devSold ?? false,
              });
            } else {
              h.txPaid += BigInt(f.tx_fee_lamports);
            }
          } else {
            const h = held.get(f.mint);
            if (h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
          }
        }
      }
      for (const mint of [...selling]) if (!hasPending(state, mint, 'sell')) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) held.delete(mint);
      }
      const loose = relaxed();

      // Exits first: take profit, stop, trailing stop, time, stale, dev sell, whale dump.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n, devSoldAtOpen: c?.devSold ?? false };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = BigInt(pos.cost_lamports) + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + p.tpBps)) exit = true;
          if (value * BPS <= basis * (BPS - p.slBps)) exit = true;
          if (h.best * BPS >= basis * (BPS + p.trailArmBps) && value * BPS <= h.best * (BPS - p.trailBps)) exit = true;
        }
        if (state.slot - h.openedSlot >= p.maxHold) exit = true;
        if (c !== undefined) {
          if (p.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
          if (c.bigSell) exit = true;
          if (state.slot - c.lastTradeSlot >= p.staleSlots) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlippageBps });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries: one buy per coin, only in its first seconds, only when the opening
      // tape shows real crowd buying and no rug signals.
      let free = state.freeCashLamports();
      let open = state.committedPositionCount();
      let entered = 0;
      for (const c of coins.values()) {
        if (orders.length >= cap || entered >= p.maxEntriesPerBatch) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        const maxAge = loose ? p.relaxedMaxAge : p.maxAge;
        if (age > maxAge) {
          c.done = true;
          continue;
        }
        if (age < p.minAge) continue;
        if (open >= state.hello.caps.max_open_positions) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        const rq = curve.real_quote_reserves;
        const minRq = loose ? p.relaxedMinRealSol : p.minRealSol;
        if (rq < minRq || rq > p.maxRealSol) continue;
        if (c.devBuy > p.maxDevBuy) continue;
        if (c.devSold) {
          c.done = true;
          continue;
        }
        const maxBuyers = loose ? p.relaxedMaxBuyers : p.maxBuyers;
        if (c.buyers.size < p.minBuyers || c.buyers.size > maxBuyers) continue;
        if (c.bought > 0n && c.soldByOthers * BPS > c.bought * p.maxSellRatioBps) continue;
        // Run-up vs the create price, cross-multiplied: price now / price at create.
        const runup = (curve.virtual_quote_reserves * c.vt0 * BPS) / (curve.virtual_token_reserves * c.vq0) - BPS;
        const maxRunup = loose ? p.relaxedMaxRunupBps : p.maxRunupBps;
        if (runup > maxRunup || runup < p.minRunupBps) continue;
        const fl = flow(c, state.slot);
        const minFlow = loose ? p.relaxedMinFlowLamports : p.minFlowLamports;
        const minFlowBuyers = loose ? p.relaxedMinRecentBuyers : p.minRecentBuyers;
        if (fl.net < minFlow || fl.buyers < minFlowBuyers) continue;
        const capBuy = state.maxBuyLamports(c.mint);
        const amount = p.stakeLamports < capBuy ? p.stakeLamports : capBuy;
        if (amount < p.minBuyLamports) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        free -= amount + tx;
        open += 1;
        entered += 1;
        c.done = true;
      }
      return orders;
    },
  };
}
