const API_BASE = "https://api.calendly.com";
const AUTH_BASE = "https://auth.calendly.com";
const DEFAULT_TIMEOUT_MS = 15_000;

function providerMessage(payload, fallback) {
  const value = payload?.title || payload?.message || payload?.error_description || payload?.error;
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : fallback;
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}

export class CalendlyApiError extends Error {
  constructor(message, { status = 502, code = "calendly_request_failed", details = null } = {}) {
    super(message);
    this.name = "CalendlyApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryable = status === 408 || status === 429 || status >= 500;
  }
}

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    const code = error?.name === "AbortError" ? "calendly_timeout" : "calendly_network_error";
    throw new CalendlyApiError(
      error?.name === "AbortError" ? "Calendly did not respond in time" : "Calendly is unreachable",
      { status: 503, code }
    );
  } finally {
    clearTimeout(timer);
  }
}

async function oauthTokenRequest(fetchImpl, body) {
  const clientId = process.env.CALENDLY_CLIENT_ID;
  const clientSecret = process.env.CALENDLY_CLIENT_SECRET;
  const form = new URLSearchParams({ ...body, client_id: clientId });
  const response = await fetchWithTimeout(fetchImpl, `${AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  const payload = await parseResponse(response);
  if (!response.ok) {
    throw new CalendlyApiError(
      providerMessage(payload, "Calendly OAuth rejected the request"),
      {
        status: response.status,
        code: payload?.error === "invalid_grant" ? "calendly_invalid_grant" : "calendly_oauth_failed",
        details: payload?.required_scopes || null,
      }
    );
  }
  if (!payload.access_token || !payload.refresh_token) {
    throw new CalendlyApiError("Calendly returned an incomplete OAuth token response", {
      status: 502,
      code: "calendly_oauth_response_invalid",
    });
  }
  return payload;
}

export function exchangeAuthorizationCode({ fetchImpl = fetch, code, codeVerifier }) {
  return oauthTokenRequest(fetchImpl, {
    grant_type: "authorization_code",
    redirect_uri: process.env.CALENDLY_REDIRECT_URI,
    code,
    code_verifier: codeVerifier,
  });
}

export function refreshAccessToken({ fetchImpl = fetch, refreshToken }) {
  return oauthTokenRequest(fetchImpl, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

export async function calendlyRequest({
  fetchImpl = fetch,
  accessToken,
  path,
  method = "GET",
  body,
  query,
}) {
  const url = new URL(path, API_BASE);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetchWithTimeout(fetchImpl, url, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await parseResponse(response);
  if (!response.ok) {
    throw new CalendlyApiError(
      providerMessage(payload, `Calendly request failed with HTTP ${response.status}`),
      {
        status: response.status,
        code: response.status === 401
          ? "calendly_unauthorized"
          : response.status === 403
            ? "calendly_forbidden"
            : response.status === 404
              ? "calendly_not_found"
              : response.status === 429
                ? "calendly_rate_limited"
                : "calendly_request_failed",
        details: payload?.required_scopes || null,
      }
    );
  }
  return payload;
}

export function getCurrentUser(args) {
  return calendlyRequest({ ...args, path: "/users/me" });
}

export function listEventTypes({ accessToken, userUri, fetchImpl = fetch }) {
  return calendlyRequest({
    fetchImpl,
    accessToken,
    path: "/event_types",
    query: { user: userUri, active: true, count: 100 },
  });
}

export function getEventType({ accessToken, eventTypeUri, fetchImpl = fetch }) {
  const uuid = resourceUuid(eventTypeUri, "event_types");
  return calendlyRequest({ fetchImpl, accessToken, path: `/event_types/${uuid}` });
}

export function listAvailableTimes({ accessToken, eventTypeUri, startTime, endTime, fetchImpl = fetch }) {
  return calendlyRequest({
    fetchImpl,
    accessToken,
    path: "/event_type_available_times",
    query: { event_type: eventTypeUri, start_time: startTime, end_time: endTime },
  });
}

export function createInvitee({ accessToken, booking, fetchImpl = fetch }) {
  return calendlyRequest({
    fetchImpl,
    accessToken,
    path: "/invitees",
    method: "POST",
    body: booking,
  });
}

export function getScheduledEvent({ accessToken, eventUri, fetchImpl = fetch }) {
  const uuid = resourceUuid(eventUri, "scheduled_events");
  return calendlyRequest({ fetchImpl, accessToken, path: `/scheduled_events/${uuid}` });
}

export function cancelScheduledEvent({ accessToken, eventUri, fetchImpl = fetch }) {
  const uuid = resourceUuid(eventUri, "scheduled_events");
  return calendlyRequest({
    fetchImpl,
    accessToken,
    path: `/scheduled_events/${uuid}/cancellation`,
    method: "POST",
  });
}

export function requestInviteeDataDeletion({ accessToken, emails, fetchImpl = fetch }) {
  return calendlyRequest({
    fetchImpl,
    accessToken,
    path: "/data_compliance/deletion/invitees",
    method: "POST",
    body: { emails },
  });
}

export function createWebhookSubscription({
  accessToken,
  callbackUrl,
  organizationUri,
  userUri,
  scope = "user",
  fetchImpl = fetch,
}) {
  return calendlyRequest({
    fetchImpl,
    accessToken,
    path: "/webhook_subscriptions",
    method: "POST",
    body: {
      url: callbackUrl,
      events: ["invitee.created", "invitee.canceled"],
      organization: organizationUri,
      scope,
      ...(scope === "user" ? { user: userUri } : {}),
    },
  });
}

export function deleteWebhookSubscription({ accessToken, subscriptionUri, fetchImpl = fetch }) {
  const uuid = resourceUuid(subscriptionUri, "webhook_subscriptions");
  return calendlyRequest({
    fetchImpl,
    accessToken,
    path: `/webhook_subscriptions/${uuid}`,
    method: "DELETE",
  });
}

export function resourceUuid(uri, expectedCollection) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new CalendlyApiError("Invalid Calendly resource URI", {
      status: 400,
      code: "invalid_calendly_resource_uri",
    });
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  const collectionIndex = parts.lastIndexOf(expectedCollection);
  const uuid = collectionIndex >= 0 ? parts[collectionIndex + 1] : null;
  if (parsed.origin !== API_BASE || !uuid || !/^[A-Za-z0-9_-]+$/.test(uuid)) {
    throw new CalendlyApiError("Invalid Calendly resource URI", {
      status: 400,
      code: "invalid_calendly_resource_uri",
    });
  }
  return uuid;
}
