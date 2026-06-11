// ============================================================
// VOICEDESK IA — CONSTANTES PARTAGÉES
// Utilisées par backend ET frontend
// ============================================================

// ── PRIX DE BASE (même chiffre dans toutes les devises) ──
// Les prix couvrent les frais Stripe (~3,5% amortis)
// CA : prix en CAD + TPS/TVQ ajoutées
// US : prix en USD, sans taxe
// EU : prix en EUR, sans taxe
// Reste du monde : prix en USD, sans taxe
export const PLANS = {
  solo: {
    label: "Solo",
    price: 79,                 // CAD HT | USD | EUR selon pays
    price_annual: 758,         // -20%
    minutes_included: 150,
    overage_rate: 0.35,
    max_voices: 1,
    max_services: 1,
  },
  demarrage: {
    label: "Démarrage",
    price: 159,
    price_annual: 1526,
    minutes_included: 400,
    overage_rate: 0.30,
    max_voices: 1,
    max_services: 2,
  },
  essentiel: {
    label: "Essentiel",
    price: 319,
    price_annual: 3062,
    minutes_included: 1000,
    overage_rate: 0.25,
    max_voices: 2,
    max_services: 4,
  },
  professionnel: {
    label: "Professionnel",
    price: 529,
    price_annual: 5078,
    minutes_included: 2500,
    overage_rate: 0.20,
    max_voices: 4,
    max_services: 8,
  },
  entreprise: {
    label: "Entreprise",
    price: 949,
    price_annual: 9110,
    minutes_included: 6000,
    overage_rate: 0.15,
    max_voices: 99,
    max_services: 99,
  },
};

// ── FRAIS D'INSTALLATION ──
// ⚠️ CANADA UNIQUEMENT. Non applicable US / Europe / reste du monde.
export const INSTALLATION_FEE = 319;        // CAD HT, Canada seulement
export const INSTALLATION_FEE_COUNTRIES = ["CA"];
export const ANNUAL_DISCOUNT = 0.20;

// ── TAXES CANADIENNES ──
export const TAXES_CA = {
  TPS: 0.05,        // Taxe fédérale 5%
  TVQ: 0.09975,     // Taxe Québec 9,975%
  TOTAL: 0.14975,   // Combiné 14,975%
};

// ── PAYS UE (facturation EUR) ──
export const EU_COUNTRIES = [
  "AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR",
  "DE","GR","HU","IE","IT","LV","LT","LU","MT","NL",
  "PL","PT","RO","SK","SI","ES","SE",
];

// ── RÉSOLUTION PRIX PAR PAYS ──
// Retourne { currency, price, taxes, total, installation_fee }
export function getPricingForCountry(planKey, country, billingCycle = "monthly") {
  const plan = PLANS[planKey];
  if (!plan) return null;

  const basePrice = billingCycle === "annual" ? plan.price_annual : plan.price;

  // 🇨🇦 Canada : CAD + TPS/TVQ + frais installation
  if (country === "CA") {
    const tps = +(basePrice * TAXES_CA.TPS).toFixed(2);
    const tvq = +(basePrice * TAXES_CA.TVQ).toFixed(2);
    return {
      currency: "CAD",
      price: basePrice,
      taxes: { tps, tvq, label: "TPS + TVQ" },
      total: +(basePrice + tps + tvq).toFixed(2),
      installation_fee: INSTALLATION_FEE,
      installation_taxes: +(INSTALLATION_FEE * TAXES_CA.TOTAL).toFixed(2),
    };
  }

  // 🇺🇸 USA : USD sans taxe, pas d'installation
  if (country === "US") {
    return {
      currency: "USD",
      price: basePrice,
      taxes: null,
      total: basePrice,
      installation_fee: 0,
    };
  }

  // 🇪🇺 Europe : EUR sans taxe, pas d'installation
  if (EU_COUNTRIES.includes(country)) {
    return {
      currency: "EUR",
      price: basePrice,
      taxes: null,
      total: basePrice,
      installation_fee: 0,
    };
  }

  // 🌍 Reste du monde : USD sans taxe, pas d'installation
  return {
    currency: "USD",
    price: basePrice,
    taxes: null,
    total: basePrice,
    installation_fee: 0,
  };
}

