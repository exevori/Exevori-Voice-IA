// ============================================================
// EXEVORI VOICE IA — WEBHOOK POST-APPEL ELEVENLABS
//
// Le chemin entrant est volontairement court : authentifier, résoudre le
// tenant, ingérer l'événement dans une transaction idempotente, puis répondre.
// Tous les effets CRM et l'analyse LLM sont repris par le worker durable.
// ============================================================

import crypto from "node:crypto";
import { confirmOnboardingCall } from "../onboarding/callProof.js";

import express from "express";

import {
  extractPostCallTenantHints,
  resolveElevenLabsCompany,
} from "../elevenlabs/tenantResolver.js";
import handleOutboundCallback, {
  OutboundCallbackError,
} from "../outbound/callback.js";
import { supabase } from "../voice/lifecycle.js";
import {
  isPostCallTranscription,
  normalizeConversationId,
  transcriptHasConsentRefusal,
} from "./idempotency.js";
import { shouldAcceptElevenLabsWebhookSignature } from "./signaturePolicy.js";
import {
  detectAppointmentRequest,
  enqueuePostCallEvent,
  PostCallWorkerError,
} from "./worker.js";

const router = express.Router();
const MAX_TRANSCRIPT_CHARS = 200_000;
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const TWILIO_CALL_SID_PATTERN = /^CA[\da-f]{32}$/i;

/**
 * Vérifie le format ElevenLabs `t=<unix>,v0=<hex hmac sha256>` sur le corps
 * brut, avec une fenêtre anti-rejeu de cinq minutes.
 */
export function verifyElevenLabsSignature(rawBody, signatureHeader, secret) {
  if (!secret) return "no_secret";
  if (!signatureHeader) return "missing";

  const parts = String(signatureHeader).split(",").reduce((acc, item) => {
    const separator = item.indexOf("=");
    if (separator <= 0) return acc;
    acc[item.slice(0, separator).trim()] = item.slice(separator + 1).trim();
    return acc;
  }, {});
  const timestamp = parts.t;
  const signature = parts.v0;
  if (
    !/^\d{1,12}$/.test(timestamp || "")
    || !/^[a-f\d]{64}$/i.test(signature || "")
  ) {
    return "invalid_format";
  }

  const timestampNumber = Number(timestamp);
  if (!Number.isInteger(timestampNumber) || timestampNumber <= 0) {
    return "invalid_format";
  }
  const nowSeconds = Math.floor(Date.now() / 1_000);
  if (Math.abs(nowSeconds - timestampNumber) > 300) return "stale";

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest();
  const received = Buffer.from(signature, "hex");
  return received.length === expected.length
    && crypto.timingSafeEqual(expected, received)
    ? "ok"
    : "bad_signature";
}

function getValue(value, path) {
  return path
    .split(".")
    .reduce((current, key) => current == null ? undefined : current[key], value);
}

function boundedText(value, maxLength) {
  return typeof value === "string"
    ? value.replace(/\u0000/g, "").trim().slice(0, maxLength)
    : "";
}

export function normalizeE164Phone(value) {
  if (value === null || value === undefined) return null;
  let normalized = String(value).trim().replace(/[\s()./\-]/g, "");
  if (normalized.startsWith("00")) normalized = `+${normalized.slice(2)}`;
  return E164_PATTERN.test(normalized) ? normalized : null;
}

export function normalizeTwilioCallSid(value) {
  const normalized = boundedText(value, 255);
  return TWILIO_CALL_SID_PATTERN.test(normalized) ? normalized : null;
}

export function reconstructTranscript(transcript) {
  if (!Array.isArray(transcript)) return "";
  return transcript
    .map(turn => {
      if (!turn || typeof turn !== "object") return "";
      const role = String(turn.role || "").toLowerCase();
      const speaker = role === "agent" || role === "assistant"
        ? "Léa"
        : role === "user" || role === "caller"
          ? "Client"
          : null;
      if (!speaker) return "";
      const message = boundedText(
        turn.message ?? turn.content ?? turn.text ?? "",
        20_000
      );
      return message ? `${speaker}: ${message}` : "";
    })
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_TRANSCRIPT_CHARS);
}

export function buildPostCallEvent({
  companyId,
  conversationId,
  twilioCallSid,
  callerNumber,
  durationSeconds,
  transcriptText,
  providerSummary,
  language = "fr-CA",
  appointmentRequested = false,
}) {
  return {
    companyId,
    conversationId,
    twilioCallSid: normalizeTwilioCallSid(twilioCallSid),
    callerPhone: normalizeE164Phone(callerNumber),
    durationSeconds: Math.max(
      0,
      Math.min(86_400, Math.floor(Number(durationSeconds) || 0))
    ),
    transcriptText: boundedText(transcriptText, MAX_TRANSCRIPT_CHARS),
    providerSummary: boundedText(providerSummary, 4_000),
    language: boundedText(language, 16) || "fr-CA",
    appointmentRequested: appointmentRequested === true,
  };
}

