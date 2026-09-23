import {
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import bs58 from "bs58";
import BN from "bn.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import {
  PumpSdk,
  OnlinePumpSdk,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
} from "@pump-fun/pump-sdk";
import {
  OnlinePumpAmmSdk,
  PUMP_AMM_SDK,
  canonicalPumpPoolPda,
} from "@pump-fun/pump-swap-sdk";
import { config } from "./config.js";
import { addTrade, todayPnl, tradesLastHour } from "./db.js";
import { RpcPool, isRateLimitError } from "./rpc.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const solToLamports = (sol) => Math.round(Number(sol) * 1e9);
const lamportsToSol = (lamports) => Number(lamports || 0) / 1e9;
const safeNumber = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function bnFrom(value) {
  if (BN.isBN(value)) return value;
  if (typeof value === "bigint") return new BN(value.toString());
  return new BN(String(value));
}

function extractMintValue(value) {
  if (value instanceof PublicKey) return value.toBase58();
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    for (const candidate of [
      value.mint,
      value.mintAddress,
      value.tokenMint,
      value.tokenAddress,
      value.address,
      value.token_address,
      value.mint_address,
      value.id,
    ]) {
      if (candidate instanceof PublicKey) return candidate.toBase58();
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
  }
  return "";
}

function normalizeMint(value, label = "mint") {
  const raw = extractMintValue(value);
  if (!raw) throw new Error(`${label} is empty or was not found in candidate/position`);
  try {
    const publicKey = new PublicKey(raw);
    return { address: publicKey.toBase58(), publicKey };
  } catch (e) {
    throw new Error(`${label} is invalid: "${raw}" (${e.message})`);
  }
}

function keypairFromSecret(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("PRIVATE KEY IS EMPTY");
  if (raw.startsWith("[")) {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length < 32) throw new Error("PRIVATE KEY JSON IS INVALID");
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  return Keypair.fromSecretKey(bs58.decode(raw));
}

export class ExecutionEngine {
  constructor() {
    this.rpcPool = new RpcPool(config.rpcUrls, "confirmed", config.rpcRequestGapMs);
    this.connection = this.rpcPool.getConnection(0);
    this.sdk = new PumpSdk();
    this.onlineSdk = new OnlinePumpSdk(this.connection);
    this.ammSdk = new OnlinePumpAmmSdk(this.connection);
    this.wallet = null;
    this.positions = new Map();
    this.tokenProgramCache = new Map();
    this.paperSol = safeNumber(config.paperStartSol, 1);
    this.locked = false;
    this.liveTrading = !!config.live;
    this.positionSizeSol = safeNumber(config.positionSizeSol, 0.1);
    this.maxSlippageBps = safeNumber(config.maxSlippageBps, 150);
    this.priorityFeeMicroLamports = safeNumber(config.priorityFeeMicroLamports, 100000);
    this.maxOpenPositions = safeNumber(config.maxOpen, 2);
    this.maxTotalExposureSol = safeNumber(config.maxExposureSol, 0.2);
    this.maxDailyLossSol = safeNumber(config.maxDailyLossSol, 0.2);
    this.maxTradesPerHour = safeNumber(config.maxTradesHour, 10);

    this.initializeWallet();

    console.log("Pump SDK initialized:", {
      PumpSdkBuy: typeof this.sdk.buyInstructions === "function",
      PumpSdkSell: typeof this.sdk.sellInstructions === "function",
      PumpSdkBuyV2: typeof this.sdk.buyV2Instructions === "function",
      PumpSdkSellV2: typeof this.sdk.sellV2Instructions === "function",
      OnlineFetchBuyState: typeof this.onlineSdk.fetchBuyState === "function",
      OnlineFetchSellState: typeof this.onlineSdk.fetchSellState === "function",
      OnlineFetchGlobal: typeof this.onlineSdk.fetchGlobal === "function",
      OnlineFetchFeeConfig: typeof this.onlineSdk.fetchFeeConfig === "function",
      PumpAmmSell: typeof PUMP_AMM_SDK.sellBaseInput === "function",
      OnlinePumpAmmState: typeof this.ammSdk.swapSolanaState === "function",
    });
  }

  async rpcCall(label, fn, attempts = config.rpcMaxAttempts) {
    return this.rpcPool.call(label, async (connection) => {
      this.connection = connection;
      this.onlineSdk = new OnlinePumpSdk(connection);
      this.ammSdk = new OnlinePumpAmmSdk(connection);
      return fn(connection);
    }, attempts);
  }

