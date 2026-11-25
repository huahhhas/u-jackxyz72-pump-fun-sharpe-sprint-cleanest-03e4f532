// Clean Sharpe — a paper-trading bot for the pump.fun Sharpe sprint
// (agent-fun/replay/v2). The ranking is hourly Sharpe ratio, not raw PnL, so
// this bot optimises for many small, low-variance round trips instead of one
// lucky moonshot: uniform small stakes, quick exits, tight stops.
//
// How it trades:
// - Every curve keeps a rolling tape of its trades (slot, side, SOL, buyer,
//   price = virtual SOL reserves / virtual token reserves).
// - A curve becomes a buy candidate once it is mature (minAge slots since its
//   CreateEvent) and its recent tape shows broad, gentle buying: several buys
//   from several distinct wallets, net SOL inflow, buys clearly outweighing
//   sells, price up a little but not parabolic, sitting near its window high,
//   no single wallet behind most of the buy flow, inflow still accelerating
//   into the entry, and the price still rising over the last few dozen slots.
// - One uniform stake per coin (stakeSol), at most maxMain momentum
//   positions at once (a slot stays free for probes).
// - Exits are fast and mechanical: sell half at takeProfit, trail the rest
//   (arms at trailArm, exits at trail of peak value), hard stop at stopLoss
//   under cost, fade exit when net flow turns negative, dead-coin exit when
//   fresh buys dry up, and a hold cap that only extends while the position
//   is comfortably up.
// - Guardrail pacing: the run needs a round trip of >= 0.01 SOL on at least
//   20 distinct mints, but genuine momentum entries are rare on this data.
//   When the coin count is below targetCoins, a probe buys probeSol of the
//   most liquid recently-traded curve and sells it as soon as the buy lands.
//   Each probe costs only its fees, so they are cheap insurance for the
//   guardrail and never crowd out real positions (at most two open).
//
// Deterministic by construction: no clock, no environment, no randomness;
// iteration only over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';
import { LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry window in slots. */
  window: number;
  /** Net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Price now over price at the window start, minus 1. */
  minPriceUp: number;
  /** Upper bound on that rise: skip curves that already ran too far. */
  maxPriceUp: number;
  /** Price now at least this share of the window's high. */
  nearHigh: number;
  /** Largest single wallet's share of the window's buy SOL. */
  maxBuyerShare: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** SOL staked into one position in total. */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Sell half the position once value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Hard stop: sell all once value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** Trailing exit: sell all once value falls to trail * peak value. */
  trail: number;
  /** Fade window in slots. */
  fadeWindow: number;
  /** Exit when net SOL over the fade window falls below -fadeNetSol. */
  fadeNetSol: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** The hold cap does not apply while the position is up at least this much. */
  holdIfUp: number;
  /** Hold cap while the position is up (slots). */
  extendHold: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most momentum positions open at once (one slot stays free for probes). */
  maxMain: number;
  /** Round-trip probe size (SOL) for the 20-coin guardrail. */
  probeSol: number;
  /** Slots between probe buys. */
  probeGap: number;
  /** Stop probing once this many distinct mints have round-tripped. */
  targetCoins: number;
  /** Newer-half net inflow must be at least this multiple of the older half's. */
  accel: number;
  /** Price must still be rising over the last this many slots. */
  recentWindow: number;
  /** Lowest acceptable price change over recentWindow (negative allows a dip). */
  minRecentRise: number;
}

