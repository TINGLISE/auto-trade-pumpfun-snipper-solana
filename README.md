# ⚡ PumpFun Auto Moon Shoot

**A fast, automated Pump.fun trading engine for Solana — built for token discovery, flow analysis, automated entries, automated exits, and optional live execution.**

## ✨ Features

* 🔎 Automated Pump.fun token discovery
* 📊 Candidate scoring and filtering
* ⚡ Buy-flow analysis
* 🧠 Automated entry decisions
* 💰 Configurable position sizing
* 🛡️ Stop-loss protection
* 📈 Take-profit execution
* 🔒 Profit-lock logic
* ⏱️ Maximum holding-time protection
* 🔄 Multi-RPC support
* 🧹 Automatic token-account cleanup
* 🖥️ Real-time web dashboard
* 🚀 Optional LIVE trading
* 🔐 Private key loaded **only from `.env`**

---

<img width="1519" height="764" alt="1254" src="https://github.com/user-attachments/assets/0e22dac5-974e-4225-9226-68b4bf837891" />
<img width="1491" height="604" alt="5584" src="https://github.com/user-attachments/assets/10a46381-6305-42b9-9507-58cf919f8d7f" />




# 🚀 Quick Start

## Requirements

* Node.js **24.x**
* npm
* Solana wallet
* Solana RPC endpoint
* Linux, macOS, Windows, VPS, or GitHub Codespaces

# 📦 Installation

Clone the repository:

```bash
git clone https://github.com/TINGLISE/auto-trade-pumpfun-snipper-solana.git
cd auto-trade-pumpfun-snipper-solana
```

Install dependencies:

```bash
npm install
```

Edit it:

```bash
nano .env
```

---

# 🔐 Environment Configuration

Example:

```bash
SOLANA_RPC_URLS=https://api.mainnet-beta.solana.com,https://api.mainnet.solana.com
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com

# Global minimum gap between ALL RPC calls from this process.
# 125ms ~= max 80 requests / 10 seconds before retries.
RPC_REQUEST_GAP_MS=125
RPC_MAX_ATTEMPTS=7

DATA_POLL_MS=7000
DASHBOARD_POLL_MS=500
DASHBOARD_HOST=0.0.0.0
DASHBOARD_PORT=8787
LIVE_TRADING=true

PRIVATE_KEY=YOUR_PRIVATE_KEY_SOLANA

AUTO_CLOSE_TOKEN_ACCOUNTS=true
PUMP_DISCOVERY_URL=https://frontend-api-v3.pump.fun/coins?offset=0&limit=100&sort=last_trade_timestamp&searchTerm=&order=DESC&includeNsfw=false&creator=&complete=false&meta=true
PUMP_DETAIL_URL=https://frontend-api-v3.pump.fun/coins-v2
DISCOVERY_LIMIT=100
CANDIDATE_LIMIT=5
DISCOVERY_PAGES=5
MAX_IDLE_SEC=120
FLOW_ENABLED=true
PUMP_WS_URLS=wss://pumpdev.io/ws,wss://pumpportal.fun/api/data
FLOW_SUBSCRIBE_MAX=5
FLOW_REFRESH_MS=3000
FLOW_LOOKBACK_SEC=60
FLOW_REJECT_COOLDOWN_MS=5000
FLOW_HTTP_FALLBACK=true
FLOW_HTTP_REFRESH_MS=8000
POSITION_REFRESH_MS=500
EXECUTABLE_EXIT_QUOTE=true
EXECUTABLE_EXIT_QUOTE_REFRESH_MS=2000
FLOW_REQUIRED_FOR_ENTRY=true

POSITION_SIZE_SOL= YOUR_CAN_CHANGE 1 OR 0.1 OR 0.01 OR 0.001

MAX_OPEN_POSITIONS=5
MAX_TOTAL_EXPOSURE_SOL=8
MAX_DAILY_LOSS_SOL=8
MAX_TRADES_PER_HOUR=1000
MAX_SLIPPAGE_BPS=150
PRIORITY_FEE_MICROLAMPORTS=100000
MIN_AGE_SEC=3
MAX_AGE_SEC=180
MIN_MARKET_CAP_SOL=20
MAX_MARKET_CAP_SOL=420
MIN_CURVE_PROGRESS=1
MAX_CURVE_PROGRESS=99
MIN_BUYS_60S=3
MIN_BUY_SOL_60S=0.20
MIN_BUY_SELL_RATIO=1.5
MIN_UNIQUE_BUYERS=3
MIN_SCORE=70
STOP_LOSS_PCT=5
TAKE_PROFIT_PCT=30
TRAILING_STOP_PCT=18
MAX_HOLD_SEC=120

# Dynamic profit lock: -5% hard SL, then lock profit as peak rises
PROFIT_LOCK_ENABLED=true
PROFIT_LOCK_GAP_PCT=5
PROFIT_LOCK_ACTIVATE_PCT=5
EXIT_MIN_POSITION_AGE_SEC=8
EXIT_CONFIRMATIONS=2
```

# Start the application:

```bash
npm start
```

Open:

```text
http://localhost:8787
```

For a VPS:

```text
http://YOUR_SERVER_IP:8787
```
---
The dashboard displays:

* Wallet
* SOL balance
* Realized P&L
* Open positions
* Live candidates
* Token age
* Market cap
* Curve progress
* Buys in the last 60 seconds
* Buy SOL volume
* Buy/sell ratio
* Unique buyers
* Current positions
* Unrealized P&L
* Recent trades
* Transaction signatures



```text
pumpfun-auto-moon-shoot/
├── public/
│   └── index.html
├── src/
│   ├── config.js
│   ├── db.js
│   ├── execution.js
│   ├── index.js
│   ├── rpc.js
│   ├── scanner.js
│   ├── server.js
│   ├── strategy.js
│   └── dashboard.js
├── test/
│   ├── smoke.mjs
│   ├── exit-logic.mjs
│   └── profit-lock-logic.mjs
├── .env.example
├── .gitignore
├── package.json
├── package-lock.json
└── README.md
```

# ⭐ Support the Project

If you find this project useful:

* ⭐ Star the repository
* 🍴 Fork the project
* 🐛 Report reproducible bugs
* 💡 Submit feature requests
* 🔧 Contribute improvements
* 📢 Share it with other Solana builders

Every star, contribution, and useful report helps the project grow.

---

# ⚠️ Disclaimer

This software is provided for educational and experimental purposes.

Cryptocurrency trading involves substantial risk, including the possibility of losing all funds.

Always understand the code you are running, protect your private keys, test thoroughly, and use appropriate risk limits.

**Use at your own risk.**

---

# ⚡ PumpFun Auto Moon Shoot

**Scan faster. Analyze flow. Automate execution. Stay in control.**

### Trade when you're ready. 🚀
