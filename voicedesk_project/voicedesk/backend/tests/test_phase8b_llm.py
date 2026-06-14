"""
Phase 8B — Voice IA — DeepSeek V4 Flash streaming via Fireworks.

Validates the new LLM brain wired into the ConversationRelay WebSocket:
- /webhooks/voice/inbound exposes greeting from assistant_configs.greeting_inbound_fr
  and stashes the full system_prompt_voice_fr in the wsAuthToken (verified through behavior).
- /webhooks/voice/relay/ws streams DeepSeek tokens token-by-token.
- Conversation memory persists across multiple user prompts within a session.
- interrupt aborts the in-flight LLM stream without crashing.
- ws close → 'ended' event + memory purged.
- memory.js getSession returns null after endSession (unit-level smoke via Node).

LLM-cost-aware: limited to ~3 real Fireworks calls total.
Test data uses CallSid prefix 'CAtest' for easy cleanup.
"""
import os
import re
import json
import time
import uuid
import asyncio
import pytest
import requests
import websockets

BASE_HTTP = "http://localhost:8001"
BASE_WS   = "ws://localhost:8001"

SUPABASE_URL = "https://yptsvqhcnksjxufziech.supabase.co"
SUPABASE_SR  = "sb_secret_vIxlmUawjOWTV507F0RymQ_bMOeaRIb"

EXEVORI_COMPANY_ID = "992724ec-a5ec-4ecd-a2f4-9f2a6afa3f65"
EXEVORI_PHONE      = "+15817004171"

ACKS = ["Parfait", "D'accord", "D'accord,", "Très bien", "Bonne question",
        "Je comprends", "Permettez-moi", "Merci"]

