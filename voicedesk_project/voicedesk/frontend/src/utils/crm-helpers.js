// ============================================================
// VOICEDESK IA — CRM + OUTBOUND HELPERS v3 FINAL
// ============================================================

// ── CRM LOOKUP ────────────────────────────────────────────────
export function findContact(contacts, { phone, email, name, company } = {}) {
  if (!contacts?.length) return null;
  if (phone) {
    const found = contacts.find(c => normalizePhone(c.phone) === normalizePhone(phone));
    if (found) return { contact: found, match_field: "phone" };
  }
  if (email) {
    const found = contacts.find(c => c.email?.toLowerCase() === email.toLowerCase());
    if (found) return { contact: found, match_field: "email" };
  }
  if (name) {
    const found = contacts.find(c => c.full_name?.toLowerCase().includes(name.toLowerCase()));
    if (found) return { contact: found, match_field: "name" };
  }
  if (company) {
    const found = contacts.find(c => c.company?.toLowerCase().includes(company.toLowerCase()));
    if (found) return { contact: found, match_field: "company" };
  }
  return null;
}

export function normalizePhone(phone) {
  return phone ? phone.replace(/[\s\-\(\)\+\.]/g, "") : "";
}

export function createContact({ first_name = "", last_name = "", company = "", phone = "", email = "", source = "call", status = "new", need = "", urgency = "medium" }) {
  return {
    id: `contact_${Date.now()}`,
    first_name, last_name,
    full_name: `${first_name} ${last_name}`.trim(),
    company, phone, email, address: "",
    type: "prospect", source, status,
    main_need: need, urgency, budget: null,
    last_interaction: new Date().toISOString(),
    next_action: "",
    notes: [],
    history: [{ date: new Date().toISOString().split("T")[0], event: `Contact créé via ${source}` }],
    tags: [],
    created_at: new Date().toISOString(),
  };
}

export function createNote({ channel = "call", direction = "inbound", summary = "", intent = "", urgency = "medium", next_action = "", status_proposed = null }) {
  return {
    id: `note_${Date.now()}`,
    date: new Date().toISOString(),
    channel, direction, summary, intent, urgency, next_action, status_proposed,
  };
}

// ── APPRENTISSAGE — RECHERCHE TEXTE SIMPLE (pas pgvector en V0) ──
/**
 * Cherche les entrées pertinentes dans la base de connaissances
 * via mots-clés SQL simple. pgvector en V1.
 * Supabase query : SELECT * FROM knowledge_base
 *   WHERE keywords && ARRAY[...keywords] OR title ILIKE '%query%'
 *   LIMIT 8
 */
export function buildKnowledgeSearchQuery(userMessage) {
  const stopWords = ["le", "la", "les", "un", "une", "des", "de", "du", "et", "ou", "je", "vous", "nous", "est", "sont", "avec", "pour", "que", "qui"];
  return userMessage
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.includes(w))
    .slice(0, 5);
}

// ── BILINGUISME — DÉTECTION LANGUE ────────────────────────────
/**
 * Détecte si le client parle anglais. Switch unique sur premier échange.
 * V0 : Deepgram détecte → flag language_used sur le call.
 */
export function detectLanguageSwitch(transcript, currentLanguage, threshold = 2) {
  if (currentLanguage === "en-CA") return "en-CA";
  const englishIndicators = [
    "hello", "hi", "good morning", "good afternoon", "good evening",
    "i would", "i want", "i need", "can you", "do you", "i am", "my name",
    "please", "thank you", "yes", "no", "okay", "sure"
  ];
  const words = transcript.toLowerCase().split(/\s+/);
  const englishCount = words.filter(w => englishIndicators.some(e => w.includes(e))).length;
  return englishCount >= threshold ? "en-CA" : "fr-CA";
}

