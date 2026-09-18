import { seed, STORAGE_KEY, COMPANY_ID, TOKEN, USER_ID } from "./data.js";

export function createDemoApi({ storage, isSignedIn = () => false, origin = "http://127.0.0.1:3000" }) {
  let db;
  try { db = JSON.parse(storage.getItem(STORAGE_KEY)); } catch {}
  if (!db?.profile || !Array.isArray(db.contacts)) db = seed();
  const save = () => storage.setItem(STORAGE_KEY, JSON.stringify(db));
  const result = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const blocked = () => result({ error: "Action désactivée en démo : aucun appel, paiement, envoi ou service externe réel.", demo: true }, 403);
  const created = () => new Date().toISOString();
  const id = () => globalThis.crypto.randomUUID();
  const api = async (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, origin);
    const method = (options.method || input?.method || "GET").toUpperCase();
    const headers = new Headers(options.headers || input?.headers);
    if (url.origin !== origin || !url.pathname.startsWith("/api/v1/")) return blocked();
    if (!isSignedIn() || headers.get("Authorization") !== `Bearer ${TOKEN}`) return result({ error: "Connectez-vous avec l'identifiant de démonstration." }, 401);
    let body = {};
    try { if (options.body) body = JSON.parse(options.body); } catch { return blocked(); }
    if ([url.searchParams.get("company_id"), body.company_id].some(v => v && v !== COMPANY_ID)) return result({ error: "forbidden" }, 403);
    const path = url.pathname.slice("/api/v1".length);
    const parts = path.split("/").filter(Boolean);
    const read = method === "GET";
    // Never simulate a successful paid/external action.
    if (/\/(portal|checkout|launch|resume|oauth|send-test|upload|scrape|reembed|provision|step\/5|recording|invite|sessions\/revoke)(\/|$)/.test(path)) return blocked();
    if (path.startsWith("/admin") || path.startsWith("/webhooks")) return blocked();
    if (path === "/auth/me" && read) return result(db.profile);
    if (["/onboarding", "/onboarding/provisioning-status"].includes(path) && read) return result({ progress: { current_step: 1 }, config: { assistant_name: "Léa", tone: "professional", voice_library_id: "" }, knowledge_entries: [], area_code: "581", status: "idle", test: { status: "idle", phone: "", verified_at: null }, ready: false, can_retry: false });
    if (path === "/dashboard/stats" && read) return result({ generated_at: created(), has_activity: true, windows: {}, kpis: { calls_7d: { total: 7, inbound: 4, outbound: 3 }, appointments_this_week: db.appointments.length, contacts_created_7d: db.contacts.length, ai_resolution_rate_pct: 75, ai_resolved_calls_7d: 3, ai_resolution_eligible_calls_7d: 4, tickets_open: db.tickets.filter(t => !["closed", "resolved"].includes(t.status)).length }, roi: { time_saved_seconds: 2400, time_saved_hours: 0.7, calculation: "Illustration fictive, pas une mesure réelle", assumptions: { transfer_takeover_seconds: 60 } }, minutes: { used: 42, included: 500, remaining: 458, overage: 0, usage_pct: 8.4 } });
    if (path === "/dashboard/activity" && read) return result({ activities: db.calls.map(c => ({ id: c.id, type: "call_inbound", title: c.intent, description: c.ai_summary, timestamp: c.created_at, occurred_at: c.created_at, created_at: c.created_at, link: "/calls" })) });
    if (path === "/calls/stats" && read) return result({ total: db.calls.length, by_status: { completed: 3, abandoned: 1, in_progress: 0 } });
    if (path === "/calls" && read) return result({ calls: db.calls, total: db.calls.length });
    if (parts[0] === "calls" && read) { const call = db.calls.find(c => c.id === parts[1]); return call ? result({ call, transcript: call.transcript, events: [] }) : result({ error: "Appel fictif introuvable" }, 404); }
    if (parts[0] === "contacts") {
      if (parts.length === 1 && read) return result({ contacts: db.contacts, total: db.contacts.length });
      const contact = db.contacts.find(c => c.id === parts[1]);
      if (parts[2] === "duplicates" && read) return result({ duplicates: [] });
      if (parts.length === 2 && contact && read) return result({ contact, history: { calls: db.calls.filter(c => c.contact_id === contact.id), outbound_calls: [], emails: [], appointments: db.appointments.filter(a => a.contact_id === contact.id) }, notes: [], suggestions: [], learning_suggestions: [] });
      if (parts.length === 2 && contact && ["PATCH", "PUT"].includes(method)) { for (const k of ["full_name", "phone", "email", "status", "notes", "main_need", "next_action", "next_action_note", "next_action_date", "call_consent", "email_consent"]) if (Object.hasOwn(body, k)) contact[k] = body[k]; save(); return result({ contact }); }
      if (parts.length === 2 && contact && method === "DELETE") { contact.status = "archived"; save(); return result({ success: true }); }
    }
    if (parts[0] === "tickets") {
      if (parts.length === 1 && read) return result({ tickets: db.tickets.filter(t => !url.searchParams.get("status") || t.status === url.searchParams.get("status")), total: db.tickets.length });
      if (parts.length === 1 && method === "POST") { const ticket = { ...db.tickets[0], ...body, id: id(), company_id: COMPANY_ID, ticket_number: `T-DEMO-${db.tickets.length + 1}`, status: "open", created_at: created(), updated_at: created(), first_response_at: null }; db.tickets.unshift(ticket); save(); return result({ ticket, success: true }, 201); }
      const ticket = db.tickets.find(t => t.id === parts[1]);
      if (ticket && read) return result({ ticket, messages: db.messages.filter(m => m.ticket_id === ticket.id), attachments: [] });
      if (ticket && parts[2] === "messages" && method === "POST") { const message = { id: id(), ticket_id: ticket.id, company_id: COMPANY_ID, body: body.body, author_user_id: USER_ID, author_name: db.profile.full_name, author_role: "company_admin", is_internal: false, attachments: [], created_at: created() }; db.messages.push(message); save(); return result({ message, ticket }, 201); }
      if (ticket && !read) { if (parts[2] === "close") ticket.status = "closed"; else if (parts[2] === "reopen") ticket.status = "open"; else if (body.satisfaction_rating) ticket.satisfaction_rating = body.satisfaction_rating; else return blocked(); save(); return result({ ticket }); }
    }
    if (path === "/kb/sources" && read) return result({ sources: db.sources, total: db.sources.length });
    if (path.startsWith("/kb/sources/")) {
      if (["qa", "manual"].includes(parts[2]) && method === "POST") { const source = { ...body, id: id(), company_id: COMPANY_ID, name: body.name || body.question || "Note de démonstration", type: parts[2], answer: body.answer || body.content || "", status: "ready", chunks_count: 1, created_at: created(), size_bytes: 100 }; db.sources.push(source); save(); return result({ source, chunks_count: 1, demo: true }, 201); }
      const source = db.sources.find(s => s.id === parts[2]);
      if (source && read) return result({ source, chunks: [{ id: source.id, content: `${source.question || source.name}\n${source.answer}`, chunk_index: 0, token_count: 30 }] });
      if (source && method === "DELETE") { db.sources = db.sources.filter(s => s.id !== source.id); save(); return result({ success: true }); }
    }
    if (path === "/outbound/campaigns" && read) return result({ campaigns: db.campaigns });
    if (path === "/outbound/settings" && read) return result({ outbound_phone_numbers: [{ id: "demo-phone", phone_number: "+14185550100", label: "Numéro fictif — aucun appel", ready: true }] });
    if (path === "/outbound/dnc" && read) return result({ dnc: [] });
    if (parts[0] === "outbound" && parts[1] === "campaigns" && parts[3] === "contacts" && read) return result({ contacts: db.contacts.slice(0, 3).map(c => ({ ...c, name: c.full_name, status: "pending", consent_status: "granted" })) });
    if (path === "/calendar/connection" && read) return result({ connected: false, status: "not_connected", message: "Calendly désactivé pour cette démonstration locale." });
    if (path === "/calendar/appointments" && read) return result({ appointments: db.appointments });
    if (parts[0] === "calendar" && parts[1] === "appointments" && read) return result({ appointment: db.appointments.find(a => a.id === parts[2]) });
    if (path === "/config") { if (!read && ["PATCH", "PUT"].includes(method)) { for (const k of ["assistant_name", "tone", "greeting_inbound_fr", "system_prompt_voice_fr", "rag_min_similarity"]) if (Object.hasOwn(body,k)) db.config[k] = body[k]; save(); } else if (!read) return blocked(); return result({ config: db.config, voices: [], sync_status: "not_provisioned", success: true }); }
    if (path === "/company" && read) return result({ company: db.company });
    if (path === "/account/profile" && read) return result({ profile: db.profile });
    if (path === "/account/company-settings" && read) return result({ settings: { retention_days: 90, transcript_retention_days: 90, recordings_visible: true }, can_manage: true, is_owner: true });
    if (path === "/account/sessions" && read) return result({ sessions: [{ id: "demo-session", current: true, created_at: created(), user_agent: "Navigateur local — session fictive" }] });
    if (path === "/team" && read) return result({ members: [db.profile], invitations: [], owner_user_id: USER_ID });
    if (path === "/twilio-config" && read) return result({ config: null });
    if (path === "/voice-library" && read) return result({ voices: [] });
    if (path === "/billing/me" && read) return result({ generated_at: created(), plan: { name: "essentiel", label: "Essentiel — exemple", currency: "CAD", monthly_price: 319 }, subscription: { payment_status: "trial", trial_days_remaining: 14, trial_ends_at: new Date(Date.now()+14*86400000).toISOString(), portal_available: false, subscription_update_available: false }, usage: { minutes_used: 42, minutes_included: 500, minutes_remaining: 458, usage_pct: 8.4 }, forecast: {}, payment_method: null, invoices: [] });
    if (path === "/notifications/preferences") { if (!read) { db.preferences = { ...db.preferences, ...body }; save(); } return result({ preferences: db.preferences }); }
    if (path === "/notifications/unread-count" && read) return result({ unread_count: db.notifications.filter(n => !n.read).length });
    if (path === "/notifications" && read) return result({ notifications: db.notifications, unread_count: db.notifications.filter(n => !n.read).length, as_of: created() });
    if (parts[0] === "notifications" && !read && (parts[2] === "read" || parts[1] === "mark-all-read")) { db.notifications.forEach(n => { if (parts[1] === "mark-all-read" || n.id === parts[1]) { n.read = true; n.read_at = created(); } }); save(); return result({ success: true }); }
    if (path === "/learning/suggestions" && read) return result({ suggestions: [] });
    return result({ error: "Cette action n'est pas simulée dans la démo locale. Aucune donnée réelle n'a été modifiée.", demo: true }, 501);
  };
  return { fetch: api, getProfile: () => structuredClone(db.profile), reset: () => { db = seed(); save(); }, getData: () => structuredClone(db) };
}
