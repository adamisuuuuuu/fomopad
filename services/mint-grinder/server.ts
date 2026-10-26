import postgres from "postgres";
import bs58 from "bs58";
import { createCipheriv, generateKeyPairSync, randomBytes } from "node:crypto";

const url = Bun.env.DATABASE_URL;
const key = Bun.env.MINT_ENCRYPTION_KEY ? Buffer.from(Bun.env.MINT_ENCRYPTION_KEY, "hex") : null;
const targetStock = Math.max(6, Math.min(50, Number(Bun.env.MINT_STOCK_TARGET || 20)));
if (!url || !key || key.length !== 32) throw new Error("DATABASE_URL and 32-byte MINT_ENCRYPTION_KEY are required");
const db = postgres(url, { max: 1, idle_timeout: 5 });

try {
  await db`CREATE TABLE IF NOT EXISTS vanity_mints (
    mint text PRIMARY KEY, secret_cipher bytea, secret_iv bytea,
    reserved_by text, reserved_at timestamptz, consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await db`UPDATE vanity_mints SET reserved_by = NULL, reserved_at = NULL
    WHERE reserved_at < now() - interval '60 minutes' AND consumed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM launches WHERE launches.mint = vanity_mints.mint)`;
  const count = await db`SELECT count(*)::int AS ready FROM vanity_mints WHERE reserved_by IS NULL AND consumed_at IS NULL`;
  if (count[0].ready >= targetStock) { console.log("Fomo mint stock full:", count[0].ready, "/", targetStock); }
  else {
    let attempts = 0, mint = "", secret: Buffer | null = null;
    while (!secret) {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const spki = publicKey.export({ format: "der", type: "spki" });
      const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
      if (spki.length !== 44 || pkcs8.length !== 48) throw new Error("Unexpected Ed25519 key encoding");
      mint = bs58.encode(spki.subarray(-32));
      attempts++;
      if (mint.endsWith("fomo")) secret = Buffer.concat([pkcs8.subarray(-32), spki.subarray(-32)]);
      if (attempts % 1_000_000 === 0) console.log("Fomo mint candidates:", attempts);
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(secret), cipher.final(), cipher.getAuthTag()]);
    secret.fill(0);
    await db`INSERT INTO vanity_mints (mint, secret_cipher, secret_iv) VALUES (${mint}, ${encrypted}, ${iv}) ON CONFLICT (mint) DO NOTHING`;
    console.log("Prepared fomo mint", mint, "after", attempts, "candidates");
  }
} finally {
  await db.end({ timeout: 5 });
}

