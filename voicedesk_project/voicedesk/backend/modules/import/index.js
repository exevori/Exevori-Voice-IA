// ============================================================
// EXEVORI VOICE IA — IMPORT CONTACTS
// CSV preview/import and small manual batches, aligned with CRM V1.
// ============================================================

import express from "express";
import { createClient } from "@supabase/supabase-js";
import multer from "multer";
import { parse as csvParse } from "csv-parse/sync";
import dotenv from "dotenv";

dotenv.config();

const productionSupabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
      )
    : null;

const AI_GATEWAY_URL = process.env.AI_GATEWAY_URL || "http://localhost:3100";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_RE = /^\+[1-9]\d{7,14}$/;
const SUPABASE_PAGE_SIZE = 1_000;
const VALID_URGENCY = new Set(["low", "normal", "high"]);
const DUPLICATE_ACTIONS = new Set(["skip", "overwrite"]);
const CONSENT_FIELDS = ["email_consent", "sms_consent", "call_consent"];

export const CRM_IMPORT_PIPELINE = Object.freeze([
  "new",
  "qualified",
  "client",
  "lost",
  "archived",
]);

export const IMPORTABLE_FIELDS = Object.freeze([
  "full_name",
  "first_name",
  "last_name",
  "email",
  "phone",
  "company",
  "status",
  "main_need",
  "budget",
  "urgency",
  "tags",
  "notes",
  "next_action_date",
  "next_action_note",
  "email_consent",
  "email_consent_at",
  "sms_consent",
  "sms_consent_at",
  "call_consent",
  "call_consent_at",
]);

const IMPORTABLE_FIELD_SET = new Set(IMPORTABLE_FIELDS);
const CONTACT_WRITE_FIELDS = new Set([
  ...IMPORTABLE_FIELDS,
  "source",
  "next_action",
]);
const STATUS_ALIASES = new Map([
  ["new", "new"],
  ["nouveau", "new"],
  ["qualified", "qualified"],
  ["qualifie", "qualified"],
  ["hot", "qualified"],
  ["warm", "qualified"],
  ["hot_lead", "qualified"],
  ["warm_lead", "qualified"],
  ["callback_required", "qualified"],
  ["appointment_set", "qualified"],
  ["client", "client"],
  ["customer", "client"],
  ["lost", "lost"],
  ["perdu", "lost"],
  ["cold", "lost"],
  ["inactive", "lost"],
  ["not_interested", "lost"],
  ["archived", "archived"],
  ["archive", "archived"],
]);
const FORBIDDEN_ANONYMIZED_STATUSES = new Set([
  "anonymized",
  "anonymised",
  "anonymise",
]);
const TRUE_VALUES = new Set([
  "true",
  "1",
  "yes",
  "y",
  "oui",
  "o",
  "consent",
  "accepted",
  "accepte",
]);
const FALSE_VALUES = new Set([
  "false",
  "0",
  "no",
  "n",
  "non",
  "refused",
  "refuse",
  "opt_out",
  "dnc",
]);
const NULL_VALUES = new Set([
  "",
  "null",
  "unknown",
  "inconnu",
  "inconnue",
  "n_a",
  "na",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function cleanText(value, maxLength) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
}

function normalizeToken(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s-]+/g, "_");
}

function normalizeComparable(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function trigramSet(value) {
  const normalized = normalizeComparable(value);
  if (!normalized) return new Set();
  const result = new Set();
  for (const word of normalized.split(" ")) {
    const padded = "  " + word + " ";
    for (let index = 0; index <= padded.length - 3; index += 1) {
      result.add(padded.slice(index, index + 3));
    }
  }
  return result;
}

function trigramSimilarity(left, right) {
  const leftTrigrams = trigramSet(left);
  const rightTrigrams = trigramSet(right);
  if (leftTrigrams.size === 0 || rightTrigrams.size === 0) return 0;
  let common = 0;
  for (const trigram of leftTrigrams) {
    if (rightTrigrams.has(trigram)) common += 1;
  }
  return common / Math.max(leftTrigrams.size, rightTrigrams.size);
}

function isFuzzyNameCompanyMatch(left, right) {
  if (!left?.full_name || !left?.company || !right?.full_name || !right?.company) {
    return false;
  }
  return (
    trigramSimilarity(left.full_name, right.full_name) >= 0.72
    && trigramSimilarity(left.company, right.company) >= 0.55
  );
}

export function normalizeE164Phone(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }

  let normalized = String(value)
    .trim()
    .replace(/[\s()./\-]/g, "");

  if (normalized.startsWith("00")) {
    normalized = "+" + normalized.slice(2);
  } else if (/^\d{10}$/.test(normalized)) {
    normalized = "+1" + normalized;
  } else if (/^1\d{10}$/.test(normalized)) {
    normalized = "+" + normalized;
  }

  return E164_RE.test(normalized) ? normalized : null;
}

