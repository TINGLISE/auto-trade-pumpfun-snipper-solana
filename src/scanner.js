import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "./config.js";
import { upsertToken } from "./db.js";
import WebSocket from "ws";

const candidates = new Map();
const recentTradesFeed = [];
const seenTradeIds = new Set();
let flowCache = new Map();
let lastScanError = null;
let discoveryStatus = "STARTING";
let flowStatus = config.flowEnabled ? "WS CONNECTING" : "DISABLED";
let lastDiscoveryAt = 0;
let discoveryEtag = null;
let rateLimitedUntil = 0;
let ws = null;
let wsConnected = false;
let wsReconnectTimer = null;
let wsReconnectDelay = 2000;
let subscribedMints = new Set();
const protectedMints = new Set();
const latestMarketCaps = new Map();
const latestTradePrices = new Map();
let wsSource = "";
let wsUrlIndex = 0;
let wsOpenedAt = 0;
let wsLastTradeAt = 0;
let discoveryPage = 0;
let lastFlowHttpAt = 0;
let flowHttpStatus = "HTTP FLOW READY";
const flowRejectedUntil = new Map();

function headers(etag) {
  const h = { accept: "application/json", origin: "https://pump.fun", referer: "https://pump.fun/", "user-agent": "Mozilla/5.0 (compatible; PumpAlphaPro/3.5.16)" };
  if (config.pumpApiToken) h.authorization = `Bearer ${config.pumpApiToken}`;
  if (config.pumpCookie) h.cookie = config.pumpCookie;
  if (etag) h["if-none-match"] = etag;
  return h;
}

