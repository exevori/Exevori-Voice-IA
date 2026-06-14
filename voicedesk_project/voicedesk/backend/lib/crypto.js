// ============================================================
// EXEVORI VOICE IA — CRYPTO HELPER (Phase 6B)
//
// AES-256-GCM pour chiffrer les passwords IMAP des PMEs.
// Clé maître: ENCRYPTION_KEY 32 bytes base64 en .env
// Format de stockage en DB:
//   password_encrypted (ciphertext base64)
//   password_iv        (IV 12 bytes base64)
//   password_tag       (auth tag 16 bytes base64)
//
// ⚠️ Si ENCRYPTION_KEY est perdue, tous les passwords sont
//    irrécupérables. Backup obligatoire (Bitwarden côté Karim).
// ============================================================

import crypto from "node:crypto";
import dotenv from "dotenv";

dotenv.config();

const ALGO = "aes-256-gcm";

function getKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY manquante dans .env");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error(`ENCRYPTION_KEY doit être 32 bytes base64 (44 chars) — actuel: ${buf.length} bytes`);
  return buf;
}

export function encryptPassword(plaintext) {
  if (!plaintext || typeof plaintext !== "string") {
    throw new Error("encryptPassword: plaintext string requis");
  }
  const key = getKey();
  const iv = crypto.randomBytes(12);                          // standard GCM IV size
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ct.toString("base64"),
    iv:         iv.toString("base64"),
    tag:        tag.toString("base64"),
  };
}

export function decryptPassword({ ciphertext, iv, tag }) {
  if (!ciphertext || !iv || !tag) throw new Error("decryptPassword: ciphertext, iv et tag requis");
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}

// Sanity check au boot (optionnel, utile en debug)
export function selfTestCrypto() {
  const sample = "test-password-12345-éàü";
  const enc = encryptPassword(sample);
  const dec = decryptPassword(enc);
  if (dec !== sample) throw new Error("Crypto self-test FAILED — ENCRYPTION_KEY corrompue ?");
  return true;
}
