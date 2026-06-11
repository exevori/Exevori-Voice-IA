// ============================================================
// VOICEDESK IA — AUTH HELPERS v1
// Supabase Auth + Rôles + Protection des routes
// ============================================================

// ── RÔLES ────────────────────────────────────────────────────
export const ROLES = {
  SUPER_ADMIN:    "super_admin",    // Admin Exevori — accès total
  COMPANY_ADMIN:  "company_admin",  // Responsable PME cliente
  COMPANY_USER:   "company_user",   // Utilisateur secondaire PME
};

export const ROLE_CONFIG = {
  super_admin:   { label: "Admin Exevori",    color: "#EF4444", redirect: "/admin"     },
  company_admin: { label: "Responsable PME",  color: "#3B82F6", redirect: "/dashboard" },
  company_user:  { label: "Utilisateur",      color: "#8B5CF6", redirect: "/dashboard" },
};

// ── PERMISSIONS ───────────────────────────────────────────────
export const PERMISSIONS = {
  // Visible pour tous les rôles connectés
  VIEW_DASHBOARD:     ["super_admin", "company_admin", "company_user"],
  VIEW_CALLS:         ["super_admin", "company_admin", "company_user"],
  VIEW_CRM:           ["super_admin", "company_admin", "company_user"],
  VIEW_MISSIONS:      ["super_admin", "company_admin", "company_user"],
  VIEW_CALENDAR:      ["super_admin", "company_admin", "company_user"],
  VIEW_KNOWLEDGE:     ["super_admin", "company_admin", "company_user"],
  VIEW_EMAILS:        ["super_admin", "company_admin", "company_user"],

  // Company admin seulement
  MANAGE_CONFIG:      ["super_admin", "company_admin"],
  APPROVE_LEARNING:   ["super_admin", "company_admin"],
  APPROVE_DRAFTS:     ["super_admin", "company_admin"],
  TRIGGER_CALLS:      ["super_admin", "company_admin"],

  // Super admin seulement
  VIEW_ADMIN:         ["super_admin"],
  MANAGE_COMPANIES:   ["super_admin"],
  MANAGE_INVITATIONS: ["super_admin"],
  MANAGE_PAYMENTS:    ["super_admin"],
  GLOBAL_CONFIG:      ["super_admin"],
};

export function hasPermission(role, permission) {
  return PERMISSIONS[permission]?.includes(role) ?? false;
}

export function canAccess(role, route) {
  if (route.startsWith("/admin")) return role === ROLES.SUPER_ADMIN;
  return [ROLES.COMPANY_ADMIN, ROLES.COMPANY_USER, ROLES.SUPER_ADMIN].includes(role);
}

// ── STATUTS INVITATION ────────────────────────────────────────
export const INVITATION_STATUSES = {
  pending:  { label: "En attente",  color: "#F59E0B", bg: "rgba(245,158,11,0.15)"  },
  accepted: { label: "Acceptée",    color: "#10B981", bg: "rgba(16,185,129,0.15)"  },
  expired:  { label: "Expirée",     color: "#EF4444", bg: "rgba(239,68,68,0.15)"   },
  cancelled:{ label: "Annulée",     color: "#94A3B8", bg: "rgba(100,116,139,0.15)" },
};

// ── STATUTS COMPTE ────────────────────────────────────────────
export const COMPANY_STATUSES = {
  active:   { label: "Actif",         color: "#10B981", bg: "rgba(16,185,129,0.15)"  },
  trial:    { label: "Essai gratuit", color: "#3B82F6", bg: "rgba(59,130,246,0.15)"  },
  overdue:  { label: "En retard ⚠️",  color: "#F97316", bg: "rgba(249,115,22,0.15)"  },
  suspended:{ label: "Suspendu 🔒",   color: "#EF4444", bg: "rgba(239,68,68,0.15)"   },
  cancelled:{ label: "Annulé",        color: "#94A3B8", bg: "rgba(100,116,139,0.15)" },
};

// ── STATUTS PAIEMENT ──────────────────────────────────────────
export const PAYMENT_STATUSES = {
  active_paid:     { label: "Actif — Payé ✓",    color: "#10B981", bg: "rgba(16,185,129,0.15)"  },
  trial:           { label: "Essai gratuit",      color: "#3B82F6", bg: "rgba(59,130,246,0.15)"  },
  pending_payment: { label: "En attente",         color: "#F59E0B", bg: "rgba(245,158,11,0.15)"  },
  overdue:         { label: "En retard ⚠️",       color: "#F97316", bg: "rgba(249,115,22,0.15)"  },
  suspended:       { label: "Suspendu 🔒",         color: "#EF4444", bg: "rgba(239,68,68,0.15)"   },
  cancelled:       { label: "Annulé",             color: "#94A3B8", bg: "rgba(100,116,139,0.15)" },
};

// ── FLUX D'INVITATION ─────────────────────────────────────────
/**
 * Génère le courriel d'invitation à envoyer via Resend
 */
