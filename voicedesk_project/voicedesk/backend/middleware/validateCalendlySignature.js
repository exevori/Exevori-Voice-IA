import {
  rawBodyError,
  rawBodyToString,
  signatureConfigurationError,
  signatureError,
  verifyTimestampedHmac,
} from "./webhookSignatureUtils.js";

export function validateCalendlySignature(req, res, next) {
  const secret =
    process.env.CALENDLY_WEBHOOK_SECRET
    || process.env.CALENDLY_WEBHOOK_SIGNING_KEY;

  if (!secret) return signatureConfigurationError(res, "calendly");
  if (rawBodyToString(req.body) === null) return rawBodyError(res, "calendly");

  const isValid = verifyTimestampedHmac({
    rawBody: req.body,
    signatureHeader: req.headers["calendly-webhook-signature"],
    secret,
    signatureVersion: "v1",
  });

  return isValid ? next() : signatureError(res, "calendly");
}
