import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { domainToASCII } from "node:url";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_CONTENT_TYPES = Object.freeze([
  "text/html",
  "application/xhtml+xml",
  "text/plain",
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "user-agent",
]);

const IPV4_BLOCKED_CIDRS = Object.freeze([
  "0.0.0.0/8",       // Current network, including 0.0.0.0.
  "10.0.0.0/8",      // RFC 1918.
  "100.64.0.0/10",   // Shared address space.
  "127.0.0.0/8",     // Loopback.
  "169.254.0.0/16",  // Link-local and cloud metadata endpoints.
  "172.16.0.0/12",   // RFC 1918.
  "192.0.0.0/24",    // IETF protocol assignments.
  "192.0.2.0/24",    // Documentation.
  "192.31.196.0/24", // AS112 special-purpose service.
  "192.52.193.0/24", // AMT special-purpose relay anycast.
  "192.88.99.0/24",  // Deprecated 6to4 relay anycast.
  "192.168.0.0/16",  // RFC 1918.
  "192.175.48.0/24", // AS112 special-purpose service.
  "198.18.0.0/15",   // Benchmarking.
  "198.51.100.0/24", // Documentation.
  "203.0.113.0/24",  // Documentation.
  "224.0.0.0/4",     // Multicast.
  "240.0.0.0/4",     // Reserved and limited broadcast.
]);

// IPv6 is fail-closed: only ordinary 2000::/3 global unicast is accepted,
// with special-purpose allocations inside that range explicitly removed.
const IPV6_GLOBAL_UNICAST = "2000::/3";
const IPV6_BLOCKED_GLOBAL_CIDRS = Object.freeze([
  "2001::/23",       // IETF protocol assignments (Teredo, ORCHID, etc.).
  "2001:db8::/32",   // Documentation.
  "2002::/16",       // 6to4; can encode otherwise-blocked IPv4 targets.
  "3ffe::/16",       // Former 6bone allocation.
  "3fff::/20",       // Documentation.
]);

export class SafeFetchError extends Error {
  constructor(code, message = code, options = {}) {
    super(message, options);
    this.name = "SafeFetchError";
    this.code = code;
  }
}

class SafeFetchResponse {
  constructor({ status, headers, url, body }) {
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this.headers = headers instanceof Headers ? headers : new Headers(headers);
    this.url = url;
    this.redirected = false;
    this.#body = Buffer.from(body);
  }

  #body;

  async text() {
    return this.#body.toString("utf8");
  }

  async arrayBuffer() {
    return this.#body.buffer.slice(
      this.#body.byteOffset,
      this.#body.byteOffset + this.#body.byteLength
    );
  }
}

function integerOption(value, fallback, { min, max, name }) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function stripIpv6Brackets(hostname) {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function normalizeHostname(hostname) {
  const unwrapped = stripIpv6Brackets(String(hostname || "").trim());
  if (!unwrapped || unwrapped.includes("%")) return null;
  if (net.isIP(unwrapped)) return unwrapped.toLowerCase();

  const withoutTrailingDot = unwrapped.replace(/\.+$/, "");
  const ascii = domainToASCII(withoutTrailingDot).toLowerCase();
  if (!ascii || ascii.length > 253) return null;

  const labels = ascii.split(".");
  if (labels.some(label => (
    !label
    || label.length > 63
    || !/^[a-z0-9-]+$/.test(label)
    || label.startsWith("-")
    || label.endsWith("-")
  ))) {
    return null;
  }
  return ascii;
}

function parseAllowedDomains(value) {
  const entries = Array.isArray(value)
    ? value
    : String(value || "").split(/[\s,]+/);

  const rules = [];
  for (const rawEntry of entries) {
    const raw = String(rawEntry || "").trim();
    if (!raw) continue;

    const wildcard = raw.startsWith("*.");
    const candidate = wildcard ? raw.slice(2) : raw;
    const hostname = normalizeHostname(candidate);
    if (!hostname || (wildcard && net.isIP(hostname))) {
      throw new SafeFetchError(
        "invalid_allowed_domain",
        `Invalid KB scrape allowlist entry: ${raw}`
      );
    }
    rules.push({ hostname, wildcard });
  }
  return rules;
}

function hostnameAllowed(hostname, rules) {
  return rules.some(rule => (
    rule.wildcard
      ? hostname.endsWith(`.${rule.hostname}`)
      : hostname === rule.hostname
  ));
}

function parseIpv4(address) {
  if (net.isIP(address) !== 4) return null;
  const octets = address.split(".").map(Number);
  return (
    ((octets[0] << 24) >>> 0)
    + (octets[1] << 16)
    + (octets[2] << 8)
    + octets[3]
  ) >>> 0;
}

function parseIpv4Cidr(cidr) {
  const [address, prefixText] = cidr.split("/");
  const prefix = Number(prefixText);
  const value = parseIpv4(address);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { network: value & mask, mask };
}

const IPV4_BLOCKED_RANGES = IPV4_BLOCKED_CIDRS.map(parseIpv4Cidr);

function isBlockedIpv4(address) {
  const value = parseIpv4(address);
  if (value === null) return true;
  return IPV4_BLOCKED_RANGES.some(({ network, mask }) => (
    (value & mask) === network
  ));
}

function parseIpv6(address) {
  let input = stripIpv6Brackets(String(address || "").toLowerCase());
  if (!input || input.includes("%") || net.isIP(input) !== 6) return null;

  if (input.includes(".")) {
    const lastColon = input.lastIndexOf(":");
    const ipv4 = input.slice(lastColon + 1);
    const ipv4Value = parseIpv4(ipv4);
    if (ipv4Value === null) return null;
    const high = ((ipv4Value >>> 16) & 0xffff).toString(16);
    const low = (ipv4Value & 0xffff).toString(16);
    input = `${input.slice(0, lastColon)}:${high}:${low}`;
  }

  const doubleColonParts = input.split("::");
  if (doubleColonParts.length > 2) return null;

  const left = doubleColonParts[0]
    ? doubleColonParts[0].split(":")
    : [];
  const right = doubleColonParts.length === 2 && doubleColonParts[1]
    ? doubleColonParts[1].split(":")
    : [];
  const missing = 8 - left.length - right.length;
  if (
    (doubleColonParts.length === 1 && missing !== 0)
    || (doubleColonParts.length === 2 && missing < 1)
  ) {
    return null;
  }

  const groups = [
    ...left,
    ...Array(doubleColonParts.length === 2 ? missing : 0).fill("0"),
    ...right,
  ];
  if (
    groups.length !== 8
    || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))
  ) {
    return null;
  }

  return groups.reduce(
    (value, group) => (value << 16n) | BigInt(parseInt(group, 16)),
    0n
  );
}