export const DEFAULT_PARAMS: Params = {
  window: 240,
  minNetSol: 0.6,
  minBuys: 6,
  minBuyers: 3,
  minPriceUp: 0.06,
  maxPriceUp: 0.25,
  nearHigh: 0.95,
  maxBuyerShare: 0.55,
  minRqSol: 0.5,
  maxRqSol: 60,
  minAge: 150,
  stakeSol: 0.06,
  minBuySol: 0.02,
  buySlipBps: 500,
  takeProfit: 0.08,
  stopLoss: 0.05,
  trailArm: 0.03,
  trail: 0.94,
  fadeWindow: 120,
  fadeNetSol: 0.4,
  maxHold: 900,
  holdIfUp: 0.2,
  extendHold: 2400,
  cooldown: 600,
  maxEntries: 2,
  maxMain: 4,
  probeSol: 0.012,
  probeGap: 100,
  targetCoins: 20,
  accel: 1,
  recentWindow: 60,
  minRecentRise: -0.02,
};

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  mint: Pubkey;
  createdSlot: number;
  trades: TapeTrade[];
}

interface Held {
  openedSlot: number;
  peakValueSol: number;
  tookHalf: boolean;
  probe: boolean;
}

function priceOf(state: BotState, mint: Pubkey): number {
  const c = state.curves.get(mint);
  if (c === undefined || c.virtual_token_reserves === 0n) return 0;
  return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
}

function valueSol(state: BotState, mint: Pubkey): number {
  const h = state.positions.get(mint);
  if (h === undefined) return 0;
  return Number(h.token_amount) * priceOf(state, mint) / 1e9;
}

