// ============================================================
// EXEVORI VOICE IA — Voice call lifecycle helpers (Phase 8A)
//
// Schéma `calls` réel:
//   id, company_id, contact_id, twilio_call_sid, caller_phone,
//   caller_name, duration_seconds, status, intent, outcome,
//   language_used, ai_summary, ai_transcript, confidence_score,
//   cost_usd, ended_at, created_at, live_status, cost_cents,
//   recording_id
//
// Pas de "direction", pas de "callee_number" en V1 (un numéro Twilio
// par PME → callee implicite via twilio_configs.phone_number).
// ============================================================

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Retrouve la company_id correspondant au numéro Twilio appelé (champ "to").
 * V1: 1 numéro Twilio par PME via twilio_configs.phone_number (UNIQUE).
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
 * Retourne le call (id, company_id, ...) ou throw si insert échoue.
 */
export async function getOrCreateCall({ twilio_call_sid, company_id, from }) {
  const { data: existing } = await supabase
    .from("calls")
    .select("id, company_id, twilio_call_sid, live_status, status")
    .eq("twilio_call_sid", twilio_call_sid)
    .maybeSingle();
  if (existing) return existing;

  const row = {
    company_id,
    twilio_call_sid,
    caller_phone: from,
    status: "in_progress",
    live_status: "connecting",
    language_used: "fr-CA",
  };
  const { data, error } = await supabase
    .from("calls")
    .insert(row)
    .select("id, company_id, twilio_call_sid, live_status, status")
    .single();
  if (error) throw new Error(`calls.insert failed: ${error.message}`);
  return data;
}

/**
 * Met à jour le live_status de l'appel (no-op si call_id falsy).
 */
export async function setLiveStatus(call_id, live_status, extra = {}) {
  if (!call_id) return;
  await supabase.from("calls").update({ live_status, ...extra }).eq("id", call_id);
}

/**
 * Marque l'appel comme terminé.
 */
export async function endCall(call_id, { status = "completed", duration_seconds = null } = {}) {
  if (!call_id) return;
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
 * Skip si call_id falsy pour éviter FK violation.
 */
export async function logEvent({ company_id, call_id, event_type, payload = {}, ts_ms = null }) {
  if (!call_id || !company_id) return;
  try {
    await supabase.from("call_events").insert({
      company_id, call_id, event_type, payload, ts_ms,
    });
  } catch (err) {
    console.error("[voice/lifecycle] logEvent failed:", err.message, event_type);
  }
}
