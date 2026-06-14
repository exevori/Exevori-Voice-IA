"""Phase 6E — Notifications + Resend tests (qa-bot ONLY, never super_admin).

Backend Express on http://localhost:8001, prefix /api/v1.
Auth = Supabase JWT obtained via password grant for qa-bot user.

Resend is in SANDBOX mode (clé live but domain not verified) — so any send to
an address != exevori@gmail.com returns 403. The test asserts that the error
is properly propagated to the client (not masked).
"""
import os
import pytest
import requests

BACKEND = "http://localhost:8001"
SUPABASE_URL = "https://yptsvqhcnksjxufziech.supabase.co"
SUPABASE_ANON = "sb_publishable_avATcYb4hXUF-_MKPNnYwg_9Q8uI9vl"
SUPABASE_SERVICE_KEY = "sb_secret_vIxlmUawjOWTV507F0RymQ_bMOeaRIb"
QA_EMAIL = "qa-bot@garage-tremblay.test"
QA_PASSWORD = "QaBot_Test_2026!"
QA_COMPANY_ID = "af5f079f-6fc2-4d70-8c8d-51d83d301906"

DEFAULT_PREFS_KEYS = {"ticket_email", "billing_email", "draft_email", "learning_email", "system_email"}


# ─── Fixtures ──────────────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def token():
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        headers={"apikey": SUPABASE_ANON, "Content-Type": "application/json"},
        json={"email": QA_EMAIL, "password": QA_PASSWORD},
        timeout=10,
    )
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    tok = r.json().get("access_token")
    assert tok
    return tok


@pytest.fixture(scope="module")
def headers(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


# ─── GET /notifications ────────────────────────────────────────────────────────
def test_list_notifications_empty(headers):
    r = requests.get(f"{BACKEND}/api/v1/notifications", headers=headers, timeout=10)
    assert r.status_code == 200
    body = r.json()
    assert "notifications" in body
    assert "total" in body
    assert "unread_count" in body
    assert isinstance(body["notifications"], list)
    # qa-bot has no notifications yet
    assert body["total"] == 0
    assert body["notifications"] == []
    assert body["unread_count"] == 0


# ─── GET /notifications/unread-count ───────────────────────────────────────────
def test_unread_count_zero(headers):
    r = requests.get(f"{BACKEND}/api/v1/notifications/unread-count", headers=headers, timeout=10)
    assert r.status_code == 200
    body = r.json()
    assert body == {"unread_count": 0}


# ─── GET /notifications/preferences (defaults) ────────────────────────────────
def test_get_preferences_returns_all_keys(headers):
    r = requests.get(f"{BACKEND}/api/v1/notifications/preferences", headers=headers, timeout=10)
    assert r.status_code == 200
    body = r.json()
    assert "preferences" in body
    prefs = body["preferences"]
    for k in DEFAULT_PREFS_KEYS:
        assert k in prefs, f"missing preference key {k}"
        assert isinstance(prefs[k], bool)


# ─── PATCH /notifications/preferences + verify GET ────────────────────────────
def test_patch_preferences_then_get_reflects(headers):
    payload = {
        "ticket_email": False,
        "billing_email": True,
        "draft_email": True,
        "learning_email": False,
        "system_email": True,
    }
    r = requests.patch(
        f"{BACKEND}/api/v1/notifications/preferences",
        headers=headers,
        json=payload,
        timeout=10,
    )
    assert r.status_code == 200, r.text
    assert r.json().get("success") is True

    g = requests.get(f"{BACKEND}/api/v1/notifications/preferences", headers=headers, timeout=10)
    assert g.status_code == 200
    prefs = g.json()["preferences"]
    for k, v in payload.items():
        assert prefs[k] == v, f"pref {k}: expected {v}, got {prefs[k]}"


# ─── POST /notifications/send-test (sandbox → 500 expected) ───────────────────
def test_send_test_in_sandbox_propagates_403(headers):
    r = requests.post(f"{BACKEND}/api/v1/notifications/send-test", headers=headers, timeout=15)
    # In sandbox, Resend rejects with 403 (destinataire != owner's email).
    # The backend should propagate as a non-2xx (currently 500) with explicit error.
    assert r.status_code == 500, f"expected 500 (Resend sandbox), got {r.status_code}: {r.text}"
    body = r.json()
    assert "error" in body
    # Error message should reference Resend's testing-mode restriction
    msg = (body.get("error") or "").lower()
    assert "testing" in msg or "own email" in msg or "verify a domain" in msg, (
        f"expected Resend sandbox message, got: {body}"
    )


# ─── POST /team/invitations (creates invite + email_sent/email_error fields) ──
def _delete_invitation(invitation_id):
    """Direct DELETE via Supabase service role to clean up."""
    if not invitation_id:
        return
    try:
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/invitations",
            headers={
                "apikey": SUPABASE_SERVICE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
                "Content-Type": "application/json",
            },
            params={"id": f"eq.{invitation_id}"},
            timeout=10,
        )
    except Exception:
        pass


def test_team_invitation_returns_email_sent_and_email_error(headers):
    test_email = "qa-bot-invite-test@garage-tremblay.test"
    payload = {
        "company_id": QA_COMPANY_ID,
        "email": test_email,
        "role": "company_member",
    }
    r = requests.post(
        f"{BACKEND}/api/v1/team/invitations",
        headers=headers,
        json=payload,
        timeout=20,
    )
    invitation_id = None
    try:
        assert r.status_code == 200, f"create invite failed: {r.status_code} {r.text}"
        body = r.json()
        assert body.get("success") is True
        assert "invitation" in body
        invitation_id = body["invitation"]["id"]
        assert body["invitation"]["email"] == test_email
        assert body["invitation"]["role"] == "company_member"

        # New fields from Phase 6E
        assert "email_sent" in body, "email_sent field missing"
        assert "email_error" in body, "email_error field missing"
        assert isinstance(body["email_sent"], bool)
        # In Resend sandbox: email_sent=False, email_error contains "testing"-like msg
        # We don't strictly assert False (in case domain gets verified later), but if
        # email_sent is False, email_error must be a string.
        if body["email_sent"] is False:
            assert isinstance(body["email_error"], str) and len(body["email_error"]) > 0
        else:
            assert body["email_error"] is None
    finally:
        _delete_invitation(invitation_id)


# ─── Auth guard ───────────────────────────────────────────────────────────────
def test_unauthenticated_returns_401():
    r = requests.get(f"{BACKEND}/api/v1/notifications", timeout=10)
    assert r.status_code == 401
