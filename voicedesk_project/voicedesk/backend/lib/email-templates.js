// ============================================================
// VOICEDESK IA — TEMPLATES D'EMAILS CENTRALISÉS
// Tous les emails transactionnels en un seul endroit.
// Bilingue FR / EN selon la préférence du destinataire.
// ============================================================

const BASE_STYLES = `
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  max-width: 600px;
  margin: 0 auto;
  padding: 20px;
  color: #1F2937;
  line-height: 1.6;
`;

const BUTTON_STYLES = `
  display: inline-block;
  padding: 12px 24px;
  background: #3B82F6;
  color: white;
  text-decoration: none;
  border-radius: 8px;
  font-weight: 600;
  margin: 16px 0;
`;

const FOOTER_FR = `
<hr style="margin-top:32px;border:none;border-top:1px solid #E5E7EB">
<p style="color:#94A3B8;font-size:12px">
  VoiceDesk IA — Assistante IA pour PME québécoises<br>
  Une initiative <strong>Exevori</strong> (Lévis, Québec)<br>
  <a href="mailto:support@voicedesk.ca" style="color:#3B82F6">support@voicedesk.ca</a>
</p>
`;

const FOOTER_EN = `
<hr style="margin-top:32px;border:none;border-top:1px solid #E5E7EB">
<p style="color:#94A3B8;font-size:12px">
  VoiceDesk IA — AI Assistant for Quebec SMBs<br>
  Powered by <strong>Exevori</strong> (Lévis, Quebec)<br>
  <a href="mailto:support@voicedesk.ca" style="color:#3B82F6">support@voicedesk.ca</a>
</p>
`;

// ─────────────────────────────────────────────────────────────
// EMAILS — INVITATION
// ─────────────────────────────────────────────────────────────

export function invitationEmail({ companyName, contactName, inviteUrl, expiresAt, lang = "fr-CA" }) {
  const dateExpire = new Date(expiresAt).toLocaleDateString(lang, {
    day: "numeric", month: "long", year: "numeric"
  });

  if (lang.startsWith("en")) {
    return {
      subject: `Welcome to VoiceDesk IA, ${contactName}!`,
      html: `
<div style="${BASE_STYLES}">
  <h1 style="color:#3B82F6">👋 Welcome to VoiceDesk IA!</h1>
  <p>Hello <strong>${contactName}</strong>,</p>
  <p>You have been invited to activate your VoiceDesk IA account for <strong>${companyName}</strong>.</p>
  <p>Click the button below to create your password and start configuring your AI assistant:</p>
  <a href="${inviteUrl}" style="${BUTTON_STYLES}">Activate my account</a>
  <p style="color:#94A3B8;font-size:13px">This link expires on ${dateExpire}.</p>
  <p>If you didn't expect this invitation, you can ignore this email.</p>
  ${FOOTER_EN}
</div>`,
    };
  }

  return {
    subject: `Bienvenue chez VoiceDesk IA, ${contactName}!`,
    html: `
<div style="${BASE_STYLES}">
  <h1 style="color:#3B82F6">👋 Bienvenue chez VoiceDesk IA!</h1>
  <p>Bonjour <strong>${contactName}</strong>,</p>
  <p>Vous avez été invité(e) à activer votre compte VoiceDesk IA pour <strong>${companyName}</strong>.</p>
  <p>Cliquez sur le bouton ci-dessous pour créer votre mot de passe et commencer à configurer votre assistante IA :</p>
  <a href="${inviteUrl}" style="${BUTTON_STYLES}">Activer mon compte</a>
  <p style="color:#94A3B8;font-size:13px">Ce lien expire le ${dateExpire}.</p>
  <p>Si vous n'attendiez pas cette invitation, vous pouvez ignorer ce courriel.</p>
  ${FOOTER_FR}
</div>`,
  };
}

// ─────────────────────────────────────────────────────────────
// EMAILS — RESET PASSWORD
// ─────────────────────────────────────────────────────────────