function asNumber(v) {
  if (v == null || v === "") return 0;
  const n = Number(typeof v === "string" ? v.replace(/,/g, "") : v);
  return Number.isFinite(n) ? n : 0;
}
function timestampMs(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "string" && /[T:Z-]/.test(v) && !/^[-+]?\d+(?:\.\d+)?$/.test(v)) {
    const parsed = Date.parse(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  const n = asNumber(v);
  if (!n) return 0;
  return n < 1e12 ? n * 1000 : n;
}
function arrOf(j) { return Array.isArray(j) ? j : j?.coins || j?.data || j?.items || j?.trades || j?.results || []; }
function marketCapSol(c) {
  const direct = asNumber(c.market_cap_sol ?? c.marketCapSol);
  if (direct > 0) return direct;
  const mc = asNumber(c.market_cap ?? c.marketCap);
  if (mc > 0) return mc > 1e7 ? mc / 1e9 : mc;
  const vs = asNumber(c.virtual_sol_reserves ?? c.virtualSolReserves ?? c.vSolInBondingCurve ?? c.vSolInBondingCurveLamports);
  const vt = asNumber(c.virtual_token_reserves ?? c.virtualTokenReserves ?? c.vTokensInBondingCurve);
  const supply = asNumber(c.total_supply ?? c.tokenTotalSupply ?? c.token_total_supply);
  if (vs > 0 && vt > 0 && supply > 0) return (vs * supply) / vt / 1e9;
  return 0;
}
function curveProgress(c) {
  if (c.complete === true) return 100;
  const real = asNumber(c.real_sol_reserves ?? c.realSolReserves);
  const virtual = asNumber(c.virtual_sol_reserves ?? c.virtualSolReserves ?? c.vSolInBondingCurve);
  if (real > 0 && virtual > 0) return Math.max(0, Math.min(100, (real / virtual) * 100));
  return asNumber(c.progress ?? c.bondingCurveProgress ?? 0);
}
function normalize(c) {
  const createdMs = timestampMs(c.created_timestamp ?? c.created_timestamp_ms ?? c.createdAt ?? c.created_at ?? c.timestamp);
  const age = createdMs ? Math.max(0, (Date.now() - createdMs) / 1000) : 999999;
  const lastTradeMs = timestampMs(c.last_trade_timestamp ?? c.lastTradeTimestamp ?? c.last_trade_time);
  const idleSec = lastTradeMs ? Math.max(0, (Date.now() - lastTradeMs) / 1000) : 999999;
  return { ...c,
    mint: c.mint || c.address || c.tokenAddress || c.token_address,
    name: c.name || c.tokenName || "Unnamed", symbol: c.symbol || c.ticker || "???",
    creator: c.creator || c.creator_address || c.traderPublicKey || "", createdMs, age,
    mcapSol: marketCapSol(c), mcapUsd: asNumber(c.usd_market_cap ?? c.usdMarketCap ?? c.market_cap_usd ?? c.marketCapUsd), curve: curveProgress(c), complete: !!c.complete,
    replyCount: asNumber(c.reply_count ?? c.replyCount), lastTradeMs, idleSec
  };
}
function parseTrade(raw, fallbackMint = "") {

  let t = raw;
  if (raw?.data && typeof raw.data === "object" && !Array.isArray(raw.data)) t = { ...raw, ...raw.data };
  if (t?.trade && typeof t.trade === "object") t = { ...t, ...t.trade };
  if (t?.trade_details && typeof t.trade_details === "object") t = { ...t, ...t.trade_details };

  const mint = t.mint || t.mint_address || t.coinMint || t.tokenMint || t.token_address || t.tokenAddress || t.coin?.mint || t.coin?.address || fallbackMint;
  const txType = String(t.txType || t.tx_type || t.type || t.side || t.action || t.tradeType || t.trade_type || t.event || t.swap_type || "").toLowerCase();
  const side = txType.includes("buy") ? "buy" : txType.includes("sell") ? "sell" : (t.is_buy === true || t.isBuy === true ? "buy" : t.is_buy === false || t.isBuy === false ? "sell" : "");
  const rawSol = asNumber(t.solAmount ?? t.sol_amount ?? t.amountSol ?? t.amount_sol ?? t.sol ?? t.quoteAmount ?? t.quote_amount ?? t.amountInSol ?? t.amount_in_sol);
  const sol = rawSol > 1e6 ? rawSol / 1e9 : rawSol;
  const ts = timestampMs(t.timestamp ?? t.timestamp_utc ?? t.createdTs ?? t.created_timestamp ?? t.created_timestamp_ms ?? t.time ?? t.blockTime ?? t.created_at ?? t.createdAt) || Date.now();
  const buyer = t.traderPublicKey || t.user || t.userAddress || t.trader || t.buyer || t.wallet || t.userPublicKey || t.owner || "";
  const id = String(t.signature || t.txSignature || t.transactionSignature || t.tx_hash || t.transactionHash || t.id || t.tradeId || `${mint}:${ts}:${buyer}:${side}:${sol}`);
  let marketCapSol = asNumber(t.marketCapSol ?? t.market_cap_sol);
  // Some providers expose market cap in lamports under generic market_cap fields.
  // Only normalize those when the magnitude is clearly not a SOL-denominated cap.
  if (marketCapSol > 1e6) marketCapSol /= 1e9;
  const tokenAmount = asNumber(t.tokenAmount ?? t.token_amount ?? t.tokens ?? t.baseAmount ?? t.base_amount ?? t.tokenQty ?? t.token_quantity);
  let vSol = asNumber(t.vSolInBondingCurve ?? t.v_sol_in_bonding_curve ?? t.virtualSolReserves ?? t.virtual_sol_reserves);
  const vTokens = asNumber(t.vTokensInBondingCurve ?? t.v_tokens_in_bonding_curve ?? t.virtualTokenReserves ?? t.virtual_token_reserves);
  if (vSol > 1e6) vSol /= 1e9;
  // Pump.fun supply is 1B tokens. Trade/token and reserve values can be either
  // human units or 6-decimal base units, so detect the representation first.
  const supplyRaw = 1e15;
  const supplyHuman = 1e9;
  const tokenBaseUnits = tokenAmount >= 1e6;
  const tradePriceSol = tokenAmount > 0 && sol > 0 ? sol / (tokenBaseUnits ? tokenAmount / 1e6 : tokenAmount) : 0;
  const reservePriceSol = vSol > 0 && vTokens > 0 ? vSol / (vTokens >= 1e12 ? vTokens / 1e6 : vTokens) : 0;
  const priceSol = reservePriceSol > 0 ? reservePriceSol : tradePriceSol;
  const derivedMarketCapSol = marketCapSol > 0 ? marketCapSol : (priceSol > 0 ? priceSol * supplyHuman : 0);
  return { id, mint, side, sol, ts, buyer, marketCapSol: derivedMarketCapSol, tokenAmount, priceSol, vSol, vTokens };
}

function addTrade(raw, fallbackMint = "") {
  const t = parseTrade(raw, fallbackMint);
  if (!t.mint || !t.side) return;
  if (seenTradeIds.has(t.id)) return;
  seenTradeIds.add(t.id);
  recentTradesFeed.push(t);
  const cutoff = Date.now() - Math.max(config.flowLookbackSec, 60) * 1000;
  while (recentTradesFeed.length && recentTradesFeed[0].ts < cutoff) recentTradesFeed.shift();
  while (seenTradeIds.size > 10000) seenTradeIds.delete(seenTradeIds.values().next().value);
  recomputeFlow();

  const c = candidates.get(t.mint);

  const baseMcap = Number(c?.mcapSol || 0);
  const saneMcap = t.marketCapSol > 0 && (!baseMcap || (t.marketCapSol >= baseMcap * 0.01 && t.marketCapSol <= baseMcap * 100));
  const sanePrice = t.priceSol > 0 && (!baseMcap || !c?.lastTradePriceSol || (t.priceSol >= c.lastTradePriceSol * 0.01 && t.priceSol <= c.lastTradePriceSol * 100));
  if (sanePrice) latestTradePrices.set(t.mint, { priceSol: t.priceSol, ts: t.ts });
  if (saneMcap) latestMarketCaps.set(t.mint, { mcapSol: t.marketCapSol, priceSol: sanePrice ? t.priceSol : 0, ts: t.ts, source: "trade" });
  if (c) {
    if (saneMcap) c.mcapSol = t.marketCapSol;
    if (sanePrice) { c.lastTradePriceSol = t.priceSol; c.lastTradePriceTs = t.ts; }
    c.lastUpdated = Date.now();
  }
}
function recomputeFlow() {
  const since = Date.now() - config.flowLookbackSec * 1000;
  const map = new Map();
  for (const t of recentTradesFeed) {
    if (t.ts < since || !t.mint) continue;
    let f = map.get(t.mint); if (!f) f = { buys: 0, sells: 0, buySol: 0, sellSol: 0, buyers: new Set() };
    if (t.side === "buy") { f.buys++; f.buySol += t.sol; if (t.buyer) f.buyers.add(t.buyer); }
    else if (t.side === "sell") { f.sells++; f.sellSol += t.sol; }
    map.set(t.mint, f);
  }
  flowCache = new Map([...map].map(([mint, f]) => [mint, { buys:f.buys, sells:f.sells, buySol:f.buySol, sellSol:f.sellSol, uniqueBuyers:f.buyers.size, ratio:f.sellSol>0?f.buySol/f.sellSol:(f.buySol>0?10:0), available:true }]));
}
function flowScore(f) {
  if (!config.flowEnabled) return { points:0, valid:true, available:true };
  if (!f || !f.available) return { points:0, valid:false, available:false };
  let p=0; if(f.buys>=config.minBuys)p+=8; if(f.buySol>=config.minBuySol)p+=8; if(f.ratio>=config.minRatio)p+=8; if(f.uniqueBuyers>=config.minUnique)p+=6;
  return { points:p, available:true, valid:f.buys>=config.minBuys&&f.buySol>=config.minBuySol&&f.ratio>=config.minRatio&&f.uniqueBuyers>=config.minUnique };
}
function marketScore(c) {

  if(c.idleSec>config.maxIdleSec||c.mcapSol<config.minMcap||c.mcapSol>config.maxMcap||c.curve<config.minCurve||c.curve>config.maxCurve)return 0;
  const freshness=Math.max(0,30-c.idleSec/4), curvePts=Math.min(20,c.curve/5), mcapPts=c.mcapSol<=120?20:c.mcapSol<=250?12:6, social=Math.min(10,c.replyCount/2);
  return Math.round(Math.min(70,freshness+curvePts+mcapPts+social));
}
function score(c, flow){ const base=marketScore(c); if(!base)return 0; return Math.round(Math.min(100,base+flowScore(flow).points)); }

function updateTradeSubscriptions() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !config.flowEnabled) return;
  const anonymousLimit = wsSource.includes("pumpdev.io") && !config.pumpDevApiKey ? 5 : config.flowSubscribeMax;
  const maxSubs = Math.max(1, Math.min(config.flowSubscribeMax, anonymousLimit));
  const protectedTargets = [...protectedMints].filter(Boolean).slice(0, maxSubs);
  const slots = Math.max(0, maxSubs - protectedTargets.length);
  const now = Date.now();
  const candidateTargets = [...candidates.values()]
    .filter(c => {
      if (!c.mint || protectedMints.has(c.mint) || marketScore(c) <= 0) return false;
      const rejectedUntil = Number(flowRejectedUntil.get(c.mint) || 0);
      return rejectedUntil <= now;
    })
    .sort((a, b) => Number(b.score ?? b.marketScore ?? marketScore(b)) - Number(a.score ?? a.marketScore ?? marketScore(a)))
    .slice(0, slots)
    .map(c => c.mint);
  const target = [...protectedTargets, ...candidateTargets];
  const targetSet = new Set(target);
  const removed = [...subscribedMints].filter(m => !targetSet.has(m));
  const added = target.filter(m => !subscribedMints.has(m));
  try {
    if (removed.length) ws.send(JSON.stringify({ method: "unsubscribeTokenTrade", keys: removed }));
    if (added.length) ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: added }));
  } catch (e) {
    flowStatus = `WS SEND ERROR: ${e.message}`;
    return;
  }
  subscribedMints = targetSet;
  flowStatus = wsConnected ? `WS OK ${wsSource} | subscribed ${subscribedMints.size}` : flowStatus;
}