function parseIpv6Cidr(cidr) {
  const [address, prefixText] = cidr.split("/");
  return { network: parseIpv6(address), prefix: Number(prefixText) };
}

function ipv6InCidr(value, { network, prefix }) {
  if (value === null || network === null) return false;
  const shift = 128n - BigInt(prefix);
  return (value >> shift) === (network >> shift);
}

const IPV6_GLOBAL_RANGE = parseIpv6Cidr(IPV6_GLOBAL_UNICAST);
const IPV6_BLOCKED_GLOBAL_RANGES = IPV6_BLOCKED_GLOBAL_CIDRS.map(parseIpv6Cidr);

function isBlockedIpv6(address) {
  const value = parseIpv6(address);
  if (value === null) return true;
  if (!ipv6InCidr(value, IPV6_GLOBAL_RANGE)) return true;
  return IPV6_BLOCKED_GLOBAL_RANGES.some(range => ipv6InCidr(value, range));
}

export function isPublicAddress(address) {
  const normalized = stripIpv6Brackets(String(address || "").trim());
  const family = net.isIP(normalized);
  if (family === 4) return !isBlockedIpv4(normalized);
  if (family === 6) return !isBlockedIpv6(normalized);
  return false;
}

function normalizeLookupRecords(records) {
  const list = Array.isArray(records) ? records : [records];
  const normalized = [];
  const seen = new Set();

  for (const record of list) {
    const rawAddress = typeof record === "string" ? record : record?.address;
    const address = stripIpv6Brackets(String(rawAddress || "").trim());
    const family = net.isIP(address);
    if (!family || !isPublicAddress(address)) {
      throw new SafeFetchError(
        "non_public_address",
        "KB scrape target resolved to a private or reserved address"
      );
    }
    const key = `${family}:${address}`;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push({ address, family });
    }
  }

  if (normalized.length === 0) {
    throw new SafeFetchError("dns_no_addresses", "KB scrape target has no address");
  }
  return normalized;
}

async function defaultLookupAll(hostname) {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function requestHeaders(input) {
  const source = new Headers(input || {});
  const result = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    if (source.has(name)) result[name] = source.get(name);
  }
  result.accept ||= "text/html,application/xhtml+xml,text/plain;q=0.8";
  result["user-agent"] ||= "ExevoriVoiceIA-KB-Bot/1.0 (+https://exevori.com)";
  // Avoid transparent decompression bombs. A compliant origin can always send
  // an identity representation for this bounded ingestion client.
  result["accept-encoding"] = "identity";
  return result;
}

function hostHeader(hostname, url) {
  const rendered = net.isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  return url.port ? `${rendered}:${url.port}` : rendered;
}

