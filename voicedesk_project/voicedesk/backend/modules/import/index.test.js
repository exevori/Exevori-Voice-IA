import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import express from "express";

process.env.SUPABASE_URL ||= "https://import-tests.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-only-service-role-key";

const {
  createImportRouter,
  mapRowToContact,
  normalizeE164Phone,
  normalizePipelineStatus,
  sanitizeColumnMapping,
} = await import("./index.js");

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const FIXED_NOW = new Date("2026-08-20T15:30:00.000Z");

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

class FakeQuery {
  constructor(client, table) {
    this.client = client;
    this.table = table;
    this.operation = "select";
    this.payload = null;
    this.filters = [];
    this.shouldReturnRows = false;
    this.singleResult = false;
    this.rangeValue = null;
    this.orderValue = null;
  }

  select() {
    this.shouldReturnRows = true;
    return this;
  }

  insert(payload) {
    this.operation = "insert";
    this.payload = clone(payload);
    return this;
  }

  update(payload) {
    this.operation = "update";
    this.payload = clone(payload);
    return this;
  }

  eq(column, value) {
    this.filters.push({ column, value });
    return this;
  }

  order(column, options = {}) {
    this.orderValue = {
      column,
      ascending: options.ascending !== false,
    };
    return this;
  }

  range(from, to) {
    this.rangeValue = { from, to };
    return this;
  }

  single() {
    this.singleResult = true;
    return this.execute();
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }

  async execute() {
    this.client.queryLog.push({
      table: this.table,
      operation: this.operation,
      payload: clone(this.payload),
      filters: clone(this.filters),
      range: clone(this.rangeValue),
    });

    const table = this.client.tables[this.table] ||= [];
    const matches = row => this.filters.every(
      filter => row[filter.column] === filter.value
    );

    if (this.operation === "select") {
      let rows = table.filter(matches);
      if (this.orderValue) {
        const { column, ascending } = this.orderValue;
        rows = [...rows].sort((left, right) => {
          const comparison = String(left[column] ?? "").localeCompare(
            String(right[column] ?? "")
          );
          return ascending ? comparison : -comparison;
        });
      }
      if (this.rangeValue) {
        rows = rows.slice(this.rangeValue.from, this.rangeValue.to + 1);
      }
      rows = rows.map(clone);
      return {
        data: this.singleResult ? rows[0] || null : rows,
        error: null,
      };
    }

    if (this.operation === "update") {
      const updated = [];
      table.forEach(row => {
        if (!matches(row)) return;
        Object.assign(row, clone(this.payload));
        updated.push(clone(row));
      });
      return {
        data: this.shouldReturnRows
          ? (this.singleResult ? updated[0] || null : updated)
          : null,
        error: null,
      };
    }

    const rows = Array.isArray(this.payload) ? this.payload : [this.payload];
    const inserted = rows.map((row, index) => ({
      id: row.id || "inserted-" + (table.length + index + 1),
      ...clone(row),
    }));
    table.push(...inserted.map(clone));
    return {
      data: this.shouldReturnRows
        ? (this.singleResult ? inserted[0] || null : inserted)
        : null,
      error: null,
    };
  }
}

class FakeSupabase {
  constructor(tables = {}, { rpcHandler = null } = {}) {
    this.tables = clone(tables);
    this.queryLog = [];
    this.rpcHandler = rpcHandler;
  }

  from(table) {
    return new FakeQuery(this, table);
  }

