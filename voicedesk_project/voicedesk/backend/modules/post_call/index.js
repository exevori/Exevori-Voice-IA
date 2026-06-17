// ============================================================
// EXEVORI VOICE IA — POST-CALL WEBHOOK ELEVENLABS
//
// Endpoint public (sans JWT — appelé par ElevenLabs après chaque appel) :
//   POST /api/voice/call-complete
//
// Payload ElevenLabs (post_call_transcription) — chemins typiques :
//   data.metadata.phone_call.external_number   → numéro appelant
//   data.metadata.call_duration_secs           → durée
//   data.transcript[]                          → tableau {role, message}
//   data.analysis.transcript_summary           → résumé IA
//   data.metadata.phone_call.call_sid          → twilio_call_sid
//   data.conversation_id                       → external_id
//
// Pipeline :
//   1. Forensic log du body complet (1 fois)
//   2. Extraire caller_number, duration, transcript, summary, twilio_sid
//   3. Trouver/créer contact (par phone + company_id)
//   4. INSERT calls (table existante — pas call_logs)
//   5. Si transcript contient "rendez-vous" ou "appointment" → INSERT appointments status=pending
//   6. Retour { success: true }
// ============================================================

import express from "express";
import crypto from "crypto";
import { supabase } from "../voice/lifecycle.js";

const router = express.Router();

let forensicDone = false;

/**
 * Vérifie la signature HMAC-SHA256 envoyée par ElevenLabs.
 * Header attendu : ElevenLabs-Signature: t=<unix_secs>,v0=<hex_sha256>
 * Payload signé  : <timestamp>.<raw_body>
 * Tolérance     : ±5 min entre timestamp et heure serveur (anti-replay)
 *
 * @returns "ok" | "missing" | "invalid_format" | "stale" | "bad_signature" | "no_secret"
 */
function verifyElevenLabsSignature(rawBody, signatureHeader, secret) {
  if (!secret) return "no_secret";
  if (!signatureHeader) return "missing";

  const parts = String(signatureHeader).split(",").reduce((acc, kv) => {
    const [k, v] = kv.split("=");
    if (k && v) acc[k.trim()] = v.trim();
    return acc;
  }, {});
  const ts = parts.t;
  const sig = parts.v0;
  if (!ts || !sig) return "invalid_format";

  // Anti-replay : tolérance 5 min
  const tsNum = Number(ts);
  const nowSec = Math.floor(Date.now() / 1000);
  if (Number.isFinite(tsNum) && Math.abs(nowSec - tsNum) > 300) return "stale";

  const payload = `${ts}.${rawBody}`;
  const computed = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  // timingSafeEqual exige des Buffers de même longueur
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(sig, "hex");
  if (a.length !== b.length) return "bad_signature";
  return crypto.timingSafeEqual(a, b) ? "ok" : "bad_signature";
}

