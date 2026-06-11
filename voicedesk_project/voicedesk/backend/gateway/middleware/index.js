// ============================================================
// VOICEDESK IA — AI GATEWAY — MIDDLEWARE
// Validation, rate limiting, logging, cost tracking
// ============================================================

// ── VALIDATOR ───────────────────────────────────────────────
export const validator = (req, res, next) => {
  const { task, input } = req.body;

  const VALID_TASKS = [
    "conversation",
    "draft_email",
    "summarize_call",
    "classify_intent",
    "suggest_learning",
    "email_reply",
    "detect_language",
    "parse_import",
  ];

  if (!task) {
    return res.status(400).json({ success: false, error: "Champ 'task' requis" });
  }

  if (!VALID_TASKS.includes(task)) {
    return res.status(400).json({
      success: false,
      error:   `Tâche invalide: "${task}"`,
      valid_tasks: VALID_TASKS,
    });
  }

  if (!input && task !== "suggest_learning") {
    return res.status(400).json({ success: false, error: "Champ 'input' requis" });
  }

  next();
};

// ── RATE LIMITER ─────────────────────────────────────────────
// Par organisation — évite les abus et les bugs en boucle
const rateLimitMap = new Map();

export const rateLimiter = (req, res, next) => {
  const orgId     = req.headers["x-organization-id"] || "anonymous";
  const now       = Date.now();
  const windowMs  = 60_000; // 1 minute
  const maxPerMin = 60;     // 60 requêtes par minute par organisation

  if (!rateLimitMap.has(orgId)) {
    rateLimitMap.set(orgId, { count: 0, resetAt: now + windowMs });
  }

  const limit = rateLimitMap.get(orgId);

  if (now > limit.resetAt) {
    limit.count   = 0;
    limit.resetAt = now + windowMs;
  }

  limit.count++;

  if (limit.count > maxPerMin) {
    return res.status(429).json({
      success: false,
      error:   "Trop de requêtes — réessayez dans une minute",
      retry_after_ms: limit.resetAt - now,
    });
  }

  next();
};

// ── LOGGER ───────────────────────────────────────────────────
export const logger = (req, res, next) => {
  if (req.path === "/api/ai/health") return next(); // Skip health checks

  const start = Date.now();
  const orgId = req.headers["x-organization-id"] || "anonymous";

  res.on("finish", () => {
    const duration  = Date.now() - start;
    const status    = res.statusCode;
    const task      = req.body?.task || "-";
    const provider  = res.locals?.provider || "-";

    console.log(
      `[AI Gateway] ${new Date().toISOString()} | org:${orgId} | task:${task} | provider:${provider} | ${status} | ${duration}ms`
    );
  });

  next();
};

// ── COST TRACKER ─────────────────────────────────────────────
// Sauvegarde les coûts dans Supabase pour affichage dans le dashboard
export const costTracker = (req, res, next) => {
  const originalJson = res.json.bind(res);

  res.json = async (body) => {
    if (body?.success && body?.cost_usd) {
      try {
        // Log asynchrone — ne bloque pas la réponse
        logCostToSupabase({
          organization_id: req.headers["x-organization-id"],
          task:            body.task,
          provider:        body.provider,
          model:           body.model,
          tokens_used:     body.tokens_used,
          cost_usd:        body.cost_usd,
          latency_ms:      body.latency_ms,
        }).catch(err => console.error("[CostTracker] Erreur log:", err.message));
      } catch { /* silencieux */ }
    }
    return originalJson(body);
  };

  next();
};

async function logCostToSupabase(data) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) return;

  await fetch(`${supabaseUrl}/rest/v1/ai_usage_logs`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "apikey":        supabaseKey,
      "Authorization": `Bearer ${supabaseKey}`,
      "Prefer":        "return=minimal",
    },
    body: JSON.stringify({
      ...data,
      created_at: new Date().toISOString(),
    }),
  });
}
