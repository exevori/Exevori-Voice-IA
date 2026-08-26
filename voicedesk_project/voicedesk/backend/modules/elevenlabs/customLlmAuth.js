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

export function parseCustomLlmAgentSecrets(rawValue) {
  if (typeof rawValue !== "string" || !rawValue.trim()) return null;
  const parsed = JSON.parse(rawValue);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new TypeError("custom_llm_agent_secrets_invalid");
  }
  const rawEntries = Object.entries(parsed);
  const entries = rawEntries.filter(
    ([agentId, secret]) => agentId.trim() && typeof secret === "string" && secret.length >= 24
  );
  const uniqueSecrets = new Set(entries.map(([, secret]) => secret));
  if (
    entries.length === 0
    || entries.length !== rawEntries.length
    || uniqueSecrets.size !== entries.length
  ) {
    throw new TypeError("custom_llm_agent_secrets_empty");
  }
  return Object.fromEntries(entries);
}

export function getCustomLlmAuthStatus({
  nodeEnv = process.env.NODE_ENV,
  rawAgentSecrets = process.env.ELEVENLABS_CUSTOM_LLM_AGENT_SECRETS_JSON,
} = {}) {
  try {
    const agentSecrets = parseCustomLlmAgentSecrets(rawAgentSecrets);
    if (agentSecrets) {
      return { ready: true, mode: "per_agent" };
    }
    if (nodeEnv === "production") {
      return { ready: false, mode: "missing_per_agent_secrets" };
    }
    return { ready: true, mode: "development_shared_secret" };
  } catch {
    return { ready: false, mode: "invalid_per_agent_secrets" };
  }
}

export function createCustomLlmAuthMiddleware({
  getExpectedSecret = () => process.env.ELEVENLABS_CUSTOM_LLM_SECRET,
  getAgentSecrets = () => process.env.ELEVENLABS_CUSTOM_LLM_AGENT_SECRETS_JSON,
  getNodeEnv = () => process.env.NODE_ENV,
} = {}) {
  return function requireCustomLlmAuth(req, res, next) {
    let expectedSecret;
    try {
      const agentSecrets = parseCustomLlmAgentSecrets(getAgentSecrets());
      if (agentSecrets) {
        const agentId = String(req.headers?.["x-elevenlabs-agent-id"] || "").trim();
        expectedSecret = agentSecrets[agentId];
        if (!agentId || !expectedSecret) {
          return res.status(401).json({ error: "unauthorized_agent" });
        }
        req.customLlmAgentId = agentId;
      } else {
        if (getNodeEnv() === "production") {
          return res.status(503).json({ error: "custom_llm_per_agent_secrets_required" });
        }
        expectedSecret = getExpectedSecret();
      }
    } catch {
      return res.status(503).json({ error: "custom_llm_agent_secrets_invalid" });
    }
    if (typeof expectedSecret !== "string" || !expectedSecret) {
      return res.status(503).json({ error: "custom_llm_not_configured" });
    }
    if (!verifyCustomLlmSecret(readCustomLlmSecret(req), expectedSecret)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    return next();
  };
}