// ── LANGUES SUPPORTÉES ──
export const LANGUAGES = {
  "fr-CA": { label: "Français (Québec)", flag: "🇨🇦", default_voice_accent: "quebec" },
  "fr-FR": { label: "Français (France)", flag: "🇫🇷", default_voice_accent: "france" },
  "en-CA": { label: "English (Canada)", flag: "🇨🇦", default_voice_accent: "american" },
  "en-US": { label: "English (USA)", flag: "🇺🇸", default_voice_accent: "american" },
};

// ── RÔLES ──
export const ROLES = {
  super_admin: { label_fr: "Super Admin", label_en: "Super Admin" },
  company_admin: { label_fr: "Administrateur", label_en: "Administrator" },
  company_user: { label_fr: "Utilisateur", label_en: "User" },
};

// ── STATUTS ──
export const COMPANY_STATUSES = [
  "trial", "active", "overdue", "suspended", "suspended_overage", "cancelled",
];

// ── TICKETS + SLA ──
export const TICKET_PRIORITIES = {
  urgent: { label_fr: "🔴 Urgent",  label_en: "🔴 Urgent",  sla_first_response_hours: 1,  sla_resolution_hours: 4 },
  high:   { label_fr: "🟠 Haute",   label_en: "🟠 High",    sla_first_response_hours: 4,  sla_resolution_hours: 24 },
  normal: { label_fr: "🔵 Normale", label_en: "🔵 Normal",  sla_first_response_hours: 24, sla_resolution_hours: 72 },
  low:    { label_fr: "⚪ Basse",   label_en: "⚪ Low",     sla_first_response_hours: 48, sla_resolution_hours: 168 },
};

// ── SERVICES PAR DÉFAUT ──
export const DEFAULT_SERVICES = [
  { code: "reception",    name_fr: "Réception",       name_en: "Reception",        icon: "Phone",         color: "#3B82F6" },
  { code: "appointments", name_fr: "Rendez-vous",     name_en: "Appointments",     icon: "Calendar",      color: "#8B5CF6" },
  { code: "support",      name_fr: "Support client",  name_en: "Customer support", icon: "MessageCircle", color: "#10B981" },
  { code: "outbound",     name_fr: "Appels sortants", name_en: "Outbound calls",   icon: "PhoneOutgoing", color: "#F59E0B" },
];

// ── ROUTES API ──
export const API_ROUTES = {
  AUTH_ME: "/api/v1/auth/me",
  CONFIG: "/api/v1/config",
  CONFIG_VOICES: "/api/v1/config/voices",
  DASHBOARD_STATS: "/api/v1/dashboard/stats",
  DASHBOARD_ACTIVITY: "/api/v1/dashboard/activity",
  DASHBOARD_ALERTS: "/api/v1/dashboard/alerts",
  CONTACTS: "/api/v1/contacts",
  EMAILS: "/api/v1/emails",
  EMAIL_DRAFTS: "/api/v1/emails/drafts",
  KNOWLEDGE: "/api/v1/knowledge",
  LEARNING_SUGGESTIONS: "/api/v1/learning/suggestions",
  BILLING_ME: "/api/v1/billing/me",
  BILLING_CHECKOUT: "/api/v1/billing/checkout",
  BILLING_PORTAL: "/api/v1/billing/portal",
  BILLING_PRICING: "/api/v1/billing/pricing",
  TICKETS: "/api/v1/tickets",
  VOICE_LIBRARY: "/api/v1/voice-library",
  NOTIFICATIONS: "/api/v1/notifications",
  NOTIFICATIONS_UNREAD: "/api/v1/notifications/unread-count",
  ADMIN_DASHBOARD: "/api/v1/admin/dashboard",
};
