import express from "express";
import { config } from "./config.js";
import { listCandidates, scannerHealth } from "./scanner.js";
import { recentTrades, todayPnl } from "./db.js";

function maskAddress(address) {
  if (!address) return null;
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-5)}` : address;
}

export function startServer(executor) {
  const app = express();
  app.use(express.json({ limit: "32kb" }));
  app.use(express.static("public"));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, mode: config.live ? "LIVE" : "PAPER", port: config.port });
  });

  app.get("/api/state", async (_req, res) => {
    let balance = null;
    try {
      balance = executor.wallet ? await executor.balance() : null;
    } catch (e) {
      console.error("BALANCE ERROR:", e.message);
    }

    const wallet = executor.wallet?.publicKey?.toBase58?.() || null;
    const positions = [...executor.positions.values()].map((p) => ({
      ...p,
      cost: Number(p.cost || p.costSol || 0),
      currentValueSol: Number(p.currentValueSol || 0),
      unrealizedPnlSol: Number(p.unrealizedPnlSol || 0),
      unrealizedPnlPct: Number(p.unrealizedPnlPct || 0),
      realizedPnl: Number(p.realizedPnl || 0),
      holdSec: Number(p.holdSec || 0),
      remainingPct: Number.isFinite(Number(p.remaining)) ? Math.max(0, Math.min(100, Number(p.remaining) * 100)) : 0,
      pnlPct: Number.isFinite(Number(p.unrealizedPnlPct)) ? Number(p.unrealizedPnlPct) : 0,
      liveFeedAt: Number(p.liveFeedAt || 0),
      liveFeedAgeMs: p.liveFeedAgeMs == null ? null : Number(p.liveFeedAgeMs),
    }));

    res.json({
      mode: config.live ? "LIVE" : "PAPER",
      locked: executor.locked,
      balance,
      paperSol: Number(executor.paperSol || 0),
      pnl: Number(todayPnl() || 0),
      wallet,
      walletMasked: maskAddress(wallet),
      candidates: listCandidates().slice(0, config.candidateLimit),
      trades: recentTrades(50),
      positions,
      scanner: scannerHealth(),
      flowRequiredForEntry: config.flowRequiredForEntry,
      maxOpen: config.maxOpen,
      maxHoldSec: config.maxHoldSec,
    });
  });


  app.post("/api/mode", (req, res) => {
    const mode = String(req.body?.mode || "PAPER").toUpperCase();
    if (mode === "LIVE") {
      if (!executor.wallet) return res.status(400).json({ ok: false, error: "Connect the wallet configured in .env first" });
      executor.unlock();
      config.live = true;
      executor.liveTrading = true;
    } else {
      config.live = false;
      executor.liveTrading = false;
    }
    res.json({ ok: true, mode: config.live ? "LIVE" : "PAPER", locked: executor.locked });
  });

  app.post("/api/stop", (_req, res) => {
    executor.lock();
    res.json({ ok: true, mode: "PAPER_LOCKED" });
  });

  let server;
  let candidatePort = Number(config.port);
  const maxPortAttempts = 10;

  const listenNext = () => {
    server = app.listen(candidatePort, config.host, () => {
      config.port = candidatePort;
      console.log(`Dashboard: http://localhost:${candidatePort}`);
      console.log(`Dashboard bind: ${config.host}:${candidatePort}`);
    });

    server.once("error", (err) => {
      if (err?.code === "EADDRINUSE" && candidatePort < Number(config.port) + maxPortAttempts) {
        const oldPort = candidatePort;
        candidatePort += 1;
        console.warn(`Dashboard port ${oldPort} is already in use; trying ${candidatePort}...`);
        // The failed listener has not started serving. Create a fresh listener
        // on the next port instead of killing the whole trading process.
        setTimeout(listenNext, 50);
        return;
      }
      console.error(`Dashboard server error on ${config.host}:${candidatePort}: ${err.message}`);
    });
  };

  listenNext();
  return server;
}
