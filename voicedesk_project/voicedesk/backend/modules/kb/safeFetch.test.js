import assert from "node:assert/strict";
import test from "node:test";

import {
  SafeFetchError,
  createSafeFetch,
  isPublicAddress,
} from "./safeFetch.js";

const PUBLIC_V4 = "93.184.216.34";
const SECOND_PUBLIC_V4 = "1.1.1.1";

function response({
  status = 200,
  headers = { "content-type": "text/html; charset=utf-8" },
  body = "<main>ok</main>",
} = {}) {
  return { statusCode: status, headers, body };
}

function publicLookup(address = PUBLIC_V4) {
  return async () => [{ address, family: address.includes(":") ? 6 : 4 }];
}

function fakeTransport(handler, calls = []) {
  return async context => {
    calls.push(context);
    return typeof handler === "function" ? handler(context) : handler;
  };
}

function assertSafeCode(expected) {
  return error => {
    assert.ok(error instanceof SafeFetchError);
    assert.equal(error.code, expected);
    return true;
  };
}

test("l'allowlist est fail-closed et ne fait aucun DNS hors domaine", async () => {
  let lookups = 0;
  let requests = 0;
  const fetch = createSafeFetch({
    allowedDomains: "",
    lookupAll: async () => {
      lookups += 1;
      return [{ address: PUBLIC_V4, family: 4 }];
    },
    transport: async () => {
      requests += 1;
      return response();
    },
  });

  await assert.rejects(
    fetch("https://example.com/"),
    assertSafeCode("domain_not_allowed")
  );
  assert.equal(lookups, 0);
  assert.equal(requests, 0);
});

test("l'allowlist accepte les domaines exacts et les wildcards sans suffix confusion", async () => {
  const transport = fakeTransport(response());
  const fetch = createSafeFetch({
    allowedDomains: "example.com, *.example.com",
    lookupAll: publicLookup(),
    transport,
  });

  assert.equal((await fetch("https://example.com/")).status, 200);
  assert.equal((await fetch("https://docs.example.com/")).status, 200);
  await assert.rejects(
    fetch("https://example.com.attacker.test/"),
    assertSafeCode("domain_not_allowed")
  );
});

test("une entrée d'allowlist malformée fait échouer la configuration", () => {
  assert.throws(
    () => createSafeFetch({ allowedDomains: "https://example.com" }),
    assertSafeCode("invalid_allowed_domain")
  );
});

test("HTTPS est obligatoire par défaut, HTTP exige un opt-in explicite", async () => {
  const base = {
    allowedDomains: "example.com",
    lookupAll: publicLookup(),
    transport: fakeTransport(response()),
  };
  await assert.rejects(
    createSafeFetch(base)("http://example.com/"),
    assertSafeCode("https_required")
  );

  const allowed = createSafeFetch({ ...base, allowHttp: true });
  assert.equal((await allowed("http://example.com/")).status, 200);
});

test("les credentials URL et ports non standards sont rejetés avant DNS", async () => {
  let lookups = 0;
  const fetch = createSafeFetch({
    allowedDomains: "example.com",
    lookupAll: async () => {
      lookups += 1;
      return [{ address: PUBLIC_V4, family: 4 }];
    },
    transport: fakeTransport(response()),
  });

  await assert.rejects(
    fetch("https://user:secret@example.com/"),
    assertSafeCode("userinfo_forbidden")
  );
  await assert.rejects(
    fetch("https://example.com:8443/"),
    assertSafeCode("non_standard_port")
  );
  assert.equal(lookups, 0);

  // WHATWG normalizes an explicit standard port to the protocol default.
  assert.equal((await fetch("https://example.com:443/")).status, 200);
});