export function normalizePipelineStatus(value) {
  const token = normalizeToken(value);
  if (!token || FORBIDDEN_ANONYMIZED_STATUSES.has(token)) return null;
  return STATUS_ALIASES.get(token) || null;
}

export function parseConsentValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (value === 1) return true;
  if (value === 0) return false;

  const token = normalizeToken(value);
  if (NULL_VALUES.has(token)) return null;
  if (TRUE_VALUES.has(token)) return true;
  if (FALSE_VALUES.has(token)) return false;
  throw new Error("invalid_consent");
}

function normalizeEmail(value) {
  const email = cleanText(value, 320)?.toLowerCase() || null;
  if (email && !EMAIL_RE.test(email)) throw new Error("invalid_email");
  return email;
}

function normalizeDate(value, errorCode) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(errorCode);
  return parsed.toISOString();
}

function normalizeMappingField(value) {
  if (!value || value === "ignore") return value;
  return value === "next_action" ? "next_action_note" : value;
}

export function sanitizeColumnMapping(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { mapping: null, errors: ["column_mapping_required"] };
  }

  const mapping = {};
  const errors = [];
  for (const [header, rawField] of Object.entries(input)) {
    const field = normalizeMappingField(rawField);
    if (!field || field === "ignore") continue;
    if (!IMPORTABLE_FIELD_SET.has(field)) {
      errors.push({ header, field: rawField });
      continue;
    }
    mapping[header] = field;
  }
  return { mapping, errors };
}

function normalizeTags(value) {
  const values = Array.isArray(value)
    ? value
    : String(value ?? "").split(/[,;|]/);
  return [...new Set(
    values.map(tag => cleanText(tag, 50)).filter(Boolean)
  )].slice(0, 30);
}

function pickContactWriteFields(contact, mapping) {
  const mappedFields = new Set(
    Object.values(mapping || {}).map(normalizeMappingField)
  );
  mappedFields.add("phone");
  if (mappedFields.has("first_name") || mappedFields.has("last_name")) {
    mappedFields.add("full_name");
  }
  if (mappedFields.has("next_action_note")) {
    mappedFields.add("next_action");
  }
  for (const consentField of CONSENT_FIELDS) {
    if (mappedFields.has(consentField)) {
      mappedFields.add(consentField + "_at");
    }
  }

  return Object.fromEntries(
    Object.entries(contact).filter(
      ([key, value]) =>
        CONTACT_WRITE_FIELDS.has(key)
        && mappedFields.has(key)
        && value !== undefined
    )
  );
}

