import crypto from "node:crypto";

export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export function rawBodyToString(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody.toString("utf8");
  if (typeof rawBody === "string") return rawBody;
  return null;
}

export function parseSignatureHeader(signatureHeader) {
  const values = new Map();

  for (const part of String(signatureHeader || "").split(",")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (!key || !value) continue;

    const existing = values.get(key) || [];
    existing.push(value);
    values.set(key, existing);
  }

  return values;
}

export function timingSafeHexEqual(expectedHex, receivedHex) {
  if (
    typeof expectedHex !== "string"
    || typeof receivedHex !== "string"
    || !/^[a-f0-9]+$/i.test(receivedHex)
  ) {
    return false;
  }

  const expected = Buffer.from(expectedHex, "hex");
  const received = Buffer.from(receivedHex, "hex");
  return expected.length === received.length
    && crypto.timingSafeEqual(expected, received);
}

export function verifyTimestampedHmac({
  rawBody,
  signatureHeader,
  secret,
  signatureVersion,
  toleranceSeconds = DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const payload = rawBodyToString(rawBody);
  if (payload === null || !signatureHeader || !secret) return false;

  const parts = parseSignatureHeader(signatureHeader);
  const timestamp = parts.get("t")?.[0];
  const signatures = parts.get(signatureVersion) || [];
  const timestampNumber = Number(timestamp);

  if (
    !timestamp
    || signatures.length === 0
    || !Number.isInteger(timestampNumber)
    || Math.abs(nowSeconds - timestampNumber) > toleranceSeconds
  ) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`, "utf8")
    .digest("hex");

  return signatures.some(signature => timingSafeHexEqual(expected, signature));
}

export function signatureError(res, provider) {
  return res.status(403).json({
    error: "invalid_webhook_signature",
    provider,
  });
}

export function signatureConfigurationError(res, provider) {
  return res.status(503).json({
    error: "webhook_signature_not_configured",
    provider,
  });
}

export function rawBodyError(res, provider) {
  return res.status(400).json({
    error: "raw_webhook_body_required",
    provider,
  });
}
