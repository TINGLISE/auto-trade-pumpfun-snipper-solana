import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const read = f => fs.readFileSync(path.join(root, f), "utf8");
const execution = read("src/execution.js");
const rpc = read("src/rpc.js");
const index = read("src/index.js");
const db = read("src/db.js");
const server = read("src/server.js");
const dashboard = read("public/index.html");

const checks = [
  ["Executor export", /export const Executor = ExecutionEngine/.test(execution)],
  ["SELL method exists", /async sell\(input, fraction = 1, reason = "MANUAL"\)/.test(execution)],
  ["SELL DB write", /side: "SELL"/.test(execution) && /reason/.test(execution)],
  ["SELL ATA wait", /getTokenBalanceRaw|Associated token account belum tersedia/.test(execution)],
  ["SELL V2 route", /sellV2Instructions/.test(execution)],
  ["Graduated AMM sell route", /OnlinePumpAmmSdk/.test(execution) && /PUMP_AMM_SDK\.sellBaseInput/.test(execution) && /canonicalPumpPoolPda/.test(execution)],
  ["Full sell removes position", /position\.remaining = Math\.max\(0, remaining - soldFraction\)/.test(execution) && /this\.positions\.delete\(mintAddress\)/.test(execution)],
  ["Auto close ATA after full sell", /async closeTokenAccount\(mint\)/.test(execution) && /createCloseAccountInstruction/.test(execution) && /closeTokenAccount\(mintPk\)/.test(execution)],
  ["RPC pool failover", /new RpcPool\(config\.rpcUrls/.test(execution) && /rpcPool\.call/.test(execution)],
  ["RPC 429 cooldown", /rateLimits/.test(rpc) && /cooldownUntil/.test(rpc)],
  ["No TP1/TP2/TP3 execution", !/tp1Frac|tp2Frac|tp3Frac/.test(index) && !/tp1Done|tp2Done|tp3Done/.test(execution)],
  ["Single full take profit", /executor\.sell\(\s*pos,\s*1,\s*`TAKE_PROFIT_/.test(index)],
  ["Trade reason column", /reason TEXT/.test(db) && /Reason/.test(dashboard)],
  ["Safe PNL percent", /pnlPct/.test(server) && /Number\.isFinite\(rawPct\)/.test(dashboard)],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failed++;
}
if (failed) process.exit(1);
console.log(`ALL SMOKE CHECKS PASSED (${checks.length})`);