// ── MISSIONS ──────────────────────────────────────────────────
export function calculateMissionStats(outboundCalls) {
  const total = outboundCalls.length;
  if (!total) return { total: 0, completion_rate: 0 };
  const counts = {
    called:             outboundCalls.filter(c => c.status !== "to_call").length,
    answered:           outboundCalls.filter(c => !["to_call","no_answer","voicemail"].includes(c.status)).length,
    no_answer:          outboundCalls.filter(c => c.status === "no_answer").length,
    voicemail:          outboundCalls.filter(c => c.status === "voicemail").length,
    interested:         outboundCalls.filter(c => ["interested","appointment_booked","confirmed"].includes(c.status)).length,
    not_interested:     outboundCalls.filter(c => c.status === "not_interested").length,
    appointment_booked: outboundCalls.filter(c => c.status === "appointment_booked").length,
    remaining:          outboundCalls.filter(c => ["to_call","no_answer"].includes(c.status)).length,
  };
  return {
    total, ...counts,
    completion_rate: Math.round((counts.called / total) * 100),
    success_rate: Math.round((counts.interested / total) * 100),
  };
}

/**
 * V0 — Manuel : trouve le prochain contact à appeler dans une mission.
 * L'utilisateur clique "Appeler" pour déclencher l'appel Twilio.
 */
export function getNextCallToMake(outboundCalls) {
  return outboundCalls.find(c => c.status === "to_call") ||
         outboundCalls.find(c => c.status === "no_answer" && (c.attempt_number || 1) < 2) ||
         null;
}

export function personalizeScript(template, contact, missionData = {}) {
  return template
    .replace("{first_name}",       contact.first_name || contact.full_name || "")
    .replace("{company}",          contact.company || "votre entreprise")
    .replace("{service}",          missionData.service || "nos services")
    .replace("{mission_subject}",  missionData.subject || "un sujet important")
    .replace("{appointment_date}", missionData.appointment_date || "votre rendez-vous")
    .replace("{appointment_time}", missionData.appointment_time || "")
    .replace("{appointment_type}", missionData.appointment_type || "rendez-vous");
}

export function isOutboundCallAllowed(outboundHours) {
  const now      = new Date();
  const dayNames = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  const day      = outboundHours?.[dayNames[now.getDay()]];
  if (!day) return false;
  const cur   = now.getHours() * 60 + now.getMinutes();
  const [oh, om] = day.start.split(":").map(Number);
  const [ch, cm] = day.end.split(":").map(Number);
  return cur >= oh * 60 + om && cur < ch * 60 + cm;
}

// ── IMPORT DOUBLONS ───────────────────────────────────────────
export function detectDuplicates(existingContacts, importList) {
  return importList.map(imported => {
    const match = findContact(existingContacts, {
      phone: imported.phone, email: imported.email,
      name: `${imported.first_name || ""} ${imported.last_name || ""}`.trim(),
    });
    return { ...imported, is_duplicate: !!match, duplicate_match: match ? { id: match.contact.id, name: match.contact.full_name, field: match.match_field } : null };
  });
}

// ── UTILITAIRES ───────────────────────────────────────────────
export function getConfidenceColor(score) {
  if (score >= 90) return "#10B981";
  if (score >= 70) return "#F59E0B";
  if (score >= 50) return "#F97316";
  return "#EF4444";
}

export function getConfidenceLabel(score) {
  if (score >= 90) return "Très haute";
  if (score >= 70) return "Bonne";
  if (score >= 50) return "Moyenne";
  return "Faible — transfert recommandé";
}

export function formatDuration(seconds) {
  if (!seconds) return "00:00";
  return `${String(Math.floor(seconds / 60)).padStart(2,"0")}:${String(seconds % 60).padStart(2,"0")}`;
}

export function formatDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("fr-CA", { day: "numeric", month: "long", year: "numeric" });
}

export function formatTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("fr-CA", { hour: "2-digit", minute: "2-digit" });
}

export function getUrgencyConfig(urgency) {
  return { high: { label: "Urgence haute", bg: "rgba(239,68,68,0.15)", color: "#EF4444" }, medium: { label: "Urgence moyenne", bg: "rgba(245,158,11,0.15)", color: "#F59E0B" }, low: { label: "Urgence basse", bg: "rgba(16,185,129,0.15)", color: "#10B981" } }[urgency] || { label: urgency, bg: "rgba(100,116,139,0.15)", color: "#94A3B8" };
}

