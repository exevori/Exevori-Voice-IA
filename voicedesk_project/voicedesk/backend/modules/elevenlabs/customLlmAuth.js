import crypto from "node:crypto";

export const CUSTOM_LLM_SECRET_HEADER =
  "x-elevenlabs-custom-llm-secret";

function digestSecret(value) {
  return crypto
    .createHash("sha256")
    .update(String(value ?? ""), "utf8")
    .digest();
}

export function verifyCustomLlmSecret(providedSecret, expectedSecret) {
  const configured =
    typeof expectedSecret === "string" && expectedSecret.length > 0;
  const provided =
    typeof providedSecret === "string" && providedSecret.length > 0;
  const matches = crypto.timingSafeEqual(
    digestSecret(providedSecret),
    digestSecret(expectedSecret || "__unconfigured_custom_llm_secret__")
  );
  return configured && provided && matches;
}

export function readCustomLlmSecret(req) {
  const direct = req.headers?.[CUSTOM_LLM_SECRET_HEADER];
  if (typeof direct === "string" && direct) return direct;

  const authorization = req.headers?.authorization;
  if (typeof authorization !== "string") return "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

export function createCustomLlmAuthMiddleware({
  getExpectedSecret = () => process.env.ELEVENLABS_CUSTOM_LLM_SECRET,
} = {}) {
  return function requireCustomLlmAuth(req, res, next) {
    const expectedSecret = getExpectedSecret();
    if (typeof expectedSecret !== "string" || !expectedSecret) {
      return res.status(503).json({ error: "custom_llm_not_configured" });
    }
    if (!verifyCustomLlmSecret(readCustomLlmSecret(req), expectedSecret)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    return next();
  };
}
