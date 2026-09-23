import "dotenv/config";

const num = (
  k,
  d
) =>
  Number.isFinite(
    Number(
      process.env[k]
    )
  )
    ? Number(
        process.env[k]
      )
    : d;

const bool = (
  k,
  d = false
) =>
  process.env[k] == null
    ? d
    : /^(1|true|yes)$/i.test(
        process.env[k]
      );

export const config = {
  rpcUrls:
    (process.env.SOLANA_RPC_URLS || process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),

  rpcMaxAttempts:
    Math.max(2, Math.min(8, num("RPC_MAX_ATTEMPTS", 4))),

  rpcRequestGapMs:
    Math.max(0, num("RPC_REQUEST_GAP_MS", 75)),

  autoCloseTokenAccounts:
    bool("AUTO_CLOSE_TOKEN_ACCOUNTS", true),

  rpcUrl:
    (process.env.SOLANA_RPC_URLS || process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com")
      .split(",")[0]
      .trim(),

  host:
    process.env.DASHBOARD_HOST || "0.0.0.0",

  port:
    num(
      "DASHBOARD_PORT",
      8787
    ),

  pollMs:
    Math.max(
      3000,
      num(
        "DATA_POLL_MS",
        7000
      )
    ),

  dashboardPollMs:
    Math.max(
      250,
      num(
        "DASHBOARD_POLL_MS",
        500
      )
    ),

  live:
    bool(
      "LIVE_TRADING",
      false
    ),

  privateKeyJson:
    process.env.PRIVATE_KEY ||
    "",

  discoveryUrl:
    process.env.PUMP_DISCOVERY_URL ||
    "https://frontend-api-v3.pump.fun/coins?offset=0&limit=100&sort=last_trade_timestamp&searchTerm=&order=DESC&includeNsfw=false&creator=&complete=false&meta=true",

  detailUrl:
    process.env.PUMP_DETAIL_URL ||
    "https://frontend-api-v3.pump.fun/coins-v2",

  pumpApiToken:
    process.env.PUMP_API_TOKEN ||
    "",

  discoveryLimit:
    Math.max(
      10,
      Math.min(
        100,
        num(
          "DISCOVERY_LIMIT",
          100
        )
      )
    ),

  candidateLimit:
    Math.max(
      5,
      Math.min(
        20,
        num(
          "CANDIDATE_LIMIT",
          5
        )
      )
    ),

  discoveryPages:
    Math.max(
      1,
      Math.min(
        20,
        num(
          "DISCOVERY_PAGES",
          5
        )
      )
    ),

  maxIdleSec:
    Math.max(
      10,
      num(
        "MAX_IDLE_SEC",
        120
      )
    ),

  flowEnabled:
    bool(
      "FLOW_ENABLED",
      true
    ),

  flowWsUrls:
    (
      process.env.PUMP_WS_URLS ||
      "wss://pumpdev.io/ws,wss://pumpportal.fun/api/data"
    )
      .split(",")
      .map(
        s =>
          s.trim()
      )
      .filter(Boolean),

  pumpPortalApiKey:
    process.env.PUMPPORTAL_API_KEY ||
    "",

  pumpDevApiKey:
    process.env.PUMPDEV_API_KEY ||
    "",

  flowSubscribeMax:
    Math.max(
      5,
      Math.min(
        100,
        num(
          "FLOW_SUBSCRIBE_MAX",
          5
        )
      )
    ),

  flowRefreshMs:
    Math.max(
      1000,
      num(
        "FLOW_REFRESH_MS",
        3000
      )
    ),

  flowLookbackSec:
    num(
      "FLOW_LOOKBACK_SEC",
      60
    ),

  flowRejectCooldownMs:
    Math.max(
      1000,
      num(
        "FLOW_REJECT_COOLDOWN_MS",
        5000
      )
    ),

  flowHttpFallback:
    bool(
      "FLOW_HTTP_FALLBACK",
      true
    ),

  flowHttpRefreshMs:
    Math.max(
      7000,
      num(
        "FLOW_HTTP_REFRESH_MS",
        8000
      )
    ),

  positionRefreshMs:
    Math.max(
      250,
      num(
        "POSITION_REFRESH_MS",
        500
      )
    ),

  executableExitQuote:
    bool(
      "EXECUTABLE_EXIT_QUOTE",
      true
    ),

  executableExitQuoteRefreshMs:
    Math.max(
      1000,
      num(
        "EXECUTABLE_EXIT_QUOTE_REFRESH_MS",
        2000
      )
    ),

  profitLockEnabled:
    bool(
      "PROFIT_LOCK_ENABLED",
      true
    ),

  profitLockGapPct:
    Math.max(0.1, num("PROFIT_LOCK_GAP_PCT", 5)),

  profitLockActivatePct:
    num("PROFIT_LOCK_ACTIVATE_PCT", 5),

  exitMinPositionAgeSec:
    Math.max(0, num("EXIT_MIN_POSITION_AGE_SEC", 8)),

  exitConfirmations:
    Math.max(1, Math.floor(num("EXIT_CONFIRMATIONS", 2))),

  maxHoldSec:
    Math.max(
      30,
      num(
        "MAX_HOLD_SEC",
        300
      )
    ),

  flowRequiredForEntry:
    bool(
      "FLOW_REQUIRED_FOR_ENTRY",
      true
    ),

  positionSizeSol:
    num(
      "POSITION_SIZE_SOL",
      0.10
    ),

  maxOpen:
    num(
      "MAX_OPEN_POSITIONS",
      2
    ),

  maxExposureSol:
    num(
      "MAX_TOTAL_EXPOSURE_SOL",
      0.20
    ),

  maxDailyLossSol:
    num(
      "MAX_DAILY_LOSS_SOL",
      0.20
    ),

  maxTradesHour:
    num(
      "MAX_TRADES_PER_HOUR",
      10
    ),

  maxSlippageBps:
    num(
      "MAX_SLIPPAGE_BPS",
      150
    ),

  priorityFeeMicroLamports:
    num(
      "PRIORITY_FEE_MICROLAMPORTS",
      100000
    ),

  minAge:
    num(
      "MIN_AGE_SEC",
      3
    ),

  maxAge:
    num(
      "MAX_AGE_SEC",
      180
    ),

  minMcap:
    num(
      "MIN_MARKET_CAP_SOL",
      20
    ),

  maxMcap:
    num(
      "MAX_MARKET_CAP_SOL",
      420
    ),

  minCurve:
    num(
      "MIN_CURVE_PROGRESS",
      1
    ),

  maxCurve:
    num(
      "MAX_CURVE_PROGRESS",
      99
    ),

  minBuys:
    num(
      "MIN_BUYS_60S",
      3
    ),

  minBuySol:
    num(
      "MIN_BUY_SOL_60S",
      0.20
    ),

  minRatio:
    num(
      "MIN_BUY_SELL_RATIO",
      1.5
    ),

  minUnique:
    num(
      "MIN_UNIQUE_BUYERS",
      3
    ),

  minScore:
    num(
      "MIN_SCORE",
      70
    ),

  stopLoss:
    num(
      "STOP_LOSS_PCT",
      5
    ),

  takeProfit:
    num(
      "TAKE_PROFIT_PCT",
      30
    ),

  trailing:
    num(
      "TRAILING_STOP_PCT",
      18
    ),

  paperStartSol:
    num(
      "PAPER_START_SOL",
      1
    ),

  pumpCookie:
    process.env.PUMP_COOKIE ||
    "",
};
