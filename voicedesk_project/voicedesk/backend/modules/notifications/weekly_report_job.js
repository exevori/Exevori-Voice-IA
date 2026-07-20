// ============================================================
// EXEVORI VOICE IA — Rapport hebdomadaire automatique (Tâche 7)
// Fichier : backend/modules/notifications/weekly_report_job.js
//
// À importer dans index.js (backend) :
//   import { startWeeklyReportJob } from "./modules/notifications/weekly_report_job.js";
//   startWeeklyReportJob();
//
// Planification de fallback sans dépendance externe : setInterval
// ============================================================

import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const resend = new Resend(process.env.RESEND_API_KEY);

const HOURLY_COST_ESTIMATE = 35; // 35$/h = coût moyen réceptionniste au Québec

// ─── Trigger manuel (endpoint POST /api/v1/notifications/weekly-report) ───────
export async function triggerWeeklyReport(req, res) {
  const { company_id } = req.query;
  try {
    if (company_id) {
      await generateAndSendReport(company_id);
    } else {
      await sendReportsToAllCompanies();
    }
    return res.json({ success: true, message: "Rapport(s) envoyé(s)" });
  } catch (err) {
    console.error("[weekly-report] Error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── Planification hebdomadaire de fallback ───────────────────────────────────
export function startWeeklyReportJob() {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  setInterval(async () => { await sendReportsToAllCompanies(); }, WEEK_MS);
  console.log("[weekly-report] Planification active — intervalle de 7 jours");
}

// ─── Envoyer à toutes les entreprises actives ─────────────────────────────────
async function sendReportsToAllCompanies() {
  const { data: companies } = await supabase
    .from("companies")
    .select("id, name")
    .eq("status", "active");

  if (!companies?.length) return;

  for (const company of companies) {
    try {
      await generateAndSendReport(company.id);
    } catch (err) {
      console.error(`[weekly-report] Erreur pour ${company.name}:`, err.message);
    }
  }
}

// ─── Générer et envoyer le rapport pour une entreprise ────────────────────────
async function generateAndSendReport(companyId) {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const from = sevenDaysAgo.toISOString();

  // Récupérer les données
  const [callsRes, appointmentsRes, contactsRes, companyRes] = await Promise.all([
    supabase.from("calls").select("id, duration_seconds, outcome, created_at")
      .eq("company_id", companyId).gte("created_at", from),
    supabase.from("appointments").select("id, status, created_at")
      .eq("company_id", companyId).gte("created_at", from),
    supabase.from("contacts").select("id, created_at")
      .eq("company_id", companyId).gte("created_at", from),
    supabase.from("companies").select("name, contact_email").eq("id", companyId).single(),
  ]);

  const calls        = callsRes.data || [];
  const appointments = appointmentsRes.data || [];
  const contacts     = contactsRes.data || [];
  const company      = companyRes.data;

  if (!company?.contact_email) {
    console.warn(`[weekly-report] Pas d'email pour company ${companyId}`);
    return;
  }

  // Calculer les métriques
  const totalCalls      = calls.length;
  const totalSeconds    = calls.reduce((sum, c) => sum + (c.duration_seconds || 0), 0);
  const totalHours      = Math.round((totalSeconds / 3600) * 10) / 10;
  const valueEstimate   = Math.round(totalHours * HOURLY_COST_ESTIMATE);
  const resolved        = calls.filter(c => c.outcome && c.outcome !== "transferred").length;
  const resolutionRate  = totalCalls > 0 ? Math.round((resolved / totalCalls) * 100) : 0;
  const rdvCount        = appointments.length;
  const newContacts     = contacts.length;

  // Si aucune activité cette semaine
  if (totalCalls === 0 && rdvCount === 0 && newContacts === 0) {
    console.log(`[weekly-report] Aucune activité pour ${company.name} — rapport sauté`);
    return;
  }

  // Générer et envoyer l'email
  const html = buildEmailHTML(company.name, {
    totalCalls, totalHours, valueEstimate, resolutionRate, rdvCount, newContacts
  });

  await resend.emails.send({
    from: "Léa — VoiceDesk AI <rapports@exevori.com>",
    to: company.contact_email,
    subject: `📊 Votre rapport hebdomadaire — ${company.name}`,
    html,
  });

  console.log(`[weekly-report] Rapport envoyé à ${company.contact_email} (${company.name})`);
}

// ─── Template HTML de l'email ─────────────────────────────────────────────────
function buildEmailHTML(companyName, metrics) {
  const { totalCalls, totalHours, valueEstimate, resolutionRate, rdvCount, newContacts } = metrics;

  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
  <div style="max-width:580px;margin:32px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
    <!-- Header -->
    <div style="background:#1E3A5F;padding:28px 32px">
      <p style="color:#93C5FD;font-size:12px;margin:0 0 4px;letter-spacing:0.05em;text-transform:uppercase">Rapport hebdomadaire</p>
      <h1 style="color:#ffffff;font-size:22px;margin:0;font-weight:600">${companyName}</h1>
    </div>

    <!-- Summary -->
    <div style="padding:24px 32px;background:#EFF6FF;border-bottom:1px solid #DBEAFE">
      <p style="color:#1E3A5F;font-size:14px;margin:0;line-height:1.6">
        Cette semaine, <strong>Léa a géré ${totalCalls} appel${totalCalls > 1 ? "s" : ""}</strong>
        pour votre équipe, économisant environ <strong>${totalHours}h</strong> de travail —
        soit une valeur estimée de <strong>${valueEstimate}$</strong>.
      </p>
    </div>

    <!-- Metrics -->
    <div style="padding:24px 32px">
      <table style="width:100%;border-collapse:collapse">
        <tr>
          ${metricCell("Appels traités",    totalCalls.toString(),       "#3B82F6")}
          ${metricCell("Rendez-vous pris",  rdvCount.toString(),         "#8B5CF6")}
        </tr>
        <tr><td colspan="2" style="padding:6px 0"></td></tr>
        <tr>
          ${metricCell("Taux de résolution", `${resolutionRate}%`,       "#10B981")}
          ${metricCell("Nouveaux contacts",  newContacts.toString(),      "#F59E0B")}
        </tr>
      </table>
    </div>

    <!-- CTA -->
    <div style="padding:0 32px 28px;text-align:center">
      <a href="https://emergent-preview-113.preview.emergentagent.com/dashboard"
        style="display:inline-block;background:#3B82F6;color:#ffffff;padding:12px 28px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600">
        Voir le tableau de bord →
      </a>
    </div>

    <!-- Footer -->
    <div style="padding:16px 32px;background:#F8FAFC;border-top:1px solid #E2E8F0;text-align:center">
      <p style="color:#94A3B8;font-size:11px;margin:0">
        Rapport généré automatiquement par <strong>VoiceDesk AI</strong> — Exevori, Lévis, Québec<br>
        Pour modifier vos préférences de notification : <a href="https://emergent-preview-113.preview.emergentagent.com/config" style="color:#3B82F6">Paramètres</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

function metricCell(label, value, color) {
  return `<td style="width:50%;padding:12px 8px">
    <div style="background:#F8FAFC;border-radius:10px;padding:16px;text-align:center;border:1px solid #E2E8F0">
      <p style="font-size:28px;font-weight:700;color:${color};margin:0">${value}</p>
      <p style="font-size:12px;color:#64748B;margin:6px 0 0">${label}</p>
    </div>
  </td>`;
}