export function mapRowToContact(row, mapping, defaults, {
  now = () => new Date(),
} = {}) {
  const defaultStatus = normalizePipelineStatus(defaults?.default_status || "new");
  if (!defaultStatus) {
    const rawDefault = normalizeToken(defaults?.default_status);
    throw new Error(
      FORBIDDEN_ANONYMIZED_STATUSES.has(rawDefault)
        ? "anonymized_status_forbidden"
        : "invalid_default_status"
    );
  }

  const contact = {
    company_id: defaults?.company_id,
    status: defaultStatus,
    source: cleanText(defaults?.default_source, 100) || "csv_import",
  };
  const notesParts = [];
  const consentValues = {};
  const consentTimestamps = {};

  for (const [csvHeader, rawField] of Object.entries(mapping || {})) {
    const field = normalizeMappingField(rawField);
    if (!IMPORTABLE_FIELD_SET.has(field)) continue;

    const raw = row?.[csvHeader];
    if (CONSENT_FIELDS.includes(field)) {
      consentValues[field] = parseConsentValue(raw);
      continue;
    }
    if (field.endsWith("_consent_at")) {
      consentTimestamps[field] = raw;
      continue;
    }

    const value = cleanText(raw, field === "notes" ? 10000 : 2000);
    if (!value) continue;

    if (field === "tags") {
      contact.tags = normalizeTags(raw);
    } else if (field === "notes") {
      notesParts.push(value);
    } else {
      contact[field] = value;
    }
  }

  if (notesParts.length > 0) {
    contact.notes = notesParts.join("\n").slice(0, 10000);
  }

  contact.full_name = cleanText(contact.full_name, 200);
  contact.first_name = cleanText(contact.first_name, 100);
  contact.last_name = cleanText(contact.last_name, 100);
  contact.company = cleanText(contact.company, 200);
  contact.main_need = cleanText(contact.main_need, 2000);
  contact.budget = cleanText(contact.budget, 200);
  contact.email = normalizeEmail(contact.email);

  const phone = normalizeE164Phone(contact.phone);
  if (!phone) throw new Error("phone_e164_required");
  contact.phone = phone;

  if (!contact.full_name && (contact.first_name || contact.last_name)) {
    contact.full_name = [contact.first_name, contact.last_name]
      .filter(Boolean)
      .join(" ");
  }
  if (!contact.full_name) {
    contact.full_name = contact.email || contact.phone;
  }

  if (hasOwn(contact, "status")) {
    const rawStatus = normalizeToken(contact.status);
    const status = normalizePipelineStatus(contact.status);
    if (!status) {
      throw new Error(
        FORBIDDEN_ANONYMIZED_STATUSES.has(rawStatus)
          ? "anonymized_status_forbidden"
          : "invalid_contact_status"
      );
    }
    contact.status = status;
  }

  if (hasOwn(contact, "urgency")) {
    contact.urgency = normalizeToken(contact.urgency);
    if (!VALID_URGENCY.has(contact.urgency)) {
      throw new Error("invalid_urgency");
    }
  }

  if (hasOwn(contact, "next_action_date")) {
    contact.next_action_date = normalizeDate(
      contact.next_action_date,
      "invalid_next_action_date"
    );
  }
  if (hasOwn(contact, "next_action_note")) {
    contact.next_action_note = cleanText(contact.next_action_note, 2000);
    contact.next_action = contact.next_action_note;
  }

  for (const field of CONSENT_FIELDS) {
    const timestampField = field + "_at";
    const hasConsent = hasOwn(consentValues, field);
    const hasTimestamp = hasOwn(consentTimestamps, timestampField)
      && cleanText(consentTimestamps[timestampField], 100);

    if (!hasConsent) {
      if (hasTimestamp) throw new Error(timestampField + "_without_consent");
      continue;
    }

    const consent = consentValues[field];
    contact[field] = consent;
    contact[timestampField] = consent === null
      ? null
      : (
        hasTimestamp
          ? normalizeDate(consentTimestamps[timestampField], "invalid_" + timestampField)
          : now().toISOString()
      );
  }

  return contact;
}

function resolveImportTenant(req) {
  if (!req.user) return { status: 401, error: "unauthorized" };
  const requestedCompanyId = req.body?.company_id || null;

  if (req.user.role === "super_admin") {
    if (!requestedCompanyId || !UUID_RE.test(requestedCompanyId)) {
      return { status: 400, error: "company_id_required" };
    }
    return { companyId: requestedCompanyId };
  }

  if (!req.user.company_id) {
    return { status: 403, error: "company_context_required" };
  }
  if (requestedCompanyId && requestedCompanyId !== req.user.company_id) {
    return { status: 403, error: "forbidden_cross_tenant" };
  }
  return { companyId: req.user.company_id };
}

function sendTenantError(res, tenant) {
  return res.status(tenant.status).json({ error: tenant.error });
}

