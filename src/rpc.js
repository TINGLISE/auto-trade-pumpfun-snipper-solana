import { Connection } from "@solana/web3.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRateLimitError(error) {
  const text = String(error?.message || error || "");
  const status = Number(error?.status || error?.code || 0);
  return status === 429 || /429|too many requests|rate limit|resource exhausted/i.test(text);
}

function isEndpointAccessError(error) {
  const text = String(error?.message || error || "");
  const status = Number(error?.status || error?.code || 0);
  return status === 401 || status === 403 ||
    /api key is not allowed|api key.*not allowed|unauthorized|forbidden|invalid api key|permission denied|access denied/i.test(text);
}

function isRetryableRpcError(error) {
  const text = String(error?.message || error || "");
  const status = Number(error?.status || error?.code || 0);
  return isRateLimitError(error) || isEndpointAccessError(error) || [408, 425, 500, 502, 503, 504, -32601].includes(status) ||
    /fetch failed|timeout|timed out|socket hang up|econnreset|service unavailable|method .* not found/i.test(text);
}

export class RpcPool {
  constructor(urls, commitment = "confirmed", minGapMs = 75) {
    this.urls = [...new Set((urls || []).map((v) => String(v || "").trim()).filter(Boolean))];
    if (!this.urls.length) this.urls = ["https://api.mainnet-beta.solana.com"];

    this.commitment = commitment;
    this.minGapMs = Math.max(0, Number(minGapMs) || 0);
    this.entries = this.urls.map((url) => ({
      url,
      connection: new Connection(url, commitment),
      cooldownUntil: 0,
      failures: 0,
      lastUsedAt: 0,
      nextAllowedAt: 0,
      requests: 0,
      rateLimits: 0,
    }));
    this.cursor = 0;
    this.totalRequests = 0;
    this.nextGlobalAllowedAt = 0;
    this.totalRateLimits = 0;
    this.lastError = null;
  }

  pick() {
    const now = Date.now();
    const healthy = this.entries.filter((e) => e.cooldownUntil <= now);
    const pool = healthy.length ? healthy : this.entries;
    let selected = pool[0];

    for (const entry of pool) {
      if (entry.lastUsedAt < selected.lastUsedAt) selected = entry;
    }

    const start = this.cursor++ % pool.length;
    selected = pool[start] || selected;
    selected.lastUsedAt = now;
    return selected;
  }

  async call(label, fn, attempts = Math.max(2, this.entries.length + 1)) {
    let lastError;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const entry = this.pick();
      const globalWait = Math.max(0, this.nextGlobalAllowedAt - Date.now());
      const endpointWait = Math.max(0, entry.nextAllowedAt - Date.now());
      const waitMs = Math.max(globalWait, endpointWait);
      if (waitMs > 0) await sleep(waitMs);
      this.nextGlobalAllowedAt = Date.now() + this.minGapMs;
      entry.nextAllowedAt = Date.now() + this.minGapMs;
      entry.requests++;
      this.totalRequests++;

      try {
        return await fn(entry.connection, entry.url);
      } catch (error) {
        lastError = error;
        this.lastError = `${label}: ${error?.message || error}`;

        if (!isRetryableRpcError(error) || attempt === attempts - 1) {
          throw error;
        }

        const code = Number(error?.code || 0);
        const message = String(error?.message || error || "");
        if (code === -32601 || /method .* not found/i.test(message)) {
          entry.failures++;
          const cooldown = 60000;
          entry.cooldownUntil = Date.now() + cooldown;
          console.warn(`RPC POOL METHOD_NOT_FOUND ${entry.url} | ${label} | ${message} | endpoint disabled for ${cooldown}ms | failover`);
        } else if (isRateLimitError(error)) {
          entry.rateLimits++;
          this.totalRateLimits++;
          const retryAfter = Number(error?.headers?.["retry-after"] || error?.retryAfter || 0);
          const backoff = retryAfter > 0
            ? Math.min(15000, retryAfter * 1000)
            : Math.min(10000, 500 * (2 ** attempt) + Math.floor(Math.random() * 250));
          entry.cooldownUntil = Date.now() + backoff;
          console.warn(`RPC POOL 429 ${entry.url} | ${label} | cooldown ${backoff}ms | failover`);
          await sleep(Math.min(backoff, 1500));
        } else if (isEndpointAccessError(error)) {

          entry.failures++;
          const cooldown = 60000;
          entry.cooldownUntil = Date.now() + cooldown;
          console.warn(`RPC POOL ${Number(error?.status || error?.code || 403)} ${entry.url} | ${label} | endpoint disabled for ${cooldown}ms | failover`);
        } else {
          entry.failures++;
          entry.cooldownUntil = Date.now() + Math.min(5000, 750 * (2 ** attempt));
          await sleep(150);
        }
      }
    }

    throw lastError;
  }

  getConnection(index = 0) {
    return this.entries[index % this.entries.length].connection;
  }

  getEndpointUrl(index = 0) {
    return this.entries[index % this.entries.length]?.url || null;
  }

  stats() {
    return {
      endpoints: this.entries.map((e) => ({
        url: e.url,
        cooldownMs: Math.max(0, e.cooldownUntil - Date.now()),
        requests: e.requests,
        rateLimits: e.rateLimits,
        failures: e.failures,
      })),
      totalRequests: this.totalRequests,
      totalRateLimits: this.totalRateLimits,
      lastError: this.lastError,
    };
  }
}

export { isRateLimitError, isRetryableRpcError, isEndpointAccessError };