  async rpc(name, args) {
    this.queryLog.push({
      table: null,
      operation: "rpc",
      name,
      args: clone(args),
    });
    if (this.rpcHandler) return this.rpcHandler(name, clone(args));

    const normalize = value => String(value ?? "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    const data = (this.tables.contacts || [])
      .filter(contact =>
        contact.company_id === args.p_company_id
        && !["archived", "anonymized"].includes(contact.status)
      )
      .map(contact => {
        const matchReasons = [];
        if (args.p_phone && contact.phone === args.p_phone) {
          matchReasons.push("phone");
        }
        if (
          args.p_email
          && normalize(contact.email) === normalize(args.p_email)
        ) {
          matchReasons.push("email");
        }
        if (
          args.p_full_name
          && args.p_company
          && normalize(contact.full_name) === normalize(args.p_full_name)
          && normalize(contact.company) === normalize(args.p_company)
        ) {
          matchReasons.push("name_company_fuzzy");
        }
        return {
          ...clone(contact),
          similarity_score: matchReasons.includes("phone")
            ? 1
            : (matchReasons.includes("email") ? 0.98 : 0.9),
          match_reasons: matchReasons,
        };
      })
      .filter(contact => contact.match_reasons.length > 0);
    return { data, error: null };
  }
}

async function withServer(database, callback) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const role = req.get("x-test-role");
    if (role) {
      req.user = {
        role,
        company_id: req.get("x-test-company") || null,
      };
    }
    next();
  });
  app.use("/import", createImportRouter({
    supabase: database,
    now: () => FIXED_NOW,
    fetchImpl: null,
    logger: { error() {} },
  }));

  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const port = server.address().port;
    await callback("http://127.0.0.1:" + port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function tenantHeaders(companyId = COMPANY_A) {
  return {
    "content-type": "application/json",
    "x-test-role": "company_admin",
    "x-test-company": companyId,
  };
}

test("phone normalization produces E.164 without reusing outbound rules", () => {
  assert.equal(normalizeE164Phone("(514) 555-0123"), "+15145550123");
  assert.equal(normalizeE164Phone("1 514 555 0123"), "+15145550123");
  assert.equal(normalizeE164Phone("0033 1 42 68 53 00"), "+33142685300");
  assert.equal(normalizeE164Phone("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizeE164Phone("555-0123"), null);
  assert.equal(normalizeE164Phone("+0123456789"), null);
});

test("CRM V1 status aliases are canonical and anonymized is never importable", () => {
  assert.equal(normalizePipelineStatus("nouveau"), "new");
  assert.equal(normalizePipelineStatus("Qualifié"), "qualified");
  assert.equal(normalizePipelineStatus("customer"), "client");
  assert.equal(normalizePipelineStatus("not interested"), "lost");
  assert.equal(normalizePipelineStatus("archivé"), "archived");
  assert.equal(normalizePipelineStatus("anonymized"), null);
});

test("row mapping applies allowlisted next action and tri-state consent fields", () => {
  const safe = sanitizeColumnMapping({
    Nom: "full_name",
    Telephone: "phone",
    Statut: "status",
    Action: "next_action",
    DateAction: "next_action_date",
    Appels: "call_consent",
    SMS: "sms_consent",
    DateSMS: "sms_consent_at",
  });
  assert.deepEqual(safe.errors, []);

  const contact = mapRowToContact({
    Nom: "  Élodie Tremblay ",
    Telephone: "(514) 555-0123",
    Statut: "hot",
    Action: "Rappeler",
    DateAction: "2026-08-25T14:00:00-04:00",
    Appels: "non",
    SMS: "",
    DateSMS: "",
  }, safe.mapping, {
    company_id: COMPANY_A,
    default_status: "new",
    default_source: "csv_import",
  }, {
    now: () => FIXED_NOW,
  });

  assert.equal(contact.company_id, COMPANY_A);
  assert.equal(contact.full_name, "Élodie Tremblay");
  assert.equal(contact.phone, "+15145550123");
  assert.equal(contact.status, "qualified");
  assert.equal(contact.next_action_note, "Rappeler");
  assert.equal(contact.next_action, "Rappeler");
  assert.equal(contact.next_action_date, "2026-08-25T18:00:00.000Z");
  assert.equal(contact.call_consent, false);
  assert.equal(contact.call_consent_at, FIXED_NOW.toISOString());
  assert.equal(contact.sms_consent, null);
  assert.equal(contact.sms_consent_at, null);
  assert.equal(Object.prototype.hasOwnProperty.call(contact, "email_consent"), false);
});

test("column mapping rejects tenant and lifecycle metadata outside the allowlist", () => {
  const result = sanitizeColumnMapping({
    Tenant: "company_id",
    Identifiant: "id",
    AnonymiseLe: "anonymized_at",
    Telephone: "phone",
  });
  assert.deepEqual(result.mapping, { Telephone: "phone" });
  assert.deepEqual(result.errors, [
    { header: "Tenant", field: "company_id" },
    { header: "Identifiant", field: "id" },
    { header: "AnonymiseLe", field: "anonymized_at" },
  ]);
});

test("manual import blocks cross-tenant requests before any database query", async () => {
  const database = new FakeSupabase({ contacts: [] });
  await withServer(database, async baseUrl => {
    const response = await fetch(baseUrl + "/import/manual", {
      method: "POST",
      headers: tenantHeaders(COMPANY_A),
      body: JSON.stringify({
        company_id: COMPANY_B,
        contacts: [{ full_name: "Intrus", phone: "+15145550123" }],
      }),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "forbidden_cross_tenant");
  });
  assert.equal(database.queryLog.length, 0);
});

test("tenant contact loading paginates beyond the Supabase 1000-row limit", async () => {
  const contacts = Array.from({ length: 1_000 }, (_, index) => ({
    id: "contact-" + String(index).padStart(4, "0"),
    company_id: COMPANY_A,
    full_name: "Contact " + index,
    company: "Pagination Inc",
    phone: "+1212555" + String(index).padStart(4, "0"),
    email: "contact-" + index + "@example.com",
    status: "new",
  }));
  contacts.push({
    id: "zzzz-target",
    company_id: COMPANY_A,
    full_name: "Contact page deux",
    company: "Pagination Inc",
    phone: "+15145559999",
    email: "page-deux@example.com",
    status: "qualified",
  });
  const database = new FakeSupabase({ contacts });

  await withServer(database, async baseUrl => {
    const response = await fetch(baseUrl + "/import/manual", {
      method: "POST",
      headers: tenantHeaders(),
      body: JSON.stringify({
        contacts: [{
          full_name: "Contact importé",
          phone: "+15145559999",
        }],
      }),
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, "duplicate_contact");
    assert.equal(body.duplicates[0].id, "zzzz-target");
  });

  const pageQueries = database.queryLog.filter(
    entry => entry.table === "contacts" && entry.operation === "select"
  );
  assert.deepEqual(pageQueries.map(entry => entry.range), [
    { from: 0, to: 999 },
    { from: 1000, to: 1999 },
    { from: 1001, to: 2000 },
  ]);
  const rpcLog = database.queryLog.find(entry => entry.operation === "rpc");
  assert.equal(rpcLog.args.p_phone, "+15145559999");
  assert.equal(rpcLog.args.p_company_id, COMPANY_A);
});

test("RPC exact phone and email checks run without name or company", async () => {
  const database = new FakeSupabase({ contacts: [] }, {
    rpcHandler(_name, args) {
      if (args.p_phone === "+15145550601") {
        return {
          data: [{
            id: "rpc-phone",
            full_name: null,
            company: null,
            phone: args.p_phone,
            email: null,
            status: "new",
            similarity_score: 1,
            match_reasons: ["phone"],
          }],
          error: null,
        };
      }
      return {
        data: [{
          id: "rpc-email",
          full_name: null,
          company: null,
          phone: null,
          email: args.p_email,
          status: "client",
          similarity_score: 0.98,
          match_reasons: ["email"],
        }],
        error: null,
      };
    },
  });

  await withServer(database, async baseUrl => {
    const response = await fetch(baseUrl + "/import/manual", {
      method: "POST",
      headers: tenantHeaders(),
      body: JSON.stringify({
        contacts: [{
          phone: "+15145550601",
        }, {
          phone: "+15145550602",
          email: "exact@example.com",
        }],
      }),
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, "duplicate_contact");
    assert.deepEqual(
      body.duplicates.map(duplicate => duplicate.id),
      ["rpc-phone", "rpc-email"]
    );
  });

  const rpcLogs = database.queryLog.filter(entry => entry.operation === "rpc");
  assert.equal(rpcLogs.length, 2);
  assert.equal(rpcLogs[0].args.p_company, null);
  assert.equal(rpcLogs[0].args.p_phone, "+15145550601");
  assert.equal(rpcLogs[1].args.p_company, null);
  assert.equal(rpcLogs[1].args.p_email, "exact@example.com");
  assert.equal(
    database.queryLog.some(entry => entry.operation === "insert"),
    false
  );
});

test("manual import rejects invalid phones and the anonymized terminal state atomically", async () => {
  const database = new FakeSupabase({ contacts: [] });
  await withServer(database, async baseUrl => {
    const response = await fetch(baseUrl + "/import/manual", {
      method: "POST",
      headers: tenantHeaders(),
      body: JSON.stringify({
        contacts: [
          { full_name: "Sans téléphone", phone: "555-0123" },
          { full_name: "Anonyme", phone: "+15145550124", status: "anonymized" },
        ],
      }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "invalid_contacts");
    assert.deepEqual(body.details, [
      { row: 1, message: "phone_e164_required" },
      { row: 2, message: "anonymized_status_forbidden" },
    ]);
  });
  assert.equal(database.queryLog.length, 0);
});

test("manual import enforces exact duplicate checks and ignores archived contacts", async () => {
  const database = new FakeSupabase({
    contacts: [
      {
        id: "active-contact",
        company_id: COMPANY_A,
        full_name: "Marie Dupont",
        company: "Exemple Inc",
        phone: "+15145550123",
        email: "marie@example.com",
        status: "qualified",
      },
      {
        id: "archived-contact",
        company_id: COMPANY_A,
        full_name: "Ancien Contact",
        company: "Archive Inc",
        phone: "+15145550999",
        email: "ancien@example.com",
        status: "archived",
      },
      {
        id: "other-tenant",
        company_id: COMPANY_B,
        full_name: "Autre Tenant",
        company: "Autre Inc",
        phone: "+15145550888",
        email: "autre@example.com",
        status: "new",
      },
    ],
  });

  await withServer(database, async baseUrl => {
    const phoneDuplicateResponse = await fetch(baseUrl + "/import/manual", {
      method: "POST",
      headers: tenantHeaders(),
      body: JSON.stringify({
        contacts: [{
          full_name: "Nom différent",
          company: "Entreprise différente",
          phone: "(514) 555-0123",
          email: "different@example.com",
        }],
      }),
    });
    assert.equal(phoneDuplicateResponse.status, 409);
    const phoneDuplicateBody = await phoneDuplicateResponse.json();
    assert.equal(phoneDuplicateBody.duplicates[0].matched_on, "phone");

    const duplicateResponse = await fetch(baseUrl + "/import/manual", {
      method: "POST",
      headers: tenantHeaders(),
      body: JSON.stringify({
        contacts: [{
          full_name: "Marie Dupont",
          company: "Exemple Inc",
          phone: "+15145550777",
          email: "nouveau@example.com",
        }],
      }),
    });
    assert.equal(duplicateResponse.status, 409);
    const duplicateBody = await duplicateResponse.json();
    assert.equal(duplicateBody.error, "manual_merge_required");
    assert.equal(duplicateBody.duplicates[0].matched_on, "name_company_fuzzy");

    const sameNameDifferentCompanyResponse = await fetch(baseUrl + "/import/manual", {
      method: "POST",
      headers: tenantHeaders(),
      body: JSON.stringify({
        contacts: [{
          full_name: "Marie Dupont",
          company: "Entreprise différente",
          phone: "+15145550700",
          email: "marie-autre@example.com",
        }],
      }),
    });
    assert.equal(sameNameDifferentCompanyResponse.status, 200);

    const batchDuplicateResponse = await fetch(baseUrl + "/import/manual", {
      method: "POST",
      headers: tenantHeaders(),
      body: JSON.stringify({
        contacts: [{
          full_name: "Nouvelle Personne",
          company: "Même Entreprise",
          phone: "+15145550701",
          email: "personne-1@example.com",
        }, {
          full_name: "Nouvelle Persone",
          company: "Même Entreprize",
          phone: "+15145550702",
          email: "personne-2@example.com",
        }],
      }),
    });
    assert.equal(batchDuplicateResponse.status, 409);
    const batchDuplicateBody = await batchDuplicateResponse.json();
    assert.equal(batchDuplicateBody.duplicates[0].row, 2);
    assert.equal(batchDuplicateBody.error, "manual_merge_required");
    assert.equal(batchDuplicateBody.duplicates[0].matched_on, "name_company_fuzzy");
    assert.equal(batchDuplicateBody.duplicates[0].id, "batch:1");

    const archivedPhoneResponse = await fetch(baseUrl + "/import/manual", {
      method: "POST",
      headers: tenantHeaders(),
      body: JSON.stringify({
        contacts: [{
          full_name: "Nouveau Contact",
          phone: "+15145550999",
          email: "nouveau-archive@example.com",
          status: "client",
          company_id: COMPANY_B,
          id: "injected-id",
          anonymized_at: "2026-01-01T00:00:00Z",
        }],
      }),
    });
    assert.equal(archivedPhoneResponse.status, 200);
  });

  const inserted = database.tables.contacts.find(
    contact => contact.email === "nouveau-archive@example.com"
  );
  assert.equal(inserted.company_id, COMPANY_A);
  assert.equal(inserted.source, "manual");
  assert.equal(inserted.status, "client");
  assert.equal(Object.prototype.hasOwnProperty.call(inserted, "anonymized_at"), false);
  assert.notEqual(inserted.id, "injected-id");
});

test("manual import blocks fuzzy CRM duplicates through the tenant-scoped RPC", async () => {
  const fuzzyCandidate = {
    id: "fuzzy-existing",
    company_id: COMPANY_A,
    full_name: "Sophie Tremblay",
    company: "Nordik Solutions",
    phone: "+15145550301",
    email: "sophie@nordik.example",
    status: "qualified",
  };
  const database = new FakeSupabase({
    contacts: [fuzzyCandidate],
  }, {
    rpcHandler(name, args) {
      assert.equal(name, "find_crm_contact_duplicates");
      return {
        data: [{
          ...fuzzyCandidate,
          similarity_score: 0.91,
          match_reasons: ["name_company_fuzzy"],
        }],
        error: null,
      };
    },
  });

  await withServer(database, async baseUrl => {
    const response = await fetch(baseUrl + "/import/manual", {
      method: "POST",
      headers: tenantHeaders(),
      body: JSON.stringify({
        contacts: [{
          full_name: "Sofie Tremblay",
          company: "Nordik Solution",
          phone: "+15145550302",
          email: "sofie@nordik.example",
        }],
      }),
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, "manual_merge_required");
    assert.equal(body.duplicates[0].id, "fuzzy-existing");
    assert.equal(body.duplicates[0].matched_on, "name_company_fuzzy");
  });

  assert.equal(database.tables.contacts.length, 1);
  assert.equal(
    database.queryLog.some(entry => entry.operation === "insert"),
    false
  );
  const rpcLog = database.queryLog.find(entry => entry.operation === "rpc");
  assert.equal(rpcLog.args.p_company_id, COMPANY_A);
  assert.equal(rpcLog.args.p_exclude_contact_id, null);
});

test("CSV overwrite reports fuzzy matches instead of overwriting them", async () => {
  const fuzzyCandidate = {
    id: "fuzzy-a",
    company_id: COMPANY_A,
    full_name: "Sophie Tremblay",
    company: "Nordik Solutions",
    phone: "+15145550401",
    email: "sophie@nordik.example",
    status: "qualified",
  };
  const database = new FakeSupabase({
    contacts: [fuzzyCandidate],
    activity_logs: [],
  }, {
    rpcHandler() {
      return {
        data: [{
          ...fuzzyCandidate,
          similarity_score: 0.89,
          match_reasons: ["name_company_fuzzy"],
        }],
        error: null,
      };
    },
  });

  await withServer(database, async baseUrl => {
    const form = new FormData();
    form.append("column_mapping", JSON.stringify({
      Name: "full_name",
      Company: "company",
      Phone: "phone",
      Email: "email",
    }));
    form.append("duplicate_action", "overwrite");
    form.append(
      "file",
      new Blob([
        "Name,Company,Phone,Email\n" +
        "Sofie Tremblay,Nordik Solution,+15145550402,sofie@nordik.example\n",
      ], { type: "text/csv" }),
      "contacts.csv"
    );
    const response = await fetch(baseUrl + "/import/execute", {
      method: "POST",
      headers: {
        "x-test-role": "company_admin",
        "x-test-company": COMPANY_A,
      },
      body: form,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.imported, 0);
    assert.equal(body.updated, 0);
    assert.equal(body.skipped, 1);
    assert.equal(body.errors[0].message, "manual_merge_required");
    assert.equal(body.errors[0].duplicates[0].id, "fuzzy-a");
  });

  assert.equal(
    database.queryLog.some(entry => entry.operation === "update"),
    false
  );
  assert.equal(database.tables.contacts.length, 1);
});

test("CSV overwrite refuses conflicting exact phone and email identities", async () => {
  const database = new FakeSupabase({
    contacts: [{
      id: "identity-phone",
      company_id: COMPANY_A,
      full_name: "Contact téléphone",
      company: "Alpha",
      phone: "+15145550501",
      email: "phone-owner@example.com",
      status: "new",
    }, {
      id: "identity-email",
      company_id: COMPANY_A,
      full_name: "Contact courriel",
      company: "Beta",
      phone: "+15145550502",
      email: "email-owner@example.com",
      status: "client",
    }],
    activity_logs: [],
  });

  await withServer(database, async baseUrl => {
    const form = new FormData();
    form.append("column_mapping", JSON.stringify({
      Name: "full_name",
      Phone: "phone",
      Email: "email",
      Status: "status",
    }));
    form.append("duplicate_action", "overwrite");
    form.append(
      "file",
      new Blob([
        "Name,Phone,Email,Status\n" +
        "Identité ambiguë,+15145550501,email-owner@example.com,qualified\n",
      ], { type: "text/csv" }),
      "contacts.csv"
    );
    const response = await fetch(baseUrl + "/import/execute", {
      method: "POST",
      headers: {
        "x-test-role": "company_admin",
        "x-test-company": COMPANY_A,
      },
      body: form,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.imported, 0);
    assert.equal(body.updated, 0);
    assert.equal(body.skipped, 1);
    assert.equal(body.errors[0].message, "conflicting_exact_duplicates");
    assert.deepEqual(
      body.errors[0].duplicates.map(duplicate => duplicate.id).sort(),
      ["identity-email", "identity-phone"]
    );
  });

  assert.equal(
    database.queryLog.some(entry => entry.operation === "update"),
    false
  );
  const conflictRpc = database.queryLog.find(entry => entry.operation === "rpc");
  assert.equal(conflictRpc.args.p_company_id, COMPANY_A);
});

test("CSV execute refuses create bypass, requires phone mapping and isolates overwrite", async () => {
  const database = new FakeSupabase({
    contacts: [{
      id: "contact-a",
      company_id: COMPANY_A,
      full_name: "Alice",
      company: "Alpha",
      phone: "+15145550123",
      email: "alice@example.com",
      status: "new",
    }, {
      id: "contact-b",
      company_id: COMPANY_B,
      full_name: "Bob",
      company: "Beta",
      phone: "+15145550124",
      email: "bob@example.com",
      status: "new",
    }],
    activity_logs: [],
  });

  await withServer(database, async baseUrl => {
    const createForm = new FormData();
    createForm.append("column_mapping", JSON.stringify({ Phone: "phone" }));
    createForm.append("duplicate_action", "create");
    createForm.append(
      "file",
      new Blob(["Phone\n+15145550123\n"], { type: "text/csv" }),
      "contacts.csv"
    );
    const createResponse = await fetch(baseUrl + "/import/execute", {
      method: "POST",
      headers: {
        "x-test-role": "company_admin",
        "x-test-company": COMPANY_A,
      },
      body: createForm,
    });
    assert.equal(createResponse.status, 400);
    assert.equal((await createResponse.json()).error, "invalid_duplicate_action");

    const noPhoneForm = new FormData();
    noPhoneForm.append("column_mapping", JSON.stringify({ Name: "full_name" }));
    noPhoneForm.append(
      "file",
      new Blob(["Name\nAlice\n"], { type: "text/csv" }),
      "contacts.csv"
    );
    const noPhoneResponse = await fetch(baseUrl + "/import/execute", {
      method: "POST",
      headers: {
        "x-test-role": "company_admin",
        "x-test-company": COMPANY_A,
      },
      body: noPhoneForm,
    });
    assert.equal(noPhoneResponse.status, 400);
    assert.equal((await noPhoneResponse.json()).error, "phone_mapping_required");

    const overwriteForm = new FormData();
    overwriteForm.append("column_mapping", JSON.stringify({
      Phone: "phone",
      Status: "status",
      Next: "next_action_note",
      Consent: "call_consent",
    }));
    overwriteForm.append("duplicate_action", "overwrite");
    overwriteForm.append(
      "file",
      new Blob([
        "Phone,Status,Next,Consent\n" +
        "(514) 555-0123,hot,Rappeler,non\n" +
        "+15145550124,anonymized,Interdit,oui\n",
      ], { type: "text/csv" }),
      "contacts.csv"
    );
    const overwriteResponse = await fetch(baseUrl + "/import/execute", {
      method: "POST",
      headers: {
        "x-test-role": "company_admin",
        "x-test-company": COMPANY_A,
      },
      body: overwriteForm,
    });
    assert.equal(overwriteResponse.status, 200);
    const body = await overwriteResponse.json();
    assert.equal(body.updated, 1);
    assert.equal(body.imported, 0);
    assert.deepEqual(body.errors, [
      { row: 3, message: "anonymized_status_forbidden" },
    ]);
  });

  const contactA = database.tables.contacts.find(contact => contact.id === "contact-a");
  const contactB = database.tables.contacts.find(contact => contact.id === "contact-b");
  assert.equal(contactA.status, "qualified");
  assert.equal(contactA.next_action_note, "Rappeler");
  assert.equal(contactA.call_consent, false);
  assert.equal(contactB.status, "new");

  const updateLog = database.queryLog.find(entry => entry.operation === "update");
  assert.deepEqual(updateLog.filters, [
    { column: "id", value: "contact-a" },
    { column: "company_id", value: COMPANY_A },
  ]);
});
