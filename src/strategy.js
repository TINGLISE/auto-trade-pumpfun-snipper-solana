import { config } from "./config.js";

export function evaluate(c) {
  const reasons = [];
  if (c.idleSec == null || c.idleSec > config.maxIdleSec) reasons.push("no_recent_activity");
  if (!(c.mcapSol >= config.minMcap)) reasons.push("mcap_low_or_missing");
  if (c.mcapSol > config.maxMcap) reasons.push("mcap_high");
  if (c.curve < config.minCurve) reasons.push("curve_low_or_missing");
  if (c.curve > config.maxCurve) reasons.push("curve_high");
  if (c.score < config.minScore) reasons.push("score_low");
  if (config.flowRequiredForEntry && !c.flowAvailable) reasons.push("flow_unavailable");
  if (config.flowRequiredForEntry && !c.flowValid) reasons.push("flow_low");
  return { enter: reasons.length === 0, reasons };
}