function detectDelimiter(content) {
  const firstLine = content.split("\n")[0];
  const counts = {
    ",": (firstLine.match(/,/g) || []).length,
    ";": (firstLine.match(/;/g) || []).length,
    "\t": (firstLine.match(/\t/g) || []).length,
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

export async function detectColumnMapping(sampleRows, {
  fetchImpl = globalThis.fetch,
  aiGatewayUrl = AI_GATEWAY_URL,
} = {}) {
  if (sampleRows.length === 0) return {};

  const headers = Object.keys(sampleRows[0]);
  const mapping = {};
  const patterns = {
    email_consent_at: /(date.*(?:consent.*(?:email|courriel)|(?:email|courriel).*consent)|(?:email|courriel).*consent.*(?:date|at))/i,
    sms_consent_at: /(date.*consent.*sms|sms.*consent.*(date|at))/i,
    call_consent_at: /(date.*consent.*(appel|call)|(?:appel|call).*consent.*(date|at))/i,
    next_action_date: /(date.*prochaine?\s*action|next[\s_-]?action[\s_-]?date|follow[\s_-]?up[\s_-]?date)/i,
    email_consent: /((email|courriel).*(consent|opt[\s_-]?in)|(consent|opt[\s_-]?in).*(email|courriel))/i,
    sms_consent: /(sms.*(consent|opt[\s_-]?in)|(consent|opt[\s_-]?in).*sms)/i,
    call_consent: /((appel|call|telephone).*(consent|opt[\s_-]?in)|(consent|opt[\s_-]?in).*(appel|call|telephone))/i,
    notes: /(notes?|commentaires?|remarques?|description|m[ée]mo)/i,
    next_action_note: /(prochaine?\s*action|next[\s_-]?action|todo|t[âa]che|follow[\s_-]?up)/i,
    main_need: /(besoin|need|raison|motif|demande|^objet$|^sujet$)/i,
    first_name: /(pr[ée]nom|first[\s_-]?name|firstname|given[\s_-]?name)/i,
    last_name: /(nom de famille|last[\s_-]?name|lastname|surname|family[\s_-]?name)/i,
    email: /(e?[\s_-]?mail|courriel|adresse courriel)/i,
    phone: /(t[ée]l[ée]?phone|^t[ée]l\b|^phone|mobile|cellulaire|\bcell\b|portable|num[ée]ro)/i,
    company: /(entreprise|^company$|compagnie|organisation|business|soci[ée]t[ée]|employeur)/i,
    status: /(statut|^status$|^[ée]tat$|stage|level)/i,
    urgency: /(urgence|urgency|priorit[ée]|priority)/i,
    tags: /(^tags?$|^[ée]tiquettes?$|cat[ée]gories?|labels?)/i,
    budget: /(budget|montant|prix\s*estim[ée]|estimated[\s_-]?value)/i,
    full_name: /(nom\s*complet|fullname|full[\s_-]?name|^client$|^customer$|^contact$|^nom$|^name$)/i,
  };

  for (const header of headers) {
    const cleaned = String(header).trim();
    if (!cleaned) continue;
    for (const [field, pattern] of Object.entries(patterns)) {
      if (pattern.test(cleaned)) {
        mapping[header] = field;
        break;
      }
    }
  }

  if (Object.keys(mapping).length < 2 && typeof fetchImpl === "function") {
    try {
      const response = await fetchImpl(aiGatewayUrl + "/api/ai/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: "parse_import",
          headers,
          sample_rows: sampleRows.slice(0, 3),
        }),
      });

      if (response.ok) {
        const ai = await response.json();
        const safeAiMapping = sanitizeColumnMapping(ai.mapping || {}).mapping || {};
        for (const [header, field] of Object.entries(safeAiMapping)) {
          if (!mapping[header]) mapping[header] = field;
        }
      }
    } catch {
      // Heuristic mapping remains available if the optional AI service is down.
    }
  }

  return mapping;
}

