"""
Phase 8A Voice Foundation — Backend tests.

Validates the Twilio ConversationRelay plumbing:
- POST /webhooks/voice/inbound (fallback + configured)
- POST /webhooks/voice/status (ringing/completed/failed)
- POST /webhooks/voice/relay-action
- WebSocket /webhooks/voice/relay/ws (setup/prompt/interrupt/dtmf/close)
- DB lifecycle (calls + call_events)
- RLS visibility via /api/v1/calls
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
SUPABASE_ANON = "sb_publishable_avATcYb4hXUF-_MKPNnYwg_9Q8uI9vl"
SUPABASE_SERVICE_ROLE = "sb_secret_vIxlmUawjOWTV507F0RymQ_bMOeaRIb"

QA_BOT_EMAIL = "qa-bot@garage-tremblay.test"
QA_BOT_PASSWORD = "QaBot_Test_2026!"
COMPANY_ID = "af5f079f-6fc2-4d70-8c8d-51d83d301906"
TEST_PHONE = "+14181112222"

# ---------- Supabase REST helpers (service role) ----------
SR_HEADERS = {
    "apikey": SUPABASE_SERVICE_ROLE,
    "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}

def sb_get(table, params):
    r = requests.get(f"{SUPABASE_URL}/rest/v1/{table}", headers=SR_HEADERS, params=params, timeout=10)
    return r

def sb_insert(table, payload):
    r = requests.post(f"{SUPABASE_URL}/rest/v1/{table}", headers=SR_HEADERS, json=payload, timeout=10)
    return r

def sb_delete(table, params):
    h = dict(SR_HEADERS)
    r = requests.delete(f"{SUPABASE_URL}/rest/v1/{table}", headers=h, params=params, timeout=10)
    return r


# ---------- Fixtures ----------
@pytest.fixture(scope="session", autouse=True)
def twilio_config_seed():
    """Insert a temporary twilio_configs row for qa-bot pointing at TEST_PHONE."""
    # cleanup first
    sb_delete("twilio_configs", {"company_id": f"eq.{COMPANY_ID}"})
    payload = {
        "company_id": COMPANY_ID,
        "account_sid": "AC00000000000000000000000000000000",
        "auth_token_encrypted": "x", "auth_token_iv": "x", "auth_token_tag": "x",
        "phone_number": TEST_PHONE,
        "forwarding_number": "+15145550000",
        "status": "active",
        "last_test_ok": True,
        "twilio_account_name": "TEST_phase8a",
    }
    r = sb_insert("twilio_configs", payload)
    assert r.status_code in (200, 201), f"seed twilio_configs failed: {r.status_code} {r.text}"
    yield
    sb_delete("twilio_configs", {"company_id": f"eq.{COMPANY_ID}"})


@pytest.fixture(scope="session")
def auth_token():
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        headers={"apikey": SUPABASE_ANON, "Content-Type": "application/json"},
        json={"email": QA_BOT_EMAIL, "password": QA_BOT_PASSWORD},
        timeout=10,
    )
    assert r.status_code == 200, f"qa-bot login failed: {r.status_code} {r.text}"
    return r.json()["access_token"]


# ---------- Tests ----------
class TestInboundWebhook:
    def test_inbound_unknown_number_returns_hangup(self):
        sid = f"CAtest{uuid.uuid4().hex[:24]}"
        r = requests.post(
            f"{BASE_HTTP}/webhooks/voice/inbound",
            data={"CallSid": sid, "From": "+15145551234", "To": "+19999999999", "AccountSid": "ACfake"},
            timeout=10,
        )
        assert r.status_code == 200
        assert "<Say" in r.text
        assert "<Hangup/>" in r.text
        assert "<Connect" not in r.text

    def test_inbound_configured_number_returns_connect_relay(self):
        sid = f"CAtest{uuid.uuid4().hex[:24]}"
        r = requests.post(
            f"{BASE_HTTP}/webhooks/voice/inbound",
            data={"CallSid": sid, "From": "+15145551234", "To": TEST_PHONE, "AccountSid": "ACfake"},
            timeout=10,
        )
        assert r.status_code == 200, r.text
        body = r.text
        assert "<Connect" in body
        assert "<ConversationRelay" in body
        assert 'language="fr-FR"' in body
        assert 'transcriptionProvider="Deepgram"' in body
        assert 'speechModel="nova-2-general"' in body
        assert "Bonjour, ici Marie" in body
        assert 'name="wsAuthToken"' in body
        assert "wss://" in body and "/webhooks/voice/relay/ws" in body
        # Stash for next test
        m = re.search(r'name="wsAuthToken"\s+value="([^"]+)"', body)
        assert m, f"wsAuthToken parameter not found in TwiML: {body[:500]}"

    def test_inbound_creates_call_row_and_started_event(self):
        sid = f"CAtest{uuid.uuid4().hex[:24]}"
        r = requests.post(
            f"{BASE_HTTP}/webhooks/voice/inbound",
            data={"CallSid": sid, "From": "+15145557777", "To": TEST_PHONE, "AccountSid": "ACtest"},
            timeout=10,
        )
        assert r.status_code == 200
        time.sleep(0.6)
        rows = sb_get("calls", {"twilio_call_sid": f"eq.{sid}", "select": "id,company_id,caller_phone,live_status,status"}).json()
        assert len(rows) == 1, f"call row not created: {rows}"
        call = rows[0]
        assert call["company_id"] == COMPANY_ID
        assert call["caller_phone"] == "+15145557777"
        assert call["live_status"] == "connecting"
        assert call["status"] == "in_progress"
        events = sb_get("call_events", {"call_id": f"eq.{call['id']}", "event_type": "eq.started", "select": "event_type,payload"}).json()
        assert len(events) >= 1, f"started event not logged: {events}"


class TestStatusWebhook:
    def _create_call(self):
        sid = f"CAtest{uuid.uuid4().hex[:24]}"
        requests.post(
            f"{BASE_HTTP}/webhooks/voice/inbound",
            data={"CallSid": sid, "From": "+15145559999", "To": TEST_PHONE, "AccountSid": "ACtest"},
            timeout=10,
        )
        time.sleep(0.4)
        return sid

    def test_status_completed_marks_ended(self):
        sid = self._create_call()
        r = requests.post(
            f"{BASE_HTTP}/webhooks/voice/status",
            data={"CallSid": sid, "CallStatus": "completed", "CallDuration": "42"},
            timeout=10,
        )
        assert r.status_code == 200
        time.sleep(0.6)
        call = sb_get("calls", {"twilio_call_sid": f"eq.{sid}", "select": "id,live_status,status,duration_seconds"}).json()[0]
        assert call["live_status"] == "ended"
        assert call["status"] == "completed"
        assert call["duration_seconds"] == 42
        events = sb_get("call_events", {"call_id": f"eq.{call['id']}", "event_type": "eq.ended", "select": "event_type"}).json()
        assert len(events) >= 1

    def test_status_ringing_sets_live_status(self):
        sid = self._create_call()
        r = requests.post(
            f"{BASE_HTTP}/webhooks/voice/status",
            data={"CallSid": sid, "CallStatus": "ringing"},
            timeout=10,
        )
        assert r.status_code == 200
        time.sleep(0.5)
        call = sb_get("calls", {"twilio_call_sid": f"eq.{sid}", "select": "live_status"}).json()[0]
        assert call["live_status"] == "ringing"

    def test_status_failed_marks_failed_and_error_event(self):
        sid = self._create_call()
        r = requests.post(
            f"{BASE_HTTP}/webhooks/voice/status",
            data={"CallSid": sid, "CallStatus": "failed"},
            timeout=10,
        )
        assert r.status_code == 200
        time.sleep(0.5)
        call = sb_get("calls", {"twilio_call_sid": f"eq.{sid}", "select": "id,status,live_status"}).json()[0]
        assert call["status"] == "abandoned"
        events = sb_get("call_events", {"call_id": f"eq.{call['id']}", "event_type": "eq.error", "select": "event_type"}).json()
        assert len(events) >= 1


class TestRelayAction:
    def test_relay_action_returns_hangup(self):
        r = requests.post(f"{BASE_HTTP}/webhooks/voice/relay-action", data={"CallSid": "CAxxx"}, timeout=10)
        assert r.status_code == 200
        assert "<Hangup/>" in r.text


# ---------- WebSocket tests ----------
def _start_call_and_get_token():
    """Trigger /inbound to get a fresh wsAuthToken + CallSid."""
    sid = f"CAtest{uuid.uuid4().hex[:24]}"
    r = requests.post(
        f"{BASE_HTTP}/webhooks/voice/inbound",
        data={"CallSid": sid, "From": "+15145558888", "To": TEST_PHONE, "AccountSid": "ACtest"},
        timeout=10,
    )
    assert r.status_code == 200
    m = re.search(r'name="wsAuthToken"\s+value="([^"]+)"', r.text)
    assert m, "wsAuthToken not found"
    return sid, m.group(1)


class TestWebSocket:
    def test_ws_upgrade_succeeds(self):
        async def go():
            async with websockets.connect(f"{BASE_WS}/webhooks/voice/relay/ws") as ws:
                assert ws.state.value == 1  # OPEN
        asyncio.run(go())

    def test_ws_setup_with_invalid_token_closes(self):
        async def go():
            async with websockets.connect(f"{BASE_WS}/webhooks/voice/relay/ws") as ws:
                await ws.send(json.dumps({
                    "type": "setup",
                    "callSid": "CAfake",
                    "customParameters": {"wsAuthToken": "invalid_token_xxx"},
                }))
                # Expect error text + end
                msg1 = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                msg2 = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                assert msg1["type"] == "text"
                assert "Erreur" in msg1["token"] or "erreur" in msg1["token"].lower()
                assert msg2["type"] == "end"
        asyncio.run(go())

    def test_ws_full_flow_setup_prompt_end(self):
        sid, token = _start_call_and_get_token()
        async def go():
            async with websockets.connect(f"{BASE_WS}/webhooks/voice/relay/ws") as ws:
                # setup
                await ws.send(json.dumps({
                    "type": "setup",
                    "callSid": sid,
                    "from": "+15145558888",
                    "to": TEST_PHONE,
                    "customParameters": {"wsAuthToken": token},
                }))
                # give server time to insert "connecting" event
                await asyncio.sleep(0.7)
                # prompt last=true
                await ws.send(json.dumps({
                    "type": "prompt",
                    "voicePrompt": "Bonjour je voudrais un rendez-vous",
                    "last": True,
                    "lang": "fr-FR",
                }))
                m1 = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                m2 = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                assert m1["type"] == "text"
                assert m1.get("last") is True
                assert "Parfait" in m1["token"]
                assert m2["type"] == "end"
        asyncio.run(go())
        time.sleep(0.7)
        # Verify events
        call = sb_get("calls", {"twilio_call_sid": f"eq.{sid}", "select": "id"}).json()[0]
        evs = sb_get("call_events", {"call_id": f"eq.{call['id']}", "select": "event_type"}).json()
        types = [e["event_type"] for e in evs]
        assert "connecting" in types
        assert "user_speaking" in types
        assert "ai_speaking" in types

    def test_ws_token_is_one_shot(self):
        sid, token = _start_call_and_get_token()
        async def first():
            async with websockets.connect(f"{BASE_WS}/webhooks/voice/relay/ws") as ws:
                await ws.send(json.dumps({"type": "setup", "callSid": sid, "customParameters": {"wsAuthToken": token}}))
                await asyncio.sleep(0.4)
        asyncio.run(first())
        async def second():
            async with websockets.connect(f"{BASE_WS}/webhooks/voice/relay/ws") as ws:
                await ws.send(json.dumps({"type": "setup", "callSid": sid, "customParameters": {"wsAuthToken": token}}))
                m1 = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                assert m1["type"] == "text"  # error message
        asyncio.run(second())

    def test_ws_interrupt_logs_event(self):
        sid, token = _start_call_and_get_token()
        async def go():
            async with websockets.connect(f"{BASE_WS}/webhooks/voice/relay/ws") as ws:
                await ws.send(json.dumps({"type": "setup", "callSid": sid, "customParameters": {"wsAuthToken": token}}))
                await asyncio.sleep(0.5)
                await ws.send(json.dumps({"type": "interrupt", "utteranceUntilInterrupt": "Parfait je vous"}))
                await asyncio.sleep(0.5)
        asyncio.run(go())
        time.sleep(0.5)
        call = sb_get("calls", {"twilio_call_sid": f"eq.{sid}", "select": "id"}).json()[0]
        evs = sb_get("call_events", {"call_id": f"eq.{call['id']}", "event_type": "eq.interrupted", "select": "event_type"}).json()
        assert len(evs) >= 1

    def test_ws_dtmf_logs_user_speaking_with_digit(self):
        sid, token = _start_call_and_get_token()
        async def go():
            async with websockets.connect(f"{BASE_WS}/webhooks/voice/relay/ws") as ws:
                await ws.send(json.dumps({"type": "setup", "callSid": sid, "customParameters": {"wsAuthToken": token}}))
                await asyncio.sleep(0.5)
                await ws.send(json.dumps({"type": "dtmf", "digit": "1"}))
                await asyncio.sleep(0.5)
        asyncio.run(go())
        time.sleep(0.5)
        call = sb_get("calls", {"twilio_call_sid": f"eq.{sid}", "select": "id"}).json()[0]
        evs = sb_get("call_events", {"call_id": f"eq.{call['id']}", "event_type": "eq.user_speaking", "select": "payload"}).json()
        # find one with dtmf=1
        assert any((e.get("payload") or {}).get("dtmf") == "1" for e in evs), f"no dtmf event: {evs}"

    def test_ws_close_logs_ended_with_reason(self):
        sid, token = _start_call_and_get_token()
        async def go():
            async with websockets.connect(f"{BASE_WS}/webhooks/voice/relay/ws") as ws:
                await ws.send(json.dumps({"type": "setup", "callSid": sid, "customParameters": {"wsAuthToken": token}}))
                await asyncio.sleep(0.5)
                await ws.close()
        asyncio.run(go())
        time.sleep(0.7)
        call = sb_get("calls", {"twilio_call_sid": f"eq.{sid}", "select": "id,live_status"}).json()[0]
        evs = sb_get("call_events", {"call_id": f"eq.{call['id']}", "event_type": "eq.ended", "select": "payload"}).json()
        assert any((e.get("payload") or {}).get("reason") == "ws_closed" for e in evs), f"no ws_closed event: {evs}"


class TestRLSCallsListing:
    def test_qa_bot_sees_its_calls(self, auth_token):
        r = requests.get(
            f"{BASE_HTTP}/api/v1/calls",
            headers={"Authorization": f"Bearer {auth_token}"},
            params={"company_id": COMPANY_ID},
            timeout=10,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        # Accept either {items: [...]} or list
        items = body.get("items") if isinstance(body, dict) else body
        if items is None and isinstance(body, dict):
            # try common keys
            for k in ("calls", "data", "results"):
                if k in body:
                    items = body[k]
                    break
        assert items is not None, f"unexpected calls payload: {body}"
        assert isinstance(items, list)
        # We created multiple calls via inbound, expect at least 1 visible
        assert len(items) >= 1, "qa-bot should see at least the calls created by inbound webhook"
