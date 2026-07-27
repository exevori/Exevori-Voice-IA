import crypto from "node:crypto";
import {
  signatureConfigurationError,
  signatureError,
} from "./webhookSignatureUtils.js";

function getHeader(req, name) {
  return req.get?.(name) || req.headers?.[name.toLowerCase()];
}

export function buildTwilioRequestUrl(req) {
  const configuredBaseUrl =
    process.env.TWILIO_WEBHOOK_BASE_URL
    || process.env.PUBLIC_BACKEND_URL
    || process.env.BACKEND_URL;
  const requestPath = req.originalUrl || req.url || "/";
  const normalizedPath = requestPath.startsWith("/")
    ? requestPath
    : `/${requestPath}`;

  if (configuredBaseUrl) {
    return `${configuredBaseUrl.replace(/\/+$/, "")}${normalizedPath}`;
  }

  const protocol =
    String(getHeader(req, "x-forwarded-proto") || req.protocol || "https")
      .split(",")[0]
      .trim();
  const host =
    String(getHeader(req, "x-forwarded-host") || getHeader(req, "host") || "")
      .split(",")[0]
      .trim();

  if (!host) return null;
  return `${protocol}://${host}${normalizedPath}`;
}

function appendTwilioParameterValues(base, key, value) {
  const values = Array.isArray(value)
    ? [...new Set(value.map(item => (item == null ? "" : String(item))))].sort()
    : [value];
  return values.reduce(
    (result, item) => `${result}${key}${item == null ? "" : String(item)}`,
    base
  );
}

export function computeTwilioSignature(authToken, url, params = {}) {
  const signedValue = Object.keys(params)
    .sort()
    .reduce(
      (result, key) => appendTwilioParameterValues(result, key, params[key]),
      url
    );

  return crypto
    .createHmac("sha1", authToken)
    .update(signedValue, "utf8")
    .digest("base64");
}

export function validateTwilioSignature(req, res, next) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return signatureConfigurationError(res, "twilio");

  const signature = getHeader(req, "x-twilio-signature");
  const requestUrl = buildTwilioRequestUrl(req);
  if (!signature || !requestUrl) return signatureError(res, "twilio");

  const expected = computeTwilioSignature(authToken, requestUrl, req.body || {});
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(String(signature), "utf8");
  const isValid =
    expectedBuffer.length === receivedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);

  return isValid ? next() : signatureError(res, "twilio");
}
