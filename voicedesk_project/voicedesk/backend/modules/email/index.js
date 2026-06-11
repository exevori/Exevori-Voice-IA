// ============================================================
// VOICEDESK IA — MODULE COURRIELS
// Inspiré de :
//   github.com/kaymen99/langgraph-email-automation
//   github.com/parthshr370/Email-AI-Agent
//   github.com/Radix-Obsidian/CHIEF (workflow human-in-the-loop)
//
// Pipeline VoiceDesk :
//   1. Webhook Gmail Push / Resend reçoit nouveau courriel
//   2. Classification IA → Niveau 1 (accusé) ou Niveau 2 (brouillon)
//   3. Niveau 1 → envoi automatique d'accusé via Resend
//   4. Niveau 2 → génération brouillon + sauvegarde DB pour validation
//   5. Admin valide via UI → envoi par Gmail/Resend
// ============================================================

import express from "express";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import dotenv from "dotenv";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const resend = new Resend(process.env.RESEND_API_KEY);
const AI_GATEWAY_URL = process.env.AI_GATEWAY_URL || "http://localhost:3100";

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// POST /api/v1/emails/incoming
// Webhook appelé par Gmail Push OU Resend quand nouveau courriel
// ─────────────────────────────────────────────────────────────
router.post("/incoming", async (req, res) => {
  const { company_id, from_email, from_name, subject, body, message_id, received_at } = req.body;

  if (!company_id || !from_email || !subject) {
    return res.status(400).json({ error: "champs requis manquants" });
  }

  try {
    // 1. Charger la config entreprise
    const { data: config } = await supabase
      .from("assistant_configs")
      .select("*, companies(*)")
      .eq("company_id", company_id)
      .single();

    if (!config) return res.status(404).json({ error: "company introuvable" });

    // 2. Identifier le contact (CRM lookup)
    const contact = await lookupContactByEmail(company_id, from_email);

    // 3. Sauvegarder le courriel reçu
    const { data: emailRecord } = await supabase
      .from("emails")
      .insert({
        company_id,
        contact_id: contact?.id || null,
        from_email,
        from_name: from_name || extractName(from_email),
        subject,
        body,
        preview: body.substring(0, 200),
        message_id,
        received_at: received_at || new Date(),
        status: "received",
      })
      .select()
      .single();

    // 4. Classifier le courriel via DeepSeek (Niveau 1 ou 2)
    const classification = await callAIGateway({
      task: "classify_email",
      company_id,
      email: { from_email, from_name, subject, body },
      contact,
    });

    const level = classification?.level || 2;
    const intent = classification?.intent || "general";
    const confidence = classification?.confidence || 70;

    await supabase
      .from("emails")
      .update({ level, intent, confidence_score: confidence })
      .eq("id", emailRecord.id);

    // 5. Niveau 1 : accusé de réception automatique
    if (level === 1 && confidence >= (config.email_auto_send_threshold || 85)) {
      const acknowledgment = await generateAcknowledgment(config, contact);
      await sendEmailViaResend({
        from: config.companies?.name + " <" + config.email_from + ">",
        to: from_email,
        subject: "Re: " + subject,
        html: acknowledgment,
        replyTo: config.email_reply_to,
      });

      await supabase
        .from("emails")
        .update({ status: "acknowledged_auto", responded_at: new Date() })
        .eq("id", emailRecord.id);

      console.log(`[EMAIL] Niveau 1 auto-acknowledged: ${emailRecord.id}`);
      return res.json({ success: true, level: 1, action: "auto_acknowledged" });
    }

    // 6. Niveau 2 : générer brouillon intelligent pour validation humaine
    const draft = await callAIGateway({
      task: "generate_email_draft",
      company_id,
      email: { from_email, from_name, subject, body },
      contact,
      knowledge_base: await getKnowledgeBase(company_id),
      assistant_config: config,
    });

    await supabase.from("email_drafts").insert({
      company_id,
      contact_id: contact?.id || null,
      related_email_id: emailRecord.id,
      subject: draft?.subject || "Re: " + subject,
      body: draft?.body || "",
      status: "pending_validation",
      confidence_score: draft?.confidence || confidence,
      notes_for_human: draft?.notes || "",
      created_by: "lea_ai",
    });

    await supabase
      .from("emails")
      .update({ status: "draft_created" })
      .eq("id", emailRecord.id);

    console.log(`[EMAIL] Niveau 2 brouillon créé pour ${emailRecord.id}`);
    return res.json({ success: true, level: 2, action: "draft_created" });

  } catch (err) {
    console.error("[EMAIL] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/emails/drafts
// Liste les brouillons en attente de validation
// ─────────────────────────────────────────────────────────────
router.get("/drafts", async (req, res) => {
  const { company_id, status = "pending_validation" } = req.query;

  const { data, error } = await supabase
    .from("email_drafts")
    .select("*, emails!related_email_id(from_email, from_name, subject, body, received_at), contacts(full_name, company)")
    .eq("company_id", company_id)
    .eq("status", status)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ drafts: data });
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/emails/drafts/:id/approve
// Admin approuve le brouillon → envoi du courriel
// ─────────────────────────────────────────────────────────────
router.post("/drafts/:id/approve", async (req, res) => {
  const { id } = req.params;
  const { edited_body, edited_subject } = req.body;

  try {
    const { data: draft } = await supabase
      .from("email_drafts")
      .select("*, emails!related_email_id(from_email, from_name, subject), companies(*)")
      .eq("id", id)
      .single();

    if (!draft) return res.status(404).json({ error: "brouillon introuvable" });

    const { data: config } = await supabase
      .from("assistant_configs")
      .select("*")
      .eq("company_id", draft.company_id)
      .single();

    const finalSubject = edited_subject || draft.subject;
    const finalBody = edited_body || draft.body;

    // Envoi via Resend
    const result = await sendEmailViaResend({
      from: `${draft.companies?.name} <${config.email_from}>`,
      to: draft.emails.from_email,
      subject: finalSubject,
      html: finalBody.replace(/\n/g, "<br>"),
      replyTo: config.email_reply_to,
    });

    // Mise à jour DB
    await Promise.all([
      supabase
        .from("email_drafts")
        .update({
          status: "sent",
          sent_at: new Date(),
          final_body: finalBody,
          final_subject: finalSubject,
        })
        .eq("id", id),
      supabase
        .from("emails")
        .update({ status: "replied", responded_at: new Date() })
        .eq("id", draft.related_email_id),
    ]);

    return res.json({ success: true, message_id: result.id });
  } catch (err) {
    console.error("[EMAIL] Approve error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/emails/drafts/:id/reject
// Admin refuse le brouillon
// ─────────────────────────────────────────────────────────────
router.post("/drafts/:id/reject", async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  await supabase
    .from("email_drafts")
    .update({
      status: "rejected",
      rejection_reason: reason || "Refusé par l'admin",
      rejected_at: new Date(),
    })
    .eq("id", id);

  return res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/emails/drafts/:id/regenerate
// Régénérer un brouillon avec une nouvelle instruction
// ─────────────────────────────────────────────────────────────
router.post("/drafts/:id/regenerate", async (req, res) => {
  const { id } = req.params;
  const { instruction } = req.body;

  const { data: draft } = await supabase
    .from("email_drafts")
    .select("*, emails!related_email_id(*)")
    .eq("id", id)
    .single();

  const newDraft = await callAIGateway({
    task: "regenerate_email_draft",
    company_id: draft.company_id,
    email: draft.emails,
    previous_draft: draft.body,
    instruction,
  });

  await supabase
    .from("email_drafts")
    .update({
      body: newDraft?.body || draft.body,
      subject: newDraft?.subject || draft.subject,
      regenerated_count: (draft.regenerated_count || 0) + 1,
    })
    .eq("id", id);

  return res.json({ success: true, draft: newDraft });
});

// ─────────────────────────────────────────────────────────────
// FONCTIONS UTILITAIRES
// ─────────────────────────────────────────────────────────────

async function lookupContactByEmail(companyId, email) {
  const { data } = await supabase
    .from("contacts")
    .select("*")
    .eq("company_id", companyId)
    .eq("email", email)
    .single();
  return data;
}

async function getKnowledgeBase(companyId) {
  const { data } = await supabase
    .from("knowledge_base")
    .select("question, answer, category")
    .eq("company_id", companyId)
    .eq("status", "active")
    .limit(30);
  return data || [];
}

function extractName(email) {
  return email.split("@")[0].replace(/[._]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

async function generateAcknowledgment(config, contact) {
  const assistantName = config.assistant_name || "Assistant";
  const companyName = config.companies?.name || "notre équipe";
  const contactName = contact?.full_name || "";

  return `
<p>Bonjour${contactName ? " " + contactName : ""},</p>

<p>Nous avons bien reçu votre message et nous vous remercions de nous avoir contactés.</p>

<p>Un membre de notre équipe vous répondra dans les plus brefs délais — habituellement sous 24 heures ouvrables.</p>

<p>Cordialement,<br>
<strong>${assistantName}</strong><br>
${companyName}</p>

<p style="color:#94A3B8;font-size:12px;margin-top:24px;">
Ce message est un accusé de réception automatique généré par votre assistante IA.
</p>
`;
}

async function sendEmailViaResend({ from, to, subject, html, replyTo }) {
  return await resend.emails.send({
    from,
    to,
    subject,
    html,
    reply_to: replyTo,
  });
}

async function callAIGateway(payload) {
  try {
    const response = await fetch(`${AI_GATEWAY_URL}/api/ai/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`AI Gateway ${response.status}`);
    return await response.json();
  } catch (err) {
    console.error("[AI Gateway] Error:", err);
    return null;
  }
}

export default router;
