// ============================================================
// VOICEDESK IA — SERVEUR PRINCIPAL BACKEND
// Assemble tous les modules avec middleware auth + logger
// ============================================================

// Node v20 polyfill : doit être importé en PREMIER (avant les modules qui
// instancient un SupabaseClient via middleware/auth.js & routers).
import "./lib/polyfill-websocket.js";

import express from "express";
import http from "node:http";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";

import { logger, requestLogger } from "./lib/logger.js";
import { requireAuth, requireRole } from "./middleware/auth.js";
import { enforceTenantOwnership } from "./middleware/enforceTenantOwnership.js";
import { validateTwilioSignature } from "./middleware/validateTwilioSignature.js";
import { validateStripeSignature } from "./middleware/validateStripeSignature.js";
import { validateElevenLabsSignature } from "./middleware/validateElevenLabsSignature.js";
import { validateCalendlySignature } from "./middleware/validateCalendlySignature.js";

// Modules backend (15)
import authRouter from "./modules/auth/index.js";
import configRouter from "./modules/config/index.js";
import dashboardRouter from "./modules/dashboard/index.js";
import crmRouter from "./modules/crm/index.js";
import calendarRouter, {
  calendarService,
  calendarSupabase,
  createCalendlyOAuthCallbackHandler,
  createCalendlyWebhookHandler,
} from "./modules/calendar/index.js";
import { createCalendarWorkers } from "./modules/calendar/worker.js";
import emailRouter from "./modules/email/index.js";
import callsRouter from "./modules/calls/index.js";
import { recordingRouter } from "./modules/calls/recording.js";
import kbRouter from "./modules/kb/index.js";
import {
  getKnowledgeWorkerStatus,
  startKnowledgeWorker,
} from "./modules/kb/worker.js";
import reportsRouter from "./modules/reports/index.js";
import companyRouter from "./modules/company/index.js";
import teamRouter from "./modules/team/index.js";
import emailAccountsRouter from "./modules/email-accounts/index.js";
import twilioConfigRouter from "./modules/twilio-config/index.js";
import learningRouter from "./modules/learning/index.js";
import knowledgeRouter from "./modules/knowledge/index.js";
import billingRouter from "./modules/billing/index.js";
import ticketsRouter from "./modules/tickets/index.js";
import adminRouter from "./modules/admin/index.js";
import voiceLibraryRouter from "./modules/voice-library/index.js";
import onboardingRouter from "./modules/onboarding/index.js";
import importRouter from "./modules/import/index.js";
import notificationsRouter from "./modules/notifications/index.js";
import outboundRouter from "./modules/outbound/index.js";
import {
  getOutboundWorkerStatus,
  startOutboundWorker,
} from "./modules/outbound/worker.js";
import elevenLabsRouter from "./modules/elevenlabs/index.js";
import { getCustomLlmAuthStatus } from "./modules/elevenlabs/customLlmAuth.js";
import postCallRouter from "./modules/post_call/index.js";
import {
  getPostCallWorkerStatus,
  startPostCallWorker,
} from "./modules/post_call/worker.js";
import privacyRouter, {
  configureCalendlyPrivacyDeleter,
} from "./modules/privacy/index.js";

// Webhooks externes génériques (Gmail Push, Twilio status, Resend)
import webhooksRouter from "./webhooks/index.js";
import { startEmailPoller } from "./modules/email/email_poller.js";
import { startWeeklyReportJob, triggerWeeklyReport } from "./modules/notifications/weekly_report_job.js";
import { startPrivacyRetentionJob } from "./modules/privacy/retention_job.js";
import {
  getPrivacyConsentSyncStatus,
  startPrivacyConsentSync,
} from "./modules/privacy/consent_sync.js";

dotenv.config();

if (calendarService) {
  configureCalendlyPrivacyDeleter(job =>
    calendarService.deleteInviteeData(
      job.company_id,
      `${job.company_id}:${job.external_id}`
    )
  );
}

const calendarWorkers = calendarService && calendarSupabase
  ? createCalendarWorkers({
      supabase: calendarSupabase,
      service: calendarService,
      logger,
    })
  : null;

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";
const trustProxyHops = Number.parseInt(process.env.TRUST_PROXY_HOPS, 10);
if (Number.isInteger(trustProxyHops) && trustProxyHops > 0) {
  // Valeur numérique uniquement : ne jamais faire confiance à une chaîne
  // X-Forwarded-For arbitraire avec `app.set("trust proxy", true)`.
  app.set("trust proxy", trustProxyHops);
}
const m2mIngressLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Math.max(
    500,
    Number.parseInt(process.env.M2M_INGRESS_RATE_LIMIT_PER_MINUTE, 10) || 3_000
  ),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "machine_ingress_rate_limited" },
});
const highVolumeMachinePaths = new Set([
  "/api/voice/call-complete",
  "/api/v1/elevenlabs/llm",
  "/api/v1/elevenlabs/llm/chat/completions",
  "/api/v1/elevenlabs/chat/completions",
]);

