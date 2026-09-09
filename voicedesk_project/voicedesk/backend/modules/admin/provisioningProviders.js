const OPAQUE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const PHONE_SID = /^PN[0-9a-f]{32}$/i;
const ACCOUNT_SID = /^AC[0-9a-f]{32}$/i;

export function createProvisioningProviders({ env = process.env, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const masterAccount = env.TWILIO_ACCOUNT_SID;
  async function request(provider, path, { method = "GET", body } = {}) {
    const twilio = provider === "twilio";
    if (twilio ? !ACCOUNT_SID.test(masterAccount || "") || !env.TWILIO_AUTH_TOKEN : !env.ELEVENLABS_API_KEY) {
      return { state: "not_configured" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${twilio ? "https://api.twilio.com" : "https://api.elevenlabs.io"}${path}`, {
        method, signal: controller.signal, redirect: "error",
        headers: {
          ...(twilio ? { Authorization: `Basic ${Buffer.from(`${masterAccount}:${env.TWILIO_AUTH_TOKEN}`).toString("base64")}` }
            : { "xi-api-key": env.ELEVENLABS_API_KEY }),
          ...(body ? { "Content-Type": "application/json" } : {}),
        }, ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel?.();
        return { state: response.status === 404 ? "missing" : [401, 403].includes(response.status) ? "unauthorized" : "unavailable" };
      }
      return { state: "ok", data: await response.json() };
    } catch { return { state: controller.signal.aborted ? "timeout" : "unavailable" }; }
    finally { clearTimeout(timer); }
  }
  return {
    masterAccount,
    async twilioNumber(sid) {
      if (!PHONE_SID.test(sid || "")) return { state: "invalid_id" };
      const base = `/2010-04-01/Accounts/${encodeURIComponent(masterAccount || "")}`;
      const [account, number] = await Promise.all([
        request("twilio", `${base}.json`), request("twilio", `${base}/IncomingPhoneNumbers/${sid}.json`),
      ]);
      if (account.state !== "ok") return { state: account.state };
      if (account.data?.sid !== masterAccount || account.data?.status !== "active") return { state: "account_inactive_or_mismatch" };
      if (number.state !== "ok") return { state: number.state };
      const row = number.data;
      // Explicit projection: the account response contains an auth_token.
      return { state: "ok", data: { sid: row?.sid, account_sid: row?.account_sid,
        phone_number: row?.phone_number, status: row?.status, voice: row?.capabilities?.voice } };
    },
    async agent(id) {
      if (!OPAQUE_ID.test(id || "")) return { state: "invalid_id" };
      const result = await request("elevenlabs", `/v1/convai/agents/${encodeURIComponent(id)}`);
      return result.state === "ok" ? { state: "ok", data: { agent_id: result.data?.agent_id } } : result;
    },
    async phone(id) {
      if (!OPAQUE_ID.test(id || "")) return { state: "invalid_id" };
      const result = await request("elevenlabs", `/v1/convai/phone-numbers/${encodeURIComponent(id)}`);
      if (result.state !== "ok") return result;
      const row = result.data;
      return { state: "ok", data: { phone_number_id: row?.phone_number_id, phone_number: row?.phone_number,
        provider: row?.provider, assigned_agent: row?.assigned_agent === null ? null : row?.assigned_agent
          ? { agent_id: row.assigned_agent.agent_id } : undefined } };
    },
    async assignPhone(phoneId, agentId) {
      if (!OPAQUE_ID.test(phoneId || "") || !OPAQUE_ID.test(agentId || "")) return { state: "invalid_id" };
      const result = await request("elevenlabs", `/v1/convai/phone-numbers/${encodeURIComponent(phoneId)}`,
        { method: "PATCH", body: { agent_id: agentId } });
      // Always verify with a separate GET; never expose the raw provider body.
      return { state: result.state };
    },
  };
}