test("la classification IP bloque les plages IPv4 privées et réservées", () => {
  const blocked = [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.31.255.255",
    "192.0.0.9",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.8",
    "203.0.113.8",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
  ];
  for (const address of blocked) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ["1.1.1.1", "8.8.8.8", PUBLIC_V4]) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test("la classification IP bloque IPv6 local, transition, documentation et réservé", () => {
  const blocked = [
    "::",
    "::1",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "100::1",
    "2001::1",
    "2001:db8::1",
    "2002:0808:0808::1",
    "3ffe::1",
    "3fff::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fec0::1",
    "ff02::1",
  ];
  for (const address of blocked) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ["2001:4860:4860::8888", "2606:4700:4700::1111"]) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test("toutes les réponses DNS sont validées et une réponse mixte est refusée", async () => {
  let requests = 0;
  const fetch = createSafeFetch({
    allowedDomains: "example.com",
    lookupAll: async () => [
      { address: PUBLIC_V4, family: 4 },
      { address: "10.0.0.9", family: 4 },
    ],
    transport: async () => {
      requests += 1;
      return response();
    },
  });

  await assert.rejects(
    fetch("https://example.com/"),
    assertSafeCode("non_public_address")
  );
  assert.equal(requests, 0);
});

test("l'adresse validée est épinglée dans le transport avec le hostname TLS original", async () => {
  const calls = [];
  const fetch = createSafeFetch({
    allowedDomains: "example.com",
    lookupAll: async hostname => {
      assert.equal(hostname, "example.com");
      return [
        { address: PUBLIC_V4, family: 4 },
        { address: SECOND_PUBLIC_V4, family: 4 },
      ];
    },
    transport: fakeTransport(response(), calls),
  });

  await fetch("https://example.com/guide?q=kb", {
    headers: {
      Authorization: "Bearer must-not-leak",
      Cookie: "session=must-not-leak",
      Host: "attacker.test",
      "X-Api-Key": "must-not-leak",
      "User-Agent": "KB-Test/1",
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].address, PUBLIC_V4);
  assert.equal(calls[0].family, 4);
  assert.equal(calls[0].hostname, "example.com");
  assert.equal(calls[0].url.pathname, "/guide");
  assert.equal(calls[0].headers["user-agent"], "KB-Test/1");
  assert.equal(calls[0].headers["accept-encoding"], "identity");
  assert.equal(calls[0].headers.authorization, undefined);
  assert.equal(calls[0].headers.cookie, undefined);
  assert.equal(calls[0].headers.host, undefined);
  assert.equal(calls[0].headers["x-api-key"], undefined);
});

test("les redirects sont manuels, revalidés et repinnés à chaque saut", async () => {
  const calls = [];
  const fetch = createSafeFetch({
    allowedDomains: "example.com, cdn.example.net",
    lookupAll: async hostname => [{
      address: hostname === "example.com" ? PUBLIC_V4 : SECOND_PUBLIC_V4,
      family: 4,
    }],
    transport: fakeTransport(({ url }) => {
      if (url.hostname === "example.com") {
        return response({
          status: 302,
          headers: { location: "https://cdn.example.net/final" },
          body: "",
        });
      }
      return response({ body: "<main>final</main>" });
    }, calls),
  });

  const result = await fetch("https://example.com/start");
  assert.equal(await result.text(), "<main>final</main>");
  assert.equal(result.redirected, true);
  assert.equal(result.url, "https://cdn.example.net/final");
  assert.deepEqual(
    calls.map(call => [call.hostname, call.address]),
    [
      ["example.com", PUBLIC_V4],
      ["cdn.example.net", SECOND_PUBLIC_V4],
    ]
  );
});

test("un redirect allowlisté qui résout vers une IP privée est bloqué", async () => {
  const calls = [];
  const fetch = createSafeFetch({
    allowedDomains: "example.com, private.example.net",
    lookupAll: async hostname => [{
      address: hostname === "example.com" ? PUBLIC_V4 : "169.254.169.254",
      family: 4,
    }],
    transport: fakeTransport(() => response({
      status: 302,
      headers: { location: "https://private.example.net/latest/meta-data" },
      body: "",
    }), calls),
  });

  await assert.rejects(
    fetch("https://example.com/start"),
    assertSafeCode("non_public_address")
  );
  assert.equal(calls.length, 1);
});

test("au plus trois redirects sont suivis", async () => {
  const calls = [];
  const fetch = createSafeFetch({
    allowedDomains: "example.com",
    lookupAll: publicLookup(),
    transport: fakeTransport(({ url }) => {
      const step = Number(url.pathname.slice(1) || 0);
      return response({
        status: 302,
        headers: { location: `https://example.com/${step + 1}` },
        body: "",
      });
    }, calls),
  });

  await assert.rejects(
    fetch("https://example.com/0"),
    assertSafeCode("too_many_redirects")
  );
  assert.equal(calls.length, 4);
});

test("le timeout global court couvre aussi une résolution DNS bloquée", async () => {
  const fetch = createSafeFetch({
    allowedDomains: "example.com",
    timeoutMs: 20,
    lookupAll: () => new Promise(() => {}),
    transport: fakeTransport(response()),
  });

  await assert.rejects(
    fetch("https://example.com/"),
    assertSafeCode("request_timeout")
  );
});

test("le Content-Type est obligatoire et limité", async () => {
  for (const headers of [
    {},
    { "content-type": "application/json" },
  ]) {
    const fetch = createSafeFetch({
      allowedDomains: "example.com",
      lookupAll: publicLookup(),
      transport: fakeTransport(response({ headers })),
    });
    await assert.rejects(
      fetch("https://example.com/"),
      assertSafeCode("unsupported_content_type")
    );
  }
});

test("les contenus compressés sont refusés pour éviter la décompression non bornée", async () => {
  const fetch = createSafeFetch({
    allowedDomains: "example.com",
    lookupAll: publicLookup(),
    transport: fakeTransport(response({
      headers: {
        "content-type": "text/html",
        "content-encoding": "gzip",
      },
    })),
  });
  await assert.rejects(
    fetch("https://example.com/"),
    assertSafeCode("unsupported_content_encoding")
  );
});

test("Content-Length et le flux réel sont tous deux bornés", async t => {
  await t.test("Content-Length déclaré", async () => {
    const fetch = createSafeFetch({
      allowedDomains: "example.com",
      maxBytes: 8,
      lookupAll: publicLookup(),
      transport: fakeTransport(response({
        headers: {
          "content-type": "text/html",
          "content-length": "9",
        },
        body: "ignored",
      })),
    });
    await assert.rejects(
      fetch("https://example.com/"),
      assertSafeCode("response_too_large")
    );
  });

  await t.test("taille observée sans Content-Length", async () => {
    async function* oversizedBody() {
      yield Buffer.from("12345");
      yield Buffer.from("67890");
    }
    const fetch = createSafeFetch({
      allowedDomains: "example.com",
      maxBytes: 8,
      lookupAll: publicLookup(),
      transport: fakeTransport(response({ body: oversizedBody() })),
    });
    await assert.rejects(
      fetch("https://example.com/"),
      assertSafeCode("response_too_large")
    );
  });
});

test("une réponse HTML sous les limites expose une interface Response minimale", async () => {
  const fetch = createSafeFetch({
    allowedDomains: "example.com",
    maxBytes: 64,
    lookupAll: publicLookup(),
    transport: fakeTransport(response({
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-length": "15",
      },
      body: "<main>ok</main>",
    })),
  });

  const result = await fetch("https://example.com/");
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(await result.text(), "<main>ok</main>");
  assert.equal((await result.arrayBuffer()).byteLength, 15);
});
