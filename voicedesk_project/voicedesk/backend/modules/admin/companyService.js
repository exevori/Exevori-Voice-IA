import { randomUUID } from "node:crypto";

const PAGE_SIZE = 1000;
const COMPANY_FIELDS = "id,name,contact_name,contact_email,phone,city,province,country,billing_country,sector,website,plan,status,assistant_name,created_at,updated_at";
const SUBSCRIPTION_FIELDS = "plan_name,payment_status,billing_cycle,monthly_price,annual_price,stripe_customer_id,stripe_subscription_id,trial_ends_at,current_period_start,current_period_end,minutes_included,minutes_used_current_period";
const ACTIVE_PAYMENTS = new Set(["active", "active_paid", "trial"]);

export function adminError(code, status = 503) {
  return Object.assign(new Error(code), { code, status });
}

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function pick(row, fields) {
  if (!row) return null;
  return Object.fromEntries(fields.split(",").map(key => [key, row[key] ?? null]));
}

function checked(result, code) {
  if (result.error) throw adminError(code);
  return result.data;
}

export function utcMonth(now) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

export function monthlySubscriptionAmount(subscription) {
  if (!["active", "active_paid", "trial", "overdue"].includes(subscription.payment_status)) return 0;
  const monthly = finite(subscription.monthly_price);
  const annual = finite(subscription.annual_price);
  return subscription.billing_cycle === "annual" && annual !== null ? annual / 12 : monthly || 0;
}

async function allPages(factory, code) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = checked(await factory().order("id").range(offset, offset + PAGE_SIZE - 1), code) || [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function applicationUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) return null;
    return url.origin;
  } catch { return null; }
}

