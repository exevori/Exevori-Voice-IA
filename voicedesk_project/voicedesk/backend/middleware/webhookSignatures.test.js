import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { after, test } from "node:test";

import { validateCalendlySignature } from "./validateCalendlySignature.js";
import { validateElevenLabsSignature } from "./validateElevenLabsSignature.js";
import { validateStripeSignature } from "./validateStripeSignature.js";
import {
  computeTwilioSignature,
  validateTwilioSignature,
} from "./validateTwilioSignature.js";

const TEST_ENVIRONMENT = {
  TWILIO_AUTH_TOKEN: "twilio_test_auth_token",
  PUBLIC_BACKEND_URL: "https://voice.example.test",
  STRIPE_WEBHOOK_SECRET: "whsec_test_signature_secret",
  ELEVENLABS_WEBHOOK_SECRET: "elevenlabs_test_signature_secret",
  CALENDLY_WEBHOOK_SECRET: "calendly_test_signature_secret",
};

const originalEnvironment = Object.fromEntries(
  Object.keys(TEST_ENVIRONMENT).map(key => [key, process.env[key]])
);

Object.assign(process.env, TEST_ENVIRONMENT);

after(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function request({ body, headers = {}, originalUrl = "/" }) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );

  return {
    body,
    headers: normalizedHeaders,
    originalUrl,
    protocol: "https",
    get(name) {
      return normalizedHeaders[name.toLowerCase()];
    },
  };
}

function invoke(middleware, req) {
  const result = {
    status: 200,
    nextCalled: false,
    responseBody: null,
  };
  const res = {
    status(statusCode) {
      result.status = statusCode;
      return this;
    },
    json(body) {
      result.responseBody = body;
      return this;
    },
  };

  middleware(req, res, () => {
    result.nextCalled = true;
    result.status = 200;
  });

  return result;
}

