import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import express from "express";

import {
  createCalendarRouter,
  createCalendlyOAuthCallbackHandler,
  createCalendlyWebhookHandler,
} from "./index.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

const COMPANY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const APPOINTMENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CONNECTION = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

async function withServer(app, callback) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function serviceStub(overrides = {}) {
  return {
    appointments: async () => [],
    availability: async () => ({ event_type_uri: "type-uri", slots: [] }),
    book: async () => ({ reused: false, appointment: { id: APPOINTMENT } }),
    disconnect: async () => ({ connected: false, status: "disconnected" }),
    eventTypes: async () => [],
    finishOAuth: async () => ({ return_path: "/calendar" }),
    getConnectionStatus: async companyId => ({ connected: false, status: "disconnected", companyId }),
    setDefaultEventType: async (_companyId, uri) => ({ default_event_type_uri: uri }),
    startOAuth: async () => ({ authorization_url: "https://auth.calendly.com/oauth/authorize" }),
    updateAppointment: async () => ({ id: APPOINTMENT }),
    enqueueWebhook: async () => ({ duplicate: false, event_id: "event-inbox" }),
    ...overrides,
  };
}

function appFor(service, user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use(createCalendarRouter({ service }));
  return app;
}

test("calendar router always derives a normal user's tenant from req.user", async () => {
  const calls = [];
  const service = serviceStub({
    getConnectionStatus: async companyId => {
      calls.push(companyId);
      return { connected: false, status: "disconnected" };
    },
  });
  await withServer(appFor(service, {
    id: USER_A,
    role: "company_user",
    company_id: COMPANY_A,
  }), async baseUrl => {
    const response = await fetch(`${baseUrl}/connection?company_id=${COMPANY_B}`);
    assert.equal(response.status, 200);
  });
  assert.deepEqual(calls, [COMPANY_A]);
});

test("only company managers can connect or change Calendly settings", async () => {
  let starts = 0;
  const service = serviceStub({
    startOAuth: async () => {
      starts += 1;
      return { authorization_url: "https://auth.calendly.com/oauth/authorize" };
    },
  });
  await withServer(appFor(service, {
    id: USER_A,
    role: "company_user",
    company_id: COMPANY_A,
  }), async baseUrl => {
    const response = await fetch(`${baseUrl}/oauth/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ company_id: COMPANY_A, return_path: "/calendar" }),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "forbidden");
  });
  assert.equal(starts, 0);
});

test("super admin can explicitly select the tenant and availability keeps the frontend contract", async () => {
  const calls = [];
  const service = serviceStub({
    availability: async companyId => {
      calls.push(companyId);
      return {
        event_type_uri: "https://api.calendly.com/event_types/type-1",
        slots: [{ start_time: "2026-09-01T14:00:00Z", status: "available" }],
      };
    },
  });
  await withServer(appFor(service, {
    id: USER_A,
    role: "super_admin",
    company_id: null,
  }), async baseUrl => {
    const response = await fetch(`${baseUrl}/availability?company_id=${COMPANY_B}`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.availability.length, 1);
    assert.equal(payload.event_type_uri.endsWith("type-1"), true);
  });
  assert.deepEqual(calls, [COMPANY_B]);
});

test("booking rejects mismatched idempotency keys before calling Calendly", async () => {
  let bookings = 0;
  const service = serviceStub({
    book: async () => {
      bookings += 1;
      return { reused: false, appointment: { id: APPOINTMENT } };
    },
  });
  await withServer(appFor(service, {
    id: USER_A,
    role: "company_user",
    company_id: COMPANY_A,
  }), async baseUrl => {
    const response = await fetch(`${baseUrl}/book`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "header-key-123",
      },
      body: JSON.stringify({ idempotency_key: "different-key-456" }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "idempotency_key_mismatch");
  });
  assert.equal(bookings, 0);
});

test("reschedule returns the reviewed Calendly URL with HTTP 409", async () => {
  const service = serviceStub({
    updateAppointment: async () => {
      const error = new Error("Utilisez le lien sécurisé.");
      error.code = "provider_reschedule_required";
      error.status = 409;
      error.reschedule_url = "https://calendly.com/resched/abc";
      throw error;
    },
  });
  await withServer(appFor(service, {
    id: USER_A,
    role: "company_user",
    company_id: COMPANY_A,
  }), async baseUrl => {
    const response = await fetch(`${baseUrl}/appointments/${APPOINTMENT}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "reschedule" }),
    });
    assert.equal(response.status, 409);
    const payload = await response.json();
    assert.equal(payload.reschedule_url, "https://calendly.com/resched/abc");
  });
});

test("webhook handler persists the already-verified raw payload in the durable inbox", async () => {
  const calls = [];
  const service = serviceStub({
    enqueueWebhook: async input => {
      calls.push(input);
      return { duplicate: false, event_id: "inbox-id" };
    },
  });
  const app = express();
  app.post(
    "/webhooks/calendly/:connectionId",
    express.raw({ type: "application/json" }),
    createCalendlyWebhookHandler({ service })
  );
  const body = JSON.stringify({
    event: "invitee.created",
    payload: { uri: "https://api.calendly.com/invitees/invitee-1" },
  });
  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/webhooks/calendly/${CONNECTION}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "calendly-webhook-signature": "t=1788000000,v1=already-verified",
      },
      body,
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { received: true, duplicate: false });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].connectionId, CONNECTION);
  assert.equal(Buffer.isBuffer(calls[0].rawBody), true);
  assert.equal(calls[0].signatureTimestamp, 1788000000);
});

test("legacy unsigned Calendly webhook endpoint is absent", () => {
  const genericWebhookSource = fs.readFileSync(
    path.resolve(currentDir, "../../webhooks/index.js"),
    "utf8"
  );
  assert.doesNotMatch(
    genericWebhookSource,
    /router\.post\(["']\/calendly["']/,
    "Calendly must only be accepted by the signed connection-scoped ingress"
  );
});

test("OAuth callback redirects only to the configured frontend and allowlisted state path", async () => {
  const previous = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL = "https://app.example.test";
  try {
    const app = express();
    app.get(
      "/callback",
      createCalendlyOAuthCallbackHandler({
        service: serviceStub({
          finishOAuth: async () => ({ return_path: "/calendar" }),
        }),
      })
    );
    await withServer(app, async baseUrl => {
      const response = await fetch(`${baseUrl}/callback?state=s&code=c`, {
        redirect: "manual",
      });
      assert.equal(response.status, 303);
      assert.equal(
        response.headers.get("location"),
        "https://app.example.test/calendar?calendar=connected"
      );
    });
  } finally {
    if (previous === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = previous;
  }
});