async function loadTenantContacts(database, companyId) {
  const contacts = [];
  let from = 0;

  while (true) {
    const { data, error } = await database
      .from("contacts")
      .select("id, full_name, phone, email, company, status")
      .eq("company_id", companyId)
      .order("id", { ascending: true })
      .range(from, from + SUPABASE_PAGE_SIZE - 1);
    if (error) throw error;

    const page = data || [];
    if (page.length === 0) break;
    contacts.push(...page);
    from += page.length;
  }

  return contacts;
}

async function findPotentialDuplicates(database, companyId, rows, mapping) {
  const existing = await loadTenantContacts(database, companyId);

  const indexes = buildExistingIndexes(existing);
  const duplicates = [];
  for (const [index, row] of rows.slice(0, 50).entries()) {
    try {
      const contact = mapRowToContact(row, mapping, {
        company_id: companyId,
        default_status: "new",
        default_source: "csv_import",
      });
      const resolution = await resolveDuplicate(
        database,
        indexes,
        companyId,
        contact
      );
      if (resolution.kind !== "none") {
        const matches = resolution.matches.map(formatDuplicateMatch);
        duplicates.push({
          row,
          issue: resolution.kind,
          existing: matches[0] || null,
          matches,
          matched_on: matches[0]?.matched_on || null,
        });
      } else {
        indexes.add(contact, "preview:" + (index + 1), { batch: true });
      }
    } catch {
      // Invalid preview rows are returned separately as validation errors.
    }
  }
  return duplicates;
}

function parseCsvFile(file) {
  const content = file.buffer.toString("utf-8");
  return csvParse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    delimiter: detectDelimiter(content),
  });
}

function parseSubmittedMapping(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return sanitizeColumnMapping(parsed);
  } catch {
    return { mapping: null, errors: ["invalid_column_mapping_json"] };
  }
}

function buildExistingIndexes(existingContacts) {
  const byPhone = new Map();
  const byEmail = new Map();
  const batchContacts = new Map();

  const addToIndex = (index, key, reference) => {
    if (!key) return;
    const bucket = index.get(key) || new Map();
    bucket.set(reference.id, reference);
    index.set(key, bucket);
  };

  const add = (contact, id, { batch = false } = {}) => {
    if (["archived", "anonymized"].includes(contact.status)) return;
    const reference = {
      id,
      full_name: contact.full_name,
      company: contact.company,
      phone: contact.phone,
      email: contact.email,
      status: contact.status,
    };
    addToIndex(byPhone, normalizeE164Phone(contact.phone), reference);
    addToIndex(byEmail, contact.email?.toLowerCase(), reference);
    if (batch) batchContacts.set(id, reference);
  };

  const remove = contact => {
    const phone = normalizeE164Phone(contact?.phone);
    if (phone) {
      const bucket = byPhone.get(phone);
      bucket?.delete(contact.id);
      if (bucket?.size === 0) byPhone.delete(phone);
    }
    const email = contact?.email?.toLowerCase();
    if (email) {
      const bucket = byEmail.get(email);
      bucket?.delete(contact.id);
      if (bucket?.size === 0) byEmail.delete(email);
    }
    batchContacts.delete(contact.id);
  };

  const replace = (previous, next, id) => {
    const wasBatchContact = batchContacts.has(previous.id);
    remove(previous);
    add(next, id, { batch: wasBatchContact });
  };

  const findExact = contact => {
    const matches = new Map();
    const collect = (bucket, reason) => {
      for (const candidate of bucket?.values() || []) {
        const existing = matches.get(candidate.id) || {
          contact: candidate,
          matchedOn: [],
        };
        if (!existing.matchedOn.includes(reason)) existing.matchedOn.push(reason);
        matches.set(candidate.id, existing);
      }
    };
    collect(byPhone.get(normalizeE164Phone(contact.phone)), "phone");
    collect(byEmail.get(contact.email?.toLowerCase()), "email");
    return [...matches.values()];
  };

  const findBatchFuzzy = contact => (
    [...batchContacts.values()]
      .filter(candidate => isFuzzyNameCompanyMatch(contact, candidate))
      .map(candidate => ({
        contact: candidate,
        matchedOn: ["name_company_fuzzy"],
      }))
  );

  for (const contact of existingContacts || []) {
    add(contact, contact.id);
  }

  return { findExact, findBatchFuzzy, add, replace };
}