// ── MIDDLEWARE GLOBAL ──
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({
  origin: process.env.FRONTEND_URL?.split(",") || ["http://localhost:5173"],
  credentials: true,
}));
app.use(requestLogger);

app.use("/api", rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  skip: req => req.method === "POST"
    && highVolumeMachinePaths.has(req.originalUrl?.split("?")[0]),
  message: { error: "rate_limited", message: "Trop de requêtes" },
}));

// ── WEBHOOK STRIPE (raw body, doit être AVANT json parser) ──
// La logique est dans modules/billing/index.js (route /webhook-stripe)
// On route uniquement /webhooks/stripe → billingRouter pour éviter le doublon
app.post("/webhooks/stripe",
  express.raw({ type: "application/json" }),
  validateStripeSignature,
  (req, res, next) => {
    req.url = "/webhook-stripe"; // mappe vers la route interne du billing module
    billingRouter(req, res, next);
  }
);

// ── WEBHOOK ELEVENLABS POST-CALL (raw body, AVANT json parser, pour HMAC) ──
// Le body brut est nécessaire pour vérifier la signature ElevenLabs-Signature
app.post("/api/voice/call-complete",
  m2mIngressLimiter,
  express.raw({ type: "*/*", limit: "2mb" }),
  validateElevenLabsSignature,
  (req, res, next) => {
    req.url = "/"; // mappe vers la route interne du post_call module
    postCallRouter(req, res, next);
  }
);

// ── JSON parser pour le reste ──
// Webhook Calendly public : tenant résolu par l'identifiant opaque de la
// connexion OAuth, corps brut signé, puis mise en inbox durable/idempotente.
app.post("/webhooks/calendly/:connectionId",
  m2mIngressLimiter,
  express.raw({ type: "application/json", limit: "256kb" }),
  validateCalendlySignature,
  createCalendlyWebhookHandler({ service: calendarService })
);

// Les callbacks Twilio sont des formulaires signes avec HMAC-SHA1.
app.use(
  "/webhooks/twilio",
  express.urlencoded({ extended: false, limit: "100kb" }),
  validateTwilioSignature
);

// Le secret Custom LLM est validé dans le router AVANT son parseur JSON.
// Ce montage doit rester avant les parseurs globaux pour éviter de traiter
// un corps non authentifié.
app.use("/api/v1/elevenlabs", m2mIngressLimiter, elevenLabsRouter);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ── HEALTH CHECKS (public) ──
app.get("/health", (req, res) => {
  const privacyConsentSync = getPrivacyConsentSyncStatus();
  const outboundWorker = getOutboundWorkerStatus();
  const postCallWorker = getPostCallWorkerStatus();
  const knowledgeWorker = getKnowledgeWorkerStatus();
  const customLlmAuth = getCustomLlmAuthStatus();
  const calendarWorker = calendarWorkers?.status() || {
    ready: false,
    started: false,
    last_error: "calendar_not_configured",
  };
  const outboundWorkerRequired = process.env.DISABLE_OUTBOUND_WORKER !== "true";
  const postCallWorkerRequired =
    process.env.DISABLE_POST_CALL_WORKER !== "true";
  const calendarWorkerRequired = process.env.DISABLE_CALENDAR_WORKER !== "true";
  const knowledgeWorkerRequired = process.env.DISABLE_KB_WORKER !== "true";
  const ready = (!outboundWorkerRequired || outboundWorker.ready)
    && (!postCallWorkerRequired || postCallWorker.ready)
    && (!calendarWorkerRequired || calendarWorker.ready)
    && (!knowledgeWorkerRequired || knowledgeWorker.ready)
    && customLlmAuth.ready;
  res.status(ready ? 200 : 503).json({
    status: ready ? "ok" : "degraded",
    service: "voicedesk-backend",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.round(process.uptime()),
    privacy_consent_sync: {
      ready: privacyConsentSync.ready,
      status: privacyConsentSync.status,
      attempt: privacyConsentSync.attempt,
      next_retry_at: privacyConsentSync.nextRetryAt,
    },
    outbound_worker: outboundWorker,
    post_call_worker: postCallWorker,
    calendar_worker: calendarWorker,
    knowledge_worker: knowledgeWorker,
    custom_llm_auth: customLlmAuth,
  });
});

app.get("/", (req, res) => {
  res.json({
    name: "VoiceDesk IA API",
    version: "1.0.0",
    health: "/health",
    docs: "voir docs/EMERGENT-BUILD.md",
  });
});

// ── WEBHOOKS EXTERNES GÉNÉRIQUES (Gmail, Twilio, Resend) - pas d'auth ──
app.use("/webhooks", webhooksRouter);

// ── ELEVENLABS POST-CALL WEBHOOK (public, sans JWT) ──
// Route déjà montée plus haut (avant le json parser, pour HMAC body raw)

// ── ROUTES PUBLIQUES (login, signup, reset) ──
app.use("/api/v1/auth", authRouter);
app.get(
  "/api/v1/calendar/oauth/callback",
  createCalendlyOAuthCallbackHandler({ service: calendarService })
);

