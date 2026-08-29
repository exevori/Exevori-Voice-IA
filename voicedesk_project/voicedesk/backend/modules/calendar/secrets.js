import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";

function encryptionKey() {
  const encoded = process.env.ENCRYPTION_KEY;
  if (!encoded) throw new Error("ENCRYPTION_KEY is required for Calendly OAuth");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return key;
}

function aad(context) {
  if (!context || typeof context !== "string") {
    throw new Error("Calendar secret encryption context is required");
  }
  return Buffer.from(`voicedesk:calendar:v1:${context}`, "utf8");
}

export function encryptCalendarSecret(value, context) {
  if (!value || typeof value !== "string") {
    throw new Error("Calendar secret must be a non-empty string");
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptCalendarSecret(encrypted, context) {
  if (!encrypted?.ciphertext || !encrypted?.iv || !encrypted?.tag) {
    throw new Error("Incomplete encrypted Calendly secret");
  }
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    encryptionKey(),
    Buffer.from(encrypted.iv, "base64")
  );
  decipher.setAAD(aad(context));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function randomBase64Url(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function pkceChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier, "ascii").digest("base64url");
}