export function createAdminCompanyService({
  supabase, stripe = null, resend = null, provisionClient = null,
  clearCompanyCache = async () => {}, now = () => new Date(),
  frontendUrl = process.env.FRONTEND_URL, emailFrom = process.env.EMAIL_FROM,
  logger = console,
}) {
  const appUrl = applicationUrl(frontendUrl);

  async function companyById(companyId) {
    const row = checked(await supabase.from("companies").select(COMPANY_FIELDS)
      .eq("id", companyId).maybeSingle(), "company_read_failed");
    if (!row) throw adminError("company_not_found", 404);
    return pick(row, COMPANY_FIELDS);
  }

  async function subscriptionByCompany(companyId) {
    return pick(checked(await supabase.from("subscriptions").select(SUBSCRIPTION_FIELDS)
      .eq("company_id", companyId).maybeSingle(), "subscription_read_failed"), SUBSCRIPTION_FIELDS);
  }

  async function stripeSnapshot(subscription, companyId) {
    const base = { state: "not_linked", subscription_status: null, checked_at: now().toISOString() };
    if (!subscription?.stripe_subscription_id) return base;
    if (!stripe?.subscriptions?.retrieve) return { ...base, state: "not_configured" };
    try {
      const row = await stripe.subscriptions.retrieve(subscription.stripe_subscription_id);
      const customerId = typeof row.customer === "string" ? row.customer : row.customer?.id;
      if (row.id !== subscription.stripe_subscription_id || !subscription.stripe_customer_id
        || customerId !== subscription.stripe_customer_id
        || (row.metadata?.company_id && row.metadata.company_id !== companyId)) {
        return { ...base, state: "mismatch" };
      }
      return {
        ...base, state: "verified", subscription_status: row.status,
        cancel_at_period_end: row.cancel_at_period_end === true,
        trial_ends_at: row.trial_end ? new Date(row.trial_end * 1000).toISOString() : null,
      };
    } catch {
      return { ...base, state: "unavailable" };
    }
  }

  async function audit(companyId, actor, action, details = {}) {
    checked(await supabase.from("audit_log").insert({
      company_id: companyId, actor_user_id: actor.id, actor_role: "super_admin",
      action, entity_type: "company", entity_id: companyId,
      request_id: actor.requestId || randomUUID(), details,
    }), "admin_audit_failed");
  }

  async function auditOutcome(companyId, actor, action, details) {
    try {
      await audit(companyId, actor, action, details);
      return null;
    } catch {
      logger.error?.("[admin] Action completed but audit outcome could not be written", { action });
      return "audit_outcome_unavailable";
    }
  }

  async function getCompanyDetail(companyId, actor) {
    const company = await companyById(companyId);
    const period = utcMonth(now());
    const [subscription, configResult, phonesResult, twilioResult, onboardingResult, inbound, outbound, usage] = await Promise.all([
      subscriptionByCompany(companyId),
      supabase.from("assistant_configs").select("assistant_name,voice_id,elevenlabs_agent_id,twilio_number")
        .eq("company_id", companyId).maybeSingle(),
      supabase.from("phone_numbers").select("id,phone_number,status,twilio_phone_sid,elevenlabs_agent_id,elevenlabs_phone_number_id")
        .eq("company_id", companyId).in("status", ["active", "suspended"]).order("created_at"),
      supabase.from("twilio_configs").select("phone_number,phone_number_sid,status")
        .eq("company_id", companyId).maybeSingle(),
      supabase.from("onboarding_progress").select("current_step,completed_steps,provisioning_status,provisioning_started_at")
        .eq("company_id", companyId).maybeSingle(),
      allPages(() => supabase.from("calls").select("id,duration_seconds,direction")
        .eq("company_id", companyId).gte("created_at", period.start).lt("created_at", period.end), "calls_read_failed"),
      allPages(() => supabase.from("outbound_calls").select("id,duration_seconds")
        .eq("company_id", companyId).gte("called_at", period.start).lt("called_at", period.end), "outbound_calls_read_failed"),
      allPages(() => supabase.from("usage_records").select("id,resource_type,quantity,total_cost_usd")
        .eq("company_id", companyId).eq("period_start", period.start.slice(0, 10)), "usage_read_failed"),
    ]);
    const assistant = pick(checked(configResult, "assistant_read_failed"), "assistant_name,voice_id,elevenlabs_agent_id,twilio_number");
    const phoneNumbers = (checked(phonesResult, "phone_numbers_read_failed") || [])
      .map(row => pick(row, "id,phone_number,status,twilio_phone_sid,elevenlabs_agent_id,elevenlabs_phone_number_id"));
    const legacyPhone = pick(checked(twilioResult, "twilio_config_read_failed"), "phone_number,phone_number_sid,status");
    const onboarding = pick(checked(onboardingResult, "onboarding_read_failed"), "current_step,completed_steps,provisioning_status,provisioning_started_at");
    const stripeState = await stripeSnapshot(subscription, companyId);
    const inboundCalls = inbound.filter(call => !call.direction || call.direction === "inbound");
    const seconds = [...inboundCalls, ...outbound].reduce((total, call) => total + (finite(call.duration_seconds) || 0), 0);
    const allCostsKnown = usage.length > 0 && usage.every(row => finite(row.total_cost_usd) !== null);
    const costTotal = allCostsKnown ? usage.reduce((total, row) => total + finite(row.total_cost_usd), 0) : null;
    const costBreakdown = usage.map(row => ({
      resource_type: row.resource_type, quantity: finite(row.quantity), total_cost_usd: finite(row.total_cost_usd),
    }));
    await audit(companyId, actor, "admin_company_viewed");
    return {
      company, subscription, stripe: stripeState,
      telephony: { phone_numbers: phoneNumbers, legacy_phone: legacyPhone, assistant },
      onboarding,
      usage: {
        period_start: period.start, period_end: period.end, timezone: "UTC",
        inbound_calls: inboundCalls.length, outbound_calls: outbound.length,
        total_calls: inboundCalls.length + outbound.length,
        minutes: Math.round(seconds / 60 * 10) / 10,
        infrastructure_cost_usd: costTotal === null ? null : Math.round(costTotal * 100) / 100,
        cost_state: allCostsKnown ? "recorded" : "not_available", cost_breakdown: costBreakdown,
      },
      generated_at: now().toISOString(),
    };
  }

  async function eligiblePayment(companyId) {
    const sub = await subscriptionByCompany(companyId);
    const live = await stripeSnapshot(sub, companyId);
    if (sub?.stripe_subscription_id || sub?.stripe_customer_id) {
      if (live.state !== "verified") throw adminError("stripe_verification_required", 503);
      if (!["active", "trialing"].includes(live.subscription_status)) throw adminError("subscription_inactive", 409);
      return live.subscription_status === "trialing" ? "trial" : "active";
    }
    if (!sub || !ACTIVE_PAYMENTS.has(sub.payment_status)) throw adminError("subscription_inactive", 409);
    if (sub.payment_status === "trial" && (!sub.trial_ends_at || Date.parse(sub.trial_ends_at) <= now().getTime()
      || !Number.isFinite(Date.parse(sub.trial_ends_at)))) throw adminError("trial_expired", 409);
    return sub.payment_status === "trial" ? "trial" : "active";
  }

  async function changeAccess(companyId, action, actor, reason) {
    const company = await companyById(companyId);
    if (action === "suspend" && company.status === "cancelled") throw adminError("cancelled_company", 409);
    if (action === "reactivate" && !["suspended", "suspended_overage"].includes(company.status)) {
      throw adminError("company_not_suspended", 409);
    }
    const nextStatus = action === "suspend" ? "suspended" : await eligiblePayment(companyId);
    await audit(companyId, actor, `admin_company_${action}_requested`, { reason, previous_status: company.status, next_status: nextStatus });
    // La suspension porte sur l'accès au produit. Le statut de paiement reste
    // géré par Stripe et ses webhooks ; cette action ne modifie aucune facture.
    const result = await supabase.from("companies").update({ status: nextStatus, updated_at: now().toISOString() })
      .eq("id", companyId).eq("status", company.status).select(COMPANY_FIELDS).maybeSingle();
    const updated = checked(result, "company_status_update_failed");
    if (!updated) throw adminError("company_changed_retry", 409);
    let cacheWarning = null;
    try { await clearCompanyCache(companyId); }
    catch { cacheWarning = "auth_cache_refresh_pending"; }
    const auditWarning = await auditOutcome(companyId, actor, `admin_company_${action}_completed`, { previous_status: company.status, next_status: nextStatus });
    const warning = auditWarning || cacheWarning;
    return { success: true, company: pick(updated, COMPANY_FIELDS), warning, billing_unchanged: true };
  }

  async function impersonate(companyId, actor, reason) {
    const company = await companyById(companyId);
    await audit(companyId, actor, "admin_impersonation_started", { reason });
    return { success: true, company: pick(company, "id,name,city,assistant_name") };
  }

  async function resendWelcome(companyId, actor) {
    const company = await companyById(companyId);
    if (!resend?.emails?.send || !emailFrom || !appUrl) throw adminError("welcome_email_not_configured");
    const email = company.contact_email?.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw adminError("company_email_invalid", 409);
    if (["cancelled", "suspended", "suspended_overage"].includes(company.status)) throw adminError("company_access_inactive", 409);
    await audit(companyId, actor, "admin_welcome_email_requested");
    const name = company.contact_name || company.name;
    const link = `${appUrl}/onboarding`;
    let result;
    try {
      result = await resend.emails.send({
        from: emailFrom, to: email,
        subject: "Bienvenue dans VoiceDesk AI",
        html: `<div style="font-family:Arial;max-width:560px;margin:auto"><h1>Bienvenue, ${escapeHtml(name)}</h1><p>Votre espace ${escapeHtml(company.name)} vous attend.</p><p>Connectez-vous pour reprendre la configuration de votre assistante.</p><p><a href="${escapeHtml(link)}">Ouvrir mon espace VoiceDesk</a></p><p>Équipe Exevori</p></div>`,
        text: `Bienvenue, ${name}. Votre espace ${company.name} vous attend. Connectez-vous pour reprendre votre configuration : ${link}`,
      }, { idempotencyKey: `admin-welcome/${companyId}/${actor.requestId}` });
    } catch { throw adminError("welcome_email_send_failed"); }
    if (result?.error || !result?.data?.id) throw adminError("welcome_email_send_failed");
    const warning = await auditOutcome(companyId, actor, "admin_welcome_email_sent", { provider_message_id: result.data.id });
    return { success: true, recipient: email, warning };
  }

  async function resyncProvisioning(companyId, actor, reason) {
    const company = await companyById(companyId);
    if (["cancelled", "suspended", "suspended_overage"].includes(company.status)) throw adminError("company_access_inactive", 409);
    await eligiblePayment(companyId);
    const cfg = checked(await supabase.from("assistant_configs")
      .select("assistant_name,voice_id,system_prompt_voice_fr").eq("company_id", companyId).maybeSingle(), "assistant_read_failed");
    if (!cfg) throw adminError("assistant_config_required", 409);
    if (!provisionClient) throw adminError("provisioning_not_configured");
    await audit(companyId, actor, "admin_provisioning_resync_requested", { reason });
    const result = await provisionClient({ companyId, assistantName: cfg.assistant_name || "Votre assistante",
      voiceId: cfg.voice_id, systemPrompt: cfg.system_prompt_voice_fr });
    if (!result?.success) {
      const busy = ["provisioning_in_progress", "provisioning_retry_required"].includes(result?.code);
      await auditOutcome(companyId, actor, "admin_provisioning_resync_failed", { busy });
      throw adminError(busy ? "provisioning_in_progress" : "provisioning_resync_failed", busy ? 409 : 503);
    }
    const warning = await auditOutcome(companyId, actor, "admin_provisioning_resync_completed", { reused_existing: result.existing === true });
    return { success: true, reused_existing: result.existing === true, warning };
  }

  async function authorizeProvisioningRepair(companyId) {
    const company = await companyById(companyId);
    if (!["active", "trial"].includes(company.status)) throw adminError("company_access_inactive", 409);
    await eligiblePayment(companyId);
  }

  return { getCompanyDetail, changeAccess, impersonate, resendWelcome, resyncProvisioning, authorizeProvisioningRepair };
}