async function invokeOverHttp({
  middleware,
  body,
  headers = {},
  originalUrl,
  parseBody = rawBody => rawBody,
}) {
  const server = http.createServer(async (incomingRequest, outgoingResponse) => {
    const chunks = [];
    for await (const chunk of incomingRequest) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks);
    const req = request({
      body: parseBody(rawBody),
      headers: incomingRequest.headers,
      originalUrl: incomingRequest.url,
    });
    const res = {
      status(statusCode) {
        outgoingResponse.statusCode = statusCode;
        return this;
      },
      json(payload) {
        outgoingResponse.setHeader("content-type", "application/json");
        outgoingResponse.end(JSON.stringify(payload));
        return this;
      },
    };

    middleware(req, res, () => {
      outgoingResponse.statusCode = 200;
      outgoingResponse.end("OK");
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    const response = await fetch(
      `http://127.0.0.1:${address.port}${originalUrl}`,
      { method: "POST", headers, body }
    );
    return response.status;
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function timestampedSignature({ body, secret, version, timestamp }) {
  const digest = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${body.toString("utf8")}`, "utf8")
    .digest("hex");
  return `t=${timestamp},${version}=${digest}`;
}

function withUnsetEnvironment(keys, callback) {
  const previousValues = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];

  try {
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previousValues)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("Serveur: les 4 middlewares sont montés avant les parseurs globaux", () => {
  const serverSource = fs.readFileSync(
    new URL("../index.js", import.meta.url),
    "utf8"
  );
  const globalJsonParserIndex = serverSource.indexOf(
    'app.use(express.json({ limit: "10mb" }))'
  );

  assert.ok(globalJsonParserIndex > 0);
  for (const middlewareName of [
    "validateTwilioSignature",
    "validateStripeSignature",
    "validateElevenLabsSignature",
    "validateCalendlySignature",
  ]) {
    const importIndex = serverSource.indexOf(`import { ${middlewareName} }`);
    const mountIndex = serverSource.indexOf(`  ${middlewareName}`, importIndex + 1);
    assert.ok(importIndex >= 0, `${middlewareName} doit être importé`);
    assert.ok(
      mountIndex > importIndex && mountIndex < globalJsonParserIndex,
      `${middlewareName} doit être monté avant express.json`
    );
  }
});

test("Configuration: chaque fournisseur échoue fermé sans secret", () => {
  const cases = [
    {
      middleware: validateTwilioSignature,
      keys: ["TWILIO_AUTH_TOKEN"],
      req: request({ body: {} }),
    },
    {
      middleware: validateStripeSignature,
      keys: ["STRIPE_WEBHOOK_SECRET"],
      req: request({ body: Buffer.from("{}") }),
    },
    {
      middleware: validateElevenLabsSignature,
      keys: ["ELEVENLABS_WEBHOOK_SECRET"],
      req: request({ body: Buffer.from("{}") }),
    },
    {
      middleware: validateCalendlySignature,
      keys: ["CALENDLY_WEBHOOK_SECRET", "CALENDLY_WEBHOOK_SIGNING_KEY"],
      req: request({ body: Buffer.from("{}") }),
    },
  ];

  for (const providerCase of cases) {
    const result = withUnsetEnvironment(
      providerCase.keys,
      () => invoke(providerCase.middleware, providerCase.req)
    );
    assert.equal(result.status, 503);
    assert.equal(result.nextCalled, false);
  }
});

test("HTTP: chaque fournisseur retourne 403 sans signature et 200 si valide", async () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const twilioParams = { CallSid: "CA_http_test", CallStatus: "completed" };
  const twilioBody = new URLSearchParams(twilioParams).toString();
  const stripeBody = Buffer.from('{"id":"evt_http_test"}');
  const elevenLabsBody = Buffer.from('{"type":"post_call_transcription"}');
  const calendlyBody = Buffer.from('{"event":"invitee.created"}');
  const providers = [
    {
      name: "Twilio",
      middleware: validateTwilioSignature,
      body: twilioBody,
      originalUrl: "/webhooks/twilio/status",
      baseHeaders: { "content-type": "application/x-www-form-urlencoded" },
      signatureHeaders: {
        "x-twilio-signature": computeTwilioSignature(
          TEST_ENVIRONMENT.TWILIO_AUTH_TOKEN,
          "https://voice.example.test/webhooks/twilio/status",
          twilioParams
        ),
      },
      parseBody: rawBody =>
        Object.fromEntries(new URLSearchParams(rawBody.toString("utf8"))),
    },
    {
      name: "Stripe",
      middleware: validateStripeSignature,
      body: stripeBody,
      originalUrl: "/webhooks/stripe",
      baseHeaders: { "content-type": "application/json" },
      signatureHeaders: {
        "stripe-signature": timestampedSignature({
          body: stripeBody,
          secret: TEST_ENVIRONMENT.STRIPE_WEBHOOK_SECRET,
          version: "v1",
          timestamp,
        }),
      },
    },
    {
      name: "ElevenLabs",
      middleware: validateElevenLabsSignature,
      body: elevenLabsBody,
      originalUrl: "/api/voice/call-complete",
      baseHeaders: { "content-type": "application/json" },
      signatureHeaders: {
        "elevenlabs-signature": timestampedSignature({
          body: elevenLabsBody,
          secret: TEST_ENVIRONMENT.ELEVENLABS_WEBHOOK_SECRET,
          version: "v0",
          timestamp,
        }),
      },
    },
    {
      name: "Calendly",
      middleware: validateCalendlySignature,
      body: calendlyBody,
      originalUrl: "/webhooks/calendly",
      baseHeaders: { "content-type": "application/json" },
      signatureHeaders: {
        "calendly-webhook-signature": timestampedSignature({
          body: calendlyBody,
          secret: TEST_ENVIRONMENT.CALENDLY_WEBHOOK_SECRET,
          version: "v1",
          timestamp,
        }),
      },
    },
  ];

  for (const provider of providers) {
    const withoutSignature = await invokeOverHttp({
      middleware: provider.middleware,
      body: provider.body,
      headers: provider.baseHeaders,
      originalUrl: provider.originalUrl,
      parseBody: provider.parseBody,
    });
    assert.equal(withoutSignature, 403, `${provider.name} sans signature`);

    const withValidSignature = await invokeOverHttp({
      middleware: provider.middleware,
      body: provider.body,
      headers: {
        ...provider.baseHeaders,
        ...provider.signatureHeaders,
      },
      originalUrl: provider.originalUrl,
      parseBody: provider.parseBody,
    });
    assert.equal(withValidSignature, 200, `${provider.name} signature valide`);
  }
});

test("Twilio: signature absente -> 403", () => {
  const result = invoke(
    validateTwilioSignature,
    request({
      body: { CallSid: "CA_test", CallStatus: "completed" },
      originalUrl: "/webhooks/twilio/status",
    })
  );

  assert.equal(result.status, 403);
  assert.equal(result.nextCalled, false);
});

test("Twilio: vecteur officiel HMAC-SHA1", () => {
  const signature = computeTwilioSignature(
    "12345",
    "https://example.com/myapp.php?foo=1&bar=2",
    {
      CallSid: "CA1234567890ABCDE",
      Caller: "+14158675310",
      Digits: "1234",
      From: "+14158675310",
      To: "+18005551212",
    }
  );

  assert.equal(signature, "L/OH5YylLD5NRKLltdqwSvS0BnU=");
});

test("Twilio: signature valide -> 200", () => {
  const body = { CallSid: "CA_test", CallStatus: "completed" };
  const url = "https://voice.example.test/webhooks/twilio/status";
  const signature = computeTwilioSignature(
    TEST_ENVIRONMENT.TWILIO_AUTH_TOKEN,
    url,
    body
  );
  const result = invoke(
    validateTwilioSignature,
    request({
      body,
      headers: { "x-twilio-signature": signature },
      originalUrl: "/webhooks/twilio/status",
    })
  );

  assert.equal(result.status, 200);
  assert.equal(result.nextCalled, true);
});

test("Twilio: paramètres altérés -> 403", () => {
  const signedBody = { CallSid: "CA_test", CallStatus: "completed" };
  const signature = computeTwilioSignature(
    TEST_ENVIRONMENT.TWILIO_AUTH_TOKEN,
    "https://voice.example.test/webhooks/twilio/status",
    signedBody
  );
  const result = invoke(
    validateTwilioSignature,
    request({
      body: { ...signedBody, CallStatus: "failed" },
      headers: { "x-twilio-signature": signature },
      originalUrl: "/webhooks/twilio/status",
    })
  );

  assert.equal(result.status, 403);
});

test("Stripe: signature absente -> 403", () => {
  const result = invoke(
    validateStripeSignature,
    request({ body: Buffer.from('{"id":"evt_test"}') })
  );

  assert.equal(result.status, 403);
  assert.equal(result.nextCalled, false);
});

test("Stripe: signature valide -> 200", () => {
  const body = Buffer.from('{"id":"evt_test","type":"checkout.session.completed"}');
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = timestampedSignature({
    body,
    secret: TEST_ENVIRONMENT.STRIPE_WEBHOOK_SECRET,
    version: "v1",
    timestamp,
  });
  const result = invoke(
    validateStripeSignature,
    request({ body, headers: { "stripe-signature": signature } })
  );

  assert.equal(result.status, 200);
  assert.equal(result.nextCalled, true);
});

test("Stripe: corps altéré -> 403", () => {
  const signedBody = Buffer.from('{"id":"evt_test"}');
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = timestampedSignature({
    body: signedBody,
    secret: TEST_ENVIRONMENT.STRIPE_WEBHOOK_SECRET,
    version: "v1",
    timestamp,
  });
  const result = invoke(
    validateStripeSignature,
    request({
      body: Buffer.from('{"id":"evt_other"}'),
      headers: { "stripe-signature": signature },
    })
  );

  assert.equal(result.status, 403);
});

test("ElevenLabs: signature absente -> 403", () => {
  const result = invoke(
    validateElevenLabsSignature,
    request({ body: Buffer.from('{"type":"post_call_transcription"}') })
  );

  assert.equal(result.status, 403);
  assert.equal(result.nextCalled, false);
});

test("ElevenLabs: signature valide -> 200", () => {
  const body = Buffer.from('{"type":"post_call_transcription"}');
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = timestampedSignature({
    body,
    secret: TEST_ENVIRONMENT.ELEVENLABS_WEBHOOK_SECRET,
    version: "v0",
    timestamp,
  });
  const result = invoke(
    validateElevenLabsSignature,
    request({ body, headers: { "elevenlabs-signature": signature } })
  );

  assert.equal(result.status, 200);
  assert.equal(result.nextCalled, true);
});

test("ElevenLabs: timestamp expiré -> 403", () => {
  const body = Buffer.from('{"type":"post_call_transcription"}');
  const timestamp = Math.floor(Date.now() / 1000) - 301;
  const signature = timestampedSignature({
    body,
    secret: TEST_ENVIRONMENT.ELEVENLABS_WEBHOOK_SECRET,
    version: "v0",
    timestamp,
  });
  const result = invoke(
    validateElevenLabsSignature,
    request({ body, headers: { "elevenlabs-signature": signature } })
  );

  assert.equal(result.status, 403);
});

test("Calendly: signature absente -> 403", () => {
  const result = invoke(
    validateCalendlySignature,
    request({ body: Buffer.from('{"event":"invitee.created"}') })
  );

  assert.equal(result.status, 403);
  assert.equal(result.nextCalled, false);
});

test("Calendly: signature valide -> 200", () => {
  const body = Buffer.from('{"event":"invitee.created"}');
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = timestampedSignature({
    body,
    secret: TEST_ENVIRONMENT.CALENDLY_WEBHOOK_SECRET,
    version: "v1",
    timestamp,
  });
  const result = invoke(
    validateCalendlySignature,
    request({
      body,
      headers: { "calendly-webhook-signature": signature },
    })
  );

  assert.equal(result.status, 200);
  assert.equal(result.nextCalled, true);
});

test("Calendly: timestamp expiré -> 403", () => {
  const body = Buffer.from('{"event":"invitee.created"}');
  const timestamp = Math.floor(Date.now() / 1000) - 301;
  const signature = timestampedSignature({
    body,
    secret: TEST_ENVIRONMENT.CALENDLY_WEBHOOK_SECRET,
    version: "v1",
    timestamp,
  });
  const result = invoke(
    validateCalendlySignature,
    request({
      body,
      headers: { "calendly-webhook-signature": signature },
    })
  );

  assert.equal(result.status, 403);
});