export default { findContact, normalizePhone, createContact, createNote, buildKnowledgeSearchQuery, detectLanguageSwitch, calculateMissionStats, getNextCallToMake, personalizeScript, isOutboundCallAllowed, detectDuplicates, getConfidenceColor, getConfidenceLabel, formatDuration, formatDate, formatTime, getUrgencyConfig };

// ── SOURCES DE CONTACTS POUR MISSIONS ────────────────────────

/**
 * SOURCE 1 — CALENDRIER
 * Pour missions "Confirmation de RDV"
 * GET /api/v1/calendar/appointments?date={date}
 */
export function buildCalendarMissionContacts(appointments) {
  return appointments
    .filter(a => ["confirmed", "pending"].includes(a.status))
    .map(a => ({
      contact_id:      a.contact_id,
      contact_name:    a.contact_name,
      contact_phone:   a.contact_phone,
      contact_company: a.contact_company || "",
      status:          "to_call",
      context: {
        appointment_type: a.type,
        appointment_date: a.date,
        appointment_time: a.time,
        meet_link:        a.meet_link || null,
      },
    }));
}

/**
 * SOURCE 2 — CRM AVEC FILTRES
 * Pour Relance soumission, Suivi, Rappel, Facture
 */
export function filterCRMContacts(contacts, filters = {}) {
  const { status, last_interaction_before_days, last_interaction_after,
          last_interaction_before, source, tags_include, urgency } = filters;
  return contacts.filter(c => {
    if (status?.length && !status.includes(c.status)) return false;
    if (source?.length && !source.includes(c.source)) return false;
    if (urgency && c.urgency !== urgency) return false;
    if (tags_include?.length && !tags_include.some(t => c.tags?.includes(t))) return false;
    if (last_interaction_before_days) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - last_interaction_before_days);
      const last = c.last_interaction_at ? new Date(c.last_interaction_at) : null;
      if (last && last > cutoff) return false;
    }
    if (last_interaction_after) {
      const after = new Date(last_interaction_after);
      const last = c.last_interaction_at ? new Date(c.last_interaction_at) : null;
      if (!last || last < after) return false;
    }
    return true;
  }).map(c => ({
    contact_id: c.id, contact_name: c.full_name,
    contact_phone: c.phone, contact_company: c.company || "",
    status: "to_call",
    context: { crm_status: c.status, main_need: c.main_need, last_action: c.next_action },
  }));
}

/**
 * SOURCE 3 — FICHIER CSV / EXCEL
 * Pour Prospection et listes externes
 */
export function buildCSVMissionContacts(importedRows) {
  return importedRows
    .filter(r => !r.is_duplicate || r.duplicate_override)
    .map(r => ({
      contact_id:      r.existing_contact_id || null,
      contact_name:    r.full_name || `${r.first_name || ""} ${r.last_name || ""}`.trim(),
      contact_phone:   r.phone || "",
      contact_company: r.company || "",
      status:          "to_call",
      is_new_contact:  !r.existing_contact_id,
      context: { source: "csv_import", notes: r.notes || "" },
    }))
    .filter(c => c.contact_phone);
}

/**
 * SOURCE 4 — SAISIE MANUELLE
 * Pour 1 à 5 contacts ponctuels
 */
export function buildManualMissionContact({ name, phone, company = "", notes = "", contact_id = null }) {
  return {
    contact_id, contact_name: name, contact_phone: phone,
    contact_company: company, status: "to_call",
    is_new_contact: !contact_id,
    context: { source: "manual", notes },
  };
}

export function getMissionSourceConfig(sourceType) {
  return {
    calendar:   { label: "Calendrier",    icon: "Calendar", color: "#3B82F6", description: "RDV Calendly automatiques" },
    crm_filter: { label: "CRM — Filtre",  icon: "Users",    color: "#8B5CF6", description: "Contacts filtrés du CRM" },
    csv_import: { label: "Fichier CSV",   icon: "Upload",   color: "#06B6D4", description: "Contacts depuis fichier" },
    manual:     { label: "Manuel",        icon: "PenLine",  color: "#F59E0B", description: "Saisie manuelle" },
  }[sourceType] || { label: sourceType, icon: "Users", color: "#94A3B8" };
}