let lastSubscriptionSyncAt = 0;
setInterval(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN || !config.flowEnabled) return;
  if (Date.now() - lastSubscriptionSyncAt < 750) return;
  lastSubscriptionSyncAt = Date.now();
  updateTradeSubscriptions();
}, 500);

async function refreshFlowHttp() {
  if (!config.flowEnabled || !config.flowHttpFallback || Date.now() - lastFlowHttpAt < config.flowHttpRefreshMs) return;
  lastFlowHttpAt = Date.now();
  const targets = [...subscribedMints].filter(m => !protectedMints.has(m)).slice(0, config.candidateLimit);
  const httpTargets = [...protectedMints].filter(Boolean).slice(0, Math.max(0, config.candidateLimit - targets.length));
  const flowTargets = [...new Set([...targets, ...httpTargets])].slice(0, config.candidateLimit);
  if (!flowTargets.length) return;
  let ok = 0, totalTrades = 0, parsedTrades = 0;
  for (const mint of flowTargets) {
    try {
      const url = `https://swap-api.pump.fun/v2/coins/${encodeURIComponent(mint)}/trades?limit=50&cursor=0&minSolAmount=0&program=pump`;
      const result = await fetchJson(url, { timeoutMs: 7000 });
      const rows = arrOf(result.data);
      if (!rows.length) continue;
      ok++;
      totalTrades += rows.length;
      for (const row of rows) {
        const before = recentTradesFeed.length;
        addTrade(row, mint);
        if (recentTradesFeed.length > before) parsedTrades++;
      }
    } catch (e) {
      // HTTP fallback is supplemental; don't take down the scanner on a provider error.
      flowHttpStatus = `HTTP FLOW: ${e.status ? `HTTP ${e.status}` : e.message}`;
    }
  }
  recomputeFlow();
  if (ok) flowHttpStatus = `HTTP FLOW OK ${ok}/${flowTargets.length} tokens | ${parsedTrades}/${totalTrades} parsed trades`;
  else if (flowTargets.length) flowHttpStatus = `HTTP FLOW NO DATA ${flowTargets.length} tokens`;
  refreshCandidateFlow();
  updateTradeSubscriptions();
}

