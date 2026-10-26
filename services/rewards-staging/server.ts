import postgres from "postgres";
import { Connection, Keypair, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import BN from "bn.js";
import * as DBC from "@meteora-ag/dynamic-bonding-curve-sdk";

const RPC = Bun.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const REWARD_AUTHORITY = Bun.env.FOMOPAD_REWARD_AUTHORITY ? new PublicKey(Bun.env.FOMOPAD_REWARD_AUTHORITY).toBase58() : null;
const DBC_PROGRAM = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
const TREASURY_WALLET = new PublicKey("6eJteDb9ag7gZviL1kgcQvyLjhJtMMt62Dh31W6nbWhx").toBase58();
const TREASURY_BPS = 2_000;
const FOMO_COSIGNER = "AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51";
const FOMO_FEE_ACCOUNT = "HrTf9CzXR1dRH4Sof5QrpmGWwpwAf3qZzwCsEjQpXcSq";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const REWARD_RESERVE = 10_000_000n;
const MIN_REWARD_CLAIM = 1_000_000n;
// A fresh treasury recipient can require a token-account rent deposit. Accrue
// until the claim exceeds that one-time cost instead of draining the gas vault.
const MIN_TREASURY_CLAIM = 5_000_000n;
const REWARDS_ACTIVE = Bun.env.FOMOPAD_REWARDS_ACTIVE === "true";
if (REWARDS_ACTIVE && (!Bun.env.DATABASE_URL || !Bun.env.SOLANA_RPC_URL || !REWARD_AUTHORITY)) throw new Error("Reward worker needs its database, dedicated RPC, and authority address");
const db = Bun.env.DATABASE_URL ? postgres(Bun.env.DATABASE_URL, { max: 5, idle_timeout: 20 }) : null;
const rpc = new Connection(RPC, "confirmed");

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
function rewardSigner() {
  const encoded = Bun.env.FOMOPAD_REWARD_AUTHORITY_SEED || "";
  if (!REWARD_AUTHORITY || !/^[a-f0-9]{64}$/i.test(encoded)) throw new Error("Reward signer is not configured");
  const seed = Buffer.from(encoded, "hex");
  try {
    const signer = Keypair.fromSeed(seed);
    if (signer.publicKey.toBase58() !== REWARD_AUTHORITY) throw new Error("Reward authority does not match its signing key");
    return signer;
  } finally { seed.fill(0); }
}
function fomoTradeOwners(tx: any, mint: string, pool: string) {
  if (!tx || tx.meta?.err || !tx.blockTime) throw new Error("Fomo buy is not confirmed");
  const keys = tx.transaction.message.accountKeys;
  const key = (k: any) => typeof k.pubkey === 'string' ? k.pubkey : k.pubkey.toBase58();
  if (key(keys[0]) !== FOMO_COSIGNER || !keys[0].signer || !keys.some((k: any) => key(k) === FOMO_FEE_ACCOUNT) || !keys.some((k: any) => key(k) === pool)) throw new Error("This transaction is not a qualifying Fomo trade for this pool");
  const sourceOwners = new Map<string,string>();
  for (const balance of [...(tx.meta.preTokenBalances || []),...(tx.meta.postTokenBalances || [])]) {
    if (balance.mint === USDC_MINT && balance.owner && keys[balance.accountIndex]) sourceOwners.set(key(keys[balance.accountIndex]), new PublicKey(balance.owner).toBase58());
  }
  const instructions = [...tx.transaction.message.instructions,...(tx.meta.innerInstructions || []).flatMap((entry: any) => entry.instructions)];
  const feePayers = new Set<string>();
  for (const ix of instructions) {
    const transfer = ix.parsed?.info;
    if (transfer?.destination !== FOMO_FEE_ACCOUNT || !transfer.source) continue;
    const owner = sourceOwners.get(transfer.source);
    if (owner && BigInt(transfer.amount || transfer.tokenAmount?.amount || "0") > 0n) feePayers.add(owner);
  }
  if (!feePayers.size) throw new Error("Fomo fee payer could not be verified");
  const sums = (balances: any[]) => {
    const result = new Map<string, bigint>();
    for (const item of balances || []) {
      if (item.mint !== mint || !item.owner) continue;
      const wallet = new PublicKey(item.owner).toBase58();
      result.set(wallet, (result.get(wallet) || 0n) + BigInt(item.uiTokenAmount?.amount || "0"));
    }
    return result;
  };
  const before = sums(tx.meta.preTokenBalances), after = sums(tx.meta.postTokenBalances);
  return [...after].filter(([wallet, balance]) => balance > (before.get(wallet) || 0n) && feePayers.has(wallet))
    .map(([wallet, balance]) => ({ wallet, boughtAmount: balance - (before.get(wallet) || 0n) }));
}
// web3.js 1.98 rejects parsed version-1 receipts before our verifier sees
// them. Read the JSON-RPC parsed shape directly as a narrow fallback; the
// same Fomo cosigner, fee transfer, pool and token-balance checks still apply.
async function parsedReceipt(signature: string) {
  const response = await fetch(RPC,{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getTransaction',params:[signature,{encoding:'jsonParsed',commitment:'confirmed',maxSupportedTransactionVersion:1}]}),
    signal:AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`RPC receipt request failed: ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(`RPC receipt error: ${data.error.message || data.error.code}`);
  return data.result;
}
async function parsedReceipts(signatures: string[]) {
  try { return await rpc.getParsedTransactions(signatures,{commitment:'confirmed',maxSupportedTransactionVersion:1}); }
  catch (err:any) {
    if (!/At path: version|Expected the value to satisfy a union/.test(err?.message || '')) throw err;
    const results:any[] = [];
    for (let i=0;i<signatures.length;i+=3) results.push(...await Promise.all(signatures.slice(i,i+3).map(parsedReceipt)));
    return results;
  }
}
async function holderBalance(wallet: string, mint: string) {
  const accounts = await rpc.getParsedTokenAccountsByOwner(new PublicKey(wallet), { mint: new PublicKey(mint) }, "confirmed");
  return accounts.value.reduce((sum, item) => sum + BigInt(item.account.data.parsed.info.tokenAmount.amount), 0n);
}
async function eligibleHolders(sql: any, mint: string) {
  const found = await sql`SELECT DISTINCT wallet FROM reward_proofs WHERE mint = ${mint} ORDER BY wallet LIMIT 201`;
  if (found.length > 200) throw new Error("Reward holder limit reached; distribution needs a larger indexer");
  const balances: { wallet: string; balance: bigint }[] = [];
  for (let i = 0; i < found.length; i += 10) {
    const chunk = await Promise.all(found.slice(i, i + 10).map(async (r: any) => ({ wallet: r.wallet, balance: await holderBalance(r.wallet, mint) })));
    balances.push(...chunk.filter(item => item.balance > 0n));
  }
  return balances;
}
async function eligibleTraders(sql: any, mint: string) {
  const found = await sql`SELECT wallet, sum(bought_amount)::text AS amount FROM reward_proofs WHERE mint = ${mint} GROUP BY wallet ORDER BY wallet LIMIT 201`;
  if (found.length > 200) throw new Error("Reward trader limit reached; distribution needs a larger indexer");
  return found.map((r: any) => ({ wallet:r.wallet, balance:BigInt(r.amount) })).filter((r: any) => r.balance > 0n);
}
async function eligibleRecipients(sql: any, launch: any) {
  return launch.reward_scope === "traders" ? eligibleTraders(sql,launch.mint) : eligibleHolders(sql,launch.mint);
}
const SCAN_PAGE = 40;
function scanWindow(scan: any, signatures: {signature: string; blockTime: number | null}[], launchedAt: number) {
  if (!signatures.length) return { head: scan.window_head || scan.anchor_signature, finished: true, before: null };
  const head = scan.window_head || signatures[0].signature;
  const finished = signatures.length < SCAN_PAGE ||
    signatures.some(s => s.signature === scan.anchor_signature || (s.blockTime && s.blockTime * 1000 < launchedAt));
  return { head, finished, before: finished ? null : signatures[signatures.length-1].signature };
}
async function scanFomoTrades(sql: any, launch: any) {
  const mint = launch.mint, pool = launch.pool;
  await sql`INSERT INTO reward_scans (mint) VALUES (${mint}) ON CONFLICT DO NOTHING`;
  const scans = await sql`SELECT * FROM reward_scans WHERE mint = ${mint} FOR UPDATE`;
  const scan = scans[0];
  const options: any = { limit: SCAN_PAGE };
  if (scan.before_signature) options.before = scan.before_signature;
  if (scan.anchor_signature) options.until = scan.anchor_signature;
  const signatures = await rpc.getSignaturesForAddress(new PublicKey(pool), options, "confirmed");
  if (!signatures.length) {
    await sql`UPDATE reward_scans SET anchor_signature = COALESCE(${scan.window_head},anchor_signature),window_head = NULL,before_signature = NULL,completed_at = now(),updated_at = now() WHERE mint = ${mint}`;
    return {state:"indexed",found:0};
  }
  const next = scanWindow(scan, signatures, new Date(launch.launched_at).getTime());
  const transactions: any[] = [];
  for (let i = 0; i < signatures.length; i += 10) {
    const batch = await parsedReceipts(signatures.slice(i,i+10).map((s:any)=>s.signature));
    transactions.push(...batch);
  }
  let found = 0;
  for (let i = 0; i < signatures.length; i++) {
    const signature = signatures[i], tx = transactions[i];
    if (signature.err) continue;
    if (!tx) throw new Error("Pool transaction not yet available; scanner will retry this page");
    if (!tx.blockTime || tx.blockTime * 1000 < new Date(launch.launched_at).getTime()) continue;
    let owners: { wallet:string; boughtAmount:bigint }[];
    try { owners = fomoTradeOwners(tx,mint,pool); }
    catch (err: any) {
      if (/not a qualifying Fomo trade|not confirmed|Fomo fee payer could not be verified/.test(err?.message || "")) continue;
      throw err;
    }
    for (const { wallet, boughtAmount } of owners) {
      const inserted = await sql`INSERT INTO reward_proofs (signature,mint,wallet,bought_at,bought_amount) VALUES (${signature.signature},${mint},${wallet},${new Date(tx.blockTime * 1000)},${String(boughtAmount)}) ON CONFLICT DO NOTHING RETURNING wallet`;
      found += inserted.length;
    }
  }
  if (next.finished) {
    await sql`UPDATE reward_scans SET anchor_signature = ${next.head},window_head = NULL,before_signature = NULL,completed_at = now(),updated_at = now() WHERE mint = ${mint}`;
    return {state:"indexed",found};
  }
  await sql`UPDATE reward_scans SET window_head = ${next.head},before_signature = ${next.before},updated_at = now() WHERE mint = ${mint}`;
  return {state:"indexing",found,checked:signatures.length};
}
function splitReward(holders: {wallet: string; balance: bigint}[], amount: bigint) {
  const total = holders.reduce((sum, h) => sum + h.balance, 0n);
  if (!total || amount < 1n) throw new Error("No eligible reward balance");
  let assigned = 0n;
  return holders.map((h, index) => {
    const lamports = index === holders.length - 1 ? amount - assigned : amount * h.balance / total;
    assigned += lamports;
    return { wallet: h.wallet, lamports };
  }).filter(h => h.lamports > 0n);
}
function splitWithTreasury(holders: {wallet: string; balance: bigint}[], amount: bigint, bps: number) {
  if (bps !== 0 && bps !== TREASURY_BPS) throw new Error("Unknown treasury fee plan");
  const treasury = amount * BigInt(bps) / 10_000n;
  const allocations = splitReward(holders, amount - treasury);
  const combined = new Map<string,bigint>();
  for (const item of allocations) combined.set(item.wallet,(combined.get(item.wallet) || 0n) + item.lamports);
  if (treasury) combined.set(TREASURY_WALLET,(combined.get(TREASURY_WALLET) || 0n) + treasury);
  return [...combined].map(([wallet,lamports])=>({wallet,lamports}));
}
function signedRewardTransaction(tx: Transaction, signer: Keypair, block: {blockhash: string; lastValidBlockHeight: number}) {
  tx.recentBlockhash = block.blockhash;
  tx.feePayer = signer.publicKey;
  tx.sign(signer);
  if (!tx.verifySignatures() || !tx.signature) throw new Error("Reward transaction did not sign");
  return { signature: base58(tx.signature), raw: tx.serialize().toString("base64"), lastValid: block.lastValidBlockHeight };
}
function payoutReceiptMatches(tx: any, wallet: string, lamports: bigint) {
  if (!tx?.meta || tx.meta.err) return false;
  const {keys,instructions} = receiptMessage(tx.transaction.message);
  return instructions.some((ix: any) => {
    const data = ix.data;
    return keys[ix.programIdIndex] === SystemProgram.programId.toBase58() && data.length === 12 &&
      data.readUInt32LE(0) === 2 && data.readBigUInt64LE(4) === lamports &&
      keys[ix.accounts[0]] === REWARD_AUTHORITY && keys[ix.accounts[1]] === wallet;
  });
}
async function advanceReward(mint: string) {
  if (!db) throw new Error("Database is not configured");
  const result = await db.begin(async sql => {
    await sql`SELECT pg_advisory_xact_lock(hashtext('rewards:global'))`;
    await sql`SELECT pg_advisory_xact_lock(hashtext(${"rewards:" + mint}))`;
    const launches = await sql`SELECT * FROM launches WHERE mint = ${mint} AND status = 'live' AND reward_mode = true AND protocol = 'DBC' LIMIT 1`;
    if (!launches.length) throw new Error("Active Fomo reward launch not found");
    const launch = launches[0];
    await sql`UPDATE launches SET reward_tick_at = now() WHERE mint = ${mint}`;
    const signer = rewardSigner();
    const open = await sql`SELECT * FROM reward_epochs WHERE mint = ${mint} AND status IN ('claim-pending','allocating','needs-review') ORDER BY id LIMIT 1 FOR UPDATE`;
    if (open.length) {
      const epoch = open[0];
      if (epoch.status === "needs-review") return { state: "needs-review", epoch: String(epoch.id) };
      if (epoch.status === "claim-pending") {
        const tx = await rpc.getTransaction(epoch.claim_signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        if (!tx) {
          const known = await rpc.getSignatureStatuses([epoch.claim_signature], { searchTransactionHistory: true });
          if (known.value[0]?.err) { await sql`UPDATE reward_epochs SET status = 'needs-review' WHERE id = ${epoch.id}`; return {state:"needs-review",epoch:String(epoch.id)}; }
          const height = await rpc.getBlockHeight("confirmed");
          if (!known.value[0] && height > Number(epoch.claim_last_valid_height) + 150) {
            await sql`UPDATE reward_epochs SET status = 'needs-review' WHERE id = ${epoch.id}`;
            return { state: "needs-review", epoch: String(epoch.id), reason: "Claim receipt unavailable after blockhash expiry" };
          }
          return { state: "claim-pending", signature: epoch.claim_signature, raw: epoch.claim_raw };
        }
        if (tx.meta?.err) { await sql`UPDATE reward_epochs SET status = 'needs-review' WHERE id = ${epoch.id}`; return {state:"needs-review",epoch:String(epoch.id)}; }
        const {keys} = receiptMessage(tx.transaction.message);
        const index = keys.indexOf(REWARD_AUTHORITY!);
        if (index < 0 || !tx.meta || !keys.includes(launch.pool)) { await sql`UPDATE reward_epochs SET status = 'needs-review' WHERE id = ${epoch.id}`; return {state:"needs-review",epoch:String(epoch.id)}; }
        const received = BigInt(tx.meta.postBalances[index]) - BigInt(tx.meta.preBalances[index]) + BigInt(tx.meta.fee || 0);
        if (received <= 0n) { await sql`UPDATE reward_epochs SET status = 'needs-review' WHERE id = ${epoch.id}`; return {state:"needs-review",epoch:String(epoch.id)}; }
        const recipients = await eligibleRecipients(sql, launch);
        if (!recipients.length) { await sql`UPDATE reward_epochs SET status = 'needs-review' WHERE id = ${epoch.id}`; return {state:"needs-review",epoch:String(epoch.id)}; }
        const vaultBalance = BigInt(await rpc.getBalance(signer.publicKey, "confirmed"));
        const liabilities = await sql`SELECT coalesce(sum(lamports), 0)::text AS total FROM reward_allocations WHERE status <> 'paid'`;
        const available = vaultBalance - REWARD_RESERVE - BigInt(liabilities[0].total) - BigInt((recipients.length + 1) * 10_000);
        if (available < received) return {state:"awaiting-vault-balance",epoch:String(epoch.id)};
        for (const h of splitWithTreasury(recipients, received, Number(launch.treasury_bps || 0))) await sql`INSERT INTO reward_allocations (epoch_id,wallet,lamports) VALUES (${epoch.id},${h.wallet},${String(h.lamports)})`;
        await sql`UPDATE reward_epochs SET status = 'allocating', claimed_lamports = ${String(received)} WHERE id = ${epoch.id}`;
        return { state: "allocating", epoch: String(epoch.id), lamports: String(received) };
      }
      const pending = await sql`SELECT * FROM reward_allocations WHERE epoch_id = ${epoch.id} AND status <> 'paid' ORDER BY wallet LIMIT 1 FOR UPDATE`;
      if (!pending.length) {
        await sql`UPDATE reward_epochs SET status = 'complete', completed_at = now() WHERE id = ${epoch.id}`;
        return { state: "complete", epoch: String(epoch.id) };
      }
      const payout = pending[0];
      if (payout.status === "sent") {
        const tx = await rpc.getTransaction(payout.payout_signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        if (tx?.meta && !tx.meta.err) {
          if (!payoutReceiptMatches(tx,payout.wallet,BigInt(payout.lamports))) {
            await sql`UPDATE reward_epochs SET status = 'needs-review' WHERE id = ${epoch.id}`;
            return {state:"needs-review",epoch:String(epoch.id),reason:"Payout receipt does not match the ledger"};
          }
          await sql`UPDATE reward_allocations SET status = 'paid', paid_at = now() WHERE epoch_id = ${epoch.id} AND wallet = ${payout.wallet}`;
          return {state:"paid",wallet:payout.wallet,signature:payout.payout_signature};
        }
        const known = await rpc.getSignatureStatuses([payout.payout_signature], { searchTransactionHistory: true });
        if (tx?.meta?.err || known.value[0]?.err) {
          await sql`UPDATE reward_allocations SET status = 'pending', payout_signature = NULL, payout_raw = NULL, payout_last_valid_height = NULL WHERE epoch_id = ${epoch.id} AND wallet = ${payout.wallet}`;
          return {state:"retry-payout",wallet:payout.wallet};
        }
        if (!known.value[0] && await rpc.getBlockHeight("confirmed") > Number(payout.payout_last_valid_height) + 150) {
          await sql`UPDATE reward_epochs SET status = 'needs-review' WHERE id = ${epoch.id}`;
          return {state:"needs-review",epoch:String(epoch.id),reason:"Payout receipt unavailable after blockhash expiry"};
        }
        return {state:"payout-pending",wallet:payout.wallet,signature:payout.payout_signature,raw:payout.payout_raw};
      }
      const balance = BigInt(await rpc.getBalance(signer.publicKey,"confirmed"));
      if (balance < BigInt(payout.lamports) + REWARD_RESERVE + 10_000n) return {state:"awaiting-vault-balance",epoch:String(epoch.id)};
      if (BigInt(payout.lamports) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Reward transfer exceeds safe lamport size");
      const block = await rpc.getLatestBlockhash("confirmed");
      const tx = new Transaction().add(SystemProgram.transfer({fromPubkey:signer.publicKey,toPubkey:new PublicKey(payout.wallet),lamports:Number(payout.lamports)}));
      const sent = signedRewardTransaction(tx, signer, block);
      await sql`UPDATE reward_allocations SET status = 'sent', payout_signature = ${sent.signature}, payout_raw = ${sent.raw}, payout_last_valid_height = ${sent.lastValid} WHERE epoch_id = ${epoch.id} AND wallet = ${payout.wallet}`;
      return {state:"payout-pending",wallet:payout.wallet,signature:sent.signature,raw:sent.raw};
    }
    const scanned = await scanFomoTrades(sql, launch);
    if (scanned.state !== "indexed") return scanned;
    const recipients = await eligibleRecipients(sql, launch);
    if (!recipients.length) return {state:launch.reward_scope === "traders" ? "awaiting-verified-fomo-traders" : "awaiting-verified-fomo-holders"};
    if (BigInt(await rpc.getBalance(signer.publicKey,"confirmed")) < REWARD_RESERVE + 10_000_000n) return {state:"awaiting-vault-funding"};
    const client = new DBC.DynamicBondingCurveClient(rpc,"confirmed");
    const poolKey = new PublicKey(launch.pool);
    const pool = await client.state.getPool(poolKey);
    const config = await client.state.getPoolConfig(new PublicKey(launch.config));
    if (!pool || !config || pool.poolState.baseMint.toBase58() !== mint || pool.poolState.config.toBase58() !== launch.config || config.feeClaimer.toBase58() !== REWARD_AUTHORITY || Number(config.creatorTradingFeePercentage) !== 0) throw new Error("Reward pool authority mismatch");
    const fee = BigInt(pool.poolState.partnerQuoteFee.toString());
    if (fee < MIN_REWARD_CLAIM) return {state:"accruing",unclaimedLamports:String(fee)};
    const tx = await client.partner.claimPartnerTradingFeeToReceiver({pool:poolKey,feeClaimer:signer.publicKey,payer:signer.publicKey,maxBaseAmount:new BN(0),maxQuoteAmount:new BN(fee.toString()),receiver:signer.publicKey});
    const sent = signedRewardTransaction(tx, signer, await rpc.getLatestBlockhash("confirmed"));
    const inserted = await sql`INSERT INTO reward_epochs (mint,claim_signature,claim_raw,claim_last_valid_height) VALUES (${mint},${sent.signature},${sent.raw},${sent.lastValid}) RETURNING id`;
    return {state:"claim-pending",epoch:String(inserted[0].id),signature:sent.signature,raw:sent.raw};
  });
  if ("raw" in result && result.raw) {
    try { await rpc.sendRawTransaction(Buffer.from(result.raw,"base64"),{skipPreflight:false,maxRetries:2}); }
    catch (err: any) { console.error("Reward broadcast will retry", result.signature, err?.message); }
    delete result.raw;
  }
  return result;
}

// DBC creator-route launches send their 20% partner share straight from the
// curve to the fixed team treasury. Persist the signed claim before broadcast,
// so a cron retry cannot create a second claim while the first is uncertain.
async function advanceTreasury(mint: string) {
  if (!db) throw new Error("Database is not configured");
  const result = await db.begin(async sql => {
    await sql`SELECT pg_advisory_xact_lock(hashtext('rewards:global'))`;
    await sql`SELECT pg_advisory_xact_lock(hashtext(${"treasury:" + mint}))`;
    const launches = await sql`SELECT * FROM launches WHERE mint = ${mint} AND status = 'live' AND protocol = 'DBC' AND reward_mode = false AND treasury_bps = ${TREASURY_BPS} LIMIT 1`;
    if (!launches.length) throw new Error("Active treasury launch not found");
    const launch = launches[0], signer = rewardSigner();
    await sql`UPDATE launches SET treasury_tick_at = now() WHERE mint = ${mint}`;
    const open = await sql`SELECT * FROM treasury_claim_epochs WHERE mint = ${mint} AND status IN ('sent','needs-review') ORDER BY id LIMIT 1 FOR UPDATE`;
    if (open.length) {
      const epoch = open[0];
      if (epoch.status === 'needs-review') return {state:'needs-review',epoch:String(epoch.id)};
      const tx = await rpc.getTransaction(epoch.signature,{commitment:'confirmed',maxSupportedTransactionVersion:0});
      if (tx?.meta && !tx.meta.err) {
        const {keys,instructions} = receiptMessage(tx.transaction.message);
        const recipientIndex = keys.indexOf(TREASURY_WALLET);
        const received = recipientIndex < 0 ? 0n : BigInt(tx.meta.postBalances[recipientIndex]) - BigInt(tx.meta.preBalances[recipientIndex]);
        if (!keys.includes(launch.pool) || !keys.includes(REWARD_AUTHORITY!) || !instructions.some((ix:any)=>keys[ix.programIdIndex]===DBC_PROGRAM.toBase58()) || received < BigInt(epoch.expected_lamports)) {
          await sql`UPDATE treasury_claim_epochs SET status = 'needs-review' WHERE id = ${epoch.id}`;
          return {state:'needs-review',epoch:String(epoch.id),reason:'Treasury claim receipt mismatch'};
        }
        await sql`UPDATE treasury_claim_epochs SET status = 'complete',completed_at=now() WHERE id = ${epoch.id}`;
        return {state:'complete',epoch:String(epoch.id),signature:epoch.signature,lamports:String(received)};
      }
      const known = await rpc.getSignatureStatuses([epoch.signature],{searchTransactionHistory:true});
      if (tx?.meta?.err || known.value[0]?.err) {
        await sql`UPDATE treasury_claim_epochs SET status='failed' WHERE id=${epoch.id}`;
        return {state:'retry',epoch:String(epoch.id)};
      }
      if (!known.value[0] && await rpc.getBlockHeight('confirmed') > Number(epoch.last_valid_height) + 150) {
        await sql`UPDATE treasury_claim_epochs SET status='needs-review' WHERE id=${epoch.id}`;
        return {state:'needs-review',epoch:String(epoch.id),reason:'Treasury claim receipt unavailable after expiry'};
      }
      return {state:'sent',signature:epoch.signature,raw:epoch.raw};
    }
    if (BigInt(await rpc.getBalance(signer.publicKey,'confirmed')) < REWARD_RESERVE + 5_000_000n) return {state:'awaiting-vault-funding'};
    const client = new DBC.DynamicBondingCurveClient(rpc,'confirmed'), poolKey = new PublicKey(launch.pool);
    const [pool,config] = await Promise.all([client.state.getPool(poolKey),client.state.getPoolConfig(new PublicKey(launch.config))]);
    if (!pool || !config || pool.poolState.baseMint.toBase58() !== mint || pool.poolState.config.toBase58() !== launch.config || pool.poolState.creator.toBase58() !== launch.creator || config.feeClaimer.toBase58() !== REWARD_AUTHORITY || Number(config.creatorTradingFeePercentage) !== 80) throw new Error('Treasury pool authority mismatch');
    const fee = BigInt(pool.poolState.partnerQuoteFee.toString());
    if (fee < MIN_TREASURY_CLAIM) return {state:'accruing',unclaimedLamports:String(fee)};
    const tx = await client.partner.claimPartnerTradingFeeToReceiver({pool:poolKey,feeClaimer:signer.publicKey,payer:signer.publicKey,maxBaseAmount:new BN(0),maxQuoteAmount:new BN(fee.toString()),receiver:new PublicKey(TREASURY_WALLET)});
    const sent = signedRewardTransaction(tx,signer,await rpc.getLatestBlockhash('confirmed'));
    await sql`INSERT INTO treasury_claim_epochs (mint,signature,raw,last_valid_height,expected_lamports) VALUES (${mint},${sent.signature},${sent.raw},${sent.lastValid},${String(fee)})`;
    return {state:'sent',signature:sent.signature,raw:sent.raw};
  });
  if ('raw' in result && result.raw) {
    try { await rpc.sendRawTransaction(Buffer.from(result.raw,'base64'),{skipPreflight:false,maxRetries:2}); }
    catch (err:any) { console.error('Treasury broadcast will retry',result.signature,err?.message); }
    delete result.raw;
  }
  return result;
}

// A private Railway cron function runs every five minutes. It has no HTTP listener or public domain.
// Only this worker receives the signing seed; the website API holds the public authority address.
try {
  if (!REWARDS_ACTIVE) {
    const rows = db ? await db`SELECT count(*)::int AS total FROM launches WHERE status = 'live' AND reward_mode = true` : null;
    const signer = Bun.env.FOMOPAD_REWARD_AUTHORITY_SEED ? rewardSigner() : null;
    console.log("Reward worker paused; no claims or payouts can run", rows ? {database:true,rewardLaunches:rows[0].total,signerVerified:!!signer} : {database:false,signerVerified:!!signer});
  } else {
    rewardSigner();
    const active = await db!`SELECT mint FROM launches WHERE status = 'live' AND reward_mode = true ORDER BY reward_tick_at NULLS FIRST, launched_at ASC LIMIT 8`;
    for (let i = 0; i < active.length; i += 4) {
      await Promise.all(active.slice(i,i+4).map(async (item: any) => {
        try {
          const result = await advanceReward(item.mint);
          console.log(item.mint, result.state, result.signature || "");
        } catch (err: any) {
          console.error("Reward settlement deferred", item.mint, err?.message || err);
        }
      }));
    }
    const treasury = await db!`SELECT mint FROM launches WHERE status = 'live' AND protocol = 'DBC' AND reward_mode = false AND treasury_bps = ${TREASURY_BPS} ORDER BY treasury_tick_at NULLS FIRST, launched_at ASC LIMIT 8`;
    for (const item of treasury) {
      try {
        const result = await advanceTreasury(item.mint);
        console.log('treasury',item.mint,result.state,result.signature || '');
      } catch (err:any) { console.error('Treasury settlement deferred',item.mint,err?.message || err); }
    }
  }
} finally { if (db) await db.end(); }

