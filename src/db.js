import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const dataDir = path.resolve("./data");
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, "pump-alpha.db"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS tokens(
  mint TEXT PRIMARY KEY, name TEXT, symbol TEXT, creator TEXT, created INTEGER, updated INTEGER,
  market_cap_sol REAL, curve_progress REAL, complete INTEGER, score REAL, status TEXT, json TEXT
);
CREATE TABLE IF NOT EXISTS trades(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, side TEXT, mint TEXT, name TEXT, symbol TEXT,
  sol REAL, price REAL, signature TEXT, mode TEXT, pnl REAL DEFAULT 0, reason TEXT DEFAULT ''
);
`);
try { db.exec("ALTER TABLE trades ADD COLUMN reason TEXT DEFAULT ''"); } catch {}

export function upsertToken(t) {
  db.prepare(`INSERT INTO tokens(mint,name,symbol,creator,created,updated,market_cap_sol,curve_progress,complete,score,status,json)
    VALUES(@mint,@name,@symbol,@creator,@created,@updated,@market_cap_sol,@curve_progress,@complete,@score,@status,@json)
    ON CONFLICT(mint) DO UPDATE SET name=@name,symbol=@symbol,creator=@creator,updated=@updated,market_cap_sol=@market_cap_sol,
    curve_progress=@curve_progress,complete=@complete,score=@score,status=@status,json=@json`).run(t);
}

export function addTrade(t) {
  db.prepare(`INSERT INTO trades(ts,side,mint,name,symbol,sol,price,signature,mode,pnl,reason)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      Number(t.ts || Date.now()),
      String(t.side || ""),
      String(t.mint || ""),
      t.name || "",
      t.symbol || "",
      Number(t.sol || 0),
      Number(t.price || 0),
      t.signature || "",
      t.mode || "",
      Number(t.pnl || 0),
      t.reason || "",
    );
}

export function recentTrades(limit = 100) {
  return db.prepare(`SELECT * FROM trades ORDER BY id DESC LIMIT ?`).all(Math.max(1, Number(limit) || 100));
}

// The dashboard label is "Realized P&L 24h", so this is a rolling 24-hour window.
export function todayPnl() {
  return Number(db.prepare(`SELECT COALESCE(SUM(pnl),0) pnl FROM trades WHERE ts>=?`).get(Date.now() - 86400000)?.pnl || 0);
}

export function tradesLastHour() {
  return Number(db.prepare(`SELECT COUNT(*) n FROM trades WHERE side='BUY' AND ts>=?`).get(Date.now() - 3600000)?.n || 0);
}

export function exposureToday() {
  return db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN side='BUY' THEN sol ELSE 0 END),0) buys,
    COALESCE(SUM(CASE WHEN side='SELL' THEN sol ELSE 0 END),0) sells
    FROM trades WHERE ts>=?`).get(Date.now() - 86400000);
}