function wsUrl(base) {
  if (base.includes("pumpportal.fun") && config.pumpPortalApiKey) {
    return `${base}?api-key=${encodeURIComponent(config.pumpPortalApiKey)}`;
  }
  if (base.includes("pumpdev.io") && config.pumpDevApiKey) {
    return `${base}?api-key=${encodeURIComponent(config.pumpDevApiKey)}`;
  }
  return base;
}
function scheduleWsReconnect() {
  if (!config.flowEnabled || wsReconnectTimer) return;
  const delay = Math.max(1000, Math.min(30000, wsReconnectDelay));
  flowStatus = `WS RECONNECT IN ${Math.ceil(delay / 1000)}s`;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    if (!config.flowEnabled || ws) return;
    connectFlowWS();
  }, delay);
  wsReconnectDelay = Math.min(30000, Math.round(wsReconnectDelay * 1.7));
}

function connectFlowWS() {
  if (!config.flowEnabled || ws || wsReconnectTimer) return;
  const urls = config.flowWsUrls;
  const base = urls[wsUrlIndex % urls.length];
  const url = wsUrl(base);
  wsSource = base;
  flowStatus = `WS CONNECTING ${base}`;
  try { ws = new WebSocket(url, { headers: { Origin: "https://pump.fun", "User-Agent": "PumpAlphaPro/3.5.16" } }); }
  catch (e) { ws=null; flowStatus=`WS ERROR: ${e.message}`; wsUrlIndex=(wsUrlIndex+1)%urls.length; scheduleWsReconnect(); return; }
  ws.on("open", () => {
    wsConnected=true; wsOpenedAt=Date.now(); wsReconnectDelay=2000; flowStatus=`WS OK ${wsSource} | waiting trades`;
    ws.send(JSON.stringify({method:"subscribeNewToken"}));
    updateTradeSubscriptions();
  });
  ws.on("message", data => {
    try {
      const raw=JSON.parse(data.toString());
      if (raw.error || raw.status === "error") {
        flowStatus = `WS ERROR: ${String(raw.error || raw.message || "subscription rejected").slice(0, 180)}`;
        return;
      }
      const parsedTrade = parseTrade(raw);
      if(parsedTrade.mint && parsedTrade.side) { wsLastTradeAt=Date.now(); addTrade(raw); }
      else if((raw.txType === "create" || raw.type === "create" || raw.event === "create") && (raw.mint || raw.data?.mint)) {
        const c=normalize(raw);
        if(c.mint && !candidates.has(c.mint)) candidates.set(c.mint,{...c,flow:{available:false,buys:null,buySol:null,ratio:null,uniqueBuyers:null},score:marketScore(c),marketScore:marketScore(c),status:"POTENTIAL / flow pending",flowValid:false,flowAvailable:false,lastUpdated:Date.now()});
      }
      refreshCandidateFlow();
      updateTradeSubscriptions();
    } catch {}
  });
  ws.on("error", e => { flowStatus=`WS ERROR: ${e.message}`; });
  ws.on("close", () => {
    wsConnected=false; ws=null; subscribedMints=new Set();
    if(config.flowEnabled) { wsUrlIndex=(wsUrlIndex+1)%urls.length; flowStatus=`WS DISCONNECTED; retrying`; scheduleWsReconnect(); }
  });
}
async function fetchJson(url,{timeoutMs=10000,etag=null}={}){
  if(Date.now()<rateLimitedUntil) throw Object.assign(new Error(`RATE_LIMIT_COOLDOWN ${Math.ceil((rateLimitedUntil-Date.now())/1000)}s`),{rateLimited:true});
  const ac=new AbortController(); const timer=setTimeout(()=>ac.abort(),timeoutMs);
  try{ const r=await fetch(url,{headers:headers(etag),signal:ac.signal}); if(r.status===304)return{notModified:true,etag:r.headers.get("etag")||etag}; const text=await r.text(); if(r.status===429){const sec=Number(r.headers.get("retry-after"))||30;rateLimitedUntil=Date.now()+sec*1000;throw Object.assign(new Error(`HTTP 429: rate limited; cooldown ${sec}s`),{rateLimited:true,status:429});} if(!r.ok)throw Object.assign(new Error(`HTTP ${r.status}: ${text.slice(0,220)}`),{status:r.status});return{data:text?JSON.parse(text):null,etag:r.headers.get("etag")||etag}; } finally{clearTimeout(timer);}
}
async function discoverRaw(){
  const url = new URL(config.discoveryUrl);
  const limit = Math.min(config.discoveryLimit, Number(url.searchParams.get("limit") || config.discoveryLimit));
  const page = discoveryPage % config.discoveryPages;
  url.searchParams.set("offset", String(page * limit));
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("sort", "last_trade_timestamp");
  url.searchParams.set("order", "DESC");
  discoveryPage = (discoveryPage + 1) % config.discoveryPages;
  const result=await fetchJson(url.toString(),{etag:null});
  if(result.notModified)return null;
  return arrOf(result.data);
}

