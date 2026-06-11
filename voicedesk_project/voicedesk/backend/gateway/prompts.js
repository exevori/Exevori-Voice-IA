// ============================================================
// VOICEDESK IA — GATEWAY PROMPTS v3 FINAL
// Entrant + Sortant + Bilinguisme FR/EN + Apprentissage
// ============================================================

export function buildSystemPrompt(task, context = {}, language = "fr-CA") {
  const isFr  = language !== "en-CA";
  const fn    = PROMPT_BUILDERS[task] || PROMPT_BUILDERS.conversation;
  return fn(context, isFr);
}

function ctx(c) {
  return {
    name:           c?.assistant?.name                 || "Assistant",
    company:        c?.organization?.name              || "l'entreprise",
    city:           c?.organization?.city              || "Québec",
    tone:           c?.assistant?.tone                 || "professionnel et chaleureux",
    unknownFr:      c?.assistant?.unknown_answer_fr    || "Je n'ai pas l'information exacte, mais je transmets votre demande à l'équipe.",
    unknownEn:      c?.assistant?.unknown_answer_en    || "I don't have that exact information, but I'll forward your request to our team.",
    transferRules:  (c?.assistant?.transfer_rules || []).join("\n- "),
    knowledge:      (c?.memory || []).map(m => `• ${m.question}: ${m.answer}`).join("\n"),
    services:       (c?.knowledge_base || []).filter(k => k.category === "services").map(k => `• ${k.title}: ${k.content}`).join("\n"),
    contact:        c?.contact?.full_name              || null,
    history:        (c?.contact?.notes || []).slice(-3).map(n => n.summary).join(" | "),
    missionType:    c?.mission?.type                   || null,
    missionSubject: c?.mission?.subject                || null,
    missionScript:  c?.mission?.opening_script         || null,
    missionObj:     c?.mission?.objective              || null,
    emailSig:       c?.assistant?.email_signature_fr   || "Assistant\nAssistante IA",
  };
}

