// ============================================================
// VOICEDESK IA — LOGGER STRUCTURÉ
//
// Logs JSON pour la production (compatible Axiom, BetterStack, Datadog).
// Logs colorés et lisibles pour le développement.
//
// Usage :
//   import { logger } from "./lib/logger.js";
//   logger.info("Call completed", { company_id, duration: 142 });
//   logger.error("Failed to send email", { error: err.message });
// ============================================================

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const NODE_ENV = process.env.NODE_ENV || "development";
const LOG_LEVEL = process.env.LOG_LEVEL || (NODE_ENV === "production" ? "info" : "debug");
const MIN_LEVEL = LEVELS[LOG_LEVEL] || 30;

const COLORS = {
  trace: "\x1b[90m",
  debug: "\x1b[36m",
  info:  "\x1b[32m",
  warn:  "\x1b[33m",
  error: "\x1b[31m",
  fatal: "\x1b[35m",
  reset: "\x1b[0m",
  dim:   "\x1b[2m",
};

function formatLog(level, message, context = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    service: process.env.SERVICE_NAME || "voicedesk-backend",
    env: NODE_ENV,
    ...context,
  };

  if (NODE_ENV === "production") {
    return JSON.stringify(entry);
  }

  // Dev : format coloré lisible
  const color = COLORS[level] || COLORS.info;
  const time = entry.timestamp.split("T")[1].substring(0, 8);
  const levelStr = level.toUpperCase().padEnd(5);
  let line = `${COLORS.dim}${time}${COLORS.reset} ${color}${levelStr}${COLORS.reset} ${message}`;

  // Ajouter contexte si présent
  const ctxKeys = Object.keys(context);
  if (ctxKeys.length > 0) {
    const ctx = ctxKeys
      .filter(k => !["timestamp", "level", "message", "service", "env"].includes(k))
      .map(k => `${COLORS.dim}${k}=${COLORS.reset}${JSON.stringify(context[k])}`)
      .join(" ");
    line += " " + ctx;
  }

  return line;
}

function log(level, message, context) {
  if (LEVELS[level] < MIN_LEVEL) return;

  const output = formatLog(level, message, context);

  if (level === "error" || level === "fatal") {
    console.error(output);
  } else if (level === "warn") {
    console.warn(output);
  } else {
    console.log(output);
  }
}

export const logger = {
  trace: (msg, ctx) => log("trace", msg, ctx),
  debug: (msg, ctx) => log("debug", msg, ctx),
  info:  (msg, ctx) => log("info", msg, ctx),
  warn:  (msg, ctx) => log("warn", msg, ctx),
  error: (msg, ctx) => log("error", msg, ctx),
  fatal: (msg, ctx) => log("fatal", msg, ctx),

  // Helper : créer un logger avec contexte par défaut
  child(defaultContext) {
    return {
      trace: (msg, ctx) => log("trace", msg, { ...defaultContext, ...ctx }),
      debug: (msg, ctx) => log("debug", msg, { ...defaultContext, ...ctx }),
      info:  (msg, ctx) => log("info", msg, { ...defaultContext, ...ctx }),
      warn:  (msg, ctx) => log("warn", msg, { ...defaultContext, ...ctx }),
      error: (msg, ctx) => log("error", msg, { ...defaultContext, ...ctx }),
      fatal: (msg, ctx) => log("fatal", msg, { ...defaultContext, ...ctx }),
    };
  },
};

// Middleware Express pour logger les requêtes
export function requestLogger(req, res, next) {
  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";

    log(level, `${req.method} ${req.path}`, {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: duration,
      user_id: req.user?.id,
      company_id: req.user?.company_id,
    });
  });

  next();
}

export default logger;