export async function discover(){
  connectFlowWS();
  if(Date.now()-lastDiscoveryAt<config.pollMs-250)return listCandidates().sort((a,b)=>b.score-a.score).slice(0,config.candidateLimit);
  lastDiscoveryAt=Date.now();
  let raw;
  try{raw=await discoverRaw(); if(raw===null){discoveryStatus="OK / 304 cached"; updateTradeSubscriptions(); await refreshFlowHttp(); recomputeFlow(); return finalize();} if(!raw.length)throw new Error("discovery returned 0 tokens"); discoveryStatus=`OK active page (${raw.length} tokens)`;}catch(e){discoveryStatus=e.rateLimited?"RATE LIMITED":`ERROR: ${e.message}`;lastScanError=`DISCOVERY: ${e.message}`;recomputeFlow();return finalize();}
  for(const rawCoin of raw.slice(0,config.discoveryLimit)){ const c=normalize(rawCoin); if(!c.mint)continue; const existing=candidates.get(c.mint); const flow=flowCache.get(c.mint)||existing?.flow||null; const market=marketScore(c); const fs=flowScore(flow); const basePass=market>0; let status="FILTERED / market"; if(basePass&&!config.flowEnabled)status=market>=config.minScore?"QUALIFIED":"POTENTIAL"; else if(basePass&&!fs.available)status="POTENTIAL / flow pending"; else if(basePass&&!fs.valid)status="REJECTED / flow"; else if(basePass&&market+fs.points>=config.minScore)status="QUALIFIED"; else if(basePass)status="POTENTIAL"; const row={...c,flow:flow||{available:false,buys:null,buySol:null,ratio:null,uniqueBuyers:null},score:score(c,flow),marketScore:market,status,flowValid:fs.valid,flowAvailable:fs.available,lastUpdated:Date.now()}; candidates.set(c.mint,row);upsertToken({mint:c.mint,name:c.name,symbol:c.symbol,creator:c.creator,created:c.createdMs,updated:Date.now(),market_cap_sol:c.mcapSol,curve_progress:c.curve,complete:c.complete?1:0,score:row.score,status,json:JSON.stringify(row)}); }
  updateTradeSubscriptions(); await refreshFlowHttp(); recomputeFlow(); refreshCandidateFlow(); return finalize();
}
function refreshCandidateFlow(){
  const now = Date.now();
  for(const c of candidates.values()){
    const flow=flowCache.get(c.mint)||null;
    const fs=flowScore(flow);
    const market=marketScore(c);
    if(!market){c.score=0;c.status="FILTERED / market";continue;}
    c.flow=flow||{available:false,buys:null,buySol:null,ratio:null,uniqueBuyers:null};
    c.flowAvailable=fs.available;c.flowValid=fs.valid;c.score=score(c,flow);
    if(!config.flowEnabled)c.status=c.score>=config.minScore?"QUALIFIED":"POTENTIAL";
    else if(!fs.available)c.status="POTENTIAL / flow pending";
    else if(!fs.valid){
      c.status="REJECTED / flow";
      flowRejectedUntil.set(c.mint, now + config.flowRejectCooldownMs);
    }
    else if(c.score>=config.minScore)c.status="QUALIFIED";
    else {
      c.status="POTENTIAL";
      // A token with flow data that fails the entry score is also rotated out.
      flowRejectedUntil.set(c.mint, now + config.flowRejectCooldownMs);
    }
  }
}
function finalize(){refreshCandidateFlow();return [...candidates.values()].sort((a,b)=>b.score-a.score).slice(0,config.candidateLimit);}
export async function getCoin(mint){const urls=[`${config.detailUrl}/${encodeURIComponent(mint)}`,`https://frontend-api-v3.pump.fun/coins/${encodeURIComponent(mint)}?sync=true`];let last;for(const url of urls){try{const result=await fetchJson(url);return normalize(result.data);}catch(e){last=e;if(e.status===429||e.rateLimited)break;}}throw last||new Error("coin detail unavailable");}
export function listCandidates(){return [...candidates.values()].sort((a,b)=>b.score-a.score);}
export function getCandidate(mint){return candidates.get(mint)||null;}
export function setProtectedMints(mints){
  const next = new Set((mints || []).filter(Boolean).map(String));
  let changed = next.size !== protectedMints.size;
  if (!changed) for (const mint of next) if (!protectedMints.has(mint)) { changed = true; break; }
  if (!changed) return;
  protectedMints.clear();
  for (const mint of next) protectedMints.add(mint);
  updateTradeSubscriptions();
}
export function getLatestMarket(mint){ return latestMarketCaps.get(String(mint)) || null; }
export function getLatestTradePrice(mint){ return latestTradePrices.get(String(mint)) || null; }
export function scannerHealth(){return{lastScanError,discoveryStatus,flowStatus,activeFlowUrl:wsSource,rateLimitedUntil,lastDiscoveryAt,candidates:candidates.size,wsConnected,flowTokens:flowCache.size,flowSubscribed:subscribedMints.size,subscribedMints:[...subscribedMints],wsLastTradeAt,wsLastTradeAgeMs:wsLastTradeAt?Math.max(0,Date.now()-wsLastTradeAt):null,flowHttpStatus};}