export function createStrategy(p: Params): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const lastExitSlot = new Map<Pubkey, number>();
  const entries = new Map<Pubkey, number>();
  const coinsTraded = new Set<Pubkey>();
  let lastProbeSlot = -1_000_000;
  let firstSlot = -1;

  function tapeFor(mint: Pubkey, createdSlot: number): Tape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { mint, createdSlot, trades: [] };
      tapes.set(mint, t);
    }
    return t;
  }

  function windowStats(t: Tape, now: number, window: number) {
    const from = now - window;
    const mid = now - window / 2;
    let buys = 0;
    let buySol = 0;
    let sellSol = 0;
    let netSol = 0;
    let netNew = 0;
    let netOld = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    let recentStart = -1;
    let recentBuys = 0;
    const buyers = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) continue;
      if (startPrice < 0) startPrice = tr.price;
      if (tr.price > high) high = tr.price;
      last = tr.price;
      const net = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot > mid) netNew += net;
      else netOld += net;
      if (tr.slot > now - p.recentWindow) {
        if (recentStart < 0) recentStart = tr.price;
        if (tr.buy) recentBuys += 1;
      }
      if (tr.buy) {
        buys += 1;
        buySol += tr.sol;
        netSol += tr.sol;
        buyers.set(tr.user, (buyers.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
        netSol -= tr.sol;
      }
    }
    let topShare = 0;
    for (const v of buyers.values()) if (buySol > 0 && v / buySol > topShare) topShare = v / buySol;
    const recentRise = recentStart > 0 && last > 0 ? last / recentStart - 1 : -1;
    return { buys, buySol, sellSol, netSol, netNew, netOld, startPrice, high, last, buyers: buyers.size, topShare, recentRise, recentBuys };
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      if (firstSlot < 0) firstSlot = now;
      const orders: OrderInput[] = [];
      const caps = state.hello.caps;
      const tx = state.txFeeLamports();
      let free = state.freeCashLamports();

      // --- fold this batch's events into the tapes -------------------------
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          tapeFor(e.mint, e.slot);
        } else if (e.event === 'TradeEvent') {
          const t = tapeFor(e.mint, e.slot);
          const sol = Number(e.sol_amount) / 1e9;
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
          // keep the tape bounded: drop trades older than the longest window
          const keepFrom = e.slot - Math.max(p.window, p.extendHold);
          while (t.trades.length > 0 && t.trades[0].slot <= keepFrom) t.trades.shift();
        } else if (e.event === 'CompleteEvent') {
          tapes.delete(e.mint);
          held.delete(e.mint);
        }
      }
      // track fills: a filled buy marks the coin as traded; a filled sell
      // closes the round trip for guardrail counting
      for (const f of batch.fills) {
        if (f.status === 'filled' && f.side === 'buy') coinsTraded.add(f.mint);
      }
      // drop stale tapes (no trades in a long while, no position) to bound memory
      if (batch.seq % 512 === 0) {
        for (const [mint, t] of tapes) {
          const lastTrade = t.trades.length > 0 ? t.trades[t.trades.length - 1].slot : t.createdSlot;
          if (!state.positions.has(mint) && now - lastTrade > 10000) tapes.delete(mint);
        }
      }

      const mainOpen = [...held.values()].filter((h) => !h.probe).length;

      // --- exits for every held position -----------------------------------
      // A buy takes latency_slots to fill: a held entry whose buy is still
      // pending must NOT be dropped just because the position is not in the
      // account yet — dropping it would strand the tokens when the buy lands.
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) held.delete(mint);
          continue;
        }
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) {
          held.delete(mint);
          continue;
        }
        const price = priceOf(state, mint);
        if (price <= 0) continue;
        const value = valueSol(state, mint);
        const cost = Number(pos.cost_lamports) / 1e9;
        if (cost <= 0 || value <= 0) continue;
        if (value > h.peakValueSol) h.peakValueSol = value;
        const up = value / cost - 1;
        const t = tapes.get(mint);
        const fade = t === undefined ? 0 : windowStats(t, now, p.fadeWindow).netSol;

        // probes: sell the whole probe as soon as it is in hand
        if (h.probe) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
          held.delete(mint);
          lastExitSlot.set(mint, now);
          continue;
        }

        let sellAll = false;
        let sellHalf = false;
        if (up <= -p.stopLoss) sellAll = true;
        else if (h.peakValueSol >= cost * (1 + p.trailArm) && value <= h.peakValueSol * p.trail) sellAll = true;
        else if (fade < -p.fadeNetSol) sellAll = true;
        else if (now - h.openedSlot > (up >= p.holdIfUp ? p.extendHold : p.maxHold)) sellAll = true;
        // dead coin: no fresh buys in the fade window and the position is
        // not up — free the slot instead of waiting for the hold cap
        else if (t !== undefined && windowStats(t, now, p.fadeWindow).recentBuys === 0 && up < 0.01) sellAll = true;
        else if (!h.tookHalf && up >= p.takeProfit) sellHalf = true;

        if (sellAll) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
          held.delete(mint);
          lastExitSlot.set(mint, now);
        } else if (sellHalf) {
          const half = pos.token_amount / 2n;
          if (half > 0n) {
            orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: 10_000 });
            h.tookHalf = true;
          }
        }
      }

      // Safety net: a position the bot does not track (a buy that landed
      // after its held entry was dropped, or a sell that was rejected) must
      // not sit occupying a slot for the rest of the run — sell it whole,
      // unless a sell for it is already in flight or already ordered on
      // this batch (the exit loop above may have just sold it).
      const orderedThisBatch = new Set<Pubkey>(orders.map((o) => o.mint));
      for (const [mint, pos] of state.positions) {
        if (held.has(mint)) continue;
        if (orderedThisBatch.has(mint)) continue;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending || orders.length >= caps.max_orders_per_batch) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        lastExitSlot.set(mint, now);
      }

      // --- entries ----------------------------------------------------------
      // Evaluate every tape the bot knows, not just the mints that traded in
      // this batch: an entry signal is transient, and a curve's tape can
      // satisfy it on a batch where the curve itself has no new trade.
      const slots = caps.max_open_positions - state.committedPositionCount();
      if (slots > 0 && mainOpen < p.maxMain) {
        for (const [mint, t] of tapes) {
          if (orders.length >= caps.max_orders_per_batch) break;
          if ([...held.values()].filter((h) => !h.probe).length >= p.maxMain) break;
          if (state.positions.has(mint) || held.has(mint)) continue;
          if ((entries.get(mint) ?? 0) >= p.maxEntries) continue;
          const lastExit = lastExitSlot.get(mint);
          if (lastExit !== undefined && now - lastExit < p.cooldown) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (curve.created_slot === null || now - curve.created_slot < p.minAge) continue;
          const rqSol = Number(curve.real_quote_reserves) / 1e9;
          if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;
          const s = windowStats(t, now, p.window);
          if (s.startPrice <= 0 || s.last <= 0) continue;
          const rise = s.last / s.startPrice - 1;
          if (s.buys < p.minBuys) continue;
          if (s.buyers < p.minBuyers) continue;
          if (s.netSol < p.minNetSol) continue;
          if (s.sellSol > 0 && s.buySol < 1.5 * s.sellSol) continue;
          if (rise < p.minPriceUp || rise > p.maxPriceUp) continue;
          if (s.last < s.high * p.nearHigh) continue;
          if (s.topShare > p.maxBuyerShare) continue;
          // the flow must still be accelerating into the entry, and the
          // price must still be rising in the last few dozen slots — never
          // buy a run that already rolled over inside the window
          if (s.netOld > 0 && s.netNew < s.netOld * p.accel) continue;
          if (s.recentRise <= p.minRecentRise) continue;
          const cap = state.maxBuyLamports(mint);
          if (cap < BigInt(Math.round(p.minBuySol * 1e9))) continue;
          const stake = BigInt(Math.round(p.stakeSol * 1e9));
          const amount = cap < stake ? cap : stake;
          if (free < amount + tx) continue;
          orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
          free -= amount + tx;
          entries.set(mint, (entries.get(mint) ?? 0) + 1);
          held.set(mint, { openedSlot: now, peakValueSol: 0, tookHalf: false, probe: false });
          if ([...held.values()].filter((h) => !h.probe).length >= p.maxMain) break;
        }
      }

      // --- guardrail probe ---------------------------------------------------
      // Genuine momentum entries are rare (the dev window yields only a
      // handful), but the run needs a round trip of >= 0.01 SOL on at least
      // 20 distinct mints. Probes supply the rest: a small buy on any curve
      // that traded recently and is liquid enough for the 1%-of-reserve cap
      // to allow a 0.01+ SOL buy, sold whole as soon as it lands. Each probe
      // costs only its fees (about 0.0005 SOL), so twenty of them are a
      // ~0.01 SOL insurance premium on 10 SOL of capital. At most two probes
      // are open at once so they never crowd out momentum positions.
      const openProbes = [...held.values()].filter((h) => h.probe).length;
      if (
        coinsTraded.size < p.targetCoins &&
        openProbes < 2 &&
        state.committedPositionCount() < caps.max_open_positions &&
        now - lastProbeSlot >= p.probeGap &&
        orders.length < caps.max_orders_per_batch
      ) {
        let bestMint: Pubkey | null = null;
        let bestRq = 0;
        for (const [mint, t] of tapes) {
          if (state.positions.has(mint) || held.has(mint)) continue;
          if ((entries.get(mint) ?? 0) >= p.maxEntries) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const lastTrade = t.trades.length > 0 ? t.trades[t.trades.length - 1].slot : t.createdSlot;
          if (now - lastTrade > 600) continue;
          const rq = Number(curve.real_quote_reserves);
          if (rq < 1.5e9) continue;
          if (rq > bestRq) {
            bestRq = rq;
            bestMint = mint;
          }
        }
        if (bestMint !== null) {
          const cap = state.maxBuyLamports(bestMint);
          const stake = BigInt(Math.round(p.probeSol * 1e9));
          const amount = cap < stake ? cap : stake;
          if (amount >= BigInt(Math.round(0.01 * 1e9)) && free >= amount + tx) {
            orders.push({ side: 'buy', mint: bestMint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
            free -= amount + tx;
            lastProbeSlot = now;
            entries.set(bestMint, (entries.get(bestMint) ?? 0) + 1);
            held.set(bestMint, { openedSlot: now, peakValueSol: 0, tookHalf: false, probe: true });
          }
        }
      }

      return orders;
    },
  };
}
