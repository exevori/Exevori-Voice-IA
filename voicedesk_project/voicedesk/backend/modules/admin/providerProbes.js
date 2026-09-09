import { performance } from "node:perf_hooks";

export const PROVIDERS = ["twilio", "elevenlabs", "groq", "supabase", "stripe", "resend"];
export const FAILED_PROVIDER_STATUSES = new Set(["down", "unauthorized"]);

// All probes are read-only. A successful probe checks API access, not the
// complete voice/payment/mail delivery flow, which requires separate E2E tests.
export function createProviderProbes({ env = process.env, fetchImpl = fetch,
  monotonicNow = () => performance.now(), now = () => new Date(), timeoutMs = 5000 } = {}) {
  const present = key => typeof env[key] === "string" && env[key].trim().length > 0;
  function definition(provider) {
    const bearer = key => ({ Authorization: `Bearer ${env[key]}` });
    switch (provider) {
      case "twilio": return {
        configured: present("TWILIO_ACCOUNT_SID") && present("TWILIO_AUTH_TOKEN"),
        valid: /^AC[a-f0-9]{32}$/i.test(env.TWILIO_ACCOUNT_SID || ""),
        url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID || "")}.json`,
        headers: { Authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64")}` },
        validate: data => data.sid === env.TWILIO_ACCOUNT_SID && data.status === "active",
      };
      case "elevenlabs": return {
        configured: present("ELEVENLABS_API_KEY"), url: "https://api.elevenlabs.io/v1/user",
        headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
        validate: data => typeof data.user_id === "string" && data.user_id.length > 0,
      };
      case "groq": return {
        configured: present("GROQ_API_KEY"), url: "https://api.groq.com/openai/v1/models",
        headers: bearer("GROQ_API_KEY"), validate: data => Array.isArray(data.data) && data.data.length > 0,
      };
      case "supabase": {
        let origin = null;
        try {
          const url = new URL(env.SUPABASE_URL);
          if (url.protocol === "https:" && /^[a-z0-9-]+\.supabase\.co$/.test(url.hostname)
            && !url.username && !url.password && !url.port) origin = url.origin;
        } catch { /* An invalid configuration must never receive credentials. */ }
        return {
          configured: present("SUPABASE_URL") && present("SUPABASE_SERVICE_ROLE_KEY"), valid: Boolean(origin),
          url: `${origin}/rest/v1/companies?select=id&limit=0`,
          headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, ...bearer("SUPABASE_SERVICE_ROLE_KEY") },
          validate: data => Array.isArray(data),
        };
      }
      case "stripe": return {
        configured: present("STRIPE_SECRET_KEY"), url: "https://api.stripe.com/v1/balance",
        headers: bearer("STRIPE_SECRET_KEY"), validate: data => data.object === "balance",
      };
      case "resend": return {
        configured: present("RESEND_MONITORING_API_KEY") || present("RESEND_API_KEY"),
        url: "https://api.resend.com/domains?limit=1",
        headers: bearer(present("RESEND_MONITORING_API_KEY") ? "RESEND_MONITORING_API_KEY" : "RESEND_API_KEY"),
        validate: data => Array.isArray(data.data),
      };
      default: throw new TypeError("Unknown monitoring provider");
    }
  }

  async function probe(provider) {
    const config = definition(provider);
    const base = { provider, checked_at: now().toISOString(), latency_ms: null };
    if (!config.configured) return { ...base, status: "not_configured", detail: "missing_configuration" };
    if (config.valid === false) return { ...base, status: "not_configured", detail: "invalid_configuration" };
    const started = monotonicNow();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(config.url, { method: "GET", headers: config.headers,
        signal: controller.signal, redirect: "error" });
      if (!response.ok) {
        await response.body?.cancel?.();
        return { ...base, latency_ms: Math.max(0, Math.round(monotonicNow() - started)),
          status: [401, 403].includes(response.status) ? "unauthorized" : "down",
          detail: `http_${response.status}` };
      }
      const data = await response.json();
      const valid = config.validate(data);
      return { ...base, latency_ms: Math.max(0, Math.round(monotonicNow() - started)),
        status: valid ? "ok" : "down", detail: valid ? "api_access_verified" : "unexpected_response" };
    } catch {
      return { ...base, latency_ms: Math.max(0, Math.round(monotonicNow() - started)),
        status: "down", detail: controller.signal.aborted ? "timeout" : "network_or_response_error" };
    } finally { clearTimeout(timeout); }
  }
  return { probe, probeAll: () => Promise.all(PROVIDERS.map(probe)) };
}
