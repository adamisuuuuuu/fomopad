import postgres from "postgres@3.4.7";
import nacl from "tweetnacl@1.0.3";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js@1.98.4";
import { createCipheriv, createDecipheriv, createHash, generateKeyPair, randomBytes } from "node:crypto";
import { PUMP_SDK } from "@pump-fun/pump-sdk";
import * as DBC from "@meteora-ag/dynamic-bonding-curve-sdk@1.5.13";
import BN from "bn.js@5.2.2";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token@0.4.13";
import {
  getPdaLaunchpadAuth, getPdaLaunchpadConfigId, getPdaLaunchpadPoolId, getPdaLaunchpadVaultId,
  getPdaPlatformAllowConfig, getPdaPlatformCurveRule, initializeWithToken2022,
  getPdaCreatorVault, getPdaCreatorFeeVaultAuth, claimCreatorFee, LaunchpadPool, PlatformConfig, LAUNCHPAD_PROGRAM,
} from "@raydium-io/raydium-sdk-v2@0.2.74-alpha";

const PORT = Number(Bun.env.PORT || 3000);
const RPC = Bun.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const DBC_PROGRAM = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const STONK_API = "https://www.stonkfun.xyz/api/public/v1";
const STONK_V2 = "https://www.stonkfun.xyz/api/v2";
const COMPUTE_BUDGET_PROGRAM = ComputeBudgetProgram.programId.toBase58();
const DBC_THRESHOLD_SOL = 88.576623265;
const REWARD_AUTHORITY = Bun.env.FOMOPAD_REWARD_AUTHORITY ? new PublicKey(Bun.env.FOMOPAD_REWARD_AUTHORITY).toBase58() : null;
const REWARD_RESERVE = 10_000_000n;
const REWARDS_ENABLED = Bun.env.FOMOPAD_REWARDS_ENABLED === "true" && !!REWARD_AUTHORITY;
const MINT_KEY = Bun.env.MINT_ENCRYPTION_KEY ? Buffer.from(Bun.env.MINT_ENCRYPTION_KEY, "hex") : null;
if (MINT_KEY && MINT_KEY.length !== 32) throw new Error("MINT_ENCRYPTION_KEY must be 32 bytes in hex");
const db = Bun.env.DATABASE_URL ? postgres(Bun.env.DATABASE_URL, { max: 5, idle_timeout: 20 }) : null;
const rpc = new Connection(RPC, "confirmed");
const hits = new Map<string, { count: number; reset: number }>();
const markets = new Map<string, { expires: number; value: any }>();
const curves = new Map<string, { expires: number; value: any }>();
const candleCache = new Map<string, { expires: number; value: any }>();
let mintReplenishment: Promise<void> | null = null;
const candlePeriods: Record<string, { timeframe: string; aggregate: number }> = {
  "1m": { timeframe: "minute", aggregate: 1 },
  "5m": { timeframe: "minute", aggregate: 5 },
  "15m": { timeframe: "minute", aggregate: 15 },
  "1h": { timeframe: "hour", aggregate: 1 },
  "4h": { timeframe: "hour", aggregate: 4 },
  "1d": { timeframe: "day", aggregate: 1 },
};