function defaultTransport({ url, hostname, address, family, headers, timeoutMs }) {
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const options = {
      protocol: url.protocol,
      hostname: address,
      family,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname || "/"}${url.search}`,
      method: "GET",
      headers: {
        ...headers,
        host: hostHeader(hostname, url),
      },
      agent: false,
    };
    if (url.protocol === "https:" && net.isIP(hostname) === 0) {
      options.servername = hostname;
    }

    const request = client.request(options, response => {
      clearTimeout(timer);
      resolve(response);
    });
    const timer = setTimeout(() => {
      request.destroy(new SafeFetchError(
        "request_timeout",
        "KB scrape request timed out"
      ));
    }, timeoutMs);
    timer.unref?.();

    request.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });
}

function remainingMs(deadline) {
  return Math.max(0, deadline - Date.now());
}

function withDeadline(promise, deadline, onTimeout) {
  const waitMs = remainingMs(deadline);
  if (waitMs <= 0) return Promise.reject(onTimeout());

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), waitMs);
    Promise.resolve(promise).then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function responseStatus(response) {
  return Number(response?.statusCode ?? response?.status);
}

function responseHeaders(response) {
  return response?.headers instanceof Headers
    ? response.headers
    : new Headers(response?.headers || {});
}

function closeResponse(response) {
  if (typeof response?.destroy === "function") response.destroy();
  else if (typeof response?.resume === "function") response.resume();
}

function bodyIterable(response) {
  const body = response?.body ?? response;
  if (body === null || body === undefined) return [];
  if (
    typeof body === "string"
    || Buffer.isBuffer(body)
    || body instanceof Uint8Array
  ) {
    return [body];
  }
  if (typeof body[Symbol.asyncIterator] === "function") return body;
  if (typeof body[Symbol.iterator] === "function") return body;
  throw new SafeFetchError("invalid_response_body", "Invalid KB scrape response body");
}

async function readBoundedBody(response, maxBytes, deadline) {
  const headers = responseHeaders(response);
  const contentLength = headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) {
      closeResponse(response);
      throw new SafeFetchError(
        "response_too_large",
        `KB scrape response exceeds ${maxBytes} bytes`
      );
    }
  }

  const chunks = [];
  let total = 0;
  const consume = (async () => {
    for await (const rawChunk of bodyIterable(response)) {
      const chunk = Buffer.isBuffer(rawChunk)
        ? rawChunk
        : Buffer.from(rawChunk);
      total += chunk.byteLength;
      if (total > maxBytes) {
        closeResponse(response);
        throw new SafeFetchError(
          "response_too_large",
          `KB scrape response exceeds ${maxBytes} bytes`
        );
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  })();

  return withDeadline(
    consume,
    deadline,
    () => {
      closeResponse(response);
      return new SafeFetchError("request_timeout", "KB scrape request timed out");
    }
  );
}

function normalizeContentTypes(values) {
  const list = Array.isArray(values) ? values : [values];
  const normalized = new Set(
    list.map(value => String(value || "").trim().toLowerCase()).filter(Boolean)
  );
  if (normalized.size === 0) {
    throw new TypeError("allowedContentTypes must not be empty");
  }
  return normalized;
}

function validateUrl(input, { allowHttp, allowedDomainRules }) {
  const raw = input instanceof URL ? input.href : String(input || "");
  if (!raw || raw.length > 2_048 || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new SafeFetchError("invalid_url", "Invalid KB scrape URL");
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError("invalid_url", "Invalid KB scrape URL");
  }

  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new SafeFetchError(
      "https_required",
      "KB scrape URLs must use HTTPS"
    );
  }
  if (url.username || url.password) {
    throw new SafeFetchError("userinfo_forbidden", "URL credentials are forbidden");
  }
  if (url.port) {
    throw new SafeFetchError(
      "non_standard_port",
      "Non-standard URL ports are forbidden"
    );
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) {
    throw new SafeFetchError("invalid_hostname", "Invalid KB scrape hostname");
  }
  if (!hostnameAllowed(hostname, allowedDomainRules)) {
    throw new SafeFetchError(
      "domain_not_allowed",
      "KB scrape hostname is not allowlisted"
    );
  }

  url.hash = "";
  return { url, hostname };
}

export function validateSafeUrl(
  input,
  {
    allowedDomains = process.env.KB_SCRAPE_ALLOWED_DOMAINS,
    allowHttp = false,
  } = {}
) {
  return validateUrl(input, {
    allowHttp: allowHttp === true,
    allowedDomainRules: parseAllowedDomains(allowedDomains),
  }).url.href;
}

async function resolvePinnedAddress(hostname, lookupAll, deadline) {
  if (net.isIP(hostname)) {
    return normalizeLookupRecords([{ address: hostname }])[0];
  }

  let records;
  try {
    records = await withDeadline(
      lookupAll(hostname),
      deadline,
      () => new SafeFetchError("request_timeout", "KB scrape DNS lookup timed out")
    );
  } catch (error) {
    if (error instanceof SafeFetchError) throw error;
    throw new SafeFetchError(
      "dns_lookup_failed",
      "KB scrape DNS lookup failed",
      { cause: error }
    );
  }
  // Reject the hostname if any answer is non-public; choosing only one public
  // record would leave mixed-answer rebinding attacks viable.
  return normalizeLookupRecords(records)[0];
}

function redirectTarget(location, currentUrl) {
  if (!location) {
    throw new SafeFetchError("invalid_redirect", "Redirect is missing Location");
  }
  try {
    return new URL(location, currentUrl);
  } catch {
    throw new SafeFetchError("invalid_redirect", "Redirect Location is invalid");
  }
}

/**
 * Creates a GET-only fetcher for KB scraping. The resolver and transport are
 * injectable so URL/DNS policy can be tested without opening real sockets.
 */
export function createSafeFetch({
  allowedDomains = process.env.KB_SCRAPE_ALLOWED_DOMAINS,
  allowHttp = false,
  lookupAll = defaultLookupAll,
  transport = defaultTransport,
  timeoutMs = process.env.KB_SCRAPE_TIMEOUT_MS,
  maxBytes = process.env.KB_SCRAPE_MAX_BYTES,
  maxRedirects = process.env.KB_SCRAPE_MAX_REDIRECTS,
  allowedContentTypes = DEFAULT_CONTENT_TYPES,
} = {}) {
  if (typeof lookupAll !== "function") throw new TypeError("lookupAll must be a function");
  if (typeof transport !== "function") throw new TypeError("transport must be a function");

  const allowedDomainRules = parseAllowedDomains(allowedDomains);
  const safeTimeoutMs = integerOption(timeoutMs, DEFAULT_TIMEOUT_MS, {
    min: 1,
    max: 30_000,
    name: "timeoutMs",
  });
  const safeMaxBytes = integerOption(maxBytes, DEFAULT_MAX_BYTES, {
    min: 1,
    max: 25 * 1024 * 1024,
    name: "maxBytes",
  });
  const safeMaxRedirects = integerOption(maxRedirects, DEFAULT_MAX_REDIRECTS, {
    min: 0,
    max: 3,
    name: "maxRedirects",
  });
  const safeContentTypes = normalizeContentTypes(allowedContentTypes);

  return async function safeFetchForKb(input, { headers } = {}) {
    const deadline = Date.now() + safeTimeoutMs;
    let current = input;
    let redirects = 0;

    while (true) {
      const { url, hostname } = validateUrl(current, {
        allowHttp: allowHttp === true,
        allowedDomainRules,
      });
      const pinned = await resolvePinnedAddress(hostname, lookupAll, deadline);

      let response;
      try {
        response = await withDeadline(
          transport({
            url,
            hostname,
            address: pinned.address,
            family: pinned.family,
            headers: requestHeaders(headers),
            timeoutMs: remainingMs(deadline),
          }),
          deadline,
          () => new SafeFetchError("request_timeout", "KB scrape request timed out")
        );
      } catch (error) {
        if (error instanceof SafeFetchError) throw error;
        throw new SafeFetchError(
          "network_error",
          "KB scrape network request failed",
          { cause: error }
        );
      }

      const status = responseStatus(response);
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        closeResponse(response);
        throw new SafeFetchError("invalid_response", "Invalid KB scrape response");
      }
      const headersObject = responseHeaders(response);

      if (REDIRECT_STATUSES.has(status)) {
        closeResponse(response);
        if (redirects >= safeMaxRedirects) {
          throw new SafeFetchError(
            "too_many_redirects",
            `KB scrape exceeded ${safeMaxRedirects} redirects`
          );
        }
        current = redirectTarget(headersObject.get("location"), url);
        redirects += 1;
        continue;
      }

      const contentEncoding = (headersObject.get("content-encoding") || "identity")
        .trim()
        .toLowerCase();
      if (contentEncoding !== "identity") {
        closeResponse(response);
        throw new SafeFetchError(
          "unsupported_content_encoding",
          "Compressed KB scrape responses are forbidden"
        );
      }

      const contentType = (headersObject.get("content-type") || "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase();
      if (!safeContentTypes.has(contentType)) {
        closeResponse(response);
        throw new SafeFetchError(
          "unsupported_content_type",
          "KB scrape response Content-Type is not allowed"
        );
      }

      const body = await readBoundedBody(response, safeMaxBytes, deadline);
      const result = new SafeFetchResponse({
        status,
        headers: headersObject,
        url: url.href,
        body,
      });
      result.redirected = redirects > 0;
      return result;
    }
  };
}

export async function safeFetch(input, options) {
  return createSafeFetch()(input, options);
}

export default safeFetch;