export function passwordResetEmail({ contactName, resetUrl, lang = "fr-CA" }) {
  if (lang.startsWith("en")) {
    return {
      subject: "Reset your VoiceDesk password",
      html: `
<div style="${BASE_STYLES}">
  <h1 style="color:#3B82F6">🔐 Reset your password</h1>
  <p>Hello ${contactName || ""},</p>
  <p>You requested a password reset. Click the button below to set a new password:</p>
  <a href="${resetUrl}" style="${BUTTON_STYLES}">Reset password</a>
  <p style="color:#94A3B8;font-size:13px">This link expires in 1 hour.</p>
  <p>If you didn't request this, you can safely ignore this email.</p>
  ${FOOTER_EN}
</div>`,
    };
  }

  return {
    subject: "Réinitialiser votre mot de passe VoiceDesk",
    html: `
<div style="${BASE_STYLES}">
  <h1 style="color:#3B82F6">🔐 Réinitialiser votre mot de passe</h1>
  <p>Bonjour ${contactName || ""},</p>
  <p>Vous avez demandé une réinitialisation de mot de passe. Cliquez sur le bouton ci-dessous pour en créer un nouveau :</p>
  <a href="${resetUrl}" style="${BUTTON_STYLES}">Réinitialiser le mot de passe</a>
  <p style="color:#94A3B8;font-size:13px">Ce lien expire dans 1 heure.</p>
  <p>Si vous n'avez pas fait cette demande, ignorez ce courriel.</p>
  ${FOOTER_FR}
</div>`,
  };
}

// ─────────────────────────────────────────────────────────────
// EMAILS — TRIAL ENDING
// ─────────────────────────────────────────────────────────────

export function trialEndingEmail({ companyName, daysLeft, billingUrl, lang = "fr-CA" }) {
  if (lang.startsWith("en")) {
    return {
      subject: `Your trial ends in ${daysLeft} day(s)`,
      html: `
<div style="${BASE_STYLES}">
  <h1 style="color:#F59E0B">⏰ Your trial is ending</h1>
  <p>Hello,</p>
  <p>Your VoiceDesk IA trial for <strong>${companyName}</strong> ends in <strong>${daysLeft} day(s)</strong>.</p>
  <p>To continue enjoying your AI assistant uninterrupted, please choose a plan:</p>
  <a href="${billingUrl}" style="${BUTTON_STYLES}">Choose a plan</a>
  <p>Need help choosing? Contact us at <a href="mailto:hello@voicedesk.ca">hello@voicedesk.ca</a></p>
  ${FOOTER_EN}
</div>`,
    };
  }

  return {
    subject: `Votre essai gratuit se termine dans ${daysLeft} jour(s)`,
    html: `
<div style="${BASE_STYLES}">
  <h1 style="color:#F59E0B">⏰ Votre essai se termine bientôt</h1>
  <p>Bonjour,</p>
  <p>Votre essai gratuit VoiceDesk IA pour <strong>${companyName}</strong> se termine dans <strong>${daysLeft} jour(s)</strong>.</p>
  <p>Pour continuer à profiter de votre assistante IA sans interruption, choisissez un forfait :</p>
  <a href="${billingUrl}" style="${BUTTON_STYLES}">Choisir un forfait</a>
  <p>Besoin d'aide ? Contactez-nous à <a href="mailto:hello@voicedesk.ca">hello@voicedesk.ca</a></p>
  ${FOOTER_FR}
</div>`,
  };
}

// ─────────────────────────────────────────────────────────────
// EMAILS — PAYMENT FAILED
// ─────────────────────────────────────────────────────────────

export function paymentFailedEmail({ companyName, amount, billingUrl, lang = "fr-CA" }) {
  if (lang.startsWith("en")) {
    return {
      subject: "Payment failed — action required",
      html: `
<div style="${BASE_STYLES}">
  <h1 style="color:#EF4444">⚠️ Payment failed</h1>
  <p>Hello,</p>
  <p>We were unable to process the payment of <strong>$${amount} CAD</strong> for <strong>${companyName}</strong>.</p>
  <p>To avoid service interruption, please update your payment method:</p>
  <a href="${billingUrl}" style="${BUTTON_STYLES}">Update payment method</a>
  <p>If you have any questions, contact us at <a href="mailto:support@voicedesk.ca">support@voicedesk.ca</a></p>
  ${FOOTER_EN}
</div>`,
    };
  }

  return {
    subject: "Échec de paiement — action requise",
    html: `
<div style="${BASE_STYLES}">
  <h1 style="color:#EF4444">⚠️ Échec de paiement</h1>
  <p>Bonjour,</p>
  <p>Nous n'avons pas pu traiter le paiement de <strong>${amount} $ CAD</strong> pour <strong>${companyName}</strong>.</p>
  <p>Pour éviter une interruption de service, mettez à jour votre méthode de paiement :</p>
  <a href="${billingUrl}" style="${BUTTON_STYLES}">Mettre à jour le paiement</a>
  <p>Pour toute question, contactez-nous à <a href="mailto:support@voicedesk.ca">support@voicedesk.ca</a></p>
  ${FOOTER_FR}
</div>`,
  };
}

