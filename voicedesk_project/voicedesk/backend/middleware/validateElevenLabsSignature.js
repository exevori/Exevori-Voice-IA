import {
  rawBodyError,
  rawBodyToString,
  signatureConfigurationError,
  signatureError,
  verifyTimestampedHmac,
} from "./webhookSignatureUtils.js";

export function validateElevenLabsSignature(req, res, next) {
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  if (!secret) return signatureConfigurationError(res, "elevenlabs");
  if (rawBodyToString(req.body) === null) return rawBodyError(res, "elevenlabs");

  const isValid = verifyTimestampedHmac({
    rawBody: req.body,
    signatureHeader:
      req.headers["elevenlabs-signature"]
      || req.headers["x-elevenlabs-signature"],
    secret,
    signatureVersion: "v0",
  });

  return isValid ? next() : signatureError(res, "elevenlabs");
}