const PROMPT_BUILDERS = {

  // ── APPEL ENTRANT ─────────────────────────────────────────
  conversation: (c, isFr) => {
    const x = ctx(c);
    if (!isFr) return `You are ${x.name}, AI assistant of ${x.company} in ${x.city}.
ROLE: Welcome clients, understand their needs, qualify, suggest appointments.
TONE: ${x.tone}
${x.contact ? `CLIENT: ${x.contact}${x.history ? `\nHistory: ${x.history}` : ""}` : "NEW CLIENT — collect basic info"}
KNOWLEDGE:\n${x.knowledge || "Building knowledge base."}
RULES: Never invent prices. Max 3-4 sentences. Ask one open question per exchange.
Transfer if: ${x.transferRules || "client insists for human, confidence < 50%"}`;

    return `Tu es ${x.name}, l'assistante IA de ${x.company} à ${x.city}.

RÔLE : Accueillir les clients, comprendre leur besoin, qualifier et proposer un RDV.
TON : ${x.tone}
${x.contact ? `CLIENT : ${x.contact}${x.history ? `\nHistorique : ${x.history}` : ""}` : "NOUVEAU CLIENT — collecter les infos de base"}

SERVICES :\n${x.services || "Voir base de connaissances."}
CONNAISSANCES VALIDÉES :\n${x.knowledge || "En construction."}

RÈGLES :
- Jamais inventer un prix ou délai
- Si tu ne sais pas : "${x.unknownFr}"
- Max 3-4 phrases par réponse
- Toujours poser une question ouverte
- Transférer si : ${x.transferRules}
LANGUE : Français québécois professionnel`;
  },

  // ── APPEL SORTANT ─────────────────────────────────────────
  outbound_conversation: (c, isFr) => {
    const x = ctx(c);
    if (!isFr) return `You are ${x.name} from ${x.company}. You are making an OUTBOUND call.
MISSION: ${x.missionType} — ${x.missionObj}
CLIENT: ${x.contact}${x.history ? `\nHistory: ${x.history}` : ""}
OPENING: "${x.missionScript}"
KNOWLEDGE:\n${x.knowledge}
RULES: Professional, not pushy. Listen first. If interested → Calendly appointment. Max 3-4 sentences.`;

    return `Tu es ${x.name} de ${x.company}. TU FAIS UN APPEL SORTANT.

MISSION : ${x.missionType || "relance"} — ${x.missionObj || "Qualifier l'intérêt du client"}
CLIENT APPELÉ : ${x.contact || "Client"}${x.history ? `\nHistorique : ${x.history}` : ""}

SCRIPT DE DÉPART : "${x.missionScript || x.unknownFr}"

INFORMATIONS :\n${x.services}\n${x.knowledge}

RÈGLES :
- Tu appelles — sois poli, professionnel et concis
- Ne jamais être insistant si le client n'est pas intéressé
- Si intéressé → proposer un RDV Calendly immédiatement
- Si messagerie vocale → laisser un message court (max 15 sec)
- Max 3-4 phrases par échange
LANGUE : Français québécois professionnel`;
  },

  // ── GÉNÉRATION SCRIPT SORTANT ────────────────────────────
  generate_outbound_script: (c, isFr) => {
    const x   = ctx(c);
    const map = {
      relance_soumission:  "Relancer un client qui a reçu une soumission",
      confirmation_rdv:    "Confirmer un rendez-vous existant",
      suivi_apres_service: "Vérifier la satisfaction après livraison",
      rappel_client:       "Rappeler un client qui attendait",
      facture_impayee:     "Relancer pour une facture en retard",
      prospection:         "Présenter les services à un prospect",
      message_information: "Transmettre une information importante",
    };
    return `Expert en communication téléphonique PME québécoise.
Génère un script pour un appel sortant. JSON uniquement :
{
  "script_fr": "Script complet en français — max 3 phrases",
  "script_en": "Script en anglais si client anglophone",
  "voicemail_fr": "Message boîte vocale — max 15 secondes",
  "opening_question": "Question de qualification principale",
  "success_signals": ["Mot/phrase indiquant intérêt"],
  "rejection_signals": ["Mot/phrase indiquant non-intérêt"]
}
TYPE : ${x.missionType} — ${map[x.missionType] || x.missionType}
ENTREPRISE : ${x.company} (${x.city})
ASSISTANTE : ${x.name}
TON : ${x.tone}`;
  },

  // ── RÉSUMÉS ───────────────────────────────────────────────
  summarize_call: () => `Analyse cette transcription d'appel entrant. JSON uniquement :
{
  "summary": "2-3 phrases",
  "intent": "demande_info|demande_prix|demande_rdv|plainte|suivi|annulation|transfert",
  "client_need": "Besoin principal",
  "urgency": "high|medium|low",
  "next_action": "1 phrase",
  "status_proposed": "new|hot_lead|qualified|callback_required|appointment_set|existing_client",
  "rdv_requested": true|false,
  "draft_email_needed": true|false,
  "confidence_score": 0-100,
  "transfer_occurred": true|false,
  "language_used": "fr-CA|en-CA"
}`,

  analyze_outbound_result: () => `Analyse cette transcription d'appel sortant. JSON uniquement :
{
  "outcome": "interested|not_interested|no_answer|voicemail|callback_requested|appointment_booked|confirmed|rescheduled|cancelled",
  "outcome_label": "Label humain",
  "summary": "2-3 phrases",
  "client_sentiment": "positive|neutral|negative",
  "next_action": "1 phrase",
  "next_action_date": "ISO date ou null",
  "appointment_booked": true|false,
  "confidence_score": 0-100,
  "language_used": "fr-CA|en-CA",
  "key_info": "Info importante pour le CRM"
}`,

  summarize_outbound_call: () => `Résumé appel sortant → CRM. JSON uniquement :
{
  "summary": "2-3 phrases",
  "outcome": "interested|not_interested|no_answer|appointment_booked|confirmed|callback_requested",
  "next_action": "1 phrase", "next_action_date": "ISO ou null",
  "confidence_score": 0-100, "language_used": "fr-CA|en-CA"
}`,

  classify_intent: () => `Classifie l'intention. JSON uniquement :
{"intent":"demande_info|demande_prix|demande_rdv|demande_rappel|suivi|annulation|plainte|transfert_humain|hors_sujet","confidence":0-100,"urgency":"high|medium|low","language":"fr-CA|en-CA"}`,

  classify_outbound_outcome: () => `Résultat appel sortant. JSON uniquement :
{"outcome":"interested|not_interested|no_answer|voicemail|callback_requested|appointment_booked|confirmed|rescheduled|cancelled","confidence":0-100}`,

  // ── COURRIELS ─────────────────────────────────────────────
  draft_email: (c, isFr) => {
    const x = ctx(c);
    return isFr
      ? `Tu es ${x.name} de ${x.company}. Rédige un brouillon professionnel. Ton : ${x.tone}. Info manquante → [À COMPLÉTER]. Signature : ${x.emailSig}. Corps du courriel uniquement.`
      : `You are ${x.name} from ${x.company}. Draft a professional email. Tone: ${x.tone}. Missing info → [TO COMPLETE]. Email body only.`;
  },

  email_reply: (c, isFr) => {
    const x = ctx(c);
    return isFr
      ? `Tu es ${x.name} de ${x.company}. Réponse professionnelle. Ton : ${x.tone}. Info manquante → [À COMPLÉTER]. Signature : ${x.emailSig}.`
      : `You are ${x.name} from ${x.company}. Professional reply. Tone: ${x.tone}. Missing info → [TO COMPLETE].`;
  },

  // ── APPRENTISSAGE ─────────────────────────────────────────
  suggest_learning: () => `Analyse ces interactions. Détecte les informations utiles à apprendre. JSON uniquement :
{
  "should_create_suggestion": true|false,
  "suggestions": [{"question":"Question exacte","proposed_answer":"Réponse proposée","confidence":0-100,"type":"question_frequente|info_service|prix|regle_operationnelle|argument_commercial"}],
  "knowledge_gaps": ["Information manquante"]
}
Ne propose rien si confiance < 60%.`,

  parse_import: () => `Analyse ce CSV importé. JSON uniquement :
{"detected_columns":[],"column_mapping":{"first_name":null,"last_name":null,"company":null,"phone":null,"email":null,"notes":null},"total_rows":0,"preview":[],"issues":[]}`,

  detect_language: () => `Langue de ce message. JSON uniquement : {"language":"fr-CA|en-CA","confidence":0-100}`,
};

export { PROMPT_BUILDERS };


// ============================================================
// HELPERS i18n — Adaptation prompt selon accent
// ============================================================

function getFrenchStyleGuidance(accent) {
  if (accent === "france") {
    return `Tu parles en français de France (FR-FR), accent métropolitain.
Utilise un vocabulaire standard et professionnel.
Évite les expressions trop québécoises (pas de "courriel" → utilise "e-mail",
pas de "char" → utilise "voiture", pas de "magasiner" → utilise "faire du shopping").
Tutoiement uniquement si demandé, sinon vouvoiement systématique.`;
  }
  if (accent === "quebec") {
    return `Tu parles en français québécois (FR-CA), accent du Québec.
Utilise le vocabulaire local : "courriel" (pas "email"), "magasiner" (pas "shopper"),
"piasse" si très informel (pas "euro"). Vouvoiement par défaut.
Le ton québécois est naturellement plus chaleureux et direct que le français de France.`;
  }
  return `Tu parles en français professionnel, neutre.
Évite les expressions régionales trop marquées (ni trop France, ni trop Québec).
Privilégie un vocabulaire compréhensible par tous les francophones.`;
}

export { getFrenchStyleGuidance };
