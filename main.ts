// Clean Sharpe — paper-trading bot for make.fun's "Pump.fun Sharpe Sprint —
// Cleanest Paper Bot Wins" bounty (agent-fun/replay/v2).
//
// The grader runs `node /bot/main.ts` with this directory mounted at /bot.
// The strategy lives in strategy.ts; the SDK shim is vendored byte for byte
// in vendor/makefun-bot.ts. Node 22 or later, no dependencies, no install.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