export function buildInvitationEmail({ companyName, contactName, inviteUrl, expiresAt }) {
  const expiry = new Date(expiresAt).toLocaleDateString("fr-CA", { day: "numeric", month: "long", year: "numeric" });
  return {
    subject: `Votre accès VoiceDesk IA — ${companyName}`,
    html: `
      <h2>Bienvenue sur VoiceDesk IA</h2>
      <p>Bonjour ${contactName},</p>
      <p>Votre compte VoiceDesk IA pour <strong>${companyName}</strong> a été créé par l'équipe Exevori.</p>
      <p>Cliquez sur le lien ci-dessous pour créer votre mot de passe et accéder à votre tableau de bord :</p>
      <p><a href="${inviteUrl}" style="background:#3B82F6;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;margin:16px 0;">
        Créer mon mot de passe →
      </a></p>
      <p style="color:#94A3B8;font-size:13px;">Ce lien expire le ${expiry}. Si vous n'êtes pas à l'origine de cette invitation, ignorez ce courriel.</p>
      <hr style="border-color:#374151;margin:24px 0;">
      <p style="color:#94A3B8;font-size:12px;">VoiceDesk IA par Exevori · Lévis, Québec</p>
    `,
  };
}

/**
 * Génère le courriel de réinitialisation de mot de passe
 */
export function buildPasswordResetEmail({ email, resetUrl }) {
  return {
    subject: "Réinitialisation de votre mot de passe VoiceDesk IA",
    html: `
      <h2>Réinitialisation du mot de passe</h2>
      <p>Vous avez demandé à réinitialiser le mot de passe du compte <strong>${email}</strong>.</p>
      <p><a href="${resetUrl}" style="background:#3B82F6;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;margin:16px 0;">
        Réinitialiser mon mot de passe →
      </a></p>
      <p style="color:#94A3B8;font-size:13px;">Ce lien expire dans 24 heures. Si vous n'avez pas fait cette demande, ignorez ce courriel.</p>
    `,
  };
}

// ── CALCULS MRR ───────────────────────────────────────────────
export function calculateMRR(subscriptions) {
  return subscriptions
    .filter(s => ["active_paid", "trial"].includes(s.payment_status))
    .reduce((total, s) => {
      if (s.billing_cycle === "annual") {
        return total + (s.monthly_price || s.annual_price / 12);
      }
      return total + (s.monthly_price || 0);
    }, 0);
}

export function getPaymentSummary(subscriptions) {
  return {
    mrr:              calculateMRR(subscriptions),
    total:            subscriptions.length,
    active_paid:      subscriptions.filter(s => s.payment_status === "active_paid").length,
    trial:            subscriptions.filter(s => s.payment_status === "trial").length,
    overdue:          subscriptions.filter(s => s.payment_status === "overdue").length,
    pending_payment:  subscriptions.filter(s => s.payment_status === "pending_payment").length,
    suspended:        subscriptions.filter(s => s.payment_status === "suspended").length,
    cancelled:        subscriptions.filter(s => s.payment_status === "cancelled").length,
  };
}

// ── NAVIGATION SELON RÔLE ─────────────────────────────────────
export const ADMIN_NAV_ITEMS = [
  { id: "admin_dashboard",  label: "Tableau de bord", icon: "LayoutDashboard" },
  { id: "admin_companies",  label: "Entreprises",     icon: "Building2",      badge_key: "pending_invitations" },
  { id: "admin_invitations",label: "Invitations",     icon: "Mail",           badge_key: "pending_invitations" },
  { id: "admin_payments",   label: "Paiements",       icon: "CreditCard",     badge_key: "overdue_count" },
  { id: "admin_users",      label: "Utilisateurs",    icon: "Users" },
  { id: "admin_config",     label: "Configuration",   icon: "Settings" },
];

export const CLIENT_NAV_ITEMS = [
  { id: "dashboard",   label: "Tableau de bord",      icon: "LayoutDashboard" },
  { id: "calls",       label: "Appels entrants",       icon: "PhoneIncoming",  badge_key: "active_calls" },
  { id: "outbound",    label: "Appels sortants",       icon: "PhoneOutgoing",  badge_key: "outbound_active" },
  { id: "missions",    label: "Missions",              icon: "Target",         badge_key: "active_missions" },
  { id: "emails",      label: "Courriels",             icon: "Mail",           badge_key: "drafts_pending" },
  { id: "crm",         label: "Clients / CRM",         icon: "Users" },
  { id: "calendar",    label: "Calendrier & RDV",      icon: "Calendar" },
  { id: "knowledge",   label: "Base de connaissances", icon: "BookOpen",       badge_key: "suggestions_pending" },
  { id: "config",      label: "Configuration",         icon: "Settings" },
];

export default {
  ROLES, ROLE_CONFIG, PERMISSIONS,
  INVITATION_STATUSES, COMPANY_STATUSES, PAYMENT_STATUSES,
  ADMIN_NAV_ITEMS, CLIENT_NAV_ITEMS,
  hasPermission, canAccess,
  buildInvitationEmail, buildPasswordResetEmail,
  calculateMRR, getPaymentSummary,
};
