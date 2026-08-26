import { evaluateBusinessHours } from "./businessHours.js";

export const DEFAULT_BUSINESS_TIMEZONE = "America/Toronto";
export const DEFAULT_AFTER_HOURS_MESSAGE_FR =
  "Nos bureaux sont actuellement fermés jusqu'à {next_open}. "
  + "Je peux prendre votre message pour que l'équipe vous rappelle.";

export class InboundPolicyError extends Error {
  constructor(code) {
    super(code);
    this.name = "InboundPolicyError";
    this.code = code;
  }
}

function normalizeDirection(value) {
  return String(value || "").trim().toLowerCase() === "outbound"
    ? "outbound"
    : "inbound";
}

function afterHoursMessage(template, nextOpenLabel) {
  const configured =
    typeof template === "string"
      && template.trim().length > 0
      && template.trim().length <= 1000
      ? template.trim()
      : DEFAULT_AFTER_HOURS_MESSAGE_FR;
  return configured.replaceAll(
    "{next_open}",
    nextOpenLabel || "notre prochaine ouverture"
  );
}

function afterHoursPrompt(message) {
  return [
    "CONSIGNE HORS HORAIRES — PRIORITÉ ÉLEVÉE :",
    `Les bureaux sont actuellement fermés. Message à communiquer : « ${message} »`,
    "Si cette annonce n'apparaît pas encore dans l'historique, commence ta prochaine réponse par ce message. Ne la répète pas ensuite.",
    "Tu peux répondre aux questions générales, prendre un message ou proposer un rendez-vous.",
    "Ne promets pas la disponibilité immédiate d'un employé et ne déclenche pas de transfert humain pendant la fermeture.",
  ].join("\n");
}

/**
 * Charge exclusivement la politique du tenant résolu côté serveur. Un appel
 * sortant est explicitement exclu : son horaire est arbitré par la file
 * sortante et ne doit jamais hériter des règles de réception.
 */
export async function resolveInboundPolicy({
  supabase,
  companyId,
  direction = "inbound",
  now = new Date(),
} = {}) {
  const safeDirection = normalizeDirection(direction);
  if (safeDirection === "outbound") {
    return {
      direction: safeDirection,
      configured: false,
      isOpen: true,
      isAfterHours: false,
      message: "",
      promptSuffix: "",
    };
  }
  if (!supabase || !companyId) {
    throw new InboundPolicyError("voice_call_settings_unavailable");
  }

  const { data: settings, error } = await supabase
    .from("voice_call_settings")
    .select("timezone, business_hours, after_hours_message_fr")
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) throw new InboundPolicyError("voice_call_settings_lookup_failed");
  if (!settings) {
    return {
      direction: safeDirection,
      configured: false,
      isOpen: true,
      isAfterHours: false,
      message: "",
      promptSuffix: "",
    };
  }

  let evaluation;
  try {
    evaluation = evaluateBusinessHours({
      now,
      timeZone: settings.timezone || DEFAULT_BUSINESS_TIMEZONE,
      businessHours: settings.business_hours,
    });
  } catch {
    throw new InboundPolicyError("invalid_voice_call_settings");
  }

  if (!evaluation.configured || evaluation.isOpen) {
    return {
      direction: safeDirection,
      configured: evaluation.configured,
      isOpen: true,
      isAfterHours: false,
      message: "",
      promptSuffix: "",
      nextOpenLabel: null,
    };
  }

  const message = afterHoursMessage(
    settings.after_hours_message_fr,
    evaluation.nextOpenLabel
  );
  return {
    direction: safeDirection,
    configured: true,
    isOpen: false,
    isAfterHours: true,
    message,
    promptSuffix: afterHoursPrompt(message),
    nextOpenLabel: evaluation.nextOpenLabel,
  };
}
