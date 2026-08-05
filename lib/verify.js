/*
 * Verifies that an incoming request really came from Discord.
 *
 * Discord signs every interaction webhook with Ed25519 and refuses to
 * register an endpoint that doesn't reject bad signatures. Without this,
 * anyone who learns the URL could post fake interactions and award
 * themselves points.
 *
 * Uses node:crypto rather than tweetnacl — Node can import a raw Ed25519
 * public key via JWK, so the usual npm dependency isn't needed.
 */

import { createPublicKey, verify as cryptoVerify } from "node:crypto";

const keyCache = new Map();

/** Turn the hex public key from the Developer Portal into a KeyObject. */
export function publicKeyFromHex(hex) {
  const clean = String(hex || "").trim().toLowerCase();

  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error("DISCORD_PUBLIC_KEY must be 64 hex characters");
  }

  if (keyCache.has(clean)) return keyCache.get(clean);

  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(clean, "hex").toString("base64url") },
    format: "jwk"
  });

  keyCache.set(clean, key);
  return key;
}

/**
 * @param rawBody   the request body as bytes, exactly as received — parsing
 *                  and re-serialising the JSON changes the bytes and breaks
 *                  the signature
 * @param signature X-Signature-Ed25519 header
 * @param timestamp X-Signature-Timestamp header
 */
export function verifyRequest({ rawBody, signature, timestamp, publicKey }) {
  if (!rawBody || !signature || !timestamp) return false;
  if (!/^[0-9a-f]{128}$/i.test(String(signature))) return false;

  let key;
  try {
    key = typeof publicKey === "string" ? publicKeyFromHex(publicKey) : publicKey;
  } catch {
    return false;
  }

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  const message = Buffer.concat([Buffer.from(String(timestamp), "utf8"), body]);

  try {
    return cryptoVerify(null, message, key, Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

/**
 * Rejects signatures whose timestamp is far from now, so a valid request
 * captured off the wire can't be replayed indefinitely.
 */
export function isFresh(timestamp, { now = Date.now(), toleranceMs = 5 * 60 * 1000 } = {}) {
  const t = Number(timestamp);
  if (!Number.isFinite(t)) return false;
  return Math.abs(now - t * 1000) <= toleranceMs;
}
