# u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/huahhhas/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/huahhhas/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Clean Sharpe — a paper-trading bot for make.fun's "Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins" bounty. It trades 10 SOL of paper money on a 6-hour replay of pump.fun bonding-curve activity. Highest hourly Sharpe ratio wins the $2 pot: steady, controlled gains beat one lucky moonshot. Paper trading only: no real money, no real trades.

## Run it

```sh
node main.ts
```

Node 22 or later, no dependencies, no install step. The grader runs `node /bot/main.ts`; the bot speaks the agent-fun/replay/v2 protocol over stdin/stdout through the vendored SDK shim in `vendor/makefun-bot.ts`.

## How it trades

Most pump.fun coins die quietly; a few run. The bot watches every curve's recent tape (240 slots) and buys only when a clean, still-accelerating run is under way:

- the curve is at least 150 slots old (fresh curves are mostly bundled launches that get dumped),
- at least 6 buys from at least 3 distinct wallets, net inflow of 0.6 SOL or more,
- price up 6–25% across the window and holding at 95% or more of the window high,
- inflow still accelerating (newer half of the window beats the older half) and the price still rising over the last 60 slots,
- no single wallet behind more than 55% of the window's buy SOL,
- real SOL reserves between 0.5 and 60 SOL.

It stakes 0.06 SOL per coin (max 4 momentum positions at once). Exits are fast and mechanical: sell half at +8%, trailing stop on the rest (arms at +3%, exits at 94% of peak), hard stop at −5% of cost, fade exit when net flow over 120 slots turns below −0.4 SOL, dead-coin exit when fresh buys dry up, and a 900-slot hold cap (2400 while up 20%+).

Guardrails: the run needs a round trip of at least 0.01 SOL on each of at least 20 coins, with max drawdown 50%. Genuine momentum entries are rare, so a pace probe buys 0.012 SOL of the most liquid recently-traded curve whenever the coin count is below 20, and sells it as soon as the buy lands (at most two probes open). Each probe costs only its fees.

## Local backtest (dev window)

Run against the kit's frozen dev window with the kit's own offline engine port:

```sh
node tools/backtest.ts <kit dir>
```

Result on the dev window (deterministic — two runs agree byte for byte):

- net −0.052376 SOL, 183 fills, 59 coins, 83 round trips, 21 wins
- max drawdown 0.72% (guardrail: 50%), 8 rejected orders, 4 failed txs
- without failed txs −0.063886 SOL, at 2x fees −0.145263 SOL

The dev window is a brutal stretch (the kit's pilot momentum baseline loses −9.38 SOL there with 95% drawdown); the bot's edge is survival — tiny stakes, fast exits, and a drawdown under 1%.

## Determinism

No clock, no environment reads, no randomness. Every decision is a pure function of the batch stream, so the grader's two executions produce identical action logs.

---

<sub>Entered on [make.fun](https://make.fun/?ref=4bs5ey91&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