  async withRpcRetry(fn, label = "RPC", attempts = config.rpcMaxAttempts) {
    return this.rpcCall(label, () => fn(), attempts);
  }

  initializeWallet() {
    const raw = config.privateKeyJson || "";
    if (!raw) {
      console.log("Wallet: not configured");
      return;
    }
    try {
      this.wallet = keypairFromSecret(raw);
      console.log("Wallet:", this.wallet.publicKey.toBase58());
    } catch (e) {
      throw new Error(`PRIVATE_KEY invalid: ${e.message}`);
    }
  }


  async balance() {
    return this.getWalletBalanceSol();
  }

  async getWalletBalanceSol() {
    if (!this.wallet) return 0;
    return lamportsToSol(await this.rpcCall("getBalance", (connection) => connection.getBalance(this.wallet.publicKey, "confirmed")));
  }

  getWalletPublicKey() {
    if (!this.wallet) throw new Error("Wallet is not configured");
    return this.wallet.publicKey;
  }

  async getMintInfo(mint) {
    const { publicKey } = normalizeMint(mint);
    const key = publicKey.toBase58();
    const cached = this.tokenProgramCache.get(key);
    if (cached) return cached;

    const info = await this.rpcCall(
      `getAccountInfo mint ${key}`,
      (connection) => connection.getAccountInfo(publicKey, "confirmed")
    );

    if (!info) throw new Error(`Mint not found: ${key}`);

    let result;
    if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      result = { mint: publicKey, tokenProgram: TOKEN_2022_PROGRAM_ID, isToken2022: true };
    } else if (info.owner.equals(TOKEN_PROGRAM_ID)) {
      result = { mint: publicKey, tokenProgram: TOKEN_PROGRAM_ID, isToken2022: false };
    } else {
      throw new Error(`Unsupported token program ${info.owner.toBase58()} for mint ${key}`);
    }

