// ============================================================
// EXEVORI VOICE IA — Twilio signature verification (Phase 8A)
//
// Vérifie la signature HMAC-SHA1 du webhook Twilio :
//   header X-Twilio-Signature = base64(HMAC-SHA1(authToken, url + sortedParamsJoined))
//
// Doc officielle Twilio:
//   https://www.twilio.com/docs/usage/webhooks/webhooks-security
// ============================================================

import twilio from "twilio";

/**
 * Express middleware. Vérifie la signature Twilio sur les webhooks HTTP.
 * Bypass automatique si NODE_ENV=development ET TWILIO_AUTH_TOKEN absent
 * (utile pour les tests locaux sans creds).
 */
export function verifyTwilioSignature(req, res, next) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  const isDev = process.env.NODE_ENV !== "production";
  const isPlaceholder = !token || token === "placeholder" || token.startsWith("placeholder");
  const explicitBypass = process.env.DEV_BYPASS_TWILIO_SIGNATURE === "true";

  // Bypass en dev si pas de vraie clé OU si flag explicite (pour pytest local)
  if (isDev && (isPlaceholder || explicitBypass)) {
    req.twilioSignatureBypassed = true;
    return next();
  }
  if (!token) {
    return res.status(500).json({ error: "TWILIO_AUTH_TOKEN missing" });
  }

  const signature = req.header("X-Twilio-Signature");
  if (!signature) {
    return res.status(403).json({ error: "X-Twilio-Signature missing" });
  }

  // Reconstruit l'URL publique (le proxy Emergent forward HTTPS → HTTP localhost)
  const proto = req.header("X-Forwarded-Proto") || req.protocol;
  const host  = req.header("X-Forwarded-Host")  || req.header("host");
  const url   = `${proto}://${host}${req.originalUrl}`;

  // Twilio envoie les paramètres en application/x-www-form-urlencoded
  const params = req.body && typeof req.body === "object" ? req.body : {};

  const ok = twilio.validateRequest(token, signature, url, params);
  if (!ok) {
    return res.status(403).json({ error: "Invalid Twilio signature", url });
  }
  next();
}