function formatDuplicateMatch(match) {
  const contact = match.contact || {};
  const reasons = Array.isArray(match.matchedOn)
    ? match.matchedOn
    : [match.matchedOn].filter(Boolean);
  return {
    id: contact.id,
    full_name: contact.full_name || null,
    phone: contact.phone || null,
    email: contact.email || null,
    company: contact.company || null,
    status: contact.status || null,
    similarity_score: Number(contact.similarity_score || 0),
    matched_on: reasons.length === 1 ? reasons[0] : reasons,
    match_reasons: reasons,
  };
}

async function findRpcDuplicates(database, companyId, contact) {
  if (
    !contact.phone
    && !contact.email
    && !(contact.full_name && contact.company)
  ) {
    return [];
  }
  const { data, error } = await database.rpc("find_crm_contact_duplicates", {
    p_company_id: companyId,
    p_phone: contact.phone || null,
    p_email: contact.email || null,
    p_full_name: contact.full_name || null,
    p_company: contact.company || null,
    p_exclude_contact_id: null,
  });
  if (error) throw error;
  return (data || [])
    .filter(candidate => !["archived", "anonymized"].includes(candidate.status))
    .map(candidate => ({
      contact: candidate,
      matchedOn: Array.isArray(candidate.match_reasons)
        ? candidate.match_reasons
        : ["name_company_fuzzy"],
    }));
}

function combineDuplicateMatches(...groups) {
  const combined = new Map();
  for (const match of groups.flat()) {
    const id = match?.contact?.id;
    if (!id) continue;
    const existing = combined.get(id);
    if (!existing) {
      combined.set(id, {
        contact: match.contact,
        matchedOn: [...new Set(match.matchedOn || [])],
      });
      continue;
    }
    existing.contact = { ...existing.contact, ...match.contact };
    existing.matchedOn = [
      ...new Set([...(existing.matchedOn || []), ...(match.matchedOn || [])]),
    ];
  }
  return [...combined.values()];
}

async function resolveDuplicate(database, indexes, companyId, contact) {
  const localExactMatches = indexes.findExact(contact);
  const rpcMatches = await findRpcDuplicates(database, companyId, contact);
  const rpcExactMatches = rpcMatches.filter(match =>
    match.matchedOn.some(reason => reason === "phone" || reason === "email")
  );
  const exactMatches = combineDuplicateMatches(
    localExactMatches,
    rpcExactMatches
  );
  if (exactMatches.length > 1) {
    return {
      kind: "identity_conflict",
      matches: exactMatches,
    };
  }
  if (exactMatches.length === 1) {
    return {
      kind: "exact",
      matches: exactMatches,
    };
  }

  const batchFuzzyMatches = indexes.findBatchFuzzy(contact);
  const rpcFuzzyMatches = rpcMatches.filter(match =>
    !match.matchedOn.some(reason => reason === "phone" || reason === "email")
  );
  const fuzzyMatches = combineDuplicateMatches(
    batchFuzzyMatches,
    rpcFuzzyMatches
  );
  if (fuzzyMatches.length > 0) {
    return {
      kind: "manual_merge_required",
      matches: fuzzyMatches,
    };
  }
  return { kind: "none", matches: [] };
}

function duplicateIssue(row, resolution) {
  return {
    row,
    message:
      resolution.kind === "identity_conflict"
        ? "conflicting_exact_duplicates"
        : (
          resolution.kind === "exact"
            ? "duplicate_contact"
            : "manual_merge_required"
        ),
    duplicates: resolution.matches.map(formatDuplicateMatch),
  };
}