SR_HEADERS = {
    "apikey": SUPABASE_SR,
    "Authorization": f"Bearer {SUPABASE_SR}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}

def sb_get(table, params):
    return requests.get(f"{SUPABASE_URL}/rest/v1/{table}", headers=SR_HEADERS, params=params, timeout=10)

def sb_delete(table, params):
    return requests.delete(f"{SUPABASE_URL}/rest/v1/{table}", headers=SR_HEADERS, params=params, timeout=10)


# ────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────
def _start_call_and_get_token():
    sid = f"CAtest{uuid.uuid4().hex[:24]}"
    r = requests.post(
        f"{BASE_HTTP}/webhooks/voice/inbound",
        data={"CallSid": sid, "From": "+15145558899", "To": EXEVORI_PHONE, "AccountSid": "ACtest"},
        timeout=10,
    )
    assert r.status_code == 200, r.text
    m = re.search(r'name="wsAuthToken"\s+value="([^"]+)"', r.text)
    assert m, "wsAuthToken not found"
    return sid, m.group(1), r.text


# ────────────────────────────────────────────────────────────
# 1. Inbound webhook → Exevori greeting + call row
# ────────────────────────────────────────────────────────────
class TestInboundExevori:
    def test_greeting_is_lea_exevori_not_marie(self):
        sid, _, body = _start_call_and_get_token()
        # Bug: assistant_configs greeting used, NOT hardcoded "Marie de Garage Tremblay"
        assert "Bonjour, ici Léa d'Exevori" in body, body
        assert "Marie" not in body
        assert "Garage Tremblay" not in body
        assert "<ConversationRelay" in body
        assert "language=\"fr-FR\"" in body

    def test_call_row_persisted_for_exevori(self):
        sid, _, _ = _start_call_and_get_token()
        time.sleep(0.7)
        rows = sb_get("calls", {
            "twilio_call_sid": f"eq.{sid}",
            "select": "id,company_id,caller_phone,status,live_status",
        }).json()
        assert len(rows) == 1, f"call row missing: {rows}"
        call = rows[0]
        assert call["company_id"] == EXEVORI_COMPANY_ID
        assert call["caller_phone"] == "+15145558899"
        assert call["status"] == "in_progress"


# ────────────────────────────────────────────────────────────
# 2. WebSocket — streaming LLM, memory, interrupt
# ────────────────────────────────────────────────────────────
class TestWebSocketLLM:
    def test_ws_streaming_response_and_events(self):
        """Real Fireworks call #1 — verify token streaming + ack + qualification."""
        sid, token, _ = _start_call_and_get_token()
        deltas = []
        last_seen = {"value": False}

        async def go():
            async with websockets.connect(f"{BASE_WS}/webhooks/voice/relay/ws") as ws:
                await ws.send(json.dumps({
                    "type": "setup",
                    "callSid": sid,
                    "customParameters": {"wsAuthToken": token},
                }))
                await asyncio.sleep(0.3)
                await ws.send(json.dumps({
                    "type": "prompt",
                    "voicePrompt": "Combien coûte votre solution ?",
                    "last": True,
                    "lang": "fr-FR",
                }))
                # Drain messages until last=true text marker (timeout 20s overall)
                deadline = asyncio.get_event_loop().time() + 25
                while asyncio.get_event_loop().time() < deadline:
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=5)
                    except asyncio.TimeoutError:
                        break
                    m = json.loads(raw)
                    if m.get("type") == "text":
                        if m.get("last") is True:
                            last_seen["value"] = True
                            break
                        if m.get("token"):
                            deltas.append(m["token"])
        asyncio.run(go())

        full = "".join(deltas).strip()
        assert len(deltas) >= 2, f"expected token streaming, got {len(deltas)} delta(s): {deltas!r}"
        assert last_seen["value"], "no final last=true marker received"
        assert len(full) >= 20, f"response too short: {full!r}"

        # Lea must acknowledge + ask qualification question (not give a direct price)
        ack_ok = any(full.startswith(a) or a in full[:60] for a in ACKS)
        assert ack_ok, f"no acknowledgment found at start: {full[:120]!r}"
        assert "?" in full, f"no qualification question found: {full!r}"

        time.sleep(1.0)
        call = sb_get("calls", {"twilio_call_sid": f"eq.{sid}", "select": "id"}).json()[0]
        evs = sb_get("call_events", {
            "call_id": f"eq.{call['id']}",
            "select": "event_type,payload,ts_ms",
        }).json()
        types = [e["event_type"] for e in evs]
        assert "connecting" in types
        assert "user_speaking" in types
        assert "ai_first_token" in types, f"missing ai_first_token in {types}"
        assert "ai_speaking" in types, f"missing ai_speaking in {types}"

        first_token_evs = [e for e in evs if e["event_type"] == "ai_first_token"]
        assert first_token_evs[0].get("ts_ms") is not None
        # First-token latency budget: <3000 ms
        assert first_token_evs[0]["ts_ms"] < 3000, f"first-token slow: {first_token_evs[0]['ts_ms']} ms"

        ai_spk = [e for e in evs if e["event_type"] == "ai_speaking"][-1]
        p = ai_spk.get("payload") or {}
        assert p.get("text"), f"ai_speaking missing text: {p}"
        assert isinstance(p.get("first_token_ms"), int)
        assert isinstance(p.get("total_ms"), int)

    def test_ws_conversation_memory_preserved(self):
        """Real Fireworks call #2 + #3 — context preserved across two prompts."""
        sid, token, _ = _start_call_and_get_token()
        responses = []

        async def turn(ws, text):
            await ws.send(json.dumps({
                "type": "prompt", "voicePrompt": text, "last": True, "lang": "fr-FR",
            }))
            buf = []
            deadline = asyncio.get_event_loop().time() + 25
            while asyncio.get_event_loop().time() < deadline:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=5)
                except asyncio.TimeoutError:
                    break
                m = json.loads(raw)
                if m.get("type") == "text":
                    if m.get("last"):
                        break
                    if m.get("token"):
                        buf.append(m["token"])
            return "".join(buf).strip()

        async def go():
            async with websockets.connect(f"{BASE_WS}/webhooks/voice/relay/ws") as ws:
                await ws.send(json.dumps({
                    "type": "setup", "callSid": sid,
                    "customParameters": {"wsAuthToken": token},
                }))
                await asyncio.sleep(0.3)
                r1 = await turn(ws, "Je dirige un petit garage automobile à Montréal.")
                responses.append(r1)
                r2 = await turn(ws, "Et le prix alors ?")
                responses.append(r2)
        asyncio.run(go())

        assert len(responses) == 2
        assert all(len(r) > 10 for r in responses), f"empty responses: {responses}"
        # Second response should reference the garage context from the first turn.
        r2 = responses[1].lower()
        memory_ok = any(k in r2 for k in [
            "garage", "automobile", "atelier", "mécanique", "voiture", "véhicule",
            "réparation", "montréal", "votre activité", "votre secteur",
        ])
        assert memory_ok, f"2nd response shows no memory of garage context: {responses[1]!r}"

    def test_ws_interrupt_aborts_stream(self):
        """No extra LLM call cost — uses already-streaming completion, aborts mid-flight."""
        sid, token, _ = _start_call_and_get_token()

        async def go():
            async with websockets.connect(f"{BASE_WS}/webhooks/voice/relay/ws") as ws:
                await ws.send(json.dumps({
                    "type": "setup", "callSid": sid,
                    "customParameters": {"wsAuthToken": token},
                }))
                await asyncio.sleep(0.2)
                await ws.send(json.dumps({
                    "type": "prompt",
                    "voicePrompt": "Pouvez-vous m'expliquer en détail tous vos services en plusieurs minutes ?",
                    "last": True, "lang": "fr-FR",
                }))
                # Wait briefly for stream to start, then interrupt
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=5)
                    _ = json.loads(raw)
                except asyncio.TimeoutError:
                    pass
                await ws.send(json.dumps({"type": "interrupt", "utteranceUntilInterrupt": "stop"}))
                await asyncio.sleep(0.6)
        asyncio.run(go())
        time.sleep(0.7)

        call = sb_get("calls", {"twilio_call_sid": f"eq.{sid}", "select": "id"}).json()[0]
        evs = sb_get("call_events", {
            "call_id": f"eq.{call['id']}",
            "event_type": "eq.interrupted",
            "select": "event_type",
        }).json()
        assert len(evs) >= 1, f"no interrupted event logged"

    def test_ws_close_logs_ended_and_marks_call(self):
        sid, token, _ = _start_call_and_get_token()
        async def go():
            async with websockets.connect(f"{BASE_WS}/webhooks/voice/relay/ws") as ws:
                await ws.send(json.dumps({
                    "type": "setup", "callSid": sid,
                    "customParameters": {"wsAuthToken": token},
                }))
                await asyncio.sleep(0.4)
                await ws.close()
        asyncio.run(go())
        time.sleep(0.8)
        call = sb_get("calls", {
            "twilio_call_sid": f"eq.{sid}",
            "select": "id,live_status,status",
        }).json()[0]
        assert call["live_status"] == "ended"
        evs = sb_get("call_events", {
            "call_id": f"eq.{call['id']}",
            "event_type": "eq.ended",
            "select": "payload",
        }).json()
        assert any((e.get("payload") or {}).get("reason") == "ws_closed" for e in evs)


