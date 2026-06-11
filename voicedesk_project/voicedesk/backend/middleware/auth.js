// ============================================================
// VOICEDESK IA — MIDDLEWARE D'AUTHENTIFICATION
//
// Vérifie le JWT Supabase à chaque requête API et injecte :
//   req.user.id          → user_id Supabase Auth
//   req.user.email
//   req.user.role        → super_admin | company_admin | company_user
//   req.user.company_id  → pour isolation multi-tenant
//   req.user.profile     → profile complet
//
// Usage dans index.js :
//   import { requireAuth, requireRole, requireSameCompany } from "./middleware/auth.js";
//   app.use("/api/v1/contacts", requireAuth, crmRouter);
//   app.use("/api/v1/admin", requireAuth, requireRole("super_admin"), adminRouter);
// ============================================================

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Cache simple des profiles (TTL 60s) pour éviter de hammer la DB
const profileCache = new Map();
const CACHE_TTL = 60 * 1000;

function getCachedProfile(userId) {
  const cached = profileCache.get(userId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.profile;
  }
  return null;
}

function setCachedProfile(userId, profile) {
  profileCache.set(userId, { profile, timestamp: Date.now() });
}

export function clearProfileCache(userId) {
  if (userId) profileCache.delete(userId);
  else profileCache.clear();
}

// ─────────────────────────────────────────────────────────────
// requireAuth — Vérifie le JWT et charge le profile
// ─────────────────────────────────────────────────────────────
export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "unauthorized", message: "Token requis" });
  }

  const token = authHeader.substring(7);

  try {
    // Vérifier le JWT via Supabase Auth
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: "invalid_token", message: "Token invalide ou expiré" });
    }

    // Charger le profile (avec cache)
    let profile = getCachedProfile(user.id);

    if (!profile) {
      const { data, error: profileError } = await supabase
        .from("profiles")
        .select("*, companies(id, name, status, plan)")
        .eq("user_id", user.id)
        .single();

      if (profileError || !data) {
        return res.status(403).json({ error: "no_profile", message: "Profil introuvable" });
      }

      profile = data;
      setCachedProfile(user.id, profile);
    }

    // Vérifier que le profile est actif
    if (profile.status !== "active") {
      return res.status(403).json({ error: "account_inactive", message: "Compte inactif" });
    }

    // Vérifier que la company est active (sauf pour super_admin)
    if (profile.role !== "super_admin") {
      if (profile.companies?.status === "suspended") {
        return res.status(403).json({
          error: "account_suspended",
          message: "Votre accès est suspendu. Contactez Exevori : info@exevori.com",
        });
      }
      if (profile.companies?.status === "cancelled") {
        return res.status(403).json({
          error: "account_cancelled",
          message: "Compte annulé",
        });
      }
    }

    // Injecter dans req
    req.user = {
      id: user.id,
      email: user.email,
      role: profile.role,
      company_id: profile.company_id,
      profile,
    };

    next();
  } catch (err) {
    console.error("[AUTH MIDDLEWARE]", err);
    return res.status(500).json({ error: "auth_error", message: "Erreur d'authentification" });
  }
}

// ─────────────────────────────────────────────────────────────
// requireRole — Vérifie que l'utilisateur a un rôle spécifique
// ─────────────────────────────────────────────────────────────
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "unauthorized" });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: "forbidden",
        message: `Accès refusé — rôle requis : ${roles.join(" ou ")}`,
      });
    }

    next();
  };
}

// ─────────────────────────────────────────────────────────────
// requireSameCompany — Vérifie que company_id du body/params correspond
// (sauf super_admin qui peut accéder à toutes les companies)
// ─────────────────────────────────────────────────────────────
export function requireSameCompany(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "unauthorized" });
  }

  // Super admin peut tout faire
  if (req.user.role === "super_admin") return next();

  const requestedCompanyId =
    req.params.company_id ||
    req.body?.company_id ||
    req.query.company_id;

  if (!requestedCompanyId) return next(); // pas de company_id à vérifier

  if (requestedCompanyId !== req.user.company_id) {
    return res.status(403).json({
      error: "forbidden_company",
      message: "Accès interdit à cette entreprise",
    });
  }

  next();
}

// ─────────────────────────────────────────────────────────────
// injectCompanyId — Force company_id à la valeur du user connecté
// (sauf super_admin qui peut spécifier un autre company_id)
// ─────────────────────────────────────────────────────────────
export function injectCompanyId(req, res, next) {
  if (!req.user) return next();

  // Super admin peut spécifier explicitement, sinon injecte
  if (req.user.role === "super_admin") return next();

  // Force company_id
  if (req.body && typeof req.body === "object") {
    req.body.company_id = req.user.company_id;
  }
  if (req.query) {
    req.query.company_id = req.user.company_id;
  }

  next();
}

// ─────────────────────────────────────────────────────────────
// optionalAuth — Auth optionnelle (pour routes publiques)
// ─────────────────────────────────────────────────────────────
export async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return next();

  try {
    const token = authHeader.substring(7);
    const { data: { user } } = await supabase.auth.getUser(token);

    if (user) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("*, companies(id, name, status)")
        .eq("user_id", user.id)
        .single();

      if (profile) {
        req.user = {
          id: user.id,
          email: user.email,
          role: profile.role,
          company_id: profile.company_id,
          profile,
        };
      }
    }
  } catch (err) {
    // Silencieux pour optional
  }

  next();
}

export default { requireAuth, requireRole, requireSameCompany, injectCompanyId, optionalAuth };
