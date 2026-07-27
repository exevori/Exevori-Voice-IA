import {
  rawBodyError,
  rawBodyToString,
  signatureConfigurationError,
  signatureError,
  verifyTimestampedHmac,
} from "./webhookSignatureUtils.js";

export function validateStripeSignature(req, res, next) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return signatureConfigurationError(res, "stripe");
  if (rawBodyToString(req.body) === null) return rawBodyError(res, "stripe");

  const isValid = verifyTimestampedHmac({
    rawBody: req.body,
    signatureHeader: req.headers["stripe-signature"],
    secret,
    signatureVersion: "v1",
  });

  return isValid ? next() : signatureError(res, "stripe");
}
