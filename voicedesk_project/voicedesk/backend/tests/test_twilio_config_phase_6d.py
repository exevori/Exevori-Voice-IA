"""Phase 6D — Twilio Config tests (qa-bot ONLY, never super_admin).

Backend Express on http://localhost:8001 with prefix /api/v1.
Auth = Supabase JWT obtained via password grant for qa-bot user.
"""
import os
import pytest
import requests

BACKEND = "http://localhost:8001"
SUPABASE_URL = "https://yptsvqhcnksjxufziech.supabase.co"
SUPABASE_ANON = "sb_publishable_avATcYb4hXUF-_MKPNnYwg_9Q8uI9vl"
QA_EMAIL = "qa-bot@garage-tremblay.test"
QA_PASSWORD = "QaBot_Test_2026!"
QA_COMPANY_ID = "af5f079f-6fc2-4d70-8c8d-51d83d301906"

VALID_SID = "AC00000000000000000000000000000000"
VALID_TOKEN = "faketoken_for_qa_testing"
VALID_PHONE = "+14186891234"
VALID_FORWARD = "+14185551234"


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


@pytest.fixture(scope="module", autouse=True)
def _cleanup_before_and_after(headers):
    # cleanup before
    requests.delete(
        f"{BACKEND}/api/v1/twilio-config",
        params={"company_id": QA_COMPANY_ID},
        headers=headers,
        timeout=10,
    )
    yield
    # cleanup after
    requests.delete(
        f"{BACKEND}/api/v1/twilio-config",
        params={"company_id": QA_COMPANY_ID},
        headers=headers,
        timeout=10,
    )


# --- GET (empty) ---------------------------------------------------------
def test_get_returns_null_when_empty(headers):
    r = requests.get(
        f"{BACKEND}/api/v1/twilio-config",
        params={"company_id": QA_COMPANY_ID},
        headers=headers,
        timeout=10,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert "config" in data
    assert data["config"] is None


# --- POST /test validations ---------------------------------------------
def test_post_test_rejects_malformed_sid(headers):
    r = requests.post(
        f"{BACKEND}/api/v1/twilio-config/test",
        headers=headers,
        json={"account_sid": "NOTASID123", "auth_token": "x"},
        timeout=10,
    )
    assert r.status_code == 400, r.text
    assert "error" in r.json()


def test_post_test_valid_format_but_fake_creds_returns_401_message(headers):
    r = requests.post(
        f"{BACKEND}/api/v1/twilio-config/test",
        headers=headers,
        json={"account_sid": VALID_SID, "auth_token": VALID_TOKEN},
        timeout=15,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data.get("ok") is False
    assert "401" in (data.get("error") or "") or "invalides" in (data.get("error") or "").lower()


# --- PUT validations ----------------------------------------------------
def test_put_rejects_non_e164_phone(headers):
    r = requests.put(
        f"{BACKEND}/api/v1/twilio-config",
        headers=headers,
        json={
            "company_id": QA_COMPANY_ID,
            "account_sid": VALID_SID,
            "auth_token": VALID_TOKEN,
            "phone_number": "514-555-1234",
        },
        timeout=10,
    )
    assert r.status_code == 400, r.text
    assert "E.164" in r.json().get("error", "") or "phone" in r.json().get("error", "").lower()


def test_put_rejects_malformed_sid(headers):
    r = requests.put(
        f"{BACKEND}/api/v1/twilio-config",
        headers=headers,
        json={
            "company_id": QA_COMPANY_ID,
            "account_sid": "BADSID",
            "auth_token": VALID_TOKEN,
            "phone_number": VALID_PHONE,
        },
        timeout=10,
    )
    assert r.status_code == 400, r.text


# --- PUT success (with fake creds → status=error) -----------------------
def test_put_save_with_valid_format_fake_creds(headers):
    r = requests.put(
        f"{BACKEND}/api/v1/twilio-config",
        headers=headers,
        json={
            "company_id": QA_COMPANY_ID,
            "account_sid": VALID_SID,
            "auth_token": VALID_TOKEN,
            "phone_number": VALID_PHONE,
            "forwarding_number": VALID_FORWARD,
        },
        timeout=20,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data.get("success") is True
    assert data.get("verified") is False
    cfg = data["config"]
    # Required fields present
    for k in [
        "id", "company_id", "account_sid", "phone_number", "forwarding_number",
        "status", "last_test_at", "last_test_ok", "last_test_error", "twilio_account_name",
    ]:
        assert k in cfg, f"missing {k}"
    assert cfg["account_sid"] == VALID_SID
    assert cfg["phone_number"] == VALID_PHONE
    assert cfg["forwarding_number"] == VALID_FORWARD
    assert cfg["status"] == "error"
    assert cfg["last_test_ok"] is False
    assert cfg["last_test_error"]
    # Auth token MUST NEVER appear
    forbidden = {"auth_token", "auth_token_encrypted", "auth_token_iv", "auth_token_tag"}
    leaked = forbidden & set(cfg.keys())
    assert not leaked, f"auth_token leaked in response: {leaked}"


def test_get_after_put_returns_saved_config_without_auth_token(headers):
    r = requests.get(
        f"{BACKEND}/api/v1/twilio-config",
        params={"company_id": QA_COMPANY_ID},
        headers=headers,
        timeout=10,
    )
    assert r.status_code == 200, r.text
    cfg = r.json().get("config")
    assert cfg is not None
    assert cfg["account_sid"] == VALID_SID
    assert cfg["phone_number"] == VALID_PHONE
    assert cfg["status"] == "error"
    forbidden = {"auth_token", "auth_token_encrypted", "auth_token_iv", "auth_token_tag"}
    leaked = forbidden & set(cfg.keys())
    assert not leaked, f"auth_token leaked in GET response: {leaked}"


# --- DELETE -------------------------------------------------------------
def test_delete_removes_config(headers):
    r = requests.delete(
        f"{BACKEND}/api/v1/twilio-config",
        params={"company_id": QA_COMPANY_ID},
        headers=headers,
        timeout=10,
    )
    assert r.status_code == 200, r.text
    assert r.json().get("success") is True

    r2 = requests.get(
        f"{BACKEND}/api/v1/twilio-config",
        params={"company_id": QA_COMPANY_ID},
        headers=headers,
        timeout=10,
    )
    assert r2.status_code == 200
    assert r2.json().get("config") is None


# --- Missing query params -----------------------------------------------
def test_get_missing_company_id_returns_400(headers):
    r = requests.get(f"{BACKEND}/api/v1/twilio-config", headers=headers, timeout=10)
    assert r.status_code == 400


def test_delete_missing_company_id_returns_400(headers):
    r = requests.delete(f"{BACKEND}/api/v1/twilio-config", headers=headers, timeout=10)
    assert r.status_code == 400