if (db) {
  await db`
    CREATE TABLE IF NOT EXISTS launches (
      mint text PRIMARY KEY,
      creator text NOT NULL,
      name text NOT NULL,
      symbol text NOT NULL,
      description text NOT NULL DEFAULT '',
      website text NOT NULL DEFAULT '',
      x_url text NOT NULL DEFAULT '',
      telegram text NOT NULL DEFAULT '',
      image bytea NOT NULL,
      image_type text NOT NULL,
      payload_hash text NOT NULL,
      status text NOT NULL DEFAULT 'draft',
      signature text UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      launched_at timestamptz
    )
  `;
  await db`CREATE INDEX IF NOT EXISTS launches_recent ON launches (launched_at DESC) WHERE status = 'live'`;
  await db`ALTER TABLE launches ADD COLUMN IF NOT EXISTS protocol text NOT NULL DEFAULT 'Pump'`;
  await db`ALTER TABLE launches ADD COLUMN IF NOT EXISTS config text`;
  await db`ALTER TABLE launches ADD COLUMN IF NOT EXISTS pool text`;
  await db`ALTER TABLE launches ADD COLUMN IF NOT EXISTS initial_cap_sol numeric`;
  await db`ALTER TABLE launches ADD COLUMN IF NOT EXISTS reward_mode boolean NOT NULL DEFAULT false`;
  await db`ALTER TABLE launches ADD COLUMN IF NOT EXISTS reward_scope text NOT NULL DEFAULT 'holders'`;
  await db`ALTER TABLE launches ADD COLUMN IF NOT EXISTS quote_mint text`;
  await db`ALTER TABLE launches ADD COLUMN IF NOT EXISTS platform text`;
  await db`ALTER TABLE launches ADD COLUMN IF NOT EXISTS reward_tick_at timestamptz`;
  await db`CREATE TABLE IF NOT EXISTS reward_proofs (
    signature text NOT NULL, mint text NOT NULL REFERENCES launches(mint),
    wallet text NOT NULL, bought_at timestamptz NOT NULL, verified_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (signature,mint,wallet)
  )`;
  await db`CREATE INDEX IF NOT EXISTS reward_proofs_mint_wallet ON reward_proofs (mint, wallet)`;
  await db`ALTER TABLE reward_proofs ADD COLUMN IF NOT EXISTS bought_amount numeric NOT NULL DEFAULT 0`;
  await db`CREATE TABLE IF NOT EXISTS reward_scans (
    mint text PRIMARY KEY REFERENCES launches(mint),
    anchor_signature text, window_head text, before_signature text,
    completed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
  )`;
  await db`CREATE TABLE IF NOT EXISTS reward_epochs (
    id bigserial PRIMARY KEY, mint text NOT NULL REFERENCES launches(mint),
    claim_signature text NOT NULL UNIQUE, claim_raw text NOT NULL,
    claim_last_valid_height bigint NOT NULL, claimed_lamports bigint,
    status text NOT NULL DEFAULT 'claim-pending',
    created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
  )`;
  await db`CREATE INDEX IF NOT EXISTS reward_epochs_open ON reward_epochs (mint) WHERE status <> 'complete'`;
  await db`CREATE TABLE IF NOT EXISTS reward_allocations (
    epoch_id bigint NOT NULL REFERENCES reward_epochs(id), wallet text NOT NULL,
    lamports bigint NOT NULL, status text NOT NULL DEFAULT 'pending',
    payout_signature text UNIQUE, payout_raw text, payout_last_valid_height bigint,
    paid_at timestamptz, PRIMARY KEY (epoch_id, wallet)
  )`;
  await db`CREATE TABLE IF NOT EXISTS auth_challenges (nonce_hash text PRIMARY KEY, wallet text NOT NULL, expires_at timestamptz NOT NULL)`;
  await db`CREATE TABLE IF NOT EXISTS auth_sessions (token_hash text PRIMARY KEY, wallet text NOT NULL, expires_at timestamptz NOT NULL)`;
  await db`CREATE INDEX IF NOT EXISTS auth_sessions_wallet ON auth_sessions (wallet)`;
  await db`CREATE TABLE IF NOT EXISTS vanity_mints (
    mint text PRIMARY KEY,
    secret_cipher bytea,
    secret_iv bytea,
    reserved_by text,
    reserved_at timestamptz,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await db`CREATE INDEX IF NOT EXISTS vanity_mints_ready ON vanity_mints (created_at) WHERE reserved_by IS NULL AND consumed_at IS NULL`;
  await db`CREATE TABLE IF NOT EXISTS vanity_waitlist (
    wallet text PRIMARY KEY,
    requested_at timestamptz NOT NULL DEFAULT now()
  )`;
  await db`CREATE TABLE IF NOT EXISTS launch_identities (
    kind text NOT NULL, key text NOT NULL, mint text NOT NULL REFERENCES launches(mint) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(kind,key)
  )`;
  await db`CREATE INDEX IF NOT EXISTS launch_identities_mint ON launch_identities (mint)`;
  // Claim identities for launches made before the registry existed. The public board
  // already contains their immutable mint receipts; never silently rename them.
  const existing = await db`SELECT mint, symbol, image FROM launches WHERE status = 'live' ORDER BY launched_at ASC`;
  for (const r of existing) {
    const key = tickerKey(r.symbol);
    if (key) await db`INSERT INTO launch_identities (kind,key,mint) VALUES ('ticker',${key},${r.mint}) ON CONFLICT DO NOTHING`;
    const imageKey = createHash("sha256").update(r.image).digest("hex");
    await db`INSERT INTO launch_identities (kind,key,mint) VALUES ('image',${imageKey},${r.mint}) ON CONFLICT DO NOTHING`;
  }
}

function json(data: unknown, status = 200, more: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type,authorization", ...more } });
}
function fail(message: string, status = 400) { return json({ error: message }, status); }
// A Fomopad-only ticker registry. Fold common visual substitutes before removing
// separators, so P3PE, P-E-P-E and the usual Cyrillic lookalikes cannot race PEPE.
function tickerKey(value: string) {
  const lookalikes: Record<string,string> = {
    "0":"o","1":"i","3":"e","4":"a","5":"s","7":"t","8":"b",
    "а":"a","в":"b","е":"e","к":"k","м":"m","н":"h","о":"o","р":"p","с":"c","т":"t","у":"y","х":"x","і":"i","ј":"j",
    "α":"a","β":"b","ε":"e","ι":"i","κ":"k","ο":"o","ρ":"p","τ":"t","υ":"u","χ":"x"
  };
  return value.normalize("NFKD").toLowerCase().replace(/[\u0300-\u036f]/g,"").split("").map(c=>lookalikes[c] || c).join("").replace(/[^a-z0-9]/g,"");
}
const imageDigest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function address(s: unknown) { if (typeof s !== "string" || s.length < 32 || s.length > 44) throw new Error("Invalid Solana address"); return new PublicKey(s); }
function mintAddress(s: unknown) { const p = address(s); if (!p.toBase58().endsWith("fomo")) throw new Error("Mint address must end in fomo"); return p; }
function safeUrl(s: unknown) {
  if (!s) return "";
  if (typeof s !== "string" || s.length > 250) throw new Error("Invalid URL");
  const u = new URL(s);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) throw new Error("Only public http(s) URLs are accepted");
  return u.toString();
}
function base58(bytes: Uint8Array) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let out = "";
  while (value > 0n) { out = alphabet[Number(value % 58n)] + out; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; out = "1" + out; }
  return out;
}
function base58Bytes(encoded: string) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const char of encoded) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error("Invalid base58 transaction data");
    value = value * 58n + BigInt(digit);
  }
  const hex = value === 0n ? "" : value.toString(16).padStart(Math.ceil(value.toString(16).length / 2) * 2, "0");
  return Buffer.concat([Buffer.alloc(encoded.match(/^1*/)?.[0].length || 0), Buffer.from(hex,"hex")]);
}
function receiptMessage(message: any) {
  const keyObjects = message.staticAccountKeys || message.accountKeys;
  const raw = message.compiledInstructions || message.instructions;
  if (!Array.isArray(keyObjects) || !Array.isArray(raw)) throw new Error("Unsupported transaction receipt format");
  const keys = keyObjects.map((key: PublicKey) => key.toBase58());
  const instructions = raw.map((ix: any) => ({programIdIndex:ix.programIdIndex,
    accounts:ix.accountKeyIndexes || ix.accounts,
    data:typeof ix.data === "string" ? base58Bytes(ix.data) : Buffer.from(ix.data)}));
  return {keys,instructions};
}
function rate(req: Request, label: string, max: number, period: number) {
  const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0] || "unknown";
  const key = label + ":" + ip;
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) { hits.set(key, { count: 1, reset: now + period }); return; }
  if (++h.count > max) throw new Error("Too many requests. Please try again later.");
}
async function body(req: Request) {
  if (Number(req.headers.get("content-length") || 0) > 950_000) throw new Error("Request too large");
  const raw = await req.text();
  if (raw.length > 950_000) throw new Error("Request too large");
  return JSON.parse(raw);
}
function origin(req: Request) { return Bun.env.PUBLIC_API_ORIGIN || new URL(req.url).origin; }
async function sha256(value: string) { return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex"); }
function authMessage(wallet: string, nonce: string) { return `Sign in to Fomopad\nDomain: fomopad.name\nWallet: ${wallet}\nNonce: ${nonce}\nThis signature does not submit a transaction or spend SOL.`; }
async function signedInWallet(req: Request) {
  const token = req.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) return null;
  const hash = await sha256(token);
  const sessions = await db!`SELECT wallet FROM auth_sessions WHERE token_hash = ${hash} AND expires_at > now() LIMIT 1`;
  return sessions[0]?.wallet || null;
}
function mintSigner(record: any) {
  if (!MINT_KEY || !record?.secret_cipher || !record?.secret_iv) throw new Error("Reserved mint signer is unavailable");
  const bytes = Buffer.from(record.secret_cipher), iv = Buffer.from(record.secret_iv);
  if (iv.length !== 12 || bytes.length !== 80) throw new Error("Reserved mint data is invalid");
  const decipher = createDecipheriv("aes-256-gcm", MINT_KEY, iv);
  decipher.setAuthTag(bytes.subarray(-16));
  const secret = Buffer.concat([decipher.update(bytes.subarray(0,-16)), decipher.final()]);
  const signer = Keypair.fromSecretKey(Uint8Array.from(secret));
  secret.fill(0);
  if (signer.publicKey.toBase58() !== record.mint || !record.mint.endsWith("fomo")) throw new Error("Reserved mint key mismatch");
  return signer;
}
async function generatePreparedMint() {
  if (!db || !MINT_KEY) return;
  let attempts = 0;
  while (true) {
    const keys: any = await new Promise((resolve, reject) => generateKeyPair("ed25519", (error, publicKey, privateKey) => error ? reject(error) : resolve({ publicKey, privateKey })));
    const spki = Buffer.from(keys.publicKey.export({ format:"der", type:"spki" }));
    const pkcs8 = Buffer.from(keys.privateKey.export({ format:"der", type:"pkcs8" }));
    if (spki.length !== 44 || pkcs8.length !== 48) throw new Error("Unexpected Ed25519 key encoding");
    const publicBytes = spki.subarray(-32);
    const mint = base58(publicBytes);
    attempts++;
    if (!mint.endsWith("fomo")) continue;
    const secret = Buffer.concat([pkcs8.subarray(-32), publicBytes]);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", MINT_KEY, iv);
    const encrypted = Buffer.concat([cipher.update(secret), cipher.final(), cipher.getAuthTag()]);
    secret.fill(0);
    await db`INSERT INTO vanity_mints (mint,secret_cipher,secret_iv) VALUES (${mint},${encrypted},${iv}) ON CONFLICT (mint) DO NOTHING`;
    console.log("Prepared fomo mint on demand", mint, "after", attempts, "candidates");
    return;
  }
}
function ensureMintStock() {
  if (!db || !MINT_KEY || mintReplenishment) return;
  mintReplenishment = (async () => {
    const count = await db`SELECT count(*)::int AS ready FROM vanity_mints WHERE reserved_by IS NULL AND consumed_at IS NULL`;
    if (count[0].ready >= 8) return;
    await Promise.all([generatePreparedMint(), generatePreparedMint(), generatePreparedMint(), generatePreparedMint()]);
  })().catch(error => console.error("On-demand fomo mint replenishment failed", error)).finally(() => { mintReplenishment = null; });
}
async function stonkGet(path: string, v2 = false) {
  const response = await fetch((v2 ? STONK_V2 : STONK_API) + path, {
    headers: { accept: "application/json", "user-agent": "Fomopad/1.0" },
    signal: AbortSignal.timeout(8_000),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(value?.error?.message || value?.error || `Stonk.fun API returned ${response.status}`);
  return v2 ? value : value?.data;
}
async function stonkTerms() {
  const [pairData, pricing] = await Promise.all([
    stonkGet("/pairs?launchable=true&launchLabReady=true"),
    stonkGet(`/launchlab/pricing?quoteMint=${SOL_MINT.toBase58()}`),
  ]);
  const pair = pairData?.pairs?.find((item: any) => item.mint === SOL_MINT.toBase58());
  if (!pair?.tokenProgram || !pricing?.curve?.programId || !pricing?.curve?.configId || !pricing?.platform?.standard ||
      !pricing?.allowConfig?.standard || !pricing?.curveRule?.standard || !pricing?.raise?.raw ||
      pricing?.allowConfig?.available?.standard === false ||
      !pricing?.curve?.supply || !pricing?.curve?.totalSellA || !Number.isInteger(pricing?.curve?.baseDecimals)) {
    throw new Error("Stonk.fun SOL launches are not available right now");
  }
  return { pair, pricing };
}
function row(r: any) {
  return { mint: r.mint, creator: r.creator, name: r.name, symbol: r.symbol, description: r.description, website: r.website, x: r.x_url, telegram: r.telegram, image: `${Bun.env.PUBLIC_API_ORIGIN || ""}/images/${r.mint}`, signature: r.signature, createdAt: r.created_at, launchedAt: r.launched_at, status: r.status, protocol: r.protocol || "Pump", config: r.config, pool: r.pool, platform: r.platform, quoteMint: r.quote_mint, rewardMode: !!r.reward_mode, rewardScope: r.reward_mode ? (r.reward_scope || "holders") : "creator", initialCapSol: r.initial_cap_sol ? Number(r.initial_cap_sol) : null, migrationThresholdSol: r.protocol === "DBC" ? DBC_THRESHOLD_SOL : null };
}
function dbcCurve(initialCapSol: number, rewardMode = false) {
  const ratio = DBC_THRESHOLD_SOL / initialCapSol;
  const capRoot = (ratio + Math.sqrt(ratio * ratio + 4 * ratio)) / 2;
  const percentageSupplyOnMigration = 100 / (1 + capRoot);
  const curve = DBC.buildCurve({
    token: { tokenType: DBC.TokenType.SPLToken, tokenBaseDecimal: DBC.TokenDecimal.SIX, tokenQuoteDecimal: 9, tokenAuthorityOption: DBC.TokenAuthorityOption.Immutable, totalTokenSupply: 1_000_000_000, leftover: 0 },
    fee: { baseFeeParams: { baseFeeMode: DBC.BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 } }, dynamicFeeEnabled: false, collectFeeMode: DBC.CollectFeeMode.QuoteToken, creatorTradingFeePercentage: rewardMode ? 0 : 100, poolCreationFee: 0, enableFirstSwapWithMinFee: false },
    migration: { migrationOption: DBC.MigrationOption.MET_DAMM_V2, migrationFeeOption: DBC.MigrationFeeOption.FixedBps200, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
    liquidityDistribution: { partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 100 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: DBC.ActivationType.Timestamp,
    percentageSupplyOnMigration,
    migrationQuoteThreshold: DBC_THRESHOLD_SOL,
  });
  if (!curve.migrationQuoteThreshold.eq(DBC.convertToLamports(DBC_THRESHOLD_SOL, 9))) throw new Error("Curve threshold mismatch");
  return curve;
}
async function marketFor(mint: string) {
  const cached = markets.get(mint);
  if (cached && cached.expires > Date.now()) return cached.value;
  let value = null;
  try {
    const response = await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${mint}`, { signal: AbortSignal.timeout(4500) });
    if (response.ok) {
      const pairs = await response.json();
      const matching = Array.isArray(pairs) ? pairs.filter((p: any) => p.chainId === "solana" && p.baseToken?.address === mint) : [];
      matching.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
      if (matching[0]) {
        const p = matching[0];
        value = { source: "DEX Screener", priceUsd: p.priceUsd ? Number(p.priceUsd) : null, liquidityUsd: p.liquidity?.usd ?? null, volume24hUsd: p.volume?.h24 ?? null, change24hPct: p.priceChange?.h24 ?? null, marketCapUsd: p.marketCap ?? null, buys24h: p.txns?.h24?.buys ?? null, sells24h: p.txns?.h24?.sells ?? null, pair: p.pairAddress, url: p.url };
      }
    }
  } catch { /* A missing or delayed index is represented as null. */ }
  markets.set(mint, { expires: Date.now() + 30_000, value });
  return value;
}
async function boardCurveFor(r: any) {
  if (r.protocol !== "DBC" || !r.pool) return null;
  const cached = curves.get(r.mint);
  if (cached && cached.expires > Date.now()) return cached.value;
  let value = null;
  try {
    const client = new DBC.DynamicBondingCurveClient(rpc, "confirmed");
    const state = await client.state.getPool(new PublicKey(r.pool));
    if (state?.poolState.baseMint.toBase58() === r.mint && state.poolState.config.toBase58() === r.config) {
      const reserveSol = Number(state.poolState.quoteReserve.toString()) / 1e9;
      value = { progressPercent: Math.min(100, Math.max(0, reserveSol / DBC_THRESHOLD_SOL * 100)), quoteReserveSol:reserveSol, migrated:Number(state.poolState.isMigrated) !== 0 };
    }
  } catch { /* Unknown is distinct from zero progress. */ }
  curves.set(r.mint, { expires: Date.now() + 45_000, value });
  return value;
}