// ── ROUTES PROTÉGÉES (requireAuth) ──
app.use("/api/v1/config",         requireAuth, configRouter);
app.use("/api/v1/dashboard",      requireAuth, dashboardRouter);
app.use("/api/v1/contacts",       requireAuth, enforceTenantOwnership, crmRouter);
app.use("/api/v1/calls",          requireAuth, enforceTenantOwnership, callsRouter);
app.use("/api/v1/calls", requireAuth, enforceTenantOwnership, recordingRouter);
app.use("/api/v1/kb",             requireAuth, enforceTenantOwnership, kbRouter);
app.use("/api/v1/reports",        requireAuth, enforceTenantOwnership, reportsRouter);
app.use("/api/v1/company",        requireAuth, enforceTenantOwnership, companyRouter);
app.use("/api/v1/team",           requireAuth, teamRouter);
app.use("/api/v1/email-accounts", requireAuth, enforceTenantOwnership, emailAccountsRouter);
app.use("/api/v1/twilio-config",  requireAuth, enforceTenantOwnership, twilioConfigRouter);
app.use("/api/v1/calendar",       requireAuth, enforceTenantOwnership, calendarRouter);
app.use("/api/v1/emails",         requireAuth, enforceTenantOwnership, emailRouter);
app.use("/api/v1/learning",       requireAuth, enforceTenantOwnership, learningRouter);
app.use("/api/v1/knowledge",      requireAuth, enforceTenantOwnership, knowledgeRouter);
app.use(
  "/api/v1/billing",
  (req, res, next) =>
    req.method === "GET" && req.path === "/verify-session"
      ? next()
      : requireAuth(req, res, next),
  billingRouter
);
app.use("/api/v1/tickets",        requireAuth, ticketsRouter);
app.use("/api/v1/voice-library",  requireAuth, voiceLibraryRouter);
app.use("/api/v1/onboarding",     requireAuth, enforceTenantOwnership, onboardingRouter);
app.use("/api/v1/import",         requireAuth, importRouter);
app.use("/api/v1/notifications",  requireAuth, notificationsRouter);
app.use("/api/v1/outbound",       requireAuth, enforceTenantOwnership, outboundRouter);
app.use("/api/v1/privacy",        requireAuth, enforceTenantOwnership, privacyRouter);

// ── ROUTES ADMIN (super_admin uniquement) ──
app.use("/api/v1/admin", requireAuth, requireRole("super_admin"), adminRouter);

app.get(
  "/api/v1/notifications/weekly-report",
  requireAuth,
  requireRole("super_admin"),
  triggerWeeklyReport
);

// ── 404 ──
app.use((req, res) => {
  res.status(404).json({
    error: "not_found",
    message: `Route inconnue : ${req.method} ${req.path}`,
  });
});

// ── Error handler ──
app.use((err, req, res, next) => {
  logger.error("Server error", { error: err.message, path: req.path });
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({
    error: err.code || "internal_error",
    message: NODE_ENV === "production" ? "Erreur serveur" : err.message,
  });
});

// ── HTTP server ──
const server = http.createServer(app);

// Les anciens WebSockets audio locaux ont été supprimés : Twilio est désormais
// relié nativement à ElevenLabs et aucun flux audio ne transite par ce serveur.

server.on("upgrade", (req, socket, head) => {
  // Aucun WebSocket interne actuellement exposé — toute requête Upgrade est rejetée.
  socket.destroy();
});

if (process.env.DISABLE_BACKGROUND_JOBS !== "true") {
  startEmailPoller();
  startWeeklyReportJob();
}

if (process.env.DISABLE_PRIVACY_RETENTION_JOB !== "true") {
  startPrivacyRetentionJob();
}

if (process.env.DISABLE_PRIVACY_CONSENT_SYNC !== "true") {
  void startPrivacyConsentSync({ logger });
}

if (process.env.DISABLE_OUTBOUND_WORKER !== "true") {
  try {
    startOutboundWorker();
  } catch (error) {
    logger.error("Outbound worker did not start", {
      error_code: error?.code || "outbound_worker_start_failed",
    });
  }
}

if (process.env.DISABLE_POST_CALL_WORKER !== "true") {
  try {
    startPostCallWorker();
  } catch (error) {
    logger.error("Post-call worker did not start", {
      error_code: error?.code || "post_call_worker_start_failed",
    });
  }
}

if (process.env.DISABLE_KB_WORKER !== "true") {
  try {
    startKnowledgeWorker({ logger });
  } catch (error) {
    logger.error("Knowledge worker did not start", {
      error_code: error?.code || error?.message || "kb_worker_start_failed",
    });
  }
}

if (process.env.DISABLE_CALENDAR_WORKER !== "true") {
  try {
    if (!calendarWorkers) throw new Error("calendar_not_configured");
    calendarWorkers.start();
  } catch (error) {
    logger.error("Calendar worker did not start", {
      error_code: error?.code || error?.message || "calendar_worker_start_failed",
    });
  }
}

server.listen(PORT, () => {
  logger.info("VoiceDesk backend started", {
    port: PORT,
    env: NODE_ENV,
    modules: 18,
  });
});

export default app;
