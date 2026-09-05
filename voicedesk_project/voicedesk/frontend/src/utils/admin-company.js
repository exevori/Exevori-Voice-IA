const ERRORS = {
  forbidden: "Cette action est réservée à l’équipe Exevori.",
  company_not_found: "Cette entreprise est introuvable.",
  company_confirmation_required: "Confirmez l’entreprise concernée.",
  reason_required: "Indiquez un motif entre 3 et 500 caractères.",
  company_not_suspended: "Cette entreprise n’est pas suspendue. Actualisez la fiche.",
  company_changed_retry: "L’entreprise a changé depuis la lecture. Actualisez avant de réessayer.",
  stripe_verification_required: "Stripe doit être accessible et le rattachement vérifié avant cette action.",
  subscription_inactive: "L’abonnement doit être actif ou en essai valide avant cette action.",
  trial_expired: "La période d’essai est expirée.",
  company_access_inactive: "Réactivez d’abord l’accès à cette entreprise.",
  cancelled_company: "Cette entreprise est annulée.",
  welcome_email_not_configured: "L’envoi du courriel de bienvenue n’est pas configuré.",
  company_email_invalid: "Le courriel de contact de l’entreprise est invalide.",
  welcome_email_send_failed: "Le courriel n’a pas été confirmé par le service d’envoi. Réessayez avec la même demande.",
  provisioning_in_progress: "Une tentative de provisioning est déjà en cours. Actualisez dans quelques instants.",
  provisioning_resync_failed: "La relance du provisioning a échoué. Consultez l’état de configuration.",
  assistant_config_required: "La configuration de l’assistante est requise.",
  admin_audit_failed: "Le journal d’audit est indisponible. L’action n’a pas été lancée.",
};

export async function requestAdminJson(url, { token, fetchImpl = fetch, ...options } = {}) {
  const response = await fetchImpl(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
  });
  let payload;
  try { payload = await response.json(); } catch {
    throw new Error("Le serveur a renvoyé une réponse illisible. Réessayez après actualisation.");
  }
  if (!response.ok) throw new Error(ERRORS[payload?.error] || `La demande a échoué (HTTP ${response.status}).`);
  return payload;
}

export function money(value, currency = "USD") {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "Non disponible";
  return new Intl.NumberFormat("fr-CA", { style: "currency", currency }).format(Number(value));
}

export function stripeLabel(snapshot) {
  if (snapshot?.state !== "verified") return {
    not_linked: "Aucun abonnement Stripe lié", not_configured: "Stripe non configuré",
    mismatch: "Rattachement Stripe incohérent", unavailable: "Stripe indisponible",
  }[snapshot?.state] || "Statut non vérifié";
  return {
    active: "Actif", trialing: "En essai", past_due: "Paiement en retard",
    unpaid: "Paiement échoué", incomplete: "Paiement incomplet",
    incomplete_expired: "Activation expirée", canceled: "Annulé", paused: "Suspendu",
  }[snapshot.subscription_status] || "Statut inconnu";
}

export function elevenLabsDashboardUrl(agentId) {
  return typeof agentId === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(agentId)
    ? `https://elevenlabs.io/app/agents/agents/${encodeURIComponent(agentId)}` : null;
}
