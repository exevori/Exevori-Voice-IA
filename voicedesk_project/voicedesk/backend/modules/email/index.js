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
// GET /api/v1/emails
// Liste boîte de réception (avec filtres status, classification, search)
// ─────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  const {
    company_id,
    status,
    classification,
    search,
    sort = "received_at",
    order = "desc",
    limit = 50,
    offset = 0,
  } = req.query;

  if (!company_id) return res.status(400).json({ error: "company_id requis" });

  try {
    let query = supabase
      .from("emails")
      .select("*", { count: "exact" })
      .eq("company_id", company_id);

    if (status) query = query.eq("status", status);
    if (classification) query = query.eq("classification", classification);
    if (search) {
      query = query.or(
        `subject.ilike.%${search}%,from_email.ilike.%${search}%,from_name.ilike.%${search}%,ai_summary.ilike.%${search}%`
      );
    }

    const { data, error, count } = await query
      .order(sort, { ascending: order === "asc" })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (error) throw error;

    // Enrichir avec contact (best-effort)
    const contactIds = [...new Set((data || []).map((e) => e.contact_id).filter(Boolean))];
    let contactMap = {};
    if (contactIds.length > 0) {
      const { data: contacts } = await supabase
        .from("contacts")
        .select("id, full_name, status")
        .in("id", contactIds);
      contactMap = Object.fromEntries((contacts || []).map((c) => [c.id, c]));
    }
    const enriched = (data || []).map((e) => ({
      ...e,
      contact: e.contact_id ? contactMap[e.contact_id] || null : null,
    }));

    return res.json({
      emails: enriched,
      total: count,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

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

  if (!company_id) return res.status(400).json({ error: "company_id requis" });

  try {
    const { data: drafts, error } = await supabase
      .from("email_drafts")
      .select("*")
      .eq("company_id", company_id)
      .eq("status", status)
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    // Hydrater email + contact
    const emailIds   = [...new Set((drafts || []).map((d) => d.email_id).filter(Boolean))];
    let emailMap = {};
    let contactMap = {};
    if (emailIds.length > 0) {
      const { data: emails } = await supabase
        .from("emails")
        .select("id, from_email, from_name, subject, body, received_at, ai_summary, classification, contact_id")
        .in("id", emailIds);
      emailMap = Object.fromEntries((emails || []).map((e) => [e.id, e]));

      const contactIds = [...new Set((emails || []).map((e) => e.contact_id).filter(Boolean))];
      if (contactIds.length > 0) {
        const { data: contacts } = await supabase
          .from("contacts")
          .select("id, full_name, company")
          .in("id", contactIds);
        contactMap = Object.fromEntries((contacts || []).map((c) => [c.id, c]));
      }
    }

    const enriched = (drafts || []).map((d) => {
      const email = emailMap[d.email_id] || null;
      const contact = email?.contact_id ? contactMap[email.contact_id] || null : null;
      return { ...d, email, contact };
    });

    return res.json({ drafts: enriched });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/emails/drafts/:id/approve
// Admin approuve le brouillon → envoi du courriel
// ─────────────────────────────────────────────────────────────
router.post("/drafts/:id/approve", async (req, res) => {
  const { id } = req.params;
  const { edited_body, edited_subject } = req.body;

  try {
    const { data: draft, error: dErr } = await supabase
      .from("email_drafts")
      .select("*")
      .eq("id", id)
      .single();
    if (dErr || !draft) return res.status(404).json({ error: "brouillon introuvable" });

    // Récupérer l'email source (peut être null si standalone draft)
    let sourceEmail = null;
    if (draft.email_id) {
      const { data: e } = await supabase
        .from("emails")
        .select("id, from_email, from_name, subject")
        .eq("id", draft.email_id)
        .maybeSingle();
      sourceEmail = e || null;
    }

    const finalSubject = edited_subject || draft.subject;
    const finalBody    = edited_body || draft.body;
    const recipient    = draft.to_email || sourceEmail?.from_email;
    if (!recipient) return res.status(400).json({ error: "Destinataire introuvable" });

    // Config assistante (pour from + reply-to). Best-effort.
    const { data: config } = await supabase
      .from("assistant_configs")
      .select("*")
      .eq("company_id", draft.company_id)
      .maybeSingle();
    const { data: company } = await supabase
      .from("companies")
      .select("name")
      .eq("id", draft.company_id)
      .maybeSingle();

    // Envoi via Resend (si configuré)
    let messageId = null;
    let sendError = null;
    if (process.env.RESEND_API_KEY && config?.email_from) {
      try {
        const result = await sendEmailViaResend({
          from: `${company?.name || "Garage"} <${config.email_from}>`,
          to: recipient,
          subject: finalSubject,
          html: finalBody.replace(/\n/g, "<br>"),
          replyTo: config.email_reply_to,
        });
        messageId = result?.id;
      } catch (e) {
        sendError = e.message;
      }
    } else {
      sendError = "resend_not_configured";
    }

    // Mise à jour DB (toujours, même si l'envoi a échoué — on garde la trace)
    // Note: la contrainte CHECK sur status limite les valeurs (sent, pending_validation, rejected).
    // En cas d'échec d'envoi, on garde "sent" mais on log le warning dans ai_reasoning.
    const newReasoning = sendError
      ? `[SEND_WARNING:${sendError}] ${draft.ai_reasoning || ""}`.trim()
      : draft.ai_reasoning;

    await supabase
      .from("email_drafts")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        body: finalBody,
        subject: finalSubject,
        ai_reasoning: newReasoning,
      })
      .eq("id", id);

    if (sourceEmail) {
      await supabase
        .from("emails")
        .update({ status: "replied" })
        .eq("id", sourceEmail.id);
    }

    return res.json({
      success: true,
      sent_via_resend: !!messageId,
      message_id: messageId,
      send_warning: sendError,
    });
  } catch (err) {
    console.error("[EMAIL] Approve error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/v1/emails/drafts/:id
// Sauvegarder une modification inline (body/subject) avant approval
// ─────────────────────────────────────────────────────────────
router.patch("/drafts/:id", async (req, res) => {
  const { id } = req.params;
  const updates = {};
  if (req.body.body != null) updates.body = req.body.body;
  if (req.body.subject != null) updates.subject = req.body.subject;
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "Aucune modification" });
  }

  try {
    const { data, error } = await supabase
      .from("email_drafts")
      .update(updates)
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    return res.json({ success: true, draft: data });
  } catch (err) {
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

  try {
    // ai_reasoning sert de log post-mortem ; on stocke aussi la raison du rejet ici
    const newReasoning = reason ? `[REJECTED] ${reason}` : "[REJECTED] Refusé par l'admin";
    const { error } = await supabase
      .from("email_drafts")
      .update({ status: "rejected", ai_reasoning: newReasoning })
      .eq("id", id);
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v1/emails/drafts/:id/regenerate
// Régénérer un brouillon avec une nouvelle instruction
// ─────────────────────────────────────────────────────────────
router.post("/drafts/:id/regenerate", async (req, res) => {
  const { id } = req.params;
  const { instruction } = req.body;

  try {
    const { data: draft, error: dErr } = await supabase
      .from("email_drafts")
      .select("*")
      .eq("id", id)
      .single();
    if (dErr || !draft) return res.status(404).json({ error: "brouillon introuvable" });

    // Récupérer email source pour donner du contexte à l'IA
    let sourceEmail = null;
    if (draft.email_id) {
      const { data: e } = await supabase
        .from("emails")
        .select("from_email, from_name, subject, body")
        .eq("id", draft.email_id)
        .maybeSingle();
      sourceEmail = e || null;
    }

    // Best-effort : appel AI Gateway (si configuré). Fallback : on garde l'ancien body.
    let newDraft = null;
    try {
      newDraft = await callAIGateway({
        task: "regenerate_email_draft",
        company_id: draft.company_id,
        email: sourceEmail,
        previous_draft: draft.body,
        instruction,
      });
    } catch (e) {
      console.warn("[EMAIL] AI regenerate failed, keeping previous draft:", e.message);
    }

    const finalBody = newDraft?.body || draft.body;
    const finalSubject = newDraft?.subject || draft.subject;
    const reasoning = instruction
      ? `[REGEN] ${instruction}`
      : (draft.ai_reasoning || "[REGEN] Régénération sans instruction");

    const { data: updated, error: uErr } = await supabase
      .from("email_drafts")
      .update({ body: finalBody, subject: finalSubject, ai_reasoning: reasoning })
      .eq("id", id)
      .select()
      .single();
    if (uErr) throw uErr;

    return res.json({ success: true, draft: updated });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/v1/emails/:id
// Détail d'un email + draft associé (si existe) + contact
// ATTENTION : doit rester APRÈS toutes les routes /drafts/*
// ─────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const { data: email, error } = await supabase
      .from("emails")
      .select("*")
      .eq("id", id)
      .single();
    if (error || !email) return res.status(404).json({ error: "Courriel introuvable" });

    let contact = null;
    if (email.contact_id) {
      const { data: c } = await supabase
        .from("contacts")
        .select("id, full_name, email, phone, company, status")
        .eq("id", email.contact_id)
        .maybeSingle();
      contact = c || null;
    }

    // Draft associé (best-effort — peut ne pas exister)
    const { data: drafts } = await supabase
      .from("email_drafts")
      .select("*")
      .eq("email_id", id)
      .order("created_at", { ascending: false })
      .limit(1);

    return res.json({
      email: { ...email, contact },
      draft: drafts?.[0] || null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
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
