export const PROVISIONING_CHECK_LABELS = {
  database: "Rattachement dans VoiceDesk", twilio: "Numéro Twilio et compte maître",
  elevenlabs_agent: "Agent ElevenLabs", elevenlabs_link: "Liaison numéro → assistante",
};

const DETAILS = {
  consistent: "Références cohérentes", number_active: "Numéro actif, voix disponible", agent_exists: "Agent présent",
  number_linked: "Numéro lié à l’assistante attendue", number_unassigned: "Numéro présent mais aucune assistante assignée",
  assistant_references_missing: "Références de l’assistante à restaurer", multiple_phone_numbers: "Plusieurs numéros : contrôle manuel nécessaire",
  phone_number_missing: "Aucun numéro dédié enregistré", no_unique_phone: "Un numéro unique est nécessaire pour vérifier",
  phone_not_active_or_owned: "Numéro suspendu ou rattachement incorrect", resource_identifiers_missing_or_invalid: "Identifiants de ressources absents ou invalides",
  twilio_config_mismatch: "Configuration Twilio incohérente", assistant_config_missing: "Configuration de l’assistante absente",
  assistant_config_mismatch: "La configuration référence une autre ressource", resource_ownership_conflict: "Une ressource est aussi référencée ailleurs : réparation bloquée",
  onboarding_missing: "Progression d’inscription absente", provisioning_in_progress: "Provisionnement déjà en cours",
  provisioning_status_incomplete: "État de provisionnement à réconcilier après vérification des ressources",
  not_configured: "Clé fournisseur absente ou configuration invalide", unauthorized: "Accès fournisseur refusé",
  timeout: "Délai de réponse dépassé", unavailable: "Fournisseur indisponible ou réponse illisible", missing: "Ressource introuvable chez le fournisseur",
  invalid_id: "Identifiant absent ou invalide", account_inactive_or_mismatch: "Compte Twilio inactif ou différent",
  number_mismatch_or_inactive: "Numéro incohérent, inactif ou sans capacité voix", agent_mismatch: "L’agent retourné ne correspond pas",
  phone_or_assignment_mismatch: "Numéro ou agent assigné différent : contrôle manuel nécessaire",
};

export function provisioningDetail(code) { return DETAILS[code] || "Vérification non concluante"; }

export function provisioningSummary(report) {
  const rows = report?.checks;
  if (!Array.isArray(rows) || rows.length !== 4 || !Object.keys(PROVISIONING_CHECK_LABELS).every(key => rows.some(row => row.key === key))) {
    return { label: "Non vérifié", variant: "orange" };
  }
  if (report.status === "healthy" && rows.every(row => row.state === "ok")) return { label: "Cohérent", variant: "green" };
  if (rows.some(row => row.state === "error" || row.state === "repairable")) return { label: "Anomalie détectée", variant: "red" };
  return { label: "Vérification incomplète", variant: "orange" };
}