router.post("/", async (req, res) => {
  const rawBody = req.body instanceof Buffer
    ? req.body.toString("utf8")
    : typeof req.body === "string"
      ? req.body
      : "";
  const signatureHeader = req.headers["elevenlabs-signature"]
    || req.headers["x-elevenlabs-signature"]
    || "";
  const sigStatus = verifyElevenLabsSignature(
    rawBody,
    signatureHeader,
    process.env.ELEVENLABS_WEBHOOK_SECRET
  );
  if (!shouldAcceptElevenLabsWebhookSignature(sigStatus)) {
    console.warn("[post-call] signature rejected");
    return res.status(401).json({ success: false, error: "invalid signature" });
  }

  let body;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return res.status(400).json({ success: false, error: "invalid JSON" });
  }

  // Les callbacks outbound possèdent déjà leur transaction durable dédiée.
  // Leur corrélation est faite uniquement depuis les identifiants queue/attempt
  // persistés par VoiceDesk, jamais depuis un company_id fourni par le webhook.
  try {
    const outbound = await handleOutboundCallback({ supabase, body, rawBody });
    if (outbound.handled) {
      return res.status(200).json({
        success: true,
        outbound: true,
        duplicate: outbound.duplicate === true,
        result: outbound.result,
      });
    }
  } catch (error) {
    if (error instanceof OutboundCallbackError) {
      console.warn("[post-call] outbound callback rejected", {
        error_code: error.code,
      });
      return res.status(error.status).json({
        success: false,
        error: error.code,
      });
    }
    console.error("[post-call] outbound callback processing failed");
    return res.status(503).json({
      success: false,
      error: "outbound_callback_unavailable",
    });
  }

  if (!isPostCallTranscription(body)) {
    return res.status(200).json({ success: true, ignored: true });
  }

  try {
    const data = body.data || body;
    const {
      agentId,
      calledNumber,
      callerNumber,
      callSid,
    } = extractPostCallTenantHints(body);
    const transcript = data.transcript || body.transcript || [];
    const consentRefused = transcriptHasConsentRefusal(transcript);
    const conversationId = normalizeConversationId(
      data.conversation_id ?? body.conversation_id
    );
    if (!conversationId) {
      return res.status(400).json({
        success: false,
        error: "invalid conversation_id",
      });
    }

    const company = await resolveElevenLabsCompany({
      supabase,
      agentId,
      calledNumber,
    });
    if (!company) {
      console.warn("[post-call] tenant resolution failed");
      return res.status(consentRefused ? 503 : 422).json(
        consentRefused
          ? { success: false, error: "privacy cleanup unavailable" }
          : { success: false, error: "tenant not configured" }
      );
    }
    const companyId = company.company_id;
    const twilioCallSid = normalizeTwilioCallSid(
      callSid
      || getValue(data, "metadata.phone_call.call_sid")
      || getValue(data, "twilio_call_sid")
      || ""
    );

    // Le refus ne traverse jamais la table de jobs contenant des PII. Cette
    // RPC atomique n'enregistre que les identifiants techniques à supprimer.
    if (consentRefused) {
      const { data: cleanup, error: cleanupError } = await supabase.rpc(
        "enqueue_consent_refusal_cleanup",
        {
          p_company_id: companyId,
          p_conversation_id: conversationId,
          p_twilio_call_sid: twilioCallSid || null,
        }
      );
      if (cleanupError) {
        console.error("[post-call] consent-refusal cleanup enqueue failed");
        return res.status(503).json({
          success: false,
          error: "privacy cleanup unavailable",
        });
      }
      return res.status(200).json({
        success: true,
        consent_refused: true,
        external_cleanup: "queued",
        external_deletions_enqueued:
          Number(cleanup?.external_deletions_enqueued) || 0,
      });
    }

    const durationSeconds = Number(
      getValue(data, "metadata.call_duration_secs")
      || getValue(data, "metadata.duration_secs")
      || data.duration
      || 0
    );
    const transcriptText = reconstructTranscript(transcript);
    const providerSummary = boundedText(
      getValue(data, "analysis.transcript_summary")
      || getValue(data, "summary")
      || "",
      4_000
    );

    let ingestion;
    try {
      ingestion = await enqueuePostCallEvent({
        supabase,
        event: buildPostCallEvent({
          companyId,
          conversationId,
          twilioCallSid,
          callerNumber,
          durationSeconds,
          transcriptText,
          providerSummary,
          language: "fr-CA",
          appointmentRequested: detectAppointmentRequest({
            transcriptText,
            analysis: { summary: providerSummary },
          }),
        }),
      });
    } catch (error) {
      if (
        error instanceof PostCallWorkerError
        && ["conversation_conflict", "post_call_conversation_conflict"]
          .includes(error.code)
      ) {
        console.warn("[post-call] conversation identity conflict");
        return res.status(409).json({
          success: false,
          error: "conversation conflict",
        });
      }
      if (
        error instanceof PostCallWorkerError
        && error.code === "privacy_tombstone"
      ) {
        return res.status(200).json({
          success: true,
          ignored: true,
          privacy_tombstone: true,
        });
      }
      console.error("[post-call] durable ingestion failed");
      return res.status(503).json({
        success: false,
        error: "call persistence unavailable",
      });
    }

    // No completion on a browser assertion: the signed provider metadata must
    // match an armed test, its actual start time, tenant and assigned number.
    // A database failure returns 503 so the provider can redeliver idempotently.
    try {
      await confirmOnboardingCall({supabase,signatureStatus:sigStatus,
        companyId,callId:ingestion.callId,data});
    } catch {
      return res.status(503).json({success:false,error:"onboarding_confirmation_unavailable"});
    }
    // Aucun appel réseau fournisseur/LLM ni effet CRM avant cette réponse.
    return res.status(200).json({
      success: true,
      queued: true,
      duplicate: ingestion.duplicate,
      status: ingestion.status,
      call_id: ingestion.callId,
      job_id: ingestion.jobId,
    });
  } catch {
    console.error("[post-call] ingestion failed");
    return res.status(500).json({ success: false, error: "internal error" });
  }
});

export default router;