async function rewardStatus(mint: string) {
  const launch = await db!`SELECT mint, pool, reward_mode, reward_scope FROM launches WHERE mint = ${mint} AND status = 'live' LIMIT 1`;
  if (!launch.length) throw new Error("Verified launch not found");
  if (!launch[0].reward_mode) return { enabled: false };
  const [proofs, epochs, payouts, scans, poolState] = await Promise.all([
    db!`SELECT count(DISTINCT wallet)::int AS holders FROM reward_proofs WHERE mint = ${mint}`,
    db!`SELECT id, status, claim_signature, claimed_lamports, created_at FROM reward_epochs WHERE mint = ${mint} ORDER BY id DESC LIMIT 10`,
    db!`SELECT a.wallet, a.lamports, a.status, a.payout_signature, a.paid_at, a.epoch_id FROM reward_allocations a JOIN reward_epochs e ON e.id = a.epoch_id WHERE e.mint = ${mint} ORDER BY a.epoch_id DESC LIMIT 100`,
    db!`SELECT completed_at,window_head FROM reward_scans WHERE mint = ${mint}`,
    new DBC.DynamicBondingCurveClient(rpc, "confirmed").state.getPool(new PublicKey(launch[0].pool)),
  ]);
  return { enabled: true, scope: "DBC bonding fees", rewardScope: launch[0].reward_scope || "holders", eligibility: launch[0].reward_scope === "traders" ? "Verified Fomo buyers of this coin, weighted by cumulative verified buy amount" : "Verified Fomo buyers of this coin who still hold it, weighted by current balance", verifiedWallets: proofs[0].holders,
    unclaimedQuoteLamports: poolState.poolState.partnerQuoteFee.toString(), authority: REWARD_AUTHORITY,
    lastIndexedAt: scans[0]?.completed_at || null, indexing: !!scans[0]?.window_head,
    epochs: epochs.map((r: any) => ({ id: String(r.id), status: r.status, claimSignature: r.claim_signature, claimedLamports: r.claimed_lamports === null ? null : String(r.claimed_lamports), createdAt: r.created_at })),
    payouts: payouts.map((r: any) => ({ wallet: r.wallet, lamports: String(r.lamports), status: r.status, signature: r.payout_signature, paidAt: r.paid_at, epoch: String(r.epoch_id) })) };
}
const CREATOR_CLAIM_DISCRIMINATOR = Buffer.from([82,220,250,189,3,85,107,45]);
const STONK_CREATOR_CLAIM_DISCRIMINATOR = Buffer.from([26,97,138,203,132,171,141,252]);
async function creatorFees(mint: string) {
  const records = await db!`SELECT mint,creator,pool,config,platform,quote_mint,protocol,reward_mode FROM launches WHERE mint = ${mint} AND status = 'live' LIMIT 1`;
  if (!records.length) throw new Error("Verified launch not found");
  const launch = records[0];
  if (launch.protocol === "STONK") {
    if (!launch.pool || !launch.platform || launch.quote_mint !== SOL_MINT.toBase58()) throw new Error("Stonk.fun launch accounts are incomplete");
    const poolKey = new PublicKey(launch.pool), platformKey = new PublicKey(launch.platform), creator = new PublicKey(launch.creator);
    const [poolAccount, platformAccount] = await Promise.all([rpc.getAccountInfo(poolKey,"confirmed"),rpc.getAccountInfo(platformKey,"confirmed")]);
    if (!poolAccount?.owner.equals(LAUNCHPAD_PROGRAM) || !platformAccount?.owner.equals(LAUNCHPAD_PROGRAM)) throw new Error("Stonk.fun pool or platform program does not match Raydium LaunchLab");
    const pool = LaunchpadPool.decode(poolAccount.data), platform = PlatformConfig.decode(platformAccount.data);
    if (!pool.mintA.equals(new PublicKey(mint)) || !pool.mintB.equals(SOL_MINT) || !pool.creator.equals(creator) || !pool.platformId.equals(platformKey) || !pool.configId.equals(new PublicKey(launch.config)) || !getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM,new PublicKey(mint),SOL_MINT).publicKey.equals(poolKey)) throw new Error("Stonk.fun creator fee route does not match the verified pool");
    const vault = getPdaCreatorVault(LAUNCHPAD_PROGRAM,creator,SOL_MINT).publicKey;
    const vaultAuth = getPdaCreatorFeeVaultAuth(LAUNCHPAD_PROGRAM).publicKey;
    const receiver = getAssociatedTokenAddressSync(SOL_MINT,creator,false,TOKEN_PROGRAM_ID);
    let amount = 0n;
    try {
      const account = await getAccount(rpc,vault,"confirmed",TOKEN_PROGRAM_ID);
      if (!account.mint.equals(SOL_MINT) || !account.owner.equals(vaultAuth)) throw new Error("Stonk.fun creator fee vault has unexpected ownership");
      amount = account.amount;
    } catch (error: any) {
      if (error?.name !== "TokenAccountNotFoundError") throw error;
    }
    const venueFees = await stonkGet(`/tokens/${mint}/fees`).catch(() => null);
    if (!venueFees) return { mode:"unavailable", rail:"Stonk.fun", creator:launch.creator, claimableQuoteLamports:"0", explanation:"Stonk.fun fee status is temporarily unavailable. Check again before preparing any claim." };
    if (!venueFees.claimable) return { mode:"automatic", rail:"Stonk.fun / Raydium LaunchLab", creator:launch.creator, claimableQuoteLamports:"0", explanation:venueFees.reason || "Stonk.fun forwards this LaunchLab creator share to the creator wallet automatically. No wallet claim is required." };
    if ((venueFees.claimable.scope || venueFees.scope) !== "creator-quote-vault") return { mode:"unavailable", rail:"Stonk.fun", creator:launch.creator, claimableQuoteLamports:"0", explanation:"This Stonk.fun fee route does not have a verified LaunchLab creator vault to claim on Fomopad." };
    return { mode:"stonk-claim", rail:"Stonk.fun / Raydium LaunchLab", creator:launch.creator, pool:launch.pool, program:LAUNCHPAD_PROGRAM.toBase58(), vault:vault.toBase58(), receiver:receiver.toBase58(), quoteMint:SOL_MINT.toBase58(), creatorFeeRate:platform.creatorFeeRate.toString(), claimableQuoteLamports:amount.toString(), scope:"shared-creator-vault", explanation:"Stonk.fun LaunchLab creator fees accrue in one wrapped-SOL vault shared by this wallet's SOL-pair Stonk launches. One claim sweeps the available vault balance into the creator's wrapped-SOL token account; network fees and token-account rent may apply." };
  }
  if (launch.protocol !== "DBC") return { mode:"external", creator:launch.creator, claimableQuoteLamports:"0", explanation:"Fee claims for this legacy rail are not managed by Fomopad." };
  if (launch.reward_mode) return { mode:"distribution", creator:launch.creator, claimableQuoteLamports:"0", explanation:"Fomopad automatically claims and distributes this DBC fee share to eligible Fomo traders." };
  const client = new DBC.DynamicBondingCurveClient(rpc,"confirmed");
  const [pool,config] = await Promise.all([client.state.getPool(new PublicKey(launch.pool)),client.state.getPoolConfig(new PublicKey(launch.config))]);
  if (!pool || !config || pool.poolState.baseMint.toBase58() !== mint || pool.poolState.config.toBase58() !== launch.config || pool.poolState.creator.toBase58() !== launch.creator || config.feeClaimer.toBase58() !== launch.creator || Number(config.creatorTradingFeePercentage) !== 100 || !config.quoteMint.equals(SOL_MINT)) throw new Error("Creator fee route does not match the verified pool");
  return { mode:"claim", rail:"Meteora DBC", creator:launch.creator, pool:launch.pool, claimableQuoteLamports:pool.poolState.creatorQuoteFee.toString(), quoteMint:SOL_MINT.toBase58(), explanation:"Claim accrued DBC bonding fees to the creator wallet. Wallet approval and network fees are required." };
}
// A cycle is persisted before broadcasting. Retrying sends the same signed transaction.
// One call advances one stage; a cron and any visitor may advance the same cycle safely.
Bun.serve({
  port: PORT,
  async fetch(req) {
    try {
      if (req.method === "OPTIONS") return json({}, 204);
      const u = new URL(req.url);
      const path = u.pathname;
      if (path === "/health") {
        if (!db) return fail("Database is not configured", 503);
        await db`SELECT 1`;
        return json({ ok: true, database: true, chain: "solana-mainnet", protocols: ["meteora-dbc", "stonk-launchlab"], rewards: REWARDS_ENABLED ? "bonding-fee-mode" : "unavailable" });
      }
      if (path === "/api/config") return json({ chain: "solana-mainnet", protocols: ["Meteora DBC", "Stonk.fun / Raydium LaunchLab"], suffix: "fomo", minInitialMarketCapSol: 30, migrationQuoteThresholdSol: DBC_THRESHOLD_SOL, tradingFeeBps: 100, graduation: "DAMM v2", fomoOnlyRewards: REWARDS_ENABLED ? "opt-in-dbc-bonding-fees" : "unavailable", rewardVaultAuthority: REWARD_AUTHORITY });
      if (path === "/api/stonk/terms" && req.method === "GET") {
        const { pair, pricing } = await stonkTerms();
        return json({ available: true, quote: { mint: pair.mint, symbol: pair.symbol || "SOL", tokenProgram: pair.tokenProgram }, mode: "standard", program: pricing.curve.programId, config: pricing.curve.configId, platform: pricing.platform.standard, openingMarketCap: pricing.marketCap?.startQuote || null, graduationMarketCap: pricing.marketCap?.graduationQuote || null, raiseRaw: pricing.raise.raw, raiseSol: pricing.raise.units || null });
      }
      if (path === "/api/rewards/vault" && req.method === "GET") {
        const balance = REWARD_AUTHORITY ? await rpc.getBalance(new PublicKey(REWARD_AUTHORITY), "confirmed") : 0;
        return json({ chain: "solana-mainnet", authority: REWARD_AUTHORITY, balanceLamports: balance,
          state: !REWARDS_ENABLED ? "unavailable" : BigInt(balance) >= REWARD_RESERVE + 10_000_000n ? "ready" : "needs-funding",
          minimumOperatingLamports: String(REWARD_RESERVE + 10_000_000n),
          feeRouting: "creator-opt-in", deposits: "operating SOL only", payouts: "verified Fomo trade wallets after a bonding-fee claim",
          scope: "DBC bonding fees before migration; DAMM v2 fees remain with the creator's locked liquidity",
          explanation: "Only new opt-in launches route their bonding-curve fee share to this authority. The authority needs SOL for claim and payout transaction fees. Do not send launch or trading funds here." });
      }
      if (!db) return fail("Database is not configured", 503);
      if (path === "/api/activity" && req.method === "GET") {
        const [launches, payouts] = await Promise.all([
          db`SELECT mint, name, symbol, creator, protocol, signature, launched_at FROM launches WHERE status = 'live' ORDER BY launched_at DESC LIMIT 25`,
          db`SELECT e.mint, a.wallet, a.lamports, a.payout_signature, a.paid_at FROM reward_allocations a JOIN reward_epochs e ON e.id = a.epoch_id WHERE a.status = 'paid' AND a.payout_signature IS NOT NULL ORDER BY a.paid_at DESC LIMIT 25`
        ]);
        const events = [...launches.map((r: any) => ({type:"launch",mint:r.mint,name:r.name,symbol:r.symbol,wallet:r.creator,protocol:r.protocol,signature:r.signature,at:r.launched_at})), ...payouts.map((r: any) => ({type:"reward",mint:r.mint,wallet:r.wallet,amountLamports:String(r.lamports),signature:r.payout_signature,at:r.paid_at}))]
          .filter(e => e.at).sort((a,b) => new Date(b.at).getTime()-new Date(a.at).getTime()).slice(0,30);
        return json({events,scope:"verified launches and paid Fomo reward receipts",updatedAt:new Date().toISOString()});
      }
      const walletRewards = path.match(/^\/api\/wallet\/([^/]+)\/rewards$/);
      if (walletRewards && req.method === "GET") {
        const owner = address(walletRewards[1]).toBase58();
        const [proofs, allocations] = await Promise.all([
          db`SELECT p.mint, l.name, l.symbol, l.reward_scope, SUM(p.bought_amount)::text AS bought_amount, MAX(p.bought_at) AS last_seen_at FROM reward_proofs p JOIN launches l ON l.mint=p.mint WHERE p.wallet=${owner} AND l.status='live' GROUP BY p.mint,l.name,l.symbol,l.reward_scope ORDER BY last_seen_at DESC LIMIT 50`,
          db`SELECT e.mint, a.lamports, a.status, a.payout_signature, a.paid_at FROM reward_allocations a JOIN reward_epochs e ON e.id=a.epoch_id WHERE a.wallet=${owner} ORDER BY e.id DESC LIMIT 100`
        ]);
        return json({wallet:owner,verifiedBuys:proofs.map((r:any)=>({mint:r.mint,name:r.name,symbol:r.symbol,rewardScope:r.reward_scope,boughtAmount:String(r.bought_amount),lastSeenAt:r.last_seen_at})),allocations:allocations.map((r:any)=>({mint:r.mint,lamports:String(r.lamports),status:r.status,signature:r.payout_signature,paidAt:r.paid_at})),note:"Historical verified buys do not guarantee future holder payouts; holder balances are checked at each reward snapshot."});
      }
      const rewardRoute = path.match(/^\/api\/rewards\/([^/]+)\/status$/);
      if (rewardRoute) {
        const mint = mintAddress(rewardRoute[1]).toBase58();
        if (req.method === "GET") return json(await rewardStatus(mint));
      }
      const creatorFeeRoute = path.match(/^\/api\/creator-fees\/([^/]+)(?:\/(prepare|confirm))?$/);
      if (creatorFeeRoute) {
        const mint = mintAddress(creatorFeeRoute[1]).toBase58();
        const action = creatorFeeRoute[2];
        if (!action && req.method === "GET") return json(await creatorFees(mint));
        if (req.method !== "POST" || !["prepare","confirm"].includes(action)) return fail("Unsupported fee claim action",405);
        rate(req,"creator-fees-" + action,20,3_600_000);
        const sessionWallet = await signedInWallet(req);
        if (!sessionWallet) return fail("Sign in with the creator wallet first",401);
        // A successful Stonk claim can empty its shared vault. Confirm against the
        // immutable live launch and transaction receipt rather than requiring its
        // balance to remain claimable after the wallet has already submitted it.
        const stonkLaunch = action === "confirm" ? await db`SELECT creator,protocol FROM launches WHERE mint=${mint} AND status='live' LIMIT 1` : [];
        const state = stonkLaunch[0]?.protocol === "STONK" ? {
          mode:"stonk-claim", creator:stonkLaunch[0].creator,
          program:LAUNCHPAD_PROGRAM.toBase58(),
          vault:getPdaCreatorVault(LAUNCHPAD_PROGRAM,new PublicKey(stonkLaunch[0].creator),SOL_MINT).publicKey.toBase58(),
          receiver:getAssociatedTokenAddressSync(SOL_MINT,new PublicKey(stonkLaunch[0].creator),false,TOKEN_PROGRAM_ID).toBase58(),
          quoteMint:SOL_MINT.toBase58(), claimableQuoteLamports:"0",
        } : await creatorFees(mint);
        if (!["claim","stonk-claim"].includes(state.mode) || state.creator !== sessionWallet) return fail("Only the launch creator wallet can claim fees",403);
        if (action === "prepare") {
          const amount = BigInt(state.claimableQuoteLamports);
          if (amount <= 0n) return fail("No creator fees have accrued yet",409);
          if (state.mode === "stonk-claim") {
            const creator = new PublicKey(state.creator), receiver = new PublicKey(state.receiver);
            const claimIx = claimCreatorFee(LAUNCHPAD_PROGRAM,creator,getPdaCreatorFeeVaultAuth(LAUNCHPAD_PROGRAM).publicKey,new PublicKey(state.vault),receiver,SOL_MINT,TOKEN_PROGRAM_ID);
            if (!Buffer.from(claimIx.data).equals(STONK_CREATOR_CLAIM_DISCRIMINATOR)) throw new Error("Unexpected Stonk.fun creator fee claim instruction");
            const block = await rpc.getLatestBlockhash("confirmed");
            const tx = new Transaction({feePayer:creator,recentBlockhash:block.blockhash}).add(
              createAssociatedTokenAccountIdempotentInstruction(creator,receiver,creator,SOL_MINT,TOKEN_PROGRAM_ID), claimIx,
            );
            return json({ mode:state.mode, transaction:tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString("base64"), blockhash:block.blockhash, lastValidBlockHeight:block.lastValidBlockHeight, program:state.program, pool:state.pool, vault:state.vault, creator:state.creator, receiver:state.receiver, quoteMint:state.quoteMint, estimatedQuoteLamports:amount.toString(), scope:state.scope });
          }
          const creator = new PublicKey(state.creator), pool = new PublicKey(state.pool);
          const client = new DBC.DynamicBondingCurveClient(rpc,"confirmed");
          const tx = await client.creator.claimCreatorTradingFeeToReceiver({creator,payer:creator,pool,receiver:creator,maxBaseAmount:new BN(0),maxQuoteAmount:new BN(amount.toString())});
          if (!tx.instructions.some(ix => ix.programId.equals(DBC_PROGRAM) && Buffer.from(ix.data).subarray(0,8).equals(CREATOR_CLAIM_DISCRIMINATOR))) throw new Error("Unexpected creator fee claim instruction");
          const block = await rpc.getLatestBlockhash("confirmed");
          tx.recentBlockhash = block.blockhash; tx.feePayer = creator;
          return json({ mode:state.mode, transaction:tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString("base64"), blockhash:block.blockhash, lastValidBlockHeight:block.lastValidBlockHeight, program:DBC_PROGRAM.toBase58(), pool:state.pool, creator:state.creator, receiver:state.creator, estimatedQuoteLamports:amount.toString() });
        }
        const input = await body(req);
        const sig = String(input.signature || "");
        if (base58Bytes(sig).length !== 64) throw new Error("Invalid Solana claim signature");
        const receipt = await rpc.getTransaction(sig,{commitment:"confirmed",maxSupportedTransactionVersion:0});
        if (!receipt) return json({status:"pending",signature:sig},202);
        if (receipt.meta?.err) return fail("Creator fee claim failed on Solana",422);
        const {keys,instructions} = receiptMessage(receipt.transaction.message);
        const signers = keys.slice(0,receipt.transaction.message.header.numRequiredSignatures);
        if (state.mode === "stonk-claim") {
          if (!signers.includes(state.creator) || !instructions.some(ix=>keys[ix.programIdIndex]===state.program && Buffer.from(ix.data).equals(STONK_CREATOR_CLAIM_DISCRIMINATOR) && ix.accounts.length===8 && keys[ix.accounts[0]]===state.creator && keys[ix.accounts[1]]===getPdaCreatorFeeVaultAuth(LAUNCHPAD_PROGRAM).publicKey.toBase58() && keys[ix.accounts[2]]===state.vault && keys[ix.accounts[3]]===state.receiver && keys[ix.accounts[4]]===state.quoteMint && keys[ix.accounts[5]]===TOKEN_PROGRAM_ID.toBase58() && keys[ix.accounts[6]]===SystemProgram.programId.toBase58() && keys[ix.accounts[7]]===ASSOCIATED_TOKEN_PROGRAM_ID.toBase58())) return fail("Stonk.fun claim receipt does not match this creator vault",422);
        } else if (!signers.includes(state.creator) || !keys.includes(state.pool) || !instructions.some(ix=>keys[ix.programIdIndex]===DBC_PROGRAM.toBase58() && Buffer.from(ix.data).subarray(0,8).equals(CREATOR_CLAIM_DISCRIMINATOR) && [...ix.accounts].some((i:number)=>keys[i]===state.pool))) return fail("Claim receipt does not match this coin and creator",422);
        return json({status:"confirmed",signature:sig,claimableQuoteLamports:state.claimableQuoteLamports});
      }

      if (path === "/api/auth/challenge" && req.method === "POST") {
        rate(req, "auth-challenge", 20, 3_600_000);
        const wallet = address((await body(req)).wallet).toBase58();
        const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");
        const hash = await sha256(nonce);
        await db`INSERT INTO auth_challenges (nonce_hash, wallet, expires_at) VALUES (${hash}, ${wallet}, now() + interval '5 minutes')`;
        return json({ wallet, nonce, message: authMessage(wallet, nonce), expiresInSeconds: 300 });
      }
      if (path === "/api/auth/verify" && req.method === "POST") {
        rate(req, "auth-verify", 30, 3_600_000);
        const input = await body(req);
        const wallet = address(input.wallet).toBase58();
        const nonce = String(input.nonce || ""), signature = String(input.signature || "");
        if (!/^[a-f0-9]{48}$/.test(nonce) || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) throw new Error("Invalid sign in proof");
        const hash = await sha256(nonce);
        const consumed = await db`DELETE FROM auth_challenges WHERE nonce_hash = ${hash} AND wallet = ${wallet} AND expires_at > now() RETURNING wallet`;
        if (!consumed.length) return fail("Sign in request expired or already used", 401);
        const valid = nacl.sign.detached.verify(new TextEncoder().encode(authMessage(wallet, nonce)), Buffer.from(signature,"base64"), new PublicKey(wallet).toBytes());
        if (!valid) return fail("Wallet signature did not match", 401);
        const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
        const tokenHash = await sha256(token);
        await db`INSERT INTO auth_sessions (token_hash, wallet, expires_at) VALUES (${tokenHash}, ${wallet}, now() + interval '7 days')`;
        return json({ wallet, token, expiresInSeconds: 604800 });
      }
      if (path === "/api/auth/me" && req.method === "GET") {
        const wallet = await signedInWallet(req);
        return wallet ? json({ wallet }) : fail("Session expired", 401);
      }
      if (path === "/api/auth/logout" && req.method === "POST") {
        const token = req.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
        if (token) { const hash = await sha256(token); await db`DELETE FROM auth_sessions WHERE token_hash = ${hash}`; }
        return json({ ok: true });
      }
      if (path === "/api/vanity/status" && req.method === "GET") {
        ensureMintStock();
        const rows = await db`SELECT count(*)::int AS ready FROM vanity_mints WHERE reserved_by IS NULL AND consumed_at IS NULL`;
        return json({ ready: rows[0].ready, suffix: "fomo", mode: "pre-generated" });
      }
      if (path === "/api/vanity/reserve" && req.method === "POST") {
        ensureMintStock();
        rate(req, "vanity-reserve", 20, 3_600_000);
        const wallet = await signedInWallet(req);
        if (!wallet) return fail("Sign in with your wallet to reserve an address", 401);
        const result = await db.begin(async sql => {
          await sql`SELECT pg_advisory_xact_lock(hashtext(${wallet}))`;
          const existing = await sql`SELECT mint FROM vanity_mints WHERE reserved_by = ${wallet} AND consumed_at IS NULL ORDER BY reserved_at DESC LIMIT 1`;
          if (existing.length) {
            await sql`DELETE FROM vanity_waitlist WHERE wallet = ${wallet}`;
            return { mint:existing[0].mint, position:0 };
          }
          await sql`INSERT INTO vanity_waitlist (wallet) VALUES (${wallet}) ON CONFLICT (wallet) DO NOTHING`;
          const ready = await sql`SELECT mint FROM vanity_mints WHERE reserved_by IS NULL AND consumed_at IS NULL ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`;
          if (ready.length) {
            const next = await sql`SELECT wallet FROM vanity_waitlist ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED`;
            if (next.length) {
              await sql`UPDATE vanity_mints SET reserved_by = ${next[0].wallet}, reserved_at = now() WHERE mint = ${ready[0].mint}`;
              await sql`DELETE FROM vanity_waitlist WHERE wallet = ${next[0].wallet}`;
            }
          }
          const assigned = await sql`SELECT mint FROM vanity_mints WHERE reserved_by = ${wallet} AND consumed_at IS NULL ORDER BY reserved_at DESC LIMIT 1`;
          if (assigned.length) return { mint:assigned[0].mint, position:0 };
          const position = await sql`SELECT count(*)::int AS n FROM vanity_waitlist WHERE requested_at <= (SELECT requested_at FROM vanity_waitlist WHERE wallet = ${wallet})`;
          return { mint:null, position:position[0]?.n || 1 };
        });
        return result.mint ? json({ mint:result.mint, wallet, suffix:"fomo" }) : json({ queued:true, position:result.position, wallet, suffix:"fomo", message:"Your wallet is queued for the next prepared fomo address." }, 202);
      }
      if (path === "/api/identity/check" && req.method === "POST") {
        rate(req, "identity-check", 40, 60_000);
        const input = await body(req);
        const symbol = String(input.symbol || "").trim();
        const name = String(input.name || "").trim();
        const image = String(input.imageSha256 || "").toLowerCase();
        const ownMint = input.mint ? mintAddress(input.mint).toBase58() : null;
        if (!symbol || symbol.length > 10 || name.length > 32 || (image && !/^[a-f0-9]{64}$/.test(image))) throw new Error("Invalid coin identity");
        const key = tickerKey(symbol);
        if (key.length < 2) throw new Error("Ticker needs two letters or digits");
        const claims = await db`SELECT kind, mint FROM launch_identities WHERE (kind = 'ticker' AND key = ${key}) OR (kind = 'image' AND key = ${image})`;
        const similar = name ? await db`SELECT mint, name, symbol FROM launches WHERE status = 'live' AND lower(name) = lower(${name}) LIMIT 3` : [];
        const ticker = claims.find((x: any) => x.kind === "ticker");
        const picture = claims.find((x: any) => x.kind === "image");
        return json({ scope:"Fomopad", ticker:{ available:!ticker || ticker.mint === ownMint, canonical:key, existingMint:ticker?.mint || null }, image:image ? { available:!picture || picture.mint === ownMint, existingMint:picture?.mint || null, rule:"exact uploaded image bytes" } : null, similarNames:similar.filter((x: any)=>x.mint !== ownMint).map((x: any)=>({mint:x.mint,name:x.name,symbol:x.symbol})) });
      }

      if (path === "/api/tokens" && req.method === "GET") {
        const q = (u.searchParams.get("q") || "").trim().slice(0, 60);
        const records = q
          ? await db`SELECT * FROM launches WHERE status = 'live' AND (name ILIKE ${"%" + q + "%"} OR symbol ILIKE ${"%" + q + "%"} OR mint = ${q}) ORDER BY launched_at DESC LIMIT 50`
          : await db`SELECT * FROM launches WHERE status = 'live' ORDER BY launched_at DESC LIMIT 50`;
        const paid = await db`SELECT e.mint, COALESCE(SUM(a.lamports),0)::text AS lamports FROM reward_epochs e JOIN reward_allocations a ON a.epoch_id=e.id WHERE a.status='paid' GROUP BY e.mint`;
        const totals = new Map(paid.map((r: any) => [r.mint, r.lamports]));
        const out = await Promise.all(records.map(async r => ({ ...row(r), market: await marketFor(r.mint), curve: await boardCurveFor(r), rewardPaidLamports:totals.get(r.mint) || "0" })));
        return json({ tokens: out, scope:"50 most recent verified launches" });
      }
      if (path.startsWith("/api/creator/") && req.method === "GET") {
        const creator = address(path.slice(13)).toBase58();
        const records = await db`SELECT * FROM launches WHERE creator = ${creator} AND status = 'live' ORDER BY launched_at DESC LIMIT 50`;
        return json({ tokens: await Promise.all(records.map(async r => ({ ...row(r), market: await marketFor(r.mint) }))) });
      }
      const chartRoute = path.match(/^\/api\/tokens\/([^/]+)\/chart$/);
      if (chartRoute && req.method === "GET") {
        rate(req, "token-chart", 90, 60_000);
        const mint = mintAddress(chartRoute[1]).toBase58();
        const period = u.searchParams.get("period") || "1m";
        const interval = candlePeriods[period];
        if (!interval) return fail("Unsupported chart interval");
        const records = await db`SELECT mint, pool, protocol FROM launches WHERE mint = ${mint} AND status = 'live' LIMIT 1`;
        if (!records.length) return fail("Verified launch not found", 404);
        const market = await marketFor(mint);
        const pool = ["DBC", "STONK"].includes(records[0].protocol) ? (market?.pair || records[0].pool) : market?.pair;
        if (!pool) return json({ candles: [], period, source: "GeckoTerminal", state: "awaiting-index" });
        const poolAddress = address(pool).toBase58();
        const cacheKey = mint + ":" + poolAddress + ":" + period;
        const cached = candleCache.get(cacheKey);
        if (cached && cached.expires > Date.now()) return json(cached.value);
        const params = new URLSearchParams({ aggregate: String(interval.aggregate), limit: "240", currency: "usd", token: mint });
        let value: any;
        try {
          const response = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}/ohlcv/${interval.timeframe}?${params}`, {
            headers: { accept: "application/json;version=20230203" }, signal: AbortSignal.timeout(6500),
          });
          if (response.status === 404) value = { candles: [], period, pool: poolAddress, source: "GeckoTerminal", state: "awaiting-index" };
          else if (!response.ok) return fail("Chart provider temporarily unavailable", 503);
          else {
            const result = await response.json();
            const tokens = [result.meta?.base?.address, result.meta?.quote?.address];
            if (!tokens.includes(mint)) throw new Error("Chart pool does not match token");
            const items = result.data?.attributes?.ohlcv_list;
            if (!Array.isArray(items)) throw new Error("Invalid chart response");
            const candles = items.filter((bar: any) => Array.isArray(bar) && bar.length >= 6)
              .map((bar: any) => ({ time: Number(bar[0]), open: Number(bar[1]), high: Number(bar[2]), low: Number(bar[3]), close: Number(bar[4]), volume: Number(bar[5]) }))
              .filter((bar: any) => Number.isSafeInteger(bar.time) && bar.time > 1_500_000_000 && [bar.open, bar.high, bar.low, bar.close, bar.volume].every((n: number) => Number.isFinite(n) && n >= 0) && bar.open > 0 && bar.close > 0 && bar.high >= Math.max(bar.open, bar.close, bar.low) && bar.low <= Math.min(bar.open, bar.close))
              .sort((a: any, b: any) => a.time - b.time)
              .filter((bar: any, i: number, all: any[]) => i === 0 || bar.time !== all[i - 1].time);
            value = { candles, period, pool: poolAddress, source: "GeckoTerminal", state: candles.length ? "ready" : "awaiting-trades" };
          }
        } catch { return fail("Chart provider temporarily unavailable", 503); }
        candleCache.set(cacheKey, { expires: Date.now() + (value.state === "ready" ? 60_000 : 20_000), value });
        return json(value);
      }
      if (path.startsWith("/api/tokens/") && req.method === "GET") {
        const mint = mintAddress(path.slice(12)).toBase58();
        const records = await db`SELECT * FROM launches WHERE mint = ${mint} AND status = 'live' LIMIT 1`;
        if (!records.length) return fail("Verified launch not found", 404);
        if (records[0].protocol === "DBC") {
          const r = records[0];
          let curve = null;
          try {
            const client = new DBC.DynamicBondingCurveClient(rpc, "confirmed");
            const state = await client.state.getPool(new PublicKey(r.pool));
            if (state?.poolState.baseMint.toBase58() === mint && state.poolState.config.toBase58() === r.config) {
              const progress = await client.state.getPoolQuoteTokenCurveProgress(new PublicKey(r.pool));
              curve = { pool: r.pool, config: r.config, quoteReserveSol: Number(state.poolState.quoteReserve.toString()) / 1e9, migrationThresholdSol: DBC_THRESHOLD_SOL, progress: Math.min(1,Math.max(0,progress)), migrated: Number(state.poolState.isMigrated) !== 0 };
            }
          } catch { /* Read errors never invent a curve state. */ }
          return json({ token: row(r), curve, graduated: curve?.migrated ?? null, market: await marketFor(mint) });
        }
        if (records[0].protocol === "STONK") {
          const r = records[0];
          let stonk = null;
          try { stonk = await stonkGet(`/launches/${mint}`, true); } catch { /* Adoption data can lag the confirmed pool. */ }
          const state = stonk?.pool || null;
          const status = String(state?.status || "").toLowerCase();
          const graduated = status ? status.includes("graduat") || status.includes("migrat") : null;
          return json({ token: row(r), curve: { pool:r.pool, config:r.config, platform:r.platform, quoteMint:r.quote_mint, source:"Stonk.fun / Raydium LaunchLab", state }, graduated, market: await marketFor(mint) });
        }
        const curve = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], PUMP_PROGRAM)[0];
        let graduated: boolean | null = null;
        try { const info = await rpc.getAccountInfo(curve, "confirmed"); graduated = info ? info.data.length > 48 && info.data[48] === 1 : null; } catch { /* RPC unavailable; do not invent a state */ }
        return json({ token: row(records[0]), curve: curve.toBase58(), graduated, market: await marketFor(mint) });
      }
      if (path.startsWith("/metadata/") && req.method === "GET") {
        const mint = mintAddress(path.slice(10)).toBase58();
        const records = await db`SELECT * FROM launches WHERE mint = ${mint} LIMIT 1`;
        if (!records.length) return fail("Metadata not found", 404);
        const r = records[0];
        return json({ name: r.name, symbol: r.symbol, description: r.description, image: `${origin(req)}/images/${mint}`, external_url: r.website || undefined, extensions: { website: r.website || undefined, twitter: r.x_url || undefined, telegram: r.telegram || undefined } }, 200, { "cache-control": "public, max-age=3600" });
      }
      if (path.startsWith("/images/") && req.method === "GET") {
        const mint = mintAddress(path.slice(8)).toBase58();
        const records = await db`SELECT image, image_type FROM launches WHERE mint = ${mint} LIMIT 1`;
        if (!records.length) return fail("Image not found", 404);
        return new Response(records[0].image, { headers: { "content-type": records[0].image_type, "cache-control": "public, max-age=86400", "access-control-allow-origin": "*", "x-content-type-options": "nosniff" } });
      }
      if (path === "/api/draft" && req.method === "POST") {
        rate(req, "draft", 6, 3_600_000);
        const input = await body(req);
        if (typeof input.payload !== "string" || input.payload.length > 750_000 || typeof input.signature !== "string") throw new Error("Invalid signed draft");
        const p = JSON.parse(input.payload);
        const mint = mintAddress(p.mint).toBase58();
        const creator = address(p.creator).toBase58();
        const isDbc = p.protocol === "DBC";
        const isStonk = p.protocol === "STONK";
        if (p.protocol && !isDbc && !isStonk) throw new Error("Unsupported launch protocol");
        const rewardMode = p.rewardMode === true;
        if (p.rewardMode !== undefined && typeof p.rewardMode !== "boolean") throw new Error("Invalid reward choice");
        if (rewardMode && !isDbc) throw new Error("Rewards require a DBC launch");
        const rewardScope = rewardMode ? (p.rewardScope === undefined ? "holders" : p.rewardScope) : "creator";
        if ((rewardMode && !["traders","holders"].includes(rewardScope)) || (!rewardMode && p.rewardScope && p.rewardScope !== "creator")) throw new Error("Invalid Fomo fee destination");
        if (rewardMode) {
          if (!REWARDS_ENABLED) throw new Error("Automatic rewards are not active yet");
          const balance = BigInt(await rpc.getBalance(new PublicKey(REWARD_AUTHORITY!),"confirmed"));
          if (balance < REWARD_RESERVE + 10_000_000n) throw new Error("Reward vault needs operating SOL before an opt-in launch");
        }
        const config = isDbc ? address(p.config).toBase58() : null;
        if (isDbc || isStonk) {
          const reserved = await db`SELECT mint FROM vanity_mints WHERE mint = ${mint} AND reserved_by = ${creator} AND consumed_at IS NULL LIMIT 1`;
          if (!reserved.length) throw new Error("Reserve this fomo address with your signed-in wallet first");
        }
        const initialCapSol = isDbc ? Number(p.initialCapSol) : null;
        if (isDbc && (!Number.isFinite(initialCapSol) || initialCapSol! < 30 || initialCapSol! > 60 || Math.round(initialCapSol! * 10) / 10 !== initialCapSol || [mint,creator].includes(config!))) throw new Error("DBC initial cap must be 30–60 SOL in 0.1 SOL steps");
        const name = String(p.name || "").trim(); const symbol = String(p.symbol || "").trim();
        const description = String(p.description || "").trim();
        if (!name || name.length > 32 || !symbol || symbol.length > 10 || description.length > 800) throw new Error("Invalid name, ticker, or description");
        const website = safeUrl(p.website), x = safeUrl(p.x), telegram = safeUrl(p.telegram);
        const type = p.image?.mime;
        if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(type) || typeof p.image?.data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(p.image.data)) throw new Error("Upload a PNG, JPG, WEBP, or GIF image");
        const bytes = Buffer.from(p.image.data, "base64");
        if (bytes.length < 20 || bytes.length > 350_000) throw new Error("Image must be under 350 KB");
        const magic = type === "image/png" ? bytes.subarray(0, 4).equals(Buffer.from([137,80,78,71])) : type === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 : type === "image/gif" ? bytes.subarray(0,3).toString() === "GIF" : bytes.subarray(8,12).toString() === "WEBP";
        if (!magic) throw new Error("Image contents do not match file type");
        const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.payload))).toString("hex");
        const message = new TextEncoder().encode("Fomopad launch draft v1\n" + hash);
        const sig = Buffer.from(input.signature, "base64");
        if (sig.length !== 64 || !nacl.sign.detached.verify(message, sig, new PublicKey(creator).toBytes())) throw new Error("Wallet signature does not match creator");
        const ticker = tickerKey(symbol), imageKey = imageDigest(bytes);
        if (ticker.length < 2) throw new Error("Ticker needs two letters or digits");
        // Both claims and the draft commit together. The primary key on (kind,key)
        // settles competing requests before either wallet gets a launch transaction.
        const launchStatus = await db.begin(async sql => {
          const prior = await sql`SELECT creator, payload_hash, status, protocol, config, reward_scope FROM launches WHERE mint = ${mint}`;
          const protocol = isDbc ? "DBC" : isStonk ? "STONK" : "Pump";
          if (prior.length && (prior[0].creator !== creator || prior[0].payload_hash !== hash || prior[0].protocol !== protocol || prior[0].config !== config || (rewardMode && prior[0].reward_scope !== rewardScope))) throw new Error("This mint already has a different draft");
          await sql`INSERT INTO launches (mint, creator, name, symbol, description, website, x_url, telegram, image, image_type, payload_hash, protocol, config, initial_cap_sol, reward_mode, reward_scope, quote_mint) VALUES (${mint}, ${creator}, ${name}, ${symbol}, ${description}, ${website}, ${x}, ${telegram}, ${bytes}, ${type}, ${hash}, ${protocol}, ${config}, ${initialCapSol}, ${rewardMode}, ${rewardScope}, ${isStonk ? SOL_MINT.toBase58() : null}) ON CONFLICT (mint) DO NOTHING`;
          await sql`INSERT INTO launch_identities (kind,key,mint) VALUES ('ticker',${ticker},${mint}) ON CONFLICT DO NOTHING`;
          await sql`INSERT INTO launch_identities (kind,key,mint) VALUES ('image',${imageKey},${mint}) ON CONFLICT DO NOTHING`;
          const claims = await sql`SELECT kind,mint FROM launch_identities WHERE (kind='ticker' AND key=${ticker}) OR (kind='image' AND key=${imageKey})`;
          if (claims.find((c: any) => c.kind === "ticker")?.mint !== mint) throw new Error("Ticker is already reserved on Fomopad");
          if (claims.find((c: any) => c.kind === "image")?.mint !== mint) throw new Error("This exact coin image is already used on Fomopad");
          const records = await sql`SELECT creator, payload_hash, status, protocol, config, reward_scope FROM launches WHERE mint = ${mint}`;
          if (records[0]?.creator !== creator || records[0]?.payload_hash !== hash || records[0]?.protocol !== protocol || records[0]?.config !== config || (rewardMode && records[0]?.reward_scope !== rewardScope)) throw new Error("This mint already has a different draft");
          return records[0].status;
        });
        return json({ mint, metadata: `${origin(req)}/metadata/${mint}`, status: launchStatus });
      }
      if (path === "/api/dbc/prepare" && req.method === "POST") {
        rate(req, "dbc-prepare", 20, 3_600_000);
        const input = await body(req);
        const mint = mintAddress(input.mint), creator = address(input.creator);
        const records = await db`SELECT * FROM launches WHERE mint = ${mint.toBase58()} AND creator = ${creator.toBase58()} AND protocol = 'DBC' AND status = 'draft' LIMIT 1`;
        if (!records.length || !records[0].config) return fail("Create a signed DBC draft first", 404);
        const r = records[0];
        const reserved = await db`SELECT * FROM vanity_mints WHERE mint = ${r.mint} AND reserved_by = ${creator.toBase58()} AND consumed_at IS NULL LIMIT 1`;
        if (!reserved.length) return fail("Reserved mint signer not found", 409);
        const mintKeypair = mintSigner(reserved[0]);
        const config = new PublicKey(r.config);
        if (r.reward_mode && !REWARDS_ENABLED) return fail("Automatic rewards are not active yet",409);
        if (r.reward_mode && BigInt(await rpc.getBalance(new PublicKey(REWARD_AUTHORITY!),"confirmed")) < REWARD_RESERVE + 10_000_000n) return fail("Reward vault needs operating SOL before launch",409);
        const curve = dbcCurve(Number(r.initial_cap_sol), !!r.reward_mode);
        const pool = DBC.deriveDbcPoolAddress(SOL_MINT, mint, config);
        const client = new DBC.DynamicBondingCurveClient(rpc, "confirmed");
        const tx = await client.partner.createConfigAndPool({
          ...curve, config, feeClaimer: r.reward_mode ? new PublicKey(REWARD_AUTHORITY!) : creator, leftoverReceiver: creator, quoteMint: SOL_MINT, payer: creator,
          preCreatePoolParam: { name: r.name, symbol: r.symbol, uri: `${origin(req)}/metadata/${r.mint}`, poolCreator: creator, baseMint: mint },
        });
        if (tx.instructions.length !== 2 || tx.instructions.some(ix => !ix.programId.equals(DBC_PROGRAM))) throw new Error("Unexpected DBC launch transaction");
        const block = await rpc.getLatestBlockhash("confirmed");
        tx.recentBlockhash = block.blockhash; tx.feePayer = creator;
        tx.partialSign(mintKeypair);
        await db`UPDATE launches SET pool = ${pool.toBase58()} WHERE mint = ${r.mint} AND status = 'draft'`;
        return json({ transaction: tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString("base64"), blockhash: block.blockhash, lastValidBlockHeight: block.lastValidBlockHeight, program: DBC_PROGRAM.toBase58(), pool: pool.toBase58(), config: r.config, metadata: `${origin(req)}/metadata/${r.mint}`, initialCapSol: Number(r.initial_cap_sol), migrationThresholdSol: DBC_THRESHOLD_SOL, rewardMode: !!r.reward_mode, rewardScope: r.reward_mode ? r.reward_scope : "creator", feeClaimer: r.reward_mode ? REWARD_AUTHORITY : creator });
      }
      if (path === "/api/stonk/prepare" && req.method === "POST") {
        rate(req, "stonk-prepare", 20, 3_600_000);
        const input = await body(req);
        const mint = mintAddress(input.mint), creator = address(input.creator);
        const records = await db`SELECT * FROM launches WHERE mint = ${mint.toBase58()} AND creator = ${creator.toBase58()} AND protocol = 'STONK' AND status = 'draft' LIMIT 1`;
        if (!records.length) return fail("Create a signed Stonk.fun draft first", 404);
        const r = records[0];
        const reserved = await db`SELECT * FROM vanity_mints WHERE mint = ${r.mint} AND reserved_by = ${creator.toBase58()} AND consumed_at IS NULL LIMIT 1`;
        if (!reserved.length) return fail("Reserved mint signer not found", 409);
        const mintKeypair = mintSigner(reserved[0]);
        const { pair, pricing } = await stonkTerms();
        const program = new PublicKey(pricing.curve.programId);
        const quoteMint = SOL_MINT;
        const platform = new PublicKey(pricing.platform.standard);
        const config = getPdaLaunchpadConfigId(program, quoteMint, 0, 0).publicKey;
        const allowConfig = getPdaPlatformAllowConfig(program, platform, config).publicKey;
        const curveRule = getPdaPlatformCurveRule(program, platform, config).publicKey;
        if (!config.equals(new PublicKey(pricing.curve.configId)) ||
            !allowConfig.equals(new PublicKey(pricing.allowConfig.standard)) ||
            !curveRule.equals(new PublicKey(pricing.curveRule.standard))) throw new Error("Stonk.fun launch accounts changed; launch stopped");
        const pool = getPdaLaunchpadPoolId(program, mint, quoteMint).publicKey;
        const instruction = initializeWithToken2022(
          program, creator, creator, config, platform, getPdaLaunchpadAuth(program).publicKey,
          pool, mint, quoteMint,
          getPdaLaunchpadVaultId(program, pool, mint).publicKey,
          getPdaLaunchpadVaultId(program, pool, quoteMint).publicKey,
          new PublicKey(pair.tokenProgram), pricing.curve.baseDecimals,
          r.name, r.symbol, `${origin(req)}/metadata/${r.mint}`,
          { type:"ConstantCurve", supply:new BN(pricing.curve.supply), totalSellA:new BN(pricing.curve.totalSellA), totalFundRaisingB:new BN(pricing.raise.raw), migrateType:"cpmm" },
          new BN(0), new BN(0), new BN(0), pricing.curve.cpmmCreatorFeeOn,
        );
        if (!instruction.keys[10]?.pubkey.equals(new PublicKey(TOKEN_2022)) || !instruction.keys[11]?.pubkey.equals(new PublicKey(pair.tokenProgram))) throw new Error("Raydium LaunchLab instruction layout changed");
        instruction.keys.push({ pubkey:allowConfig, isSigner:false, isWritable:false });
        instruction.keys.push({ pubkey:curveRule, isSigner:false, isWritable:false });
        const block = await rpc.getLatestBlockhash("confirmed");
        const tx = new Transaction({feePayer:creator,recentBlockhash:block.blockhash})
          .add(ComputeBudgetProgram.setComputeUnitLimit({units:600_000}))
          .add(instruction);
        tx.partialSign(mintKeypair);
        await db`UPDATE launches SET pool=${pool.toBase58()}, config=${config.toBase58()}, platform=${platform.toBase58()}, quote_mint=${quoteMint.toBase58()} WHERE mint=${r.mint} AND status='draft'`;
        return json({ transaction:tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString("base64"), blockhash:block.blockhash, lastValidBlockHeight:block.lastValidBlockHeight, program:program.toBase58(), pool:pool.toBase58(), config:config.toBase58(), platform:platform.toBase58(), quoteMint:quoteMint.toBase58(), allowConfig:allowConfig.toBase58(), curveRule:curveRule.toBase58(), tokenProgram:TOKEN_2022, quoteTokenProgram:pair.tokenProgram, metadata:`${origin(req)}/metadata/${r.mint}`, mode:"standard", feeDestination:creator.toBase58() });
      }
      if (path === "/api/prepare" && req.method === "POST") {
        rate(req, "prepare", 25, 3_600_000);
        const input = await body(req);
        const mint = mintAddress(input.mint), creator = address(input.creator);
        const records = await db`SELECT * FROM launches WHERE mint = ${mint.toBase58()} AND creator = ${creator.toBase58()} AND protocol = 'Pump' AND status = 'draft' LIMIT 1`;
        if (!records.length) return fail("Create a signed draft first", 404);
        const r = records[0];
        const ix = await PUMP_SDK.createV2Instruction({ mint, name: r.name, symbol: r.symbol, uri: `${origin(req)}/metadata/${r.mint}`, creator, user: creator, mayhemMode: false, holderReward: false });
        if (!ix.programId.equals(PUMP_PROGRAM)) throw new Error("Unexpected launch program");
        const block = await rpc.getLatestBlockhash("confirmed");
        const tx = new Transaction({ feePayer: creator, recentBlockhash: block.blockhash }).add(ix);
        return json({ transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"), blockhash: block.blockhash, lastValidBlockHeight: block.lastValidBlockHeight, program: PUMP_PROGRAM.toBase58(), metadata: `${origin(req)}/metadata/${r.mint}` });
      }
      if (path === "/api/dbc/confirm" && req.method === "POST") {
        rate(req, "dbc-confirm", 40, 3_600_000);
        const input = await body(req);
        const mint = mintAddress(input.mint).toBase58(), creator = address(input.creator).toBase58();
        const sig = String(input.signature || "");
        if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(sig)) throw new Error("Invalid transaction signature");
        const records = await db`SELECT * FROM launches WHERE mint = ${mint} AND creator = ${creator} AND protocol = 'DBC' LIMIT 1`;
        if (!records.length || !records[0].config || !records[0].pool) return fail("Signed DBC launch draft not found", 404);
        const r = records[0], poolKey = new PublicKey(r.pool), configKey = new PublicKey(r.config);
        const transaction = await rpc.getTransaction(sig, {commitment:"confirmed",maxSupportedTransactionVersion:0});
        if (!transaction) return json({status:"pending",message:"Waiting for Solana confirmation"},202);
        if (transaction.meta?.err) return fail("DBC transaction failed on Solana",422);
        const {keys,instructions:ixs} = receiptMessage(transaction.transaction.message);
        if (![mint,creator,r.config,r.pool,DBC_PROGRAM.toBase58()].every(k=>keys.includes(k))) return fail("DBC launch accounts do not match the draft",422);
        const signatures = keys.slice(0,transaction.transaction.message.header.numRequiredSignatures);
        if (![mint,creator,r.config].every(k=>signatures.includes(k))) return fail("DBC signers do not match the draft",422);
        if (ixs.length !== 2 || ixs.some(ix=>keys[ix.programIdIndex]!==DBC_PROGRAM.toBase58())) return fail("Expected only DBC launch instructions",422);
        const poolIndex = keys.indexOf(r.pool);
        if (!transaction.meta || transaction.meta.preBalances[poolIndex] !== 0 || transaction.meta.postBalances[poolIndex] <= 0) return fail("Transaction did not create the DBC pool",422);
        const uri = Buffer.from(`${origin(req)}/metadata/${mint}`);
        if (!ixs.some(ix=>Buffer.from(ix.data).includes(uri))) return fail("On-chain metadata differs from the signed draft",422);
        const account = await rpc.getAccountInfo(poolKey,"confirmed");
        if (!account?.owner.equals(DBC_PROGRAM)) return fail("DBC pool not created",422);
        const client = new DBC.DynamicBondingCurveClient(rpc,"confirmed");
        const state = await client.state.getPool(poolKey);
        const configState = state && await client.state.getPoolConfig(configKey);
        if (!state || !configState || state.poolState.baseMint.toBase58()!==mint || state.poolState.config.toBase58()!==r.config || state.poolState.creator.toBase58()!==creator || configState.feeClaimer.toBase58() !== (r.reward_mode ? REWARD_AUTHORITY : creator) || Number(configState.creatorTradingFeePercentage) !== (r.reward_mode ? 0 : 100) || !configState.quoteMint.equals(SOL_MINT) || !DBC.deriveDbcPoolAddress(SOL_MINT,new PublicKey(mint),configKey).equals(poolKey) || !configState.migrationQuoteThreshold.eq(DBC.convertToLamports(DBC_THRESHOLD_SOL,9))) return fail("On-chain DBC curve does not match this launch",422);
        await db`UPDATE launches SET status = 'live', signature = ${sig}, launched_at = COALESCE(launched_at, to_timestamp(${transaction.blockTime || Math.floor(Date.now()/1000)})) WHERE mint = ${mint} AND creator = ${creator} AND (signature IS NULL OR signature = ${sig})`;
        await db`UPDATE vanity_mints SET consumed_at = COALESCE(consumed_at, now()), secret_cipher = NULL, secret_iv = NULL WHERE mint = ${mint} AND reserved_by = ${creator}`;
        return json({status:"live",mint,pool:r.pool,config:r.config,signature:sig});
      }
      if (path === "/api/stonk/confirm" && req.method === "POST") {
        rate(req, "stonk-confirm", 80, 3_600_000);
        const input = await body(req);
        const mint = mintAddress(input.mint).toBase58(), creator = address(input.creator).toBase58();
        const sig = String(input.signature || "");
        if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(sig)) throw new Error("Invalid transaction signature");
        const records = await db`SELECT * FROM launches WHERE mint=${mint} AND creator=${creator} AND protocol='STONK' LIMIT 1`;
        if (!records.length || !records[0].config || !records[0].pool || !records[0].platform || !records[0].quote_mint) return fail("Signed Stonk.fun launch draft not found", 404);
        const r = records[0];
        const transaction = await rpc.getTransaction(sig, {commitment:"confirmed",maxSupportedTransactionVersion:0});
        if (!transaction) return json({status:"pending",message:"Waiting for Solana confirmation"},202);
        if (transaction.meta?.err) return fail("Stonk.fun launch transaction failed on Solana",422);
        const {keys,instructions:ixs} = receiptMessage(transaction.transaction.message);
        const launchProgram = keys[ixs.find(ix => keys[ix.programIdIndex] !== COMPUTE_BUDGET_PROGRAM)?.programIdIndex ?? -1];
        const required = [mint,creator,r.config,r.pool,r.platform,r.quote_mint,launchProgram];
        if (!launchProgram || !required.every(k=>keys.includes(k))) return fail("Stonk.fun launch accounts do not match the draft",422);
        const signatures = keys.slice(0,transaction.transaction.message.header.numRequiredSignatures);
        if (![mint,creator].every(k=>signatures.includes(k))) return fail("Stonk.fun launch signers do not match the draft",422);
        const launchIxs = ixs.filter(ix=>keys[ix.programIdIndex]===launchProgram);
        const budgetIxs = ixs.filter(ix=>keys[ix.programIdIndex]===COMPUTE_BUDGET_PROGRAM);
        if (launchIxs.length!==1 || budgetIxs.length!==1 || ixs.length!==2) return fail("Unexpected instructions in Stonk.fun launch",422);
        const uri = Buffer.from(`${origin(req)}/metadata/${mint}`);
        if (!Buffer.from(launchIxs[0].data).includes(uri)) return fail("On-chain metadata differs from the signed draft",422);
        const poolIndex = keys.indexOf(r.pool);
        if (poolIndex < 0 || !transaction.meta || transaction.meta.preBalances[poolIndex] !== 0 || transaction.meta.postBalances[poolIndex] <= 0) return fail("Transaction did not create the LaunchLab pool",422);
        const [poolInfo,mintInfo] = await Promise.all([rpc.getAccountInfo(new PublicKey(r.pool),"confirmed"),rpc.getAccountInfo(new PublicKey(mint),"confirmed")]);
        if (!poolInfo?.owner.equals(new PublicKey(launchProgram)) || mintInfo?.owner.toBase58()!==TOKEN_2022) return fail("LaunchLab pool or Token-2022 mint was not created",422);
        let adopted = null;
        try { adopted = await stonkGet(`/launches/${mint}`,true); }
        catch { return json({status:"pending",message:"Pool confirmed; waiting for Stonk.fun adoption"},202); }
        if (!adopted?.pool) return json({status:"pending",message:"Pool confirmed; waiting for Stonk.fun adoption"},202);
        await db`UPDATE launches SET status='live',signature=${sig},launched_at=COALESCE(launched_at,to_timestamp(${transaction.blockTime || Math.floor(Date.now()/1000)})) WHERE mint=${mint} AND creator=${creator} AND (signature IS NULL OR signature=${sig})`;
        await db`UPDATE vanity_mints SET consumed_at=COALESCE(consumed_at,now()),secret_cipher=NULL,secret_iv=NULL WHERE mint=${mint} AND reserved_by=${creator}`;
        return json({status:"live",mint,pool:r.pool,config:r.config,platform:r.platform,signature:sig,stonk:true});
      }
      if (path === "/api/confirm" && req.method === "POST") {
        rate(req, "confirm", 40, 3_600_000);
        const input = await body(req);
        const mint = mintAddress(input.mint).toBase58();
        const creator = address(input.creator).toBase58();
        const sig = String(input.signature || "");
        if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(sig)) throw new Error("Invalid transaction signature");
        const records = await db`SELECT * FROM launches WHERE mint = ${mint} AND creator = ${creator} AND protocol = 'Pump' LIMIT 1`;
        if (!records.length) return fail("Signed launch draft not found", 404);
        const tx = await rpc.getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        if (!tx) return json({ status: "pending", message: "Waiting for Solana confirmation" }, 202);
        if (tx.meta?.err) return fail("Launch transaction failed on Solana", 422);
        const keys = tx.transaction.message.accountKeys;
        if (!keys.some(k => k.pubkey.toBase58() === mint && k.signer) || !keys.some(k => k.pubkey.toBase58() === creator && k.signer)) return fail("Transaction signers do not match the draft", 422);
        const programIxs = tx.transaction.message.instructions.filter(ix => ix.programId.equals(PUMP_PROGRAM));
        if (programIxs.length !== 1) return fail("Expected one launch instruction", 422);
        const expected = await PUMP_SDK.createV2Instruction({ mint: new PublicKey(mint), name: records[0].name, symbol: records[0].symbol, uri: `${origin(req)}/metadata/${mint}`, creator: new PublicKey(creator), user: new PublicKey(creator), mayhemMode: false, holderReward: false });
        const actual = programIxs[0];
        if (!("data" in actual) || !("accounts" in actual) || actual.data !== base58(expected.data) || actual.accounts.map(a => a.toBase58()).join(",") !== expected.keys.map(k => k.pubkey.toBase58()).join(",")) return fail("Launch metadata or accounts do not match the signed draft", 422);
        const curve = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], PUMP_PROGRAM)[0];
        const [mintInfo, curveInfo] = await Promise.all([rpc.getAccountInfo(new PublicKey(mint), "confirmed"), rpc.getAccountInfo(curve, "confirmed")]);
        if (mintInfo?.owner.toBase58() !== TOKEN_2022 || !curveInfo?.owner.equals(PUMP_PROGRAM)) return fail("Mint and bonding curve were not created by this launch", 422);
        await db`UPDATE launches SET status = 'live', signature = ${sig}, launched_at = COALESCE(launched_at, now()) WHERE mint = ${mint} AND creator = ${creator} AND (signature IS NULL OR signature = ${sig})`;
        return json({ status: "live", mint, signature: sig });
      }
      return fail("Not found", 404);
    } catch (e: any) {
      console.error(e);
      return fail(e?.message || "Unexpected server error", /Too many requests/.test(e?.message || "") ? 429 : 400);
    }
  },
});