    this.tokenProgramCache.set(key, result);
    return result;
  }

  async getTokenProgram(mint) {
    const info = await this.getMintInfo(mint);
    return info.tokenProgram;
  }

  async getAssociatedTokenAddress(mint) {
    if (!this.wallet) throw new Error("Wallet is not configured");
    const { publicKey } = normalizeMint(mint);
    const tokenProgram = await this.getTokenProgram(publicKey);
    return getAssociatedTokenAddressSync(publicKey, this.wallet.publicKey, true, tokenProgram);
  }

  async getTokenBalanceRaw(mint) {
    if (!this.wallet) return new BN(0);
    const { publicKey } = normalizeMint(mint);
    const info = await this.getMintInfo(publicKey);
    const ata = getAssociatedTokenAddressSync(publicKey, this.wallet.publicKey, true, info.tokenProgram);
    try {
      const accountInfo = await this.rpcCall(`ATA ${publicKey.toBase58()}`, (connection) => connection.getAccountInfo(ata, "confirmed"));
      if (!accountInfo) return new BN(0);
      const balance = await this.rpcCall(`Token balance ${publicKey.toBase58()}`, (connection) => connection.getTokenAccountBalance(ata, "confirmed"));
      return new BN(String(balance?.value?.amount || "0"));
    } catch (error) {
      if (isRateLimitError(error)) throw error;
      return new BN(0);
    }
  }

  async waitForTokenBalanceRaw(mint, timeoutMs = 5000) {
    const started = Date.now();
    let last = new BN(0);
    let attempts = 0;

    while (Date.now() - started < timeoutMs && attempts < 6) {
      attempts++;
      last = await this.getTokenBalanceRaw(mint);
      if (last.gt(new BN(0))) return last;
      if (Date.now() - started >= timeoutMs) break;
      await sleep(700);
    }

    return last;
  }

  async fetchFeeConfig() {
    if (typeof this.onlineSdk.fetchFeeConfig !== "function") throw new Error("OnlinePumpSdk.fetchFeeConfig is not available");
    const feeConfig = await this.withRpcRetry(
      () => this.onlineSdk.fetchFeeConfig(),
      "fetchFeeConfig"
    );
    if (!feeConfig) throw new Error("FeeConfig is not available");
    return feeConfig;
  }

  calculateSlippage() {
    return this.maxSlippageBps / 100;
  }

  async buildBuyInstructions(mint, positionSizeSol) {
    if (!this.wallet) throw new Error("Wallet is not configured");
    const { publicKey: mintPk } = normalizeMint(mint, "BUY mint");
    const tokenProgram = await this.getTokenProgram(mintPk);
    const state = await this.withRpcRetry(
      () => this.onlineSdk.fetchBuyState(mintPk, this.wallet.publicKey),
      `fetchBuyState ${mintPk.toBase58()}`
    );
    if (!state?.bondingCurve) throw new Error(`Buy state/bonding curve is not available for ${mintPk.toBase58()}`);
    if (state.bondingCurve.complete) throw new Error(`Token ${mintPk.toBase58()} has already graduated; AMM route is not available in this build`);

    const global = state.global ?? await this.withRpcRetry(
      () => this.onlineSdk.fetchGlobal(),
      "fetchGlobal"
    );
    const feeConfig = await this.fetchFeeConfig();
    const mintSupply = state.mintSupply ?? state.bondingCurve.tokenTotalSupply;
    if (!mintSupply) throw new Error(`Mint supply is not available for ${mintPk.toBase58()}`);

    const solAmount = new BN(solToLamports(positionSizeSol));
    const amount = bnFrom(getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: bnFrom(mintSupply),
      bondingCurve: state.bondingCurve,
      amount: solAmount,
    }));

    if (amount.lte(new BN(0))) throw new Error("BUY token amount = 0");

    const common = {
      global,
      bondingCurveAccountInfo: state.bondingCurveAccountInfo ?? state.bondingCurveAccount ?? null,
      bondingCurve: state.bondingCurve,
      associatedUserAccountInfo: state.associatedUserAccountInfo ?? state.associatedUserAccount ?? null,
      mint: mintPk,
      user: this.wallet.publicKey,
      amount,
      slippage: this.calculateSlippage(),
    };

    if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
      if (typeof this.sdk.buyV2Instructions !== "function") throw new Error("PumpSdk.buyV2Instructions is not available");
      console.log(`BUY ROUTE ${mintPk.toBase58()}: TOKEN-2022 / BUY V2`);
      return this.sdk.buyV2Instructions({
        ...common,
        quoteAmount: solAmount,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
      });
    }

    if (typeof this.sdk.buyInstructions !== "function") throw new Error("PumpSdk.buyInstructions is not available");
    console.log(`BUY ROUTE ${mintPk.toBase58()}: SPL TOKEN / BUY LEGACY`);
    return this.sdk.buyInstructions({
      ...common,
      solAmount,
      tokenProgram: TOKEN_PROGRAM_ID,
    });
  }

  async buildAmmSellInstructions(mintPk, amountRaw) {
    if (typeof this.ammSdk.swapSolanaState !== "function") throw new Error("OnlinePumpAmmSdk.swapSolanaState is not available");
    if (typeof PUMP_AMM_SDK.sellBaseInput !== "function") throw new Error("PUMP_AMM_SDK.sellBaseInput is not available");

    const poolKey = canonicalPumpPoolPda(mintPk);
    const swapState = await this.withRpcRetry(
      () => this.ammSdk.swapSolanaState(poolKey, this.wallet.publicKey),
      `AMM state ${mintPk.toBase58()}`
    );
    const baseAmount = bnFrom(amountRaw);
    if (baseAmount.lte(new BN(0))) throw new Error("AMM SELL amount = 0");

    console.log(`SELL ROUTE ${mintPk.toBase58()}: PUMPSWAP AMM / GRADUATED`);
    const quote = await PUMP_AMM_SDK.sellBaseInput(
      swapState,
      baseAmount,
      this.calculateSlippage()
    );
    const instructions = Array.isArray(quote)
      ? quote
      : await PUMP_AMM_SDK.sellInstructions(swapState, baseAmount, quote.minQuote);

    return {
      instructions,
      expectedSol: bnFrom(quote?.minQuote || 0),
      route: "AMM",
    };
  }

  async buildSellInstructions(mint, amountRaw) {
    if (!this.wallet) throw new Error("Wallet is not configured");
    const { publicKey: mintPk } = normalizeMint(mint, "SELL mint");

    if (typeof this.onlineSdk.fetchBondingCurve === "function") {
      const curve = await this.withRpcRetry(
        () => this.onlineSdk.fetchBondingCurve(mintPk),
        `fetchBondingCurve ${mintPk.toBase58()}`
      );
      if (curve?.complete) {
        return this.buildAmmSellInstructions(mintPk, amountRaw);
      }
    }

    const tokenProgram = await this.getTokenProgram(mintPk);
    const ata = getAssociatedTokenAddressSync(mintPk, this.wallet.publicKey, true, tokenProgram);
    let ataReady = false;
    for (let i = 0; i < 3; i++) {
      const ataInfo = await this.rpcCall(`SELL ATA ${mintPk.toBase58()}`, (connection) => connection.getAccountInfo(ata, "confirmed"));
      if (ataInfo) { ataReady = true; break; }
      await sleep(500);
    }
    if (!ataReady) throw new Error(`Associated token account is not available for mint: ${mintPk.toBase58()} for user: ${this.wallet.publicKey.toBase58()}`);

    const state = await this.withRpcRetry(
      () => this.onlineSdk.fetchSellState(mintPk, this.wallet.publicKey, tokenProgram),
      `fetchSellState ${mintPk.toBase58()}`
    );
    if (!state?.bondingCurve) throw new Error(`Sell state/bonding curve is not available for ${mintPk.toBase58()}`);
    if (state.bondingCurve.complete) throw new Error(`Token ${mintPk.toBase58()} has already graduated; AMM route is not available in this build`);

    const global = state.global ?? await this.withRpcRetry(
      () => this.onlineSdk.fetchGlobal(),
      "fetchGlobal"
    );
    const feeConfig = await this.fetchFeeConfig();
    const amount = bnFrom(amountRaw);
    const mintSupply = state.mintSupply ?? state.bondingCurve.tokenTotalSupply;
    if (!mintSupply) throw new Error(`Mint supply is not available for ${mintPk.toBase58()}`);

    const expectedSol = bnFrom(getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: bnFrom(mintSupply),
      bondingCurve: state.bondingCurve,
      amount,
    }));

    const common = {
      global,
      bondingCurveAccountInfo: state.bondingCurveAccountInfo ?? state.bondingCurveAccount ?? null,
      bondingCurve: state.bondingCurve,
      associatedUserAccountInfo: state.associatedUserAccountInfo ?? state.associatedUserAccount ?? null,
      mint: mintPk,
      user: this.wallet.publicKey,
      amount,
      slippage: this.calculateSlippage(),
    };

    let instructions;
    if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
      if (typeof this.sdk.sellV2Instructions !== "function") throw new Error("PumpSdk.sellV2Instructions is not available");
      console.log(`SELL ROUTE ${mintPk.toBase58()}: TOKEN-2022 / SELL V2`);
      instructions = await this.withRpcRetry(
        () => this.sdk.sellV2Instructions({
          ...common,
          quoteAmount: expectedSol,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          quoteTokenProgram: TOKEN_PROGRAM_ID,
        }),
        `build SELL V2 ${mintPk.toBase58()}`
      );
    } else {
      if (typeof this.sdk.sellInstructions !== "function") throw new Error("PumpSdk.sellInstructions is not available");
      console.log(`SELL ROUTE ${mintPk.toBase58()}: SPL TOKEN / SELL LEGACY`);
      instructions = await this.withRpcRetry(
        () => this.sdk.sellInstructions({
          ...common,
          solAmount: expectedSol,
          tokenProgram: TOKEN_PROGRAM_ID,
        }),
        `build SELL ${mintPk.toBase58()}`
      );
    }
    return { instructions, expectedSol, route: "BONDING_CURVE" };
  }

  async buildTransaction(instructions) {
    if (!this.wallet) throw new Error("Wallet is not configured");
    return this.rpcCall("getLatestBlockhash", async (connection) => {
      const tx = new Transaction();
      if (this.priorityFeeMicroLamports > 0) {
        tx.add(ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: this.priorityFeeMicroLamports,
        }));
      }
      tx.add(...instructions);
      tx.feePayer = this.wallet.publicKey;
      const latest = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = latest.blockhash;
      tx.sign(this.wallet);
      return { tx, latest };
    });
  }

  async simulateInstructions(instructions) {
    const { tx } = await this.buildTransaction(instructions);
    return this.rpcCall(
      "simulateTransaction",
      (connection) => connection.simulateTransaction(tx)
    ).then((simulation) => {
      if (simulation.value.err) {
        throw new Error(
          `Simulation failed.\nLogs:\n${JSON.stringify(simulation.value.logs || [], null, 2)}`
        );
      }
      return simulation;
    });
  }

  async waitForSignature(signature, lastValidBlockHeight, timeoutMs = 30000) {
    const started = Date.now();
    let lastStatus = null;

    while (Date.now() - started < timeoutMs) {
      const result = await this.rpcCall(
        `getSignatureStatuses ${signature}`,
        (connection, rpcUrl) => connection.getSignatureStatuses([signature])
      );

      const status = result?.value?.[0] || null;
      lastStatus = status;

      if (status?.err) {
        throw new Error(`Transaction ${signature} failed: ${JSON.stringify(status.err)}`);
      }

      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
        return status;
      }

      // If the signature has been observed but has not reached confirmed yet,
      // keep polling without opening a WebSocket subscription.
      await new Promise((resolve) => setTimeout(resolve, 400));

      // If the blockhash is no longer valid, one final status check is enough.
      try {
        const bh = await this.rpcCall(
          `getBlockHeight ${signature}`,
          (connection) => connection.getBlockHeight("confirmed")
        );
        if (Number.isFinite(Number(lastValidBlockHeight)) && Number(bh) > Number(lastValidBlockHeight)) {
          throw new Error(`Transaction ${signature} expired before confirmation`);
        }
      } catch (e) {
        if (/expired before confirmation/i.test(String(e?.message || e))) throw e;
        // A transient block-height RPC failure is handled by RpcPool; keep polling.
      }
    }

    throw new Error(`Transaction ${signature} confirmation timeout after ${timeoutMs}ms; lastStatus=${JSON.stringify(lastStatus)}`);
  }

  async sendInstructions(instructions) {
    const { tx, latest } = await this.buildTransaction(instructions);
    const raw = tx.serialize();

    const signature = await this.rpcCall(
      "sendRawTransaction",
      (connection) => connection.sendRawTransaction(raw, {
        skipPreflight: false,
        maxRetries: 2,
      })
    );

    // Do not use Connection.confirmTransaction() here: web3.js may open a
    // WebSocket and call signatureSubscribe on the provider. Some RPC plans
    // do not expose PubSub even though their HTTP JSON-RPC works perfectly.
    // Poll signature status through the HTTP RPC pool instead.
    await this.waitForSignature(signature, latest.lastValidBlockHeight);

    return signature;
  }

  async closeTokenAccount(mint) {
    if (!this.wallet || !config.autoCloseTokenAccounts) {
      return { closed: false, reason: "DISABLED_OR_NO_WALLET" };
    }

    const { publicKey: mintPk } = normalizeMint(mint, "CLOSE mint");
    const tokenProgram = await this.getTokenProgram(mintPk);
    const ata = getAssociatedTokenAddressSync(
      mintPk,
      this.wallet.publicKey,
      true,
      tokenProgram
    );

    const balance = await this.getTokenBalanceRaw(mintPk);
    if (!balance.isZero()) {
      return {
        closed: false,
        reason: "TOKEN_DUST_REMAINS",
        balanceRaw: balance.toString(),
        ata: ata.toBase58(),
      };
    }

    const accountInfo = await this.rpcCall(
      `CLOSE account ${mintPk.toBase58()}`,
      (connection) => connection.getAccountInfo(ata, "confirmed")
    );

    if (!accountInfo) {
      return {
        closed: false,
        reason: "ATA_ALREADY_CLOSED",
        ata: ata.toBase58(),
      };
    }

    const ix = createCloseAccountInstruction(
      ata,
      this.wallet.publicKey,
      this.wallet.publicKey,
      [],
      tokenProgram
    );

    const signature = await this.sendInstructions([ix]);

    return {
      closed: true,
      signature,
      ata: ata.toBase58(),
    };
  }

  async getTransactionWalletSolDelta(signature) {
    if (!this.wallet) return { deltaLamports: 0, feeLamports: 0, grossPositiveLamports: 0 };
    for (let i = 0; i < 3; i++) {
      const tx = await this.rpcCall(`getParsedTransaction ${signature}`, (connection) => connection.getParsedTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }));
      if (tx?.meta) {
        const keys = tx.transaction.message.accountKeys || [];
        const idx = keys.findIndex((k) => (k.pubkey || k).toBase58() === this.wallet.publicKey.toBase58());
        if (idx >= 0) {
          const pre = Number(tx.meta.preBalances?.[idx] || 0);
          const post = Number(tx.meta.postBalances?.[idx] || 0);
          const fee = Number(tx.meta.fee || 0);
          const delta = post - pre;
          return { deltaLamports: delta, feeLamports: fee, grossPositiveLamports: delta > 0 ? delta + fee : 0 };
        }
      }
      await sleep(350);
    }
    return { deltaLamports: 0, feeLamports: 0, grossPositiveLamports: 0 };
  }

  getOpenPositionsCount() {
    return [...this.positions.values()].filter((p) => Number(p.remaining || 0) > 0).length;
  }

  getExposureSol() {
    return [...this.positions.values()].reduce((sum, p) => sum + Number(p.cost || p.costSol || 0) * Number(p.remaining || 0), 0);
  }

  riskCheck() {
    if (this.locked) throw new Error("Execution locked");
    if (this.getOpenPositionsCount() >= this.maxOpenPositions) throw new Error("MAX_OPEN_POSITIONS");
    if (this.getExposureSol() + this.positionSizeSol > this.maxTotalExposureSol) throw new Error("MAX_TOTAL_EXPOSURE_SOL");
    if (todayPnl() <= -Math.abs(this.maxDailyLossSol)) throw new Error("MAX_DAILY_LOSS_SOL");
    if (tradesLastHour() >= this.maxTradesPerHour) throw new Error("MAX_TRADES_PER_HOUR");
  }

  makePosition(c, cost, extra = {}) {
    const entry = Number(c.mcapSol || c.market_cap_sol || 0);
    return {
      ...c,
      mint: c.mint,
      name: c.name || c.symbol || c.mint.slice(0, 8),
      symbol: c.symbol || c.name || c.mint.slice(0, 8),
      entryMcapUsd: Number(c.mcapUsd || c.market_cap_usd || 0),
      mcapUsd: Number(c.mcapUsd || c.market_cap_usd || 0),
      entry,
      mcapSol: entry,
      entryPriceSol: Number(c.lastTradePriceSol || c.priceSol || 0),
      cost,
      costSol: cost,
      originalCost: cost,
      entrySol: cost,
      remaining: 1,
      high: entry,
      openedAt: Date.now(),
      boughtAt: Date.now(),
      realizedPnl: 0,
      unrealizedPnlSol: 0,
      unrealizedPnlPct: 0,
      currentValueSol: cost,
      peakGainPct: 0,
      ...extra,
    };
  }

  async buy(candidate) {
    const c = candidate && typeof candidate === "object" ? candidate : { mint: candidate };
    const { address: mintAddress, publicKey: mintPk } = normalizeMint(c, "BUY mint");
    const metadata = { ...c, mint: mintAddress };
    this.riskCheck();
    const solAmount = this.positionSizeSol;

    console.log(`BUY INPUT ${metadata.name || mintAddress} | mint=${mintAddress}`);

    if (!config.live || !this.liveTrading) {
      if (this.paperSol < solAmount) throw new Error("PAPER DANA TIDAK CUKUP");
      this.paperSol -= solAmount;
      const position = this.makePosition(metadata, solAmount, { mode: "paper", originalTokenAmountRaw: new BN("1000000000") });
      this.positions.set(mintAddress, position);
      addTrade({ ts: Date.now(), side: "BUY", mint: mintAddress, name: position.name, symbol: position.symbol, sol: solAmount, price: position.entryPriceSol, mode: "PAPER" });
      return { ok: true, mode: "PAPER", mint: mintAddress, solSpent: solAmount, position, signature: `PAPER-${Date.now()}` };
    }

    if (!this.wallet) throw new Error("LIVE_TRADING aktif tetapi PRIVATE_KEY is not available");
    const balanceBefore = await this.getWalletBalanceSol();
    if (balanceBefore < solAmount + 0.005) throw new Error(`SOL is insufficient. Balance ${balanceBefore.toFixed(6)}, requires approximately ${(solAmount + 0.005).toFixed(6)}`);

    const tokenBefore = await this.getTokenBalanceRaw(mintPk);
    const instructions = await this.buildBuyInstructions(mintPk, solAmount);
    await this.simulateInstructions(instructions);
    const signature = await this.sendInstructions(instructions);
    await sleep(500);
    const tokenAfter = await this.waitForTokenBalanceRaw(mintPk, 8000);
    const receivedRaw = tokenAfter.sub(tokenBefore);
    if (receivedRaw.lte(new BN(0))) throw new Error(`BUY transaction ${signature} confirmed tetapi token received was not detected`);

    const txSol = await this.getTransactionWalletSolDelta(signature);
    const actualCostSol = lamportsToSol(Math.max(0, -txSol.deltaLamports));
    const cost = actualCostSol > 0 ? actualCostSol : solAmount;
    const position = this.makePosition(metadata, cost, { mode: "live", originalTokenAmountRaw: receivedRaw, signature, buySignature: signature, actualWalletDebitSol: cost });
    this.positions.set(mintAddress, position);

    addTrade({ ts: Date.now(), side: "BUY", mint: mintAddress, name: position.name, symbol: position.symbol, sol: cost, price: position.entryPriceSol, signature, mode: "LIVE" });
    return { ok: true, mode: "LIVE", mint: mintAddress, signature, solSpent: cost, tokenReceivedRaw: receivedRaw, position };
  }

  async getExecutableSellQuote(input) {
    const { address: mintAddress, publicKey: mintPk } = normalizeMint(input, "QUOTE SELL mint");
    const position = this.positions.get(mintAddress);
    if (!position) throw new Error(`Position not found: ${mintAddress}`);
    const remaining = Number(position.remaining || 0);
    if (remaining <= 0) throw new Error("Position is already empty");

    const walletBalance = await this.getTokenBalanceRaw(mintPk);
    if (walletBalance.lte(new BN(0))) throw new Error("TOKEN BALANCE IS EMPTY");

    const originalRaw = bnFrom(position.originalTokenAmountRaw);
    const targetRaw = originalRaw.mul(new BN(Math.round(remaining * 1000000))).div(new BN(1000000));
    const amount = targetRaw.lt(walletBalance) ? targetRaw : walletBalance;
    if (amount.lte(new BN(0))) throw new Error("SELL QUOTE AMOUNT IS TOO SMALL");

    const { expectedSol, route } = await this.buildSellInstructions(mintPk, amount);
    const expected = lamportsToSol(expectedSol);
    const cost = Number(position.cost || 0);
    const effectiveAfterSlippage = expected * (1 - this.maxSlippageBps / 10000);
    const pnlPct = cost > 0 ? ((expected / cost) - 1) * 100 : 0;
    const guaranteedPnlPct = cost > 0 ? ((effectiveAfterSlippage / cost) - 1) * 100 : 0;

    return {
      mint: mintAddress,
      expectedSol: expected,
      effectiveAfterSlippageSol: effectiveAfterSlippage,
      pnlPct,
      guaranteedPnlPct,
      costSol: cost,
      route,
      amountRaw: amount.toString(),
      ts: Date.now(),
    };
  }

  async sell(input, fraction = 1, reason = "MANUAL") {
    const { address: mintAddress, publicKey: mintPk } = normalizeMint(input, "SELL mint");
    const position = this.positions.get(mintAddress);
    if (!position) throw new Error(`Position not found: ${mintAddress}`);
    const remaining = Number(position.remaining || 0);
    fraction = clamp(Number(fraction), 0, 1);
    if (fraction <= 0 || remaining <= 0) throw new Error("Invalid sell fraction/position");
    const soldFraction = Math.min(fraction, remaining);

    if (!config.live || !this.liveTrading) {
      const current = Number(position.mcapSol || position.entry || 0);
      const proceeds = Number(position.cost || 0) * Math.max(0, current / Math.max(Number(position.entry || 0), 1e-9)) * soldFraction;
      const costPortion = Number(position.cost || 0) * soldFraction;
      const pnl = proceeds - costPortion;
      this.paperSol += proceeds;
      position.realizedPnl = Number(position.realizedPnl || 0) + pnl;
      position.remaining = Math.max(0, remaining - soldFraction);
      addTrade({ ts: Date.now(), side: "SELL", mint: mintAddress, name: position.name, symbol: position.symbol, sol: proceeds, price: current, mode: "PAPER", pnl, reason });
      if (position.remaining <= 0.000001) this.positions.delete(mintAddress);
      return { ok: true, mode: "PAPER", mint: mintAddress, proceedsSol: proceeds, pnl, fraction: soldFraction, remaining: position.remaining, reason, signature: `PAPER-${Date.now()}` };
    }

    if (!this.wallet) throw new Error("LIVE_TRADING aktif tetapi PRIVATE_KEY is not available");
    const walletBalance = await this.getTokenBalanceRaw(mintPk);
    if (walletBalance.lte(new BN(0))) throw new Error("TOKEN BALANCE IS EMPTY");

    const originalRaw = bnFrom(position.originalTokenAmountRaw);
    const targetRaw = originalRaw.mul(new BN(Math.round(soldFraction * 1000000))).div(new BN(1000000));
    const amount = targetRaw.lt(walletBalance) ? targetRaw : walletBalance;
    if (amount.lte(new BN(0))) throw new Error("SELL AMOUNT TERLALU KECIL");

    const actualSoldFraction = Math.min(remaining, Number(amount.toString()) / Math.max(1, Number(originalRaw.toString())));
    const { instructions, expectedSol, route } = await this.buildSellInstructions(mintPk, amount);
    const costPortion = Number(position.cost || 0) * actualSoldFraction;

    const isTakeProfit = String(reason || "").startsWith("TAKE_PROFIT_");
    if (isTakeProfit) {
      const expectedSolNum = lamportsToSol(expectedSol);
      const minProfitPct = Number(config.takeProfit || 0);
      const requiredProceeds = costPortion * (1 + Math.max(0, minProfitPct) / 100);
      if (!(expectedSolNum > 0) || expectedSolNum < requiredProceeds) {
        console.warn(
          `TP QUOTE REJECTED ${mintAddress}: expected=${expectedSolNum.toFixed(6)} SOL ` +
          `required=${requiredProceeds.toFixed(6)} SOL ` +
          `reason=${reason}`
        );
        throw new Error(
          `TAKE_PROFIT quote is not profitable: expected ${expectedSolNum.toFixed(6)} SOL < ` +
          `required ${requiredProceeds.toFixed(6)} SOL`
        );
      }
    }

    console.log(`SELL BUILD ${mintAddress}: route=${route} fraction=${actualSoldFraction.toFixed(6)} expected=${lamportsToSol(expectedSol).toFixed(6)} SOL`);
    await this.simulateInstructions(instructions);
    const signature = await this.sendInstructions(instructions);
    await sleep(500);

    const txSol = await this.getTransactionWalletSolDelta(signature);

    let closeResult = null;
    if (soldFraction >= remaining - 0.000001 && config.autoCloseTokenAccounts) {
      try {
        closeResult = await this.closeTokenAccount(mintPk);
        if (closeResult.closed) {
          console.log(`CLOSE ATA ${mintAddress} ${closeResult.ata} signature=${closeResult.signature}`);
        } else {
          console.warn(`CLOSE ATA SKIPPED ${mintAddress}: ${closeResult.reason}${closeResult.balanceRaw ? ` balanceRaw=${closeResult.balanceRaw}` : ""}`);
        }
      } catch (closeError) {
        console.warn(`CLOSE ATA FAILED ${mintAddress}: ${closeError.message}`);
      }
    }

    const proceeds = txSol.grossPositiveLamports > 0 ? lamportsToSol(txSol.grossPositiveLamports) : lamportsToSol(expectedSol);
    const pnl = proceeds - costPortion;

    position.realizedPnl = Number(position.realizedPnl || 0) + pnl;
    position.remaining = Math.max(0, remaining - actualSoldFraction);
    position.lastSellSignature = signature;
    position.lastSellProceedsSol = proceeds;
    position.lastSellFeeSol = lamportsToSol(txSol.feeLamports);

    addTrade({ ts: Date.now(), side: "SELL", mint: mintAddress, name: position.name, symbol: position.symbol, sol: proceeds, price: position.mcapSol || position.entry || 0, signature, mode: "LIVE", pnl, reason });

    if (position.remaining <= 0.000001) this.positions.delete(mintAddress);
    return {
      ok: true,
      mode: "LIVE",
      mint: mintAddress,
      proceedsSol: proceeds,
      pnl,
      fraction: actualSoldFraction,
      remaining: position.remaining,
      reason,
      route,
      signature,
      close: closeResult,
    };
  }

  lock() {
    this.locked = true;
    config.live = false;
    this.liveTrading = false;
  }

  unlock() {
    if (this.wallet) {
      this.locked = false;
      config.live = true;
      this.liveTrading = true;
    }
  }

  getPosition(mint) {
    return this.positions.get(normalizeMint(mint).address);
  }

  getPositions() {
    return [...this.positions.values()];
  }

  getStats() {
    return {
      liveTrading: this.liveTrading,
      wallet: this.wallet?.publicKey?.toBase58?.() || null,
      paperSol: this.paperSol,
      openPositions: this.getOpenPositionsCount(),
      exposureSol: this.getExposureSol(),
      realizedPnl24h: todayPnl(),
      tradesLastHour: tradesLastHour(),
      rpcPool: this.rpcPool.stats(),
    };
  }
}

export const Executor = ExecutionEngine;
export default ExecutionEngine;