// ─────────────────────────────────────────────────────────────
// EMAILS — NEW TICKET
// ─────────────────────────────────────────────────────────────

export function newTicketEmail({ ticketNumber, subject, priority, clientName, ticketUrl, lang = "fr-CA" }) {
  const priorityLabels = {
    urgent: { fr: "🔴 URGENT", en: "🔴 URGENT" },
    high:   { fr: "🟠 Haute", en: "🟠 High" },
    normal: { fr: "🔵 Normale", en: "🔵 Normal" },
    low:    { fr: "⚪ Basse", en: "⚪ Low" },
  };
  const lbl = priorityLabels[priority] || priorityLabels.normal;

  if (lang.startsWith("en")) {
    return {
      subject: `[${ticketNumber}] ${lbl.en} — ${subject}`,
      html: `
<div style="${BASE_STYLES}">
  <h2 style="color:#3B82F6">New support ticket</h2>
  <p><strong>${ticketNumber}</strong> — ${subject}</p>
  <p><strong>Priority:</strong> ${lbl.en}<br>
     <strong>Client:</strong> ${clientName}</p>
  <a href="${ticketUrl}" style="${BUTTON_STYLES}">View ticket</a>
  ${FOOTER_EN}
</div>`,
    };
  }

  return {
    subject: `[${ticketNumber}] ${lbl.fr} — ${subject}`,
    html: `
<div style="${BASE_STYLES}">
  <h2 style="color:#3B82F6">Nouveau ticket de support</h2>
  <p><strong>${ticketNumber}</strong> — ${subject}</p>
  <p><strong>Priorité :</strong> ${lbl.fr}<br>
     <strong>Client :</strong> ${clientName}</p>
  <a href="${ticketUrl}" style="${BUTTON_STYLES}">Voir le ticket</a>
  ${FOOTER_FR}
</div>`,
  };
}

// ─────────────────────────────────────────────────────────────
// EMAILS — ACKNOWLEDGMENT (Niveau 1 auto)
// ─────────────────────────────────────────────────────────────

export function acknowledgmentEmail({ assistantName, companyName, contactName, lang = "fr-CA" }) {
  if (lang.startsWith("en")) {
    return {
      subject: "Message received",
      html: `
<div style="${BASE_STYLES}">
  <p>Hello${contactName ? " " + contactName : ""},</p>
  <p>We have received your message and thank you for contacting us.</p>
  <p>A member of our team will respond as soon as possible — typically within 24 business hours.</p>
  <p>Best regards,<br><strong>${assistantName}</strong><br>${companyName}</p>
  <p style="color:#94A3B8;font-size:11px;margin-top:24px">
    This is an automatic acknowledgment from our AI assistant.
  </p>
</div>`,
    };
  }

  return {
    subject: "Accusé de réception",
    html: `
<div style="${BASE_STYLES}">
  <p>Bonjour${contactName ? " " + contactName : ""},</p>
  <p>Nous avons bien reçu votre message et nous vous remercions de nous avoir contactés.</p>
  <p>Un membre de notre équipe vous répondra dans les plus brefs délais — habituellement sous 24 heures ouvrables.</p>
  <p>Cordialement,<br><strong>${assistantName}</strong><br>${companyName}</p>
  <p style="color:#94A3B8;font-size:11px;margin-top:24px">
    Ce message est un accusé de réception automatique généré par votre assistante IA.
  </p>
</div>`,
  };
}

export default {
  invitationEmail,
  passwordResetEmail,
  trialEndingEmail,
  paymentFailedEmail,
  newTicketEmail,
  acknowledgmentEmail,
};
