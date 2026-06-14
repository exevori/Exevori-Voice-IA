// ============================================================
// EXEVORI VOICE IA — Voice call lifecycle helpers (Phase 8A)
//
// Création/mise à jour de la ligne `calls` + logging des events
// dans `call_events`. Centralise tous les inserts liés aux appels.
// ============================================================

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Retrouve la company_id correspondant au numéro Twilio appelé (champ "to").
 * - V1: 1 numéro Twilio par PME via twilio_configs.phone_number.
 */
export async function findCompanyByTwilioNumber(to) {
  const { data } = await supabase
    .from("twilio_configs")
    .select("company_id, phone_number, forwarding_number")
    .eq("phone_number", to)
    .maybeSingle();
  return data || null;
}

/**
 * Crée (ou récupère si déjà existe) la ligne `calls` pour ce Twilio CallSid.
 * Retourne le call (id, company_id, ...).
 */
export async function getOrCreateCall({ twilio_call_sid, company_id, from, to, direction = "inbound" }) {
  const { data: existing } = await supabase
    .from("calls")
    .select("id, company_id, twilio_call_sid, live_status")
    .eq("twilio_call_sid", twilio_call_sid)
    .maybeSingle();
  if (existing) return existing;

  const row = {
    company_id,
    twilio_call_sid,
    direction,
    caller_number: from,
    callee_number: to,
    status: "in_progress",
    live_status: "connecting",
    started_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from("calls")
    .insert(row)
    .select("id, company_id, twilio_call_sid, live_status")
    .single();
  if (error) throw error;
  return data;
}

/**
 * Met à jour le live_status de l'appel.
 */
export async function setLiveStatus(call_id, live_status, extra = {}) {
  await supabase.from("calls").update({ live_status, ...extra }).eq("id", call_id);
}

/**
 * Marque l'appel comme terminé.
 */
export async function endCall(call_id, { status = "completed", duration_seconds = null } = {}) {
  const update = {
    live_status: "ended",
    status,
    ended_at: new Date().toISOString(),
  };
  if (duration_seconds != null) update.duration_seconds = duration_seconds;
  await supabase.from("calls").update(update).eq("id", call_id);
}

/**
 * Log un event dans call_events (best-effort, jamais throw).
 */
export async function logEvent({ company_id, call_id, event_type, payload = {}, ts_ms = null }) {
  try {
    await supabase.from("call_events").insert({
      company_id, call_id, event_type, payload, ts_ms,
    });
  } catch (err) {
    // best-effort
    console.error("[voice/lifecycle] logEvent failed:", err.message, event_type);
  }
}