export function createImportRouter({
  supabase = productionSupabase,
  now = () => new Date(),
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  const router = express.Router();

  router.post("/preview", upload.single("file"), async (req, res) => {
    const tenant = resolveImportTenant(req);
    if (tenant.error) return sendTenantError(res, tenant);
    if (!req.file) {
      return res.status(400).json({ error: "fichier_requis" });
    }

    try {
      let rows;
      try {
        rows = parseCsvFile(req.file);
      } catch (error) {
        return res.status(400).json({ error: "Format CSV invalide : " + error.message });
      }
      if (rows.length === 0) {
        return res.status(400).json({ error: "Fichier vide" });
      }

      const columnMapping = await detectColumnMapping(rows.slice(0, 5), {
        fetchImpl,
      });
      const validationErrors = [];
      rows.slice(0, 50).forEach((row, index) => {
        try {
          mapRowToContact(row, columnMapping, {
            company_id: tenant.companyId,
            default_status: "new",
            default_source: "csv_import",
          }, { now });
        } catch (error) {
          validationErrors.push({ row: index + 2, message: error.message });
        }
      });
      const duplicates = await findPotentialDuplicates(
        supabase,
        tenant.companyId,
        rows.slice(0, 50),
        columnMapping
      );

      return res.json({
        total_rows: rows.length,
        preview: rows.slice(0, 10),
        headers: Object.keys(rows[0] || {}),
        column_mapping: columnMapping,
        phone_mapping_required: !Object.values(columnMapping).includes("phone"),
        invalid_rows_previewed: validationErrors.length,
        validation_errors: validationErrors.slice(0, 50),
        potential_duplicates: duplicates.length,
        sample_duplicates: duplicates.slice(0, 5),
      });
    } catch (error) {
      logger.error("[IMPORT] Preview error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  router.post("/execute", upload.single("file"), async (req, res) => {
    const tenant = resolveImportTenant(req);
    if (tenant.error) return sendTenantError(res, tenant);
    if (!req.file) {
      return res.status(400).json({ error: "fichier_requis" });
    }

    const duplicateAction = req.body?.duplicate_action || "skip";
    if (!DUPLICATE_ACTIONS.has(duplicateAction)) {
      return res.status(400).json({ error: "invalid_duplicate_action" });
    }

    const rawDefaultStatus = req.body?.default_status || "new";
    const defaultStatus = normalizePipelineStatus(rawDefaultStatus);
    if (!defaultStatus) {
      return res.status(400).json({
        error: FORBIDDEN_ANONYMIZED_STATUSES.has(normalizeToken(rawDefaultStatus))
          ? "anonymized_status_forbidden"
          : "invalid_default_status",
      });
    }

    const parsedMapping = parseSubmittedMapping(req.body?.column_mapping);
    if (!parsedMapping.mapping || parsedMapping.errors.length > 0) {
      return res.status(400).json({
        error: "invalid_column_mapping",
        details: parsedMapping.errors,
      });
    }
    if (!Object.values(parsedMapping.mapping).includes("phone")) {
      return res.status(400).json({ error: "phone_mapping_required" });
    }

    try {
      let rows;
      try {
        rows = parseCsvFile(req.file);
      } catch (error) {
        return res.status(400).json({ error: "Format CSV invalide : " + error.message });
      }

      const defaultSource = cleanText(req.body?.default_source, 100) || "csv_import";
      let imported = 0;
      let updated = 0;
      let skipped = 0;
      const errors = [];

      const existingContacts = await loadTenantContacts(
        supabase,
        tenant.companyId
      );
      const indexes = buildExistingIndexes(existingContacts);

      for (let index = 0; index < rows.length; index += 1) {
        const rowNumber = index + 2;
        try {
          const contact = mapRowToContact(rows[index], parsedMapping.mapping, {
            company_id: tenant.companyId,
            default_status: defaultStatus,
            default_source: defaultSource,
          }, { now });
          const resolution = await resolveDuplicate(
            supabase,
            indexes,
            tenant.companyId,
            contact
          );
          if (
            resolution.kind === "identity_conflict"
            || resolution.kind === "manual_merge_required"
          ) {
            skipped += 1;
            errors.push(duplicateIssue(rowNumber, resolution));
            continue;
          }
          const existing = resolution.kind === "exact"
            ? resolution.matches[0].contact
            : null;

          if (existing && duplicateAction === "skip") {
            skipped += 1;
            continue;
          }
          if (existing && duplicateAction === "overwrite") {
            const patch = pickContactWriteFields(contact, parsedMapping.mapping);
            const indexedContact = { ...existing, ...patch };
            const { error } = await supabase
              .from("contacts")
              .update(patch)
              .eq("id", existing.id)
              .eq("company_id", tenant.companyId);
            if (error) {
              errors.push({ row: rowNumber, message: error.message });
            } else {
              updated += 1;
              indexes.replace(existing, indexedContact, existing.id);
            }
            continue;
          }

          const { data, error } = await supabase
            .from("contacts")
            .insert(contact)
            .select("id")
            .single();
          if (error) {
            errors.push({ row: rowNumber, message: error.message });
          } else {
            imported += 1;
            indexes.add(contact, data.id, { batch: true });
          }
        } catch (error) {
          errors.push({ row: rowNumber, message: error.message });
        }
      }

      await supabase.from("activity_logs").insert({
        company_id: tenant.companyId,
        action: "contacts_imported",
        details: {
          total_rows: rows.length,
          imported,
          updated,
          skipped,
          errors: errors.length,
          duplicate_action: duplicateAction,
        },
      });

      return res.json({
        success: true,
        total_rows: rows.length,
        imported,
        updated,
        skipped,
        errors: errors.slice(0, 50),
      });
    } catch (error) {
      logger.error("[IMPORT] Execute error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  router.post("/manual", async (req, res) => {
    const tenant = resolveImportTenant(req);
    if (tenant.error) return sendTenantError(res, tenant);

    const contacts = req.body?.contacts;
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ error: "contacts_array_required" });
    }
    if (contacts.length > 50) {
      return res.status(400).json({
        error: "maximum_50_contacts",
      });
    }

    const rawDefaultStatus = req.body?.default_status || "new";
    const defaultStatus = normalizePipelineStatus(rawDefaultStatus);
    if (!defaultStatus) {
      return res.status(400).json({
        error: FORBIDDEN_ANONYMIZED_STATUSES.has(normalizeToken(rawDefaultStatus))
          ? "anonymized_status_forbidden"
          : "invalid_default_status",
      });
    }

    const manualMapping = Object.fromEntries(
      IMPORTABLE_FIELDS.map(field => [field, field])
    );
    const records = [];
    const validationErrors = [];

    contacts.forEach((contact, index) => {
      try {
        records.push(mapRowToContact(contact, manualMapping, {
          company_id: tenant.companyId,
          default_status: defaultStatus,
          default_source: "manual",
        }, { now }));
      } catch (error) {
        validationErrors.push({ row: index + 1, message: error.message });
      }
    });

    if (validationErrors.length > 0) {
      return res.status(400).json({
        error: "invalid_contacts",
        details: validationErrors,
      });
    }

    try {
      const existingContacts = await loadTenantContacts(
        supabase,
        tenant.companyId
      );

      const indexes = buildExistingIndexes(existingContacts);
      const duplicateIssues = [];
      for (const [index, contact] of records.entries()) {
        const resolution = await resolveDuplicate(
          supabase,
          indexes,
          tenant.companyId,
          contact
        );
        if (resolution.kind !== "none") {
          duplicateIssues.push(duplicateIssue(index + 1, resolution));
        } else {
          indexes.add(contact, "batch:" + (index + 1), { batch: true });
        }
      }
      if (duplicateIssues.length > 0) {
        const responseError = duplicateIssues.some(
          issue => issue.message === "conflicting_exact_duplicates"
        )
          ? "conflicting_exact_duplicates"
          : (
            duplicateIssues.some(issue => issue.message === "manual_merge_required")
              ? "manual_merge_required"
              : "duplicate_contact"
          );
        const duplicates = duplicateIssues.flatMap(issue =>
          issue.duplicates.map(duplicate => ({
            ...duplicate,
            row: issue.row,
            message: issue.message,
          }))
        );
        return res.status(409).json({
          error: responseError,
          duplicates,
          issues: duplicateIssues,
        });
      }

      const { data, error } = await supabase
        .from("contacts")
        .insert(records)
        .select();
      if (error) throw error;
      return res.json({
        success: true,
        imported: data?.length || 0,
        contacts: data || [],
      });
    } catch (error) {
      logger.error("[IMPORT] Manual error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  return router;
}

const router = createImportRouter();

export default router;
