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

// Modules backend (15)
import authRouter from "./modules/auth/index.js";
import configRouter from "./modules/config/index.js";
import dashboardRouter from "./modules/dashboard/index.js";
import crmRouter from "./modules/crm/index.js";
import calendarRouter from "./modules/calendar/index.js";
import emailRouter from "./modules/email/index.js";
import callsRouter from "./modules/calls/index.js";
import kbRouter from "./modules/kb/index.js";
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
import elevenLabsRouter from "./modules/elevenlabs/index.js";
import postCallRouter from "./modules/post_call/index.js";

// Webhooks externes (Gmail Push, Twilio status, Resend, Calendly)
import webhooksRouter from "./webhooks/index.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";

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
  message: { error: "rate_limited", message: "Trop de requêtes" },
}));

// ── WEBHOOK STRIPE (raw body, doit être AVANT json parser) ──
// La logique est dans modules/billing/index.js (route /webhook-stripe)
// On route uniquement /webhooks/stripe → billingRouter pour éviter le doublon
app.post("/webhooks/stripe",
  express.raw({ type: "application/json" }),
  (req, res, next) => {
    req.url = "/webhook-stripe"; // mappe vers la route interne du billing module
    billingRouter(req, res, next);
  }
);

// ── WEBHOOK ELEVENLABS POST-CALL (raw body, AVANT json parser, pour HMAC) ──
// Le body brut est nécessaire pour vérifier la signature ElevenLabs-Signature
app.post("/api/voice/call-complete",
  express.raw({ type: "*/*", limit: "2mb" }),
  (req, res, next) => {
    req.url = "/"; // mappe vers la route interne du post_call module
    postCallRouter(req, res, next);
  }
);

// ── JSON parser pour le reste ──
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ── HEALTH CHECKS (public) ──
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "voicedesk-backend",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.round(process.uptime()),
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

// ── WEBHOOKS EXTERNES (Gmail, Twilio, Resend, Calendly) - pas d'auth ──
app.use("/webhooks", webhooksRouter);

// ── ELEVENLABS CUSTOM LLM (public, sans JWT — appelé par ElevenLabs) ──
app.use("/api/v1/elevenlabs", elevenLabsRouter);

// ── ELEVENLABS POST-CALL WEBHOOK (public, sans JWT) ──
// Route déjà montée plus haut (avant le json parser, pour HMAC body raw)

// ── ROUTES PUBLIQUES (login, signup, reset) ──
app.use("/api/v1/auth", authRouter);

// ── ROUTES PROTÉGÉES (requireAuth) ──
app.use("/api/v1/config",         requireAuth, configRouter);
app.use("/api/v1/dashboard",      requireAuth, dashboardRouter);
app.use("/api/v1/contacts",       requireAuth, crmRouter);
app.use("/api/v1/calls",          requireAuth, callsRouter);
app.use("/api/v1/kb",             requireAuth, kbRouter);
app.use("/api/v1/reports",        requireAuth, reportsRouter);
app.use("/api/v1/company",        requireAuth, companyRouter);
app.use("/api/v1/team",           requireAuth, teamRouter);
app.use("/api/v1/email-accounts", requireAuth, emailAccountsRouter);
app.use("/api/v1/twilio-config",  requireAuth, twilioConfigRouter);
app.use("/api/v1/calendar",       requireAuth, calendarRouter);
app.use("/api/v1/emails",         requireAuth, emailRouter);
app.use("/api/v1/learning",       requireAuth, learningRouter);
app.use("/api/v1/knowledge",      requireAuth, knowledgeRouter);
app.use("/api/v1/billing",        requireAuth, billingRouter);
app.use("/api/v1/tickets",        requireAuth, ticketsRouter);
app.use("/api/v1/voice-library",  requireAuth, voiceLibraryRouter);
app.use("/api/v1/onboarding",     requireAuth, onboardingRouter);
app.use("/api/v1/import",         requireAuth, importRouter);
app.use("/api/v1/notifications",  requireAuth, notificationsRouter);
app.use("/api/v1/outbound",       requireAuth, outboundRouter);

// ── ROUTES ADMIN (super_admin uniquement) ──
app.use("/api/v1/admin", requireAuth, requireRole("super_admin"), adminRouter);

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
  res.status(err.status || 500).json({
    error: err.code || "internal_error",
    message: NODE_ENV === "production" ? "Erreur serveur" : err.message,
  });
});

// ── HTTP server ──
const server = http.createServer(app);

// (Phase 8B/8C ConversationRelay + Phase 8D Media Streams supprimés le 18 juin
//  — Twilio appelle désormais ElevenLabs en direct, plus aucun WS audio local.)

server.on("upgrade", (req, socket, head) => {
  // Aucun WebSocket interne actuellement exposé — toute requête Upgrade est rejetée.
  socket.destroy();
});

server.listen(PORT, () => {
  logger.info("VoiceDesk backend started", {
    port: PORT,
    env: NODE_ENV,
    modules: 16,
  });
});

export default app;