function getValue(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function reconstructTranscript(transcriptArr) {
  if (!Array.isArray(transcriptArr)) return "";
  return transcriptArr
    .map(t => {
      const who = (t.role === "agent" || t.role === "assistant") ? "Léa" : "Client";
      const msg = t.message || t.content || t.text || "";
      return `${who}: ${msg}`;
    })
    .filter(l => l.trim().length > 5)
    .join("\n");
}

function detectAppointment(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return /(rendez[- ]?vous|appointment|réserver|booking|prendre rdv|fixer un rdv)/i.test(lower);
}

router.post("/", async (req, res) => {
  const rawBody = req.body instanceof Buffer ? req.body.toString("utf8") : (typeof req.body === "string" ? req.body : "");
  const sigHeader = req.headers["elevenlabs-signature"] || req.headers["x-elevenlabs-signature"] || "";

  // 1. Vérification signature ElevenLabs (HMAC-SHA256)
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  const sigStatus = verifyElevenLabsSignature(rawBody, sigHeader, secret);

  if (sigStatus === "bad_signature" || sigStatus === "stale" || sigStatus === "invalid_format") {
    // Debug temporaire pour comprendre les rejections (à retirer plus tard)
    const parts = String(sigHeader).split(",").reduce((acc, kv) => {
      const [k, v] = kv.split("="); if (k && v) acc[k.trim()] = v.trim(); return acc;
    }, {});
    if (parts.t && parts.v0) {
      const payload = `${parts.t}.${rawBody}`;
      const computed = crypto.createHmac("sha256", secret).update(payload).digest("hex");
      console.warn(`[post-call] SIG_DEBUG status=${sigStatus} ts=${parts.t} got=${parts.v0.slice(0,16)}... computed=${computed.slice(0,16)}... bodyLen=${rawBody.length} bodyHead=${rawBody.slice(0,80).replace(/\s+/g," ")}`);
    }
    console.warn(`[post-call] signature REJECTED: ${sigStatus}`);
    return res.status(401).json({ success: false, error: `signature ${sigStatus}` });
  }
  // Cas tolérés (en dev/test local sans header) : "missing" et "no_secret" — on log, on accepte.
  if (sigStatus !== "ok") {
    console.warn(`[post-call] signature ${sigStatus} — accepted (dev/test mode)`);
  }

  // Parse JSON manuellement (on a utilisé express.raw pour préserver le body pour HMAC)
  let body = {};
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch (e) {
    return res.status(400).json({ success: false, error: "invalid JSON" });
  }

  // 1. Forensic log (1 fois pour comprendre la structure réelle)
  if (!forensicDone) {
    try {
      const dump = JSON.stringify(body).slice(0, 4000);
      console.log("[post-call] FORENSIC body (first 4KB):", dump);
      forensicDone = true;
    } catch (_) {}
  }

  try {
    // 2. Extraction des champs (multi-chemins pour robustesse)
    const data = body.data || body;
    const callerNumber = String(
      getValue(data, "metadata.phone_call.external_number")
      || getValue(data, "metadata.phone_call.caller_number")
      || getValue(data, "metadata.caller_number")
      || body.caller_number
      || ""
    ).trim();
    const calledNumber = String(
      getValue(data, "metadata.phone_call.agent_number")
      || getValue(data, "metadata.phone_call.called_number")
      || ""
    ).trim();
    const durationSecs = Number(
      getValue(data, "metadata.call_duration_secs")
      || getValue(data, "metadata.duration_secs")
      || data.duration
      || 0
    );
    const transcriptArr = data.transcript || body.transcript || [];
    const transcriptText = reconstructTranscript(transcriptArr);
    const summary = String(
      getValue(data, "analysis.transcript_summary")
      || getValue(data, "summary")
      || ""
    ).trim();
    const twilioCallSid = String(
      getValue(data, "metadata.phone_call.call_sid")
      || getValue(data, "twilio_call_sid")
      || ""
    ).trim();
    const conversationId = String(
      data.conversation_id || body.conversation_id || ""
    ).trim();

    const companyId = process.env.ELEVENLABS_DEFAULT_COMPANY_ID;
    if (!companyId) {
      console.warn("[post-call] ELEVENLABS_DEFAULT_COMPANY_ID manquant — abandon");
      return res.status(500).json({ success: false, error: "default company not configured" });
    }

    // 3. Trouver / créer le contact par téléphone
    let contactId = null;
    if (callerNumber) {
      const { data: existing } = await supabase
        .from("contacts")
        .select("id")
        .eq("company_id", companyId)
        .eq("phone", callerNumber)
        .limit(1)
        .maybeSingle();

      if (existing) {
        contactId = existing.id;
        // Met à jour last_interaction_at
        await supabase.from("contacts")
          .update({ last_interaction_at: new Date().toISOString() })
          .eq("id", contactId);
      } else {
        const { data: created, error: insErr } = await supabase
          .from("contacts")
          .insert({
            company_id: companyId,
            full_name: `Appelant ${callerNumber}`,
            phone: callerNumber,
            status: "new",
            source: "inbound_call",
            last_interaction_at: new Date().toISOString(),
          })
          .select("id")
          .single();
        if (insErr) {
          console.error("[post-call] insert contact error:", insErr.message);
        } else {
          contactId = created.id;
        }
      }
    }

    // 4. INSERT calls (table existante)
    const callRow = {
      company_id: companyId,
      contact_id: contactId,
      twilio_call_sid: twilioCallSid || conversationId || null,
      caller_phone: callerNumber || null,
      duration_seconds: Math.max(0, Math.floor(durationSecs)),
      status: "completed",
      language_used: "fr-CA",
      ai_summary: summary || null,
      ai_transcript: transcriptText || null,
      ended_at: new Date().toISOString(),
    };
    const { data: callInserted, error: callErr } = await supabase
      .from("calls")
      .insert(callRow)
      .select("id")
      .single();
    if (callErr) {
      console.error("[post-call] insert calls error:", callErr.message);
    }
    const callId = callInserted?.id || null;

    // 5. Détection rendez-vous → INSERT appointments status=pending
    let appointmentCreated = null;
    const haystack = `${transcriptText}\n${summary}`;
    if (detectAppointment(haystack)) {
      const { data: appt, error: apptErr } = await supabase
        .from("appointments")
        .insert({
          company_id: companyId,
          contact_id: contactId,
          source: "post_call_webhook",
          date: new Date().toISOString().slice(0, 10), // date d'aujourd'hui par défaut, à raffiner via LLM extraction
          type: "phone_request",
          status: "pending",
          channel: "phone",
          notes: summary ? `Détecté via post-call webhook. ${summary}` : "Demande de rendez-vous détectée lors de l'appel.",
        })
        .select("id")
        .single();
      if (apptErr) {
        console.error("[post-call] insert appointments error:", apptErr.message);
      } else {
        appointmentCreated = appt?.id || null;
      }
    }

    console.log(
      `[post-call] company=${companyId} caller=${callerNumber} duration=${durationSecs}s `
      + `contact_id=${contactId} call_id=${callId} appointment_id=${appointmentCreated || "—"} `
      + `transcript_len=${transcriptText.length} summary_len=${summary.length}`
    );

    return res.json({
      success: true,
      contact_id: contactId,
      call_id: callId,
      appointment_id: appointmentCreated,
    });
  } catch (err) {
    console.error("[post-call] error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
