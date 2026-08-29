import { randomUUID } from "node:crypto";
import {
  CalendlyApiError,
  cancelScheduledEvent,
  createInvitee,
  createWebhookSubscription,
  deleteWebhookSubscription,
  exchangeAuthorizationCode,
  getCurrentUser,
  getScheduledEvent,
  listAvailableTimes,
  listEventTypes,
  refreshAccessToken,
  requestInviteeDataDeletion,
} from "./client.js";
import {
  decryptCalendarSecret,
  encryptCalendarSecret,
  pkceChallenge,
  randomBase64Url,
  sha256Hex,
} from "./secrets.js";

export const CALENDLY_SCOPES = Object.freeze([
  "event_types:read",
  "scheduled_events:write",
  "users:read",
  "webhooks:write",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_RE = /^\+[1-9]\d{7,14}$/;
const SAFE_RETURN_PATHS = new Set(["/calendar", "/settings", "/settings/integrations"]);
const MAX_AVAILABILITY_DAYS = 31;

function requestedCalendlyScopes() {
  return process.env.CALENDLY_DATA_COMPLIANCE_ENABLED === "true"
    ? [...CALENDLY_SCOPES, "data_compliance:write"]
    : [...CALENDLY_SCOPES];
}

function cleanText(value, maxLength = 500) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

function normalizedEmail(value) {
  const email = cleanText(value, 320)?.toLowerCase() || null;
  return email && EMAIL_RE.test(email) ? email : null;
}

function normalizedPhone(value) {
  if (!value) return null;
  let phone = String(value).trim().replace(/[\s()./\-]/g, "");
  if (phone.startsWith("00")) phone = `+${phone.slice(2)}`;
  if (/^\d{10}$/.test(phone)) phone = `+1${phone}`;
  return E164_RE.test(phone) ? phone : null;
}

function validDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function encryptedColumns(encrypted, prefix) {
  return {
    [`${prefix}_ciphertext`]: encrypted.ciphertext,
    [`${prefix}_iv`]: encrypted.iv,
    [`${prefix}_tag`]: encrypted.tag,
  };
}

function fromEncryptedColumns(row, prefix) {
  return {
    ciphertext: row?.[`${prefix}_ciphertext`],
    iv: row?.[`${prefix}_iv`],
    tag: row?.[`${prefix}_tag`],
  };
}

function requireOAuthConfiguration() {
  const required = [
    "CALENDLY_CLIENT_ID",
    "CALENDLY_CLIENT_SECRET",
    "CALENDLY_REDIRECT_URI",
    "CALENDLY_WEBHOOK_SECRET",
    "APP_PUBLIC_URL",
    "ENCRYPTION_KEY",
  ];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length) {
    const error = new Error(`Missing Calendly configuration: ${missing.join(", ")}`);
    error.code = "calendly_not_configured";
    error.status = 503;
    throw error;
  }
}

function safeConnection(row) {
  if (!row) return { connected: false, status: "disconnected" };
  return {
    id: row.id,
    connected: row.status === "connected",
    status: row.status,
    user_name: row.calendly_user_name,
    user_email: row.calendly_user_email,
    default_event_type_uri: row.default_event_type_uri,
    granted_scopes: row.granted_scopes || [],
    webhook_status: row.webhook_status,
    webhook_error: row.webhook_error,
    connected_at: row.connected_at,
    last_error: row.last_error,
  };
}

function eventUri(value) {
  return typeof value === "string" ? value : value?.uri || null;
}

function locationDetails(location) {
  if (!location) return { channel: null, meetLink: null };
  const kind = location.kind || location.type || null;
  const channelByKind = {
    google_conference: "Google Meet",
    zoom_conference: "Zoom",
    zoom: "Zoom",
    microsoft_teams_conference: "Microsoft Teams",
    gotomeeting_conference: "GoTo Meeting",
    webex_conference: "Webex",
    outbound_call: "Téléphone",
    inbound_call: "Téléphone",
    physical: "En personne",
  };
  return {
    channel: channelByKind[kind] || kind || null,
    meetLink: location.join_url || location.location || null,
  };
}

function dateAndTimeInZone(dateValue, timeZone) {
  const date = validDate(dateValue);
  if (!date) return { date: null, time: null };
  const zone = isValidTimeZone(timeZone) ? timeZone : "America/Toronto";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}:${values.second}`,
  };
}

function retryAt(attempts, nowMs) {
  const seconds = Math.min(3600, 15 * (2 ** Math.max(0, attempts - 1)));
  return new Date(nowMs + seconds * 1000).toISOString();
}

function sanitizeProviderResponse(resource) {
  if (!resource) return null;
  return {
    event: eventUri(resource.event),
    uri: resource.uri || null,
    status: resource.status || null,
    cancel_url: resource.cancel_url || null,
    reschedule_url: resource.reschedule_url || null,
    timezone: resource.timezone || null,
  };
}

function extractQuestionPhone(questions = []) {
  const answer = questions.find(item => /phone|t[ée]l|num[ée]ro/i.test(item?.question || ""))?.answer;
  return normalizedPhone(answer);
}

function formatQuestions(questions = []) {
  return questions
    .filter(item => item?.question && item?.answer)
    .map(item => `${cleanText(item.question, 300)}: ${cleanText(item.answer, 1000)}`)
    .join("\n")
    .slice(0, 5000) || null;
}

function serviceError(code, message, status = 400, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  Object.assign(error, extra);
  return error;
}

function providerErrorForClient(error) {
  if (!(error instanceof CalendlyApiError)) return error;
  if (error.code === "calendly_forbidden") {
    return serviceError(
      "calendly_plan_or_scope_required",
      "Le forfait ou les autorisations Calendly ne permettent pas cette action.",
      409,
      { required_scopes: error.details || undefined }
    );
  }
  return error;
}

export function createCalendarService({
  supabase,
  fetchImpl = fetch,
  resend = null,
  now = () => new Date(),
  logger = console,
} = {}) {
  if (!supabase) throw new Error("Calendar service requires a Supabase client");

  async function loadConnection(companyId, { allowDisconnected = false } = {}) {
    const { data, error } = await supabase
      .from("calendly_connections")
      .select("*")
      .eq("company_id", companyId)
      .maybeSingle();
    if (error) throw error;
    if (!data || (!allowDisconnected && data.status !== "connected")) {
      throw serviceError("calendly_not_connected", "Calendly n’est pas connecté.", 409);
    }
    return data;
  }

  async function getConnectionStatus(companyId) {
    const { data, error } = await supabase
      .from("calendly_connections")
      .select("id, status, calendly_user_name, calendly_user_email, default_event_type_uri, granted_scopes, webhook_status, webhook_error, connected_at, last_error")
      .eq("company_id", companyId)
      .maybeSingle();
    if (error) throw error;
    return safeConnection(data);
  }

  async function startOAuth({ companyId, userId, returnPath = "/calendar" }) {
    requireOAuthConfiguration();
    if (!UUID_RE.test(companyId) || !userId) {
      throw serviceError("invalid_oauth_context", "Contexte OAuth invalide.", 400);
    }
    const safeReturnPath = SAFE_RETURN_PATHS.has(returnPath) ? returnPath : "/calendar";
    const state = randomBase64Url(32);
    const stateHash = sha256Hex(state);
    const verifier = randomBase64Url(64);
    const encryptedVerifier = encryptCalendarSecret(verifier, `oauth-state:${stateHash}`);
    const { error } = await supabase.from("calendly_oauth_states").insert({
      state_hash: stateHash,
      company_id: companyId,
      initiated_by: userId,
      verifier_ciphertext: encryptedVerifier.ciphertext,
      verifier_iv: encryptedVerifier.iv,
      verifier_tag: encryptedVerifier.tag,
      return_path: safeReturnPath,
      expires_at: new Date(now().getTime() + 10 * 60 * 1000).toISOString(),
    });
    if (error) throw error;

    const authorizationUrl = new URL("https://auth.calendly.com/oauth/authorize");
    authorizationUrl.searchParams.set("client_id", process.env.CALENDLY_CLIENT_ID);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("redirect_uri", process.env.CALENDLY_REDIRECT_URI);
    authorizationUrl.searchParams.set("state", state);
    const requestedScopes = requestedCalendlyScopes();
    authorizationUrl.searchParams.set("scope", requestedScopes.join(" "));
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("code_challenge", pkceChallenge(verifier));
    return { authorization_url: authorizationUrl.toString() };
  }

  async function consumeOAuthState(state) {
    if (!state || state.length > 256) {
      throw serviceError("invalid_oauth_state", "État OAuth invalide ou expiré.", 400);
    }
    const stateHash = sha256Hex(state);
    const { data, error } = await supabase.rpc("consume_calendly_oauth_state", {
      p_state_hash: stateHash,
    });
    if (error) throw error;
    const row = data?.[0];
    if (!row) throw serviceError("invalid_oauth_state", "État OAuth invalide ou expiré.", 400);
    const verifier = decryptCalendarSecret({
      ciphertext: row.verifier_ciphertext,
      iv: row.verifier_iv,
      tag: row.verifier_tag,
    }, `oauth-state:${stateHash}`);
    return { ...row, verifier };
  }

  async function finishOAuth({ state, code }) {
    requireOAuthConfiguration();
    if (!code || String(code).length > 2048) {
      throw serviceError("oauth_code_missing", "Code OAuth Calendly manquant.", 400);
    }
    const oauthState = await consumeOAuthState(state);
    const tokens = await exchangeAuthorizationCode({
      fetchImpl,
      code: String(code),
      codeVerifier: oauthState.verifier,
    });
    const currentUserResponse = await getCurrentUser({
      fetchImpl,
      accessToken: tokens.access_token,
    });
    const user = currentUserResponse.resource || {};
    const userUri = user.uri || tokens.owner;
    const organizationUri = user.current_organization || tokens.organization;
    if (!userUri || !organizationUri) {
      throw serviceError(
        "calendly_identity_incomplete",
        "Calendly n’a pas retourné l’utilisateur et l’organisation attendus.",
        502
      );
    }

    const existing = await loadConnection(oauthState.company_id, { allowDisconnected: true }).catch(error => {
      if (error.code === "calendly_not_connected") return null;
      throw error;
    });
    const connectionId = existing?.id || randomUUID();
    if (existing?.webhook_subscription_uri) {
      try {
        await deleteWebhookSubscription({
          fetchImpl,
          accessToken: tokens.access_token,
          subscriptionUri: existing.webhook_subscription_uri,
        });
      } catch (error) {
        if (error?.code !== "calendly_not_found") {
          logger.warn?.("[calendar] Could not remove previous Calendly webhook", {
            company_id: oauthState.company_id,
            error_code: error?.code || "webhook_delete_failed",
          });
        }
      }
    }

    const accessToken = encryptCalendarSecret(tokens.access_token, `access:${oauthState.company_id}`);
    const refreshToken = encryptCalendarSecret(tokens.refresh_token, `refresh:${oauthState.company_id}`);
    const grantedScopes = String(tokens.scope || requestedCalendlyScopes().join(" "))
      .split(/[\s,]+/)
      .map(scope => scope.trim())
      .filter(Boolean);
    const expiresIn = Math.min(24 * 60 * 60, Math.max(60, Number(tokens.expires_in) || 7200));
    const baseConnection = {
      id: connectionId,
      company_id: oauthState.company_id,
      calendly_user_uri: userUri,
      calendly_organization_uri: organizationUri,
      calendly_user_name: cleanText(user.name, 300),
      calendly_user_email: normalizedEmail(user.email),
      granted_scopes: grantedScopes,
      ...encryptedColumns(accessToken, "access_token"),
      ...encryptedColumns(refreshToken, "refresh_token"),
      token_expires_at: new Date(now().getTime() + expiresIn * 1000).toISOString(),
      token_version: Number(existing?.token_version || 0) + 1,
      refresh_lock_token: null,
      refresh_locked_until: null,
      status: "connected",
      connected_by: oauthState.initiated_by,
      connected_at: now().toISOString(),
      disconnected_at: null,
      last_refreshed_at: now().toISOString(),
      last_error: null,
      webhook_status: "pending",
      webhook_error: null,
      updated_at: now().toISOString(),
    };
    const { data: connection, error: connectionError } = await supabase
      .from("calendly_connections")
      .upsert(baseConnection, { onConflict: "company_id" })
      .select("*")
      .single();
    if (connectionError) throw connectionError;

    let webhookStatus = "active";
    let webhookError = null;
    let webhookUri = null;
    try {
      const callbackUrl = new URL(`/webhooks/calendly/${connection.id}`, process.env.APP_PUBLIC_URL).toString();
      const created = await createWebhookSubscription({
        fetchImpl,
        accessToken: tokens.access_token,
        callbackUrl,
        organizationUri,
        userUri,
        scope: "user",
      });
      webhookUri = created.resource?.uri || null;
      if (!webhookUri) throw new Error("Calendly webhook response did not include a URI");
    } catch (error) {
      webhookStatus = "error";
      webhookError = cleanText(error?.message, 500) || "webhook_subscription_failed";
      logger.error?.("[calendar] Calendly webhook subscription failed", {
        company_id: oauthState.company_id,
        error_code: error?.code || "webhook_subscription_failed",
      });
    }

    const { data: updated, error: webhookUpdateError } = await supabase
      .from("calendly_connections")
      .update({
        webhook_subscription_uri: webhookUri,
        webhook_status: webhookStatus,
        webhook_error: webhookError,
        updated_at: now().toISOString(),
      })
      .eq("id", connection.id)
      .select("id, status, calendly_user_name, calendly_user_email, default_event_type_uri, granted_scopes, webhook_status, webhook_error, connected_at, last_error")
      .single();
    if (webhookUpdateError) throw webhookUpdateError;
    return { connection: safeConnection(updated), return_path: oauthState.return_path };
  }

  async function getValidAccessToken(companyId, { forceRefresh = false } = {}) {
    let connection = await loadConnection(companyId);
    const expiresAt = validDate(connection.token_expires_at)?.getTime() || 0;
    if (!forceRefresh && expiresAt > now().getTime() + 2 * 60 * 1000) {
      return {
        connection,
        accessToken: decryptCalendarSecret(
          fromEncryptedColumns(connection, "access_token"),
          `access:${companyId}`
        ),
      };
    }

    const lockToken = randomUUID();
    const { data: claimed, error: claimError } = await supabase.rpc("claim_calendly_token_refresh", {
      p_company_id: companyId,
      p_lock_token: lockToken,
      p_lease_seconds: 30,
    });
    if (claimError) throw claimError;
    connection = claimed?.[0];

    if (!connection) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 200));
        const latest = await loadConnection(companyId);
        const latestExpiry = validDate(latest.token_expires_at)?.getTime() || 0;
        if (latestExpiry > now().getTime() + 60 * 1000) {
          return {
            connection: latest,
            accessToken: decryptCalendarSecret(
              fromEncryptedColumns(latest, "access_token"),
              `access:${companyId}`
            ),
          };
        }
      }
      throw serviceError(
        "calendly_refresh_busy",
        "La connexion Calendly est en cours de renouvellement. Réessayez dans quelques secondes.",
        503
      );
    }

    let refreshedAccessToken = null;
    try {
      const currentRefreshToken = decryptCalendarSecret(
        fromEncryptedColumns(connection, "refresh_token"),
        `refresh:${companyId}`
      );
      const tokens = await refreshAccessToken({ fetchImpl, refreshToken: currentRefreshToken });
      refreshedAccessToken = tokens.access_token;
      const nextAccessToken = encryptCalendarSecret(tokens.access_token, `access:${companyId}`);
      const nextRefreshToken = encryptCalendarSecret(tokens.refresh_token, `refresh:${companyId}`);
      const expiresIn = Math.min(24 * 60 * 60, Math.max(60, Number(tokens.expires_in) || 7200));
      const scopes = String(tokens.scope || "")
        .split(/[\s,]+/)
        .map(scope => scope.trim())
        .filter(Boolean);
      const accessColumns = encryptedColumns(nextAccessToken, "access_token");
      const refreshColumns = encryptedColumns(nextRefreshToken, "refresh_token");
      const { data: completed, error: completeError } = await supabase.rpc(
        "complete_calendly_token_refresh",
        {
          p_company_id: companyId,
          p_lock_token: lockToken,
          p_access_token_ciphertext: accessColumns.access_token_ciphertext,
          p_access_token_iv: accessColumns.access_token_iv,
          p_access_token_tag: accessColumns.access_token_tag,
          p_refresh_token_ciphertext: refreshColumns.refresh_token_ciphertext,
          p_refresh_token_iv: refreshColumns.refresh_token_iv,
          p_refresh_token_tag: refreshColumns.refresh_token_tag,
          p_token_expires_at: new Date(now().getTime() + expiresIn * 1000).toISOString(),
          p_granted_scopes: scopes,
        }
      );
      if (completeError) throw completeError;
      const refreshed = completed?.[0];
      if (!refreshed) {
        const error = new Error("Calendly token refresh lease was lost");
        error.code = "calendly_refresh_commit_lost";
        throw error;
      }
      return { connection: refreshed, accessToken: tokens.access_token };
    } catch (error) {
      // Calendly refresh tokens are single-use. Once a refresh attempt fails or
      // its result cannot be committed atomically, replaying the old token can
      // create a race or silently lose the rotated token. Quarantine the
      // connection and require a fresh OAuth consent instead.
      const reason = cleanText(error?.code || error?.message, 500) || "oauth_refresh_uncertain";
      const { data: invalidated, error: invalidateError } = await supabase.rpc(
        "invalidate_calendly_token_refresh",
        {
          p_company_id: companyId,
          p_lock_token: lockToken,
          p_reason: reason,
        }
      );
      if (invalidateError) {
        logger.error?.("[calendar] Could not quarantine failed Calendly refresh", {
          company_id: companyId,
          error_code: invalidateError.code || "refresh_quarantine_failed",
        });
      }
      if (!invalidateError && invalidated === false && refreshedAccessToken) {
        const latest = await loadConnection(companyId);
        if (Number(latest.token_version || 0) > Number(connection.token_version || 0)) {
          return { connection: latest, accessToken: refreshedAccessToken };
        }
      }
      throw serviceError(
        "calendly_reconnect_required",
        "La connexion Calendly doit être autorisée de nouveau.",
        409
      );
    }
  }

  async function eventTypes(companyId) {
    const { connection, accessToken } = await getValidAccessToken(companyId);
    const response = await listEventTypes({
      fetchImpl,
      accessToken,
      userUri: connection.calendly_user_uri,
    });
    return (response.collection || []).map(item => ({
      uri: item.uri,
      name: item.name,
      active: item.active,
      duration: item.duration,
      color: item.color,
      scheduling_url: item.scheduling_url,
      locations: item.locations || [],
    }));
  }

  async function setDefaultEventType(companyId, eventTypeUri) {
    const types = await eventTypes(companyId);
    if (!types.some(item => item.uri === eventTypeUri && item.active !== false)) {
      throw serviceError(
        "event_type_not_available",
        "Ce type de rendez-vous n’appartient pas au compte Calendly connecté.",
        400
      );
    }
    const { error } = await supabase
      .from("calendly_connections")
      .update({ default_event_type_uri: eventTypeUri, updated_at: now().toISOString() })
      .eq("company_id", companyId)
      .eq("status", "connected");
    if (error) throw error;
    return { default_event_type_uri: eventTypeUri };
  }

  async function availability(companyId, { eventTypeUri, startTime, endTime }) {
    const { connection, accessToken } = await getValidAccessToken(companyId);
    const selectedType = eventTypeUri || connection.default_event_type_uri;
    if (!selectedType) {
      throw serviceError(
        "default_event_type_required",
        "Choisissez d’abord un type de rendez-vous Calendly.",
        409
      );
    }
    const start = validDate(startTime) || now();
    const end = validDate(endTime) || new Date(start.getTime() + 7 * 86400000);
    if (end <= start || end.getTime() - start.getTime() > MAX_AVAILABILITY_DAYS * 86400000) {
      throw serviceError(
        "invalid_availability_range",
        "La plage de disponibilité doit être positive et ne pas dépasser 31 jours.",
        400
      );
    }
    const allowedTypes = await eventTypes(companyId);
    if (!allowedTypes.some(item => item.uri === selectedType)) {
      throw serviceError("event_type_not_available", "Type de rendez-vous invalide.", 400);
    }
    const response = await listAvailableTimes({
      fetchImpl,
      accessToken,
      eventTypeUri: selectedType,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
    });
    return {
      event_type_uri: selectedType,
      slots: (response.collection || []).map(slot => ({
        start_time: slot.start_time,
        status: slot.status,
        invitees_remaining: slot.invitees_remaining,
        scheduling_url: slot.scheduling_url,
      })),
    };
  }

  async function resolveContact(companyId, { contactId, phone, email }) {
    if (contactId) {
      const { data, error } = await supabase
        .from("contacts")
        .select("id, company_id, full_name, email, phone, company, status, anonymized_at")
        .eq("id", contactId)
        .eq("company_id", companyId)
        .maybeSingle();
      if (error) throw error;
      if (!data || data.anonymized_at || data.status === "anonymized") {
        throw serviceError("contact_not_found", "Contact introuvable.", 404);
      }
      return { contact: data, match: "explicit" };
    }

    const normalized = normalizedPhone(phone);
    if (normalized) {
      const { data, error } = await supabase
        .from("contacts")
        .select("id, company_id, full_name, email, phone, company, status, anonymized_at")
        .eq("company_id", companyId)
        .eq("phone", normalized)
        .is("anonymized_at", null)
        .neq("status", "anonymized")
        .limit(2);
      if (error) throw error;
      if (data?.length === 1) return { contact: data[0], match: "phone" };
      if (data?.length > 1) return { contact: null, match: "ambiguous" };
    }

    const normalizedAddress = normalizedEmail(email);
    if (normalizedAddress) {
      const { data, error } = await supabase
        .from("contacts")
        .select("id, company_id, full_name, email, phone, company, status, anonymized_at")
        .eq("company_id", companyId)
        .eq("email", normalizedAddress)
        .is("anonymized_at", null)
        .neq("status", "anonymized")
        .limit(2);
      if (error) throw error;
      if (data?.length === 1) return { contact: data[0], match: "email" };
      if (data?.length > 1) return { contact: null, match: "ambiguous" };
    }
    return { contact: null, match: "unmatched" };
  }

  async function queueAppointmentEmails(appointment, { name, email }) {
    const recipient = normalizedEmail(email);
    const startAt = validDate(appointment.start_at);
    if (!recipient || !startAt || appointment.status === "cancelled") return;
    const payload = {
      type: appointment.type,
      start_at: appointment.start_at,
      end_at: appointment.end_at,
      timezone: appointment.timezone,
      channel: appointment.channel,
      meet_link: appointment.meet_link,
      cancel_url: appointment.calendly_cancel_url,
      reschedule_url: appointment.calendly_reschedule_url,
    };
    const rows = [{
      company_id: appointment.company_id,
      appointment_id: appointment.id,
      email_kind: "confirmation",
      recipient_email: recipient,
      recipient_name: cleanText(name, 300),
      payload,
      due_at: now().toISOString(),
      next_attempt_at: now().toISOString(),
    }];
    const reminderAt = new Date(startAt.getTime() - 24 * 60 * 60 * 1000);
    if (startAt.getTime() - now().getTime() >= 2 * 60 * 60 * 1000) {
      const dueAt = reminderAt > now() ? reminderAt : now();
      rows.push({
        company_id: appointment.company_id,
        appointment_id: appointment.id,
        email_kind: "reminder",
        recipient_email: recipient,
        recipient_name: cleanText(name, 300),
        payload,
        due_at: dueAt.toISOString(),
        next_attempt_at: dueAt.toISOString(),
      });
    }
    const { error } = await supabase
      .from("calendar_email_outbox")
      .upsert(rows, { onConflict: "appointment_id,email_kind", ignoreDuplicates: true });
    if (error) throw error;
  }

  async function recordCrmEffects(appointment, contact, { isNewAppointment }) {
    if (!contact?.id) return;
    const update = {
      last_interaction_at: now().toISOString(),
      next_action: `Rendez-vous confirmé le ${appointment.date}${appointment.time ? ` à ${String(appointment.time).slice(0, 5)}` : ""}`,
      next_action_note: `Rendez-vous confirmé le ${appointment.date}${appointment.time ? ` à ${String(appointment.time).slice(0, 5)}` : ""}`,
      next_action_date: appointment.start_at,
      updated_at: now().toISOString(),
      ...(contact.status === "new" ? { status: "qualified" } : {}),
    };
    const { error: contactError } = await supabase
      .from("contacts")
      .update(update)
      .eq("id", contact.id)
      .eq("company_id", appointment.company_id);
    if (contactError) throw contactError;

    if (isNewAppointment) {
      const { error: noteError } = await supabase.from("contact_notes").insert({
        company_id: appointment.company_id,
        contact_id: contact.id,
        direction: "inbound",
        note: `Rendez-vous Calendly confirmé : ${appointment.type || "Rendez-vous"} le ${appointment.date}${appointment.time ? ` à ${String(appointment.time).slice(0, 5)}` : ""}.`,
        created_by: "calendly_sync",
      });
      if (noteError) throw noteError;
    }
  }

  async function upsertAppointment({
    companyId,
    connectionId,
    contactResolution,
    invitee,
    scheduledEvent,
    eventTypeUri,
    source = "calendly",
  }) {
    const start = validDate(scheduledEvent.start_time || invitee.start_time);
    if (!start) throw serviceError("calendly_event_time_missing", "Heure du rendez-vous manquante.", 502);
    const end = validDate(scheduledEvent.end_time);
    const timezone = invitee.timezone || scheduledEvent.timezone || "America/Toronto";
    const legacy = dateAndTimeInZone(start, timezone);
    const providerEventUri = eventUri(invitee.event) || scheduledEvent.uri;
    const inviteeUri = invitee.uri;
    if (!providerEventUri || !inviteeUri) {
      throw serviceError("calendly_event_identity_missing", "Identifiant Calendly incomplet.", 502);
    }
    const { channel, meetLink } = locationDetails(scheduledEvent.location);
    const { data: existing, error: existingError } = await supabase
      .from("appointments")
      .select("id")
      .eq("company_id", companyId)
      .eq("calendly_invitee_uri", inviteeUri)
      .maybeSingle();
    if (existingError) throw existingError;

    const appointmentPayload = {
      company_id: companyId,
      contact_id: contactResolution.contact?.id || null,
      calendly_connection_id: connectionId,
      calendly_event_id: providerEventUri,
      calendly_event_uri: providerEventUri,
      calendly_invitee_uri: inviteeUri,
      calendly_event_type_uri: eventTypeUri || eventUri(scheduledEvent.event_type),
      calendly_cancel_url: invitee.cancel_url || null,
      calendly_reschedule_url: invitee.reschedule_url || null,
      start_at: start.toISOString(),
      end_at: end?.toISOString() || null,
      timezone,
      date: legacy.date,
      time: legacy.time,
      duration_minutes: end ? Math.max(1, Math.round((end - start) / 60000)) : null,
      type: scheduledEvent.name || "Rendez-vous",
      channel,
      meet_link: meetLink,
      status: "confirmed",
      source,
      source_direction: "inbound",
      notes: formatQuestions(invitee.questions_and_answers || []),
      invitee_name: cleanText(invitee.name, 300),
      invitee_email: normalizedEmail(invitee.email),
      invitee_phone: normalizedPhone(invitee.text_reminder_number)
        || extractQuestionPhone(invitee.questions_and_answers || []),
      contact_match_status: contactResolution.match,
      reminder_due_at: new Date(start.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      provider_updated_at: validDate(invitee.updated_at || scheduledEvent.updated_at)?.toISOString() || now().toISOString(),
      updated_at: now().toISOString(),
    };
    const { data: appointment, error } = await supabase
      .from("appointments")
      .upsert(appointmentPayload, { onConflict: "company_id,calendly_invitee_uri" })
      .select("*")
      .single();
    if (error) throw error;

    await recordCrmEffects(appointment, contactResolution.contact, {
      isNewAppointment: !existing,
    });
    await queueAppointmentEmails(appointment, {
      name: invitee.name,
      email: invitee.email,
    });
    return appointment;
  }

  async function book(companyId, actorUserId, input) {
    if (input.confirmed !== true) {
      throw serviceError(
        "explicit_confirmation_required",
        "La personne doit confirmer explicitement le créneau avant la réservation.",
        400
      );
    }
    const idempotencyKey = cleanText(input.idempotency_key, 128);
    if (!idempotencyKey || idempotencyKey.length < 8) {
      throw serviceError("idempotency_key_required", "Clé d’idempotence invalide.", 400);
    }
    const start = validDate(input.start_time);
    if (!start || start <= now() || start.getTime() > now().getTime() + MAX_AVAILABILITY_DAYS * 86400000) {
      throw serviceError("invalid_start_time", "Le créneau doit être futur et dans les 31 prochains jours.", 400);
    }
    const timezone = cleanText(input.timezone, 100) || "America/Toronto";
    if (!isValidTimeZone(timezone)) throw serviceError("invalid_timezone", "Fuseau horaire invalide.", 400);

    const { data: prior, error: priorError } = await supabase
      .from("calendar_booking_requests")
      .select("*")
      .eq("company_id", companyId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (priorError) throw priorError;
    if (prior) {
      if (prior.status === "committed") {
        const { data: priorAppointment, error: appointmentError } = await supabase
          .from("appointments")
          .select("*")
          .eq("id", prior.appointment_id)
          .eq("company_id", companyId)
          .maybeSingle();
        if (appointmentError) throw appointmentError;
        if (!priorAppointment) {
          throw serviceError(
            "booking_requires_reconciliation",
            "Le rendez-vous Calendly existe mais son dossier local doit être vérifié.",
            409
          );
        }
        return { reused: true, appointment: priorAppointment };
      }
      if (["dispatching", "reconciliation_required", "provider_succeeded"].includes(prior.status)) {
        throw serviceError(
          "booking_requires_reconciliation",
          "Calendly a peut-être créé ce rendez-vous. Vérification manuelle requise avant de réessayer.",
          409
        );
      }
      throw serviceError("booking_request_already_used", "Cette demande de réservation a déjà été utilisée.", 409);
    }

    const connection = await loadConnection(companyId);
    const selectedEventType = input.event_type_uri || connection.default_event_type_uri;
    if (!selectedEventType) {
      throw serviceError("default_event_type_required", "Choisissez un type de rendez-vous.", 409);
    }
    const types = await eventTypes(companyId);
    const eventType = types.find(item => item.uri === selectedEventType);
    if (!eventType) throw serviceError("event_type_not_available", "Type de rendez-vous invalide.", 400);

    const contactResolution = await resolveContact(companyId, {
      contactId: input.contact_id,
      phone: input.phone,
      email: input.email,
    });
    const inviteeName = cleanText(input.name, 300) || contactResolution.contact?.full_name;
    const inviteeEmail = normalizedEmail(input.email || contactResolution.contact?.email);
    const inviteePhone = normalizedPhone(input.phone || contactResolution.contact?.phone);
    if (!inviteeName || !inviteeEmail) {
      throw serviceError("invitee_identity_required", "Le nom et le courriel du client sont requis.", 400);
    }

    const { connection: tokenConnection, accessToken } = await getValidAccessToken(companyId);
    const slots = await listAvailableTimes({
      fetchImpl,
      accessToken,
      eventTypeUri: selectedEventType,
      startTime: new Date(start.getTime() - 60_000).toISOString(),
      endTime: new Date(start.getTime() + 60 * 60 * 1000).toISOString(),
    });
    if (!(slots.collection || []).some(slot => validDate(slot.start_time)?.getTime() === start.getTime())) {
      throw serviceError(
        "slot_no_longer_available",
        "Ce créneau n’est plus disponible. Actualisez les disponibilités.",
        409
      );
    }

    const { data: insertedRequest, error: requestError } = await supabase
      .from("calendar_booking_requests")
      .insert({
        company_id: companyId,
        connection_id: tokenConnection.id,
        contact_id: contactResolution.contact?.id || null,
        idempotency_key: idempotencyKey,
        event_type_uri: selectedEventType,
        requested_start_at: start.toISOString(),
        invitee_name: inviteeName,
        invitee_email: inviteeEmail,
        invitee_phone: inviteePhone,
        invitee_timezone: timezone,
        created_by: actorUserId,
      })
      .select("*")
      .single();
    if (requestError) {
      if (requestError.code === "23505") {
        throw serviceError("booking_request_already_used", "Cette demande existe déjà.", 409);
      }
      throw requestError;
    }

    const dispatchToken = randomUUID();
    const { data: claimedRequests, error: dispatchError } = await supabase.rpc(
      "claim_calendar_booking_dispatch",
      {
        p_company_id: companyId,
        p_request_id: insertedRequest.id,
        p_dispatch_token: dispatchToken,
      }
    );
    if (dispatchError) throw dispatchError;
    const request = claimedRequests?.[0];
    if (!request) {
      throw serviceError(
        "booking_requires_reconciliation",
        "La réservation est déjà en cours ou doit être vérifiée.",
        409
      );
    }

    const selectedLocation = input.location
      || (eventType.locations?.length === 1
        ? {
            kind: eventType.locations[0].kind,
            ...(eventType.locations[0].location ? { location: eventType.locations[0].location } : {}),
          }
        : null);
    const booking = {
      event_type: selectedEventType,
      start_time: start.toISOString(),
      invitee: {
        name: inviteeName,
        email: inviteeEmail,
        timezone,
        ...(inviteePhone ? { text_reminder_number: inviteePhone } : {}),
      },
      tracking: {
        utm_source: "voicedesk",
        utm_campaign: "assistant_booking",
        utm_content: request.id,
      },
      ...(selectedLocation?.kind ? { location: selectedLocation } : {}),
    };

    let inviteeResponse;
    try {
      inviteeResponse = await createInvitee({ fetchImpl, accessToken, booking });
    } catch (rawError) {
      const error = providerErrorForClient(rawError);
      const ambiguous = error?.code === "calendly_timeout" || error?.code === "calendly_network_error";
      await supabase
        .from("calendar_booking_requests")
        .update({
          status: ambiguous ? "reconciliation_required" : "failed",
          last_error: cleanText(error?.code || error?.message, 500),
          updated_at: now().toISOString(),
        })
        .eq("id", request.id)
        .eq("company_id", companyId)
        .eq("dispatch_token", dispatchToken);
      throw ambiguous
        ? serviceError(
            "booking_requires_reconciliation",
            "La réponse Calendly est incertaine. Vérification requise avant toute nouvelle tentative.",
            409
          )
        : error;
    }

    const invitee = inviteeResponse.resource || {};
    const providerEventUri = eventUri(invitee.event);
    const providerInviteeUri = invitee.uri;
    if (!providerEventUri || !providerInviteeUri) {
      await supabase
        .from("calendar_booking_requests")
        .update({
          status: "reconciliation_required",
          last_error: "calendly_booking_response_incomplete",
          updated_at: now().toISOString(),
        })
        .eq("id", request.id)
        .eq("company_id", companyId)
        .eq("dispatch_token", dispatchToken);
      throw serviceError(
        "booking_requires_reconciliation",
        "Calendly a accepté la demande mais sa réponse doit être vérifiée.",
        409
      );
    }
    const { data: providerCommitted, error: providerCommitError } = await supabase
      .from("calendar_booking_requests")
      .update({
        status: "provider_succeeded",
        provider_event_uri: providerEventUri,
        provider_invitee_uri: providerInviteeUri,
        provider_response: sanitizeProviderResponse(invitee),
        updated_at: now().toISOString(),
      })
      .eq("id", request.id)
      .eq("company_id", companyId)
      .eq("dispatch_token", dispatchToken)
      .eq("status", "dispatching")
      .select("id")
      .maybeSingle();
    if (providerCommitError || !providerCommitted) {
      throw serviceError(
        "booking_requires_reconciliation",
        "Le rendez-vous existe chez Calendly mais sa confirmation locale est incertaine.",
        409
      );
    }

    try {
      const eventResponse = await getScheduledEvent({
        fetchImpl,
        accessToken,
        eventUri: providerEventUri,
      });
      const appointment = await upsertAppointment({
        companyId,
        connectionId: tokenConnection.id,
        contactResolution,
        invitee: {
          ...invitee,
          name: invitee.name || inviteeName,
          email: invitee.email || inviteeEmail,
          text_reminder_number: invitee.text_reminder_number || inviteePhone,
          timezone: invitee.timezone || timezone,
          start_time: start.toISOString(),
        },
        scheduledEvent: eventResponse.resource || {
          uri: providerEventUri,
          start_time: start.toISOString(),
          end_time: new Date(start.getTime() + (eventType.duration || 30) * 60000).toISOString(),
          name: eventType.name,
          event_type: selectedEventType,
        },
        eventTypeUri: selectedEventType,
        source: "voicedesk_assistant",
      });
      const { data: committedRequest, error: commitError } = await supabase
        .from("calendar_booking_requests")
        .update({
          status: "committed",
          appointment_id: appointment.id,
          last_error: null,
          updated_at: now().toISOString(),
        })
        .eq("id", request.id)
        .eq("company_id", companyId)
        .eq("dispatch_token", dispatchToken)
        .eq("status", "provider_succeeded")
        .select("id")
        .maybeSingle();
      if (commitError) throw commitError;
      if (!committedRequest) throw new Error("Calendar booking commit transition was lost");
      return { reused: false, appointment };
    } catch (error) {
      await supabase
        .from("calendar_booking_requests")
        .update({
          status: "reconciliation_required",
          last_error: cleanText(error?.code || error?.message, 500),
          updated_at: now().toISOString(),
        })
        .eq("id", request.id)
        .eq("company_id", companyId)
        .eq("dispatch_token", dispatchToken);
      throw serviceError(
        "booking_requires_reconciliation",
        "Le rendez-vous existe chez Calendly mais sa synchronisation locale doit être vérifiée.",
        409
      );
    }
  }

  async function appointments(companyId, filters = {}) {
    let query = supabase
      .from("appointments")
      .select("*, contacts(full_name, email, phone, company)")
      .eq("company_id", companyId);
    if (filters.from_date) query = query.gte("date", filters.from_date);
    if (filters.to_date) query = query.lte("date", filters.to_date);
    if (filters.status) query = query.eq("status", filters.status);
    const { data, error } = await query
      .order("start_at", { ascending: true, nullsFirst: false })
      .order("date", { ascending: true });
    if (error) throw error;
    return data || [];
  }

  async function updateAppointment(companyId, appointmentId, input) {
    const { data: appointment, error } = await supabase
      .from("appointments")
      .select("*")
      .eq("id", appointmentId)
      .eq("company_id", companyId)
      .maybeSingle();
    if (error) throw error;
    if (!appointment) throw serviceError("appointment_not_found", "Rendez-vous introuvable.", 404);
    const action = input.action || "notes";

    if (action === "reschedule") {
      if (!appointment.calendly_reschedule_url) {
        throw serviceError("reschedule_unavailable", "Lien de replanification indisponible.", 409);
      }
      throw serviceError(
        "provider_reschedule_required",
        "Calendly ne propose pas d’API de replanification directe. Utilisez le lien sécurisé.",
        409,
        { reschedule_url: appointment.calendly_reschedule_url }
      );
    }

    const update = { updated_at: now().toISOString() };
    if (input.notes !== undefined) update.notes = cleanText(input.notes, 5000);
    if (action === "complete") update.status = "completed";
    if (action === "cancel") {
      if (!appointment.calendly_event_uri) {
        throw serviceError("provider_event_missing", "Identifiant Calendly manquant.", 409);
      }
      const { accessToken } = await getValidAccessToken(companyId);
      await cancelScheduledEvent({
        fetchImpl,
        accessToken,
        eventUri: appointment.calendly_event_uri,
      });
      update.status = "cancelled";
      update.cancelled_at = now().toISOString();
      update.cancellation_reason = cleanText(input.reason, 500) || "Annulé depuis VoiceDesk";
      await supabase
        .from("calendar_email_outbox")
        .update({ status: "cancelled", updated_at: now().toISOString() })
        .eq("appointment_id", appointment.id)
        .eq("email_kind", "reminder")
        .in("status", ["pending", "retry_scheduled"]);
    }
    const { data: updated, error: updateError } = await supabase
      .from("appointments")
      .update(update)
      .eq("id", appointment.id)
      .eq("company_id", companyId)
      .select("*")
      .single();
    if (updateError) throw updateError;
    return updated;
  }

  async function disconnect(companyId) {
    const connection = await loadConnection(companyId, { allowDisconnected: true });
    if (connection.status === "connected" && connection.webhook_subscription_uri) {
      try {
        const { accessToken } = await getValidAccessToken(companyId);
        await deleteWebhookSubscription({
          fetchImpl,
          accessToken,
          subscriptionUri: connection.webhook_subscription_uri,
        });
      } catch (error) {
        logger.warn?.("[calendar] Calendly webhook removal failed during disconnect", {
          company_id: companyId,
          error_code: error?.code || "webhook_delete_failed",
        });
      }
    }
    const { error } = await supabase
      .from("calendly_connections")
      .update({
        status: "disconnected",
        webhook_status: "disabled",
        webhook_subscription_uri: null,
        access_token_ciphertext: null,
        access_token_iv: null,
        access_token_tag: null,
        refresh_token_ciphertext: null,
        refresh_token_iv: null,
        refresh_token_tag: null,
        token_expires_at: null,
        refresh_lock_token: null,
        refresh_locked_until: null,
        disconnected_at: now().toISOString(),
        updated_at: now().toISOString(),
      })
      .eq("company_id", companyId);
    if (error) throw error;
    return { connected: false, status: "disconnected" };
  }

  async function enqueueWebhook({ connectionId, payload, rawBody, signatureTimestamp }) {
    if (!UUID_RE.test(connectionId)) {
      throw serviceError("invalid_calendly_connection", "Connexion Calendly invalide.", 404);
    }
    const { data: connection, error: connectionError } = await supabase
      .from("calendly_connections")
      .select("id, company_id, status, calendly_user_uri")
      .eq("id", connectionId)
      .eq("status", "connected")
      .maybeSingle();
    if (connectionError) throw connectionError;
    if (!connection) throw serviceError("calendly_connection_not_found", "Connexion Calendly introuvable.", 404);
    const eventType = cleanText(payload?.event, 100);
    const inviteeUri = cleanText(payload?.payload?.uri, 1000);
    if (!eventType || !inviteeUri || !["invitee.created", "invitee.canceled"].includes(eventType)) {
      throw serviceError("invalid_calendly_webhook", "Événement Calendly invalide.", 400);
    }
    if (payload?.created_by && payload.created_by !== connection.calendly_user_uri) {
      throw serviceError("calendly_webhook_owner_mismatch", "Émetteur Calendly invalide.", 403);
    }
    const eventKey = sha256Hex(`${connectionId}:${eventType}:${inviteeUri}`);
    const { data, error } = await supabase
      .from("calendly_webhook_events")
      .upsert({
        connection_id: connection.id,
        company_id: connection.company_id,
        event_key: eventKey,
        event_type: eventType,
        payload,
        signature_timestamp: Number.isInteger(signatureTimestamp) ? signatureTimestamp : null,
      }, { onConflict: "connection_id,event_key", ignoreDuplicates: true })
      .select("id, status")
      .maybeSingle();
    if (error) throw error;
    return { duplicate: !data, event_id: data?.id || null };
  }

  async function processWebhookEvent(row) {
    const envelope = row.payload || {};
    const type = envelope.event;
    const invitee = envelope.payload || {};
    const scheduledEvent = invitee.scheduled_event || {};
    if (!type || !["invitee.created", "invitee.canceled"].includes(type)) {
      return { ignored: true, reason: "unsupported_event" };
    }

    if (type === "invitee.canceled") {
      const inviteeUri = invitee.uri;
      const providerEventUri = eventUri(invitee.event) || scheduledEvent.uri;
      if (!inviteeUri && !providerEventUri) {
        return { ignored: true, reason: "provider_identity_missing" };
      }
      let query = supabase
        .from("appointments")
        .update({
          status: "cancelled",
          cancelled_at: validDate(invitee.canceled_at)?.toISOString() || now().toISOString(),
          cancellation_reason: cleanText(invitee.cancellation?.reason, 500),
          provider_updated_at: validDate(invitee.updated_at)?.toISOString() || now().toISOString(),
          updated_at: now().toISOString(),
        })
        .eq("company_id", row.company_id);
      query = inviteeUri
        ? query.eq("calendly_invitee_uri", inviteeUri)
        : query.eq("calendly_event_uri", providerEventUri);
      const { data: canceled, error } = await query.select("id");
      if (error) throw error;
      for (const appointment of canceled || []) {
        await supabase
          .from("calendar_email_outbox")
          .update({ status: "cancelled", updated_at: now().toISOString() })
          .eq("appointment_id", appointment.id)
          .eq("email_kind", "reminder")
          .in("status", ["pending", "retry_scheduled"]);
      }
      return { ignored: false, canceled: canceled?.length || 0 };
    }

    const phone = normalizedPhone(invitee.text_reminder_number)
      || extractQuestionPhone(invitee.questions_and_answers || []);
    const contactResolution = await resolveContact(row.company_id, {
      phone,
      email: invitee.email,
    });
    const appointment = await upsertAppointment({
      companyId: row.company_id,
      connectionId: row.connection_id,
      contactResolution,
      invitee,
      scheduledEvent,
      eventTypeUri: eventUri(scheduledEvent.event_type),
      source: "calendly_webhook",
    });
    return { ignored: false, appointment_id: appointment.id };
  }

  async function sendEmailOutbox(row) {
    if (!resend || !process.env.RESEND_API_KEY) {
      throw serviceError("resend_not_configured", "RESEND_API_KEY manquante.", 503);
    }
    const payload = row.payload || {};
    const start = validDate(payload.start_at);
    const zone = isValidTimeZone(payload.timezone) ? payload.timezone : "America/Toronto";
    const formatted = start?.toLocaleString("fr-CA", {
      timeZone: zone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }) || "à confirmer";
    const escapeHtml = value => String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
    const isReminder = row.email_kind === "reminder";
    const title = isReminder ? "Rappel de votre rendez-vous" : "Votre rendez-vous est confirmé";
    const links = [
      payload.meet_link ? `<p><a href="${escapeHtml(payload.meet_link)}">Rejoindre le rendez-vous</a></p>` : "",
      payload.reschedule_url ? `<a href="${escapeHtml(payload.reschedule_url)}">Modifier</a>` : "",
      payload.cancel_url ? `<a href="${escapeHtml(payload.cancel_url)}">Annuler</a>` : "",
    ].filter(Boolean).join(" &nbsp; ");
    const result = await resend.emails.send({
      from: process.env.EMAIL_FROM || "VoiceDesk <bonjour@voicedesk.ca>",
      to: row.recipient_email,
      subject: `${isReminder ? "Rappel — " : "Confirmation — "}${payload.type || "Rendez-vous"}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#1f2937">
        <h1 style="font-size:22px">${title}</h1>
        <p>Bonjour ${escapeHtml(row.recipient_name || "")},</p>
        <p><strong>${escapeHtml(payload.type || "Rendez-vous")}</strong><br>${escapeHtml(formatted)}<br>${escapeHtml(payload.channel || "")}</p>
        ${links}
        <p style="color:#64748b;font-size:12px">Message transactionnel envoyé par VoiceDesk AI.</p>
      </div>`,
    });
    if (result?.error) throw new Error(result.error.message || "Resend rejected the email");
    return result?.data?.id || result?.id || null;
  }

  async function deleteInviteeData(companyId, externalId) {
    const prefix = `${companyId}:`;
    if (!externalId?.startsWith(prefix)) {
      throw serviceError("invalid_calendly_privacy_target", "Cible Calendly invalide.", 400);
    }
    const email = normalizedEmail(externalId.slice(prefix.length));
    if (!email) {
      throw serviceError("invalid_calendly_privacy_target", "Courriel Calendly invalide.", 400);
    }
    const { connection, accessToken } = await getValidAccessToken(companyId);
    if (!(connection.granted_scopes || []).includes("data_compliance:write")) {
      throw serviceError(
        "calendly_data_compliance_scope_required",
        "La reconnexion Calendly avec l’autorisation de conformité est requise.",
        409
      );
    }
    await requestInviteeDataDeletion({ fetchImpl, accessToken, emails: [email] });
    return { accepted: true };
  }

  async function completeWebhook(row, result) {
    const { error } = await supabase
      .from("calendly_webhook_events")
      .update({
        status: result?.ignored ? "ignored" : "completed",
        processed_at: now().toISOString(),
        claimed_by: null,
        claimed_at: null,
        lease_expires_at: null,
        last_error: result?.reason || null,
        updated_at: now().toISOString(),
      })
      .eq("id", row.id)
      .eq("status", "processing")
      .eq("claimed_by", row.claimed_by);
    if (error) throw error;
  }

  async function failWebhook(row, error) {
    const terminal = row.attempts >= 8;
    await supabase
      .from("calendly_webhook_events")
      .update({
        status: terminal ? "failed" : "retry_scheduled",
        next_attempt_at: retryAt(row.attempts, now().getTime()),
        claimed_by: null,
        claimed_at: null,
        lease_expires_at: null,
        last_error: cleanText(error?.code || error?.message, 1000),
        updated_at: now().toISOString(),
      })
      .eq("id", row.id)
      .eq("claimed_by", row.claimed_by);
  }

  async function completeEmail(row, providerMessageId) {
    const { error } = await supabase
      .from("calendar_email_outbox")
      .update({
        status: "sent",
        provider_message_id: providerMessageId,
        sent_at: now().toISOString(),
        claimed_by: null,
        claimed_at: null,
        lease_expires_at: null,
        last_error: null,
        updated_at: now().toISOString(),
      })
      .eq("id", row.id)
      .eq("status", "processing")
      .eq("claimed_by", row.claimed_by);
    if (error) throw error;
    const appointmentUpdate = row.email_kind === "confirmation"
      ? { confirmation_sent: true, confirmation_sent_at: now().toISOString(), updated_at: now().toISOString() }
      : { reminder_sent_at: now().toISOString(), updated_at: now().toISOString() };
    await supabase
      .from("appointments")
      .update(appointmentUpdate)
      .eq("id", row.appointment_id)
      .eq("company_id", row.company_id);
  }

  async function failEmail(row, error) {
    const terminal = row.attempts >= 8 || error?.code === "resend_not_configured";
    await supabase
      .from("calendar_email_outbox")
      .update({
        status: terminal ? "failed" : "retry_scheduled",
        next_attempt_at: retryAt(row.attempts, now().getTime()),
        claimed_by: null,
        claimed_at: null,
        lease_expires_at: null,
        last_error: cleanText(error?.code || error?.message, 1000),
        updated_at: now().toISOString(),
      })
      .eq("id", row.id)
      .eq("claimed_by", row.claimed_by);
  }

  return {
    appointments,
    availability,
    book,
    completeEmail,
    completeWebhook,
    deleteInviteeData,
    disconnect,
    enqueueWebhook,
    eventTypes,
    failEmail,
    failWebhook,
    finishOAuth,
    getConnectionStatus,
    processWebhookEvent,
    sendEmailOutbox,
    setDefaultEventType,
    startOAuth,
    updateAppointment,
  };
}