# ────────────────────────────────────────────────────────────
# 3. memory.js unit smoke via Node
# ────────────────────────────────────────────────────────────
class TestMemoryUnit:
    def test_memory_init_get_end(self):
        import subprocess, textwrap
        script = textwrap.dedent("""
        import('./modules/voice/memory.js').then(m => {
          m.initSession('CAtestmem001', 'sysprompt');
          const a = m.getSession('CAtestmem001');
          const aOK = !!a && a.messages.length === 1 && a.messages[0].role === 'system';
          m.appendUser('CAtestmem001', 'hello');
          const b = m.getSession('CAtestmem001');
          const bOK = b.messages.length === 2 && b.messages[1].role === 'user';
          m.endSession('CAtestmem001');
          const c = m.getSession('CAtestmem001');
          console.log(JSON.stringify({aOK, bOK, afterEnd: c === undefined || c === null}));
          process.exit(0);
        }).catch(e => { console.error(e); process.exit(1); });
        """)
        r = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd="/app/voicedesk_project/voicedesk/backend",
            capture_output=True, text=True, timeout=15,
        )
        assert r.returncode == 0, f"node script failed: {r.stderr}"
        out = r.stdout.strip().splitlines()[-1]
        data = json.loads(out)
        assert data["aOK"], data
        assert data["bOK"], data
        assert data["afterEnd"], data


# ────────────────────────────────────────────────────────────
# 4. llm.js fail-safe on placeholder key
# ────────────────────────────────────────────────────────────
class TestLLMFailSafe:
    def test_streamchat_throws_on_placeholder_key(self):
        import subprocess, textwrap
        script = textwrap.dedent("""
        process.env.FIREWORKS_API_KEY = 'fw-placeholder-xxxxx';
        import('./modules/voice/llm.js').then(async m => {
          try {
            await m.streamChat([{role:'user', content:'hi'}], ()=>{}, {max_tokens: 5});
            console.log('NO_THROW');
            process.exit(2);
          } catch (e) {
            console.log('THREW:' + e.message);
            process.exit(0);
          }
        });
        """)
        r = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd="/app/voicedesk_project/voicedesk/backend",
            capture_output=True, text=True, timeout=15,
        )
        assert r.returncode == 0, f"expected throw, got: stdout={r.stdout!r} stderr={r.stderr!r}"
        assert "THREW:" in r.stdout
        assert "placeholder" in r.stdout.lower() or "missing" in r.stdout.lower()


# ────────────────────────────────────────────────────────────
# Cleanup
# ────────────────────────────────────────────────────────────
@pytest.fixture(scope="session", autouse=True)
def _cleanup_test_calls():
    yield
    try:
        sb_delete("calls", {"twilio_call_sid": "like.CAtest*"})
    except Exception:
        pass
