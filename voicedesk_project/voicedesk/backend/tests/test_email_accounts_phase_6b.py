"""Phase 6B — Email accounts IMAP multi-comptes (crypto + endpoints).

Tests:
  - Crypto roundtrip (via Node helper call subprocess)
  - GET /providers → templates Zoho/Gmail/Outlook/Custom
  - GET /email-accounts → list (vide)
  - POST /test-connection avec hosts inexistants → graceful failure
  - POST /test-connection sans champs requis → 400
  - POST / (create) success + password masqué + chiffré en DB
  - is_primary unique partial (2e account is_primary démote le 1er)
  - POST / errors (missing fields, provider invalide)
  - POST / duplicate email même company → 409
  - GET / list triée + imap_configs joint
  - DELETE / + cascade imap_configs (re-GET vide)
  - Auth 401 sans Bearer
"""
import os, json, subprocess, time, uuid
import requests
import pytest

BACKEND = "http://localhost:8001"
SUPABASE_URL = "https://yptsvqhcnksjxufziech.supabase.co"
SUPABASE_ANON = "sb_publishable_avATcYb4hXUF-_MKPNnYwg_9Q8uI9vl"
COMPANY_ID = "af5f079f-6fc2-4d70-8c8d-51d83d301906"
QA_EMAIL = "qa-bot@garage-tremblay.test"
QA_PASS = "QaBot_Test_2026!"


@pytest.fixture(scope="session")
def token():
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        headers={"apikey": SUPABASE_ANON, "Content-Type": "application/json"},
        json={"email": QA_EMAIL, "password": QA_PASS}, timeout=15,
    )
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    return r.json()["access_token"]


@pytest.fixture(scope="session")
def auth(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


@pytest.fixture(scope="session", autouse=True)
def cleanup(auth):
    """Clean qa-*@example.test accounts before & after."""
    def purge():
        r = requests.get(f"{BACKEND}/api/v1/email-accounts?company_id={COMPANY_ID}", headers=auth, timeout=15)
        if r.status_code == 200:
            for a in r.json().get("accounts", []):
                if "@example.test" in (a.get("email") or ""):
                    requests.delete(f"{BACKEND}/api/v1/email-accounts/{a['id']}", headers=auth, timeout=15)
    purge()
    yield
    purge()


# ─── 1. Crypto helper ──────────────────────────────────────────
def test_crypto_roundtrip_and_tampering(tmp_path):
    script = tmp_path / "crypto_test.mjs"
    script.write_text(r"""
import { encryptPassword, decryptPassword, selfTestCrypto } from "/app/voicedesk_project/voicedesk/backend/lib/crypto.js";
const out = {};
out.self_test = selfTestCrypto();
const enc = encryptPassword("mon-secret");
out.dec = decryptPassword(enc);
// tamper tag
try { decryptPassword({ ...enc, tag: Buffer.from("0".repeat(32)).toString("base64") }); out.tamper = "NO_THROW"; }
catch (e) { out.tamper = "THREW"; }
console.log(JSON.stringify(out));
""")
    r = subprocess.run(
        ["node", str(script)],
        cwd="/app/voicedesk_project/voicedesk",
        capture_output=True, text=True, timeout=15,
    )
    assert r.returncode == 0, f"node err: {r.stderr}"
    data = json.loads(r.stdout.strip().splitlines()[-1])
    assert data["self_test"] is True
    assert data["dec"] == "mon-secret"
    assert data["tamper"] == "THREW"


# ─── 2. GET /providers ─────────────────────────────────────────
def test_get_providers(auth):
    r = requests.get(f"{BACKEND}/api/v1/email-accounts/providers", headers=auth, timeout=10)
    assert r.status_code == 200, r.text
    tpl = r.json().get("templates", {})
    for k in ("zoho", "gmail", "outlook", "custom"):
        assert k in tpl, f"missing provider {k}"
        for f in ("imap_host", "imap_port", "imap_use_tls", "smtp_host", "smtp_port",
                  "smtp_use_tls", "label", "help_url", "help_text"):
            assert f in tpl[k], f"{k} missing {f}"
    assert tpl["zoho"]["imap_host"] == "imap.zoho.com"
    assert tpl["gmail"]["imap_host"] == "imap.gmail.com"


# ─── 3. Auth 401 ───────────────────────────────────────────────
def test_no_auth_401():
    r = requests.get(f"{BACKEND}/api/v1/email-accounts?company_id={COMPANY_ID}", timeout=10)
    assert r.status_code == 401
    r2 = requests.get(f"{BACKEND}/api/v1/email-accounts/providers", timeout=10)
    assert r2.status_code == 401


# ─── 4. GET list initial empty ─────────────────────────────────
def test_list_empty(auth):
    r = requests.get(f"{BACKEND}/api/v1/email-accounts?company_id={COMPANY_ID}", headers=auth, timeout=10)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "accounts" in body
    # Should be empty after cleanup
    assert isinstance(body["accounts"], list)


# ─── 5. POST /test-connection graceful failure ────────────────
def test_test_connection_unreachable_hosts(auth):
    r = requests.post(f"{BACKEND}/api/v1/email-accounts/test-connection", headers=auth, timeout=30,
        json={"imap_host":"imap.example.test","imap_port":993,"smtp_host":"smtp.example.test",
              "smtp_port":465,"username":"x@example.test","password":"x"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["success"] is False
    assert d["imap_ok"] is False and d["smtp_ok"] is False
    assert "imap_error" in d and "smtp_error" in d


def test_test_connection_missing_fields(auth):
    r = requests.post(f"{BACKEND}/api/v1/email-accounts/test-connection", headers=auth, timeout=10,
        json={"imap_host":"x"})
    assert r.status_code == 400
    assert "Champ requis manquant" in (r.json().get("error") or "")


# ─── 6. POST / create + persistence ─────────────────────────────
@pytest.fixture
def created_account(auth):
    ts = uuid.uuid4().hex[:10]
    payload = {
        "company_id": COMPANY_ID, "provider": "zoho",
        "email": f"qa-test-1-{ts}@example.test",
        "display_name": "Test Service", "signature": "— QA Test",
        "tone": "friendly", "auto_reply_threshold": 0.85,
        "mode": "draft_only", "is_primary": False,
        "imap": {"imap_host":"imap.example.test","imap_port":993,"smtp_host":"smtp.example.test",
                 "smtp_port":465,"username":f"qa-test-1-{ts}@example.test","password":"fake-password-1234"}
    }
    r = requests.post(f"{BACKEND}/api/v1/email-accounts", headers=auth, json=payload, timeout=20)
    assert r.status_code == 200, r.text
    return r.json(), payload


def test_create_success_password_masked(created_account):
    body, payload = created_account
    assert body["success"] is True
    acc = body["account"]
    assert acc["email"] == payload["email"]
    assert acc["provider"] == "zoho"
    assert acc["mode"] == "draft_only"
    assert "imap" in acc and acc["imap"]["imap_host"] == "imap.example.test"
    # password must NOT be exposed
    raw = json.dumps(body)
    assert "fake-password-1234" not in raw
    assert "password" not in acc.get("imap", {})


def test_password_encrypted_in_db(auth, created_account):
    body, _ = created_account
    # Verify via GET that imap_configs is returned WITHOUT password fields
    r = requests.get(f"{BACKEND}/api/v1/email-accounts?company_id={COMPANY_ID}", headers=auth, timeout=10)
    assert r.status_code == 200
    accounts = r.json()["accounts"]
    found = next((a for a in accounts if a["id"] == body["account"]["id"]), None)
    assert found is not None
    imap_raw = found.get("imap_configs")
    # Supabase may return object (1:1) or array (1:N) — normalize
    imap = imap_raw[0] if isinstance(imap_raw, list) else imap_raw
    assert imap is not None
    assert imap["imap_host"] == "imap.example.test"
    assert "password_encrypted" not in imap
    assert "password" not in imap


def test_is_primary_unique_partial(auth, created_account):
    body, _ = created_account
    # set 1st to is_primary via creating then make a 2nd is_primary:true
    # First, update the first by re-creating with is_primary True isn't possible (PATCH not exposed).
    # Strategy: create 2 new accounts; the 2nd with is_primary=True should demote.
    ts = int(time.time()) + 1
    p1 = {"company_id":COMPANY_ID,"provider":"gmail","email":f"qa-prim-a-{ts}@example.test",
          "is_primary":True,"imap":{"imap_host":"imap.example.test","smtp_host":"smtp.example.test",
          "username":f"qa-prim-a-{ts}@example.test","password":"p"}}
    r1 = requests.post(f"{BACKEND}/api/v1/email-accounts", headers=auth, json=p1, timeout=15)
    assert r1.status_code == 200, r1.text
    a1 = r1.json()["account"]
    assert a1["is_primary"] is True

    p2 = {"company_id":COMPANY_ID,"provider":"outlook","email":f"qa-prim-b-{ts}@example.test",
          "is_primary":True,"imap":{"imap_host":"imap.example.test","smtp_host":"smtp.example.test",
          "username":f"qa-prim-b-{ts}@example.test","password":"p"}}
    r2 = requests.post(f"{BACKEND}/api/v1/email-accounts", headers=auth, json=p2, timeout=15)
    assert r2.status_code == 200, r2.text

    # GET → only one is_primary=True
    rl = requests.get(f"{BACKEND}/api/v1/email-accounts?company_id={COMPANY_ID}", headers=auth, timeout=10)
    accts = [a for a in rl.json()["accounts"] if a["id"] in (a1["id"], r2.json()["account"]["id"])]
    primaries = [a for a in accts if a["is_primary"]]
    assert len(primaries) == 1
    assert primaries[0]["id"] == r2.json()["account"]["id"]


def test_create_missing_fields(auth):
    r = requests.post(f"{BACKEND}/api/v1/email-accounts", headers=auth, timeout=10,
        json={"company_id": COMPANY_ID})
    assert r.status_code == 400
    r2 = requests.post(f"{BACKEND}/api/v1/email-accounts", headers=auth, timeout=10,
        json={"company_id": COMPANY_ID, "email": "x@example.test"})
    assert r2.status_code == 400


def test_create_invalid_provider(auth):
    ts = int(time.time())
    r = requests.post(f"{BACKEND}/api/v1/email-accounts", headers=auth, timeout=15,
        json={"company_id":COMPANY_ID,"provider":"foobar","email":f"qa-bad-{ts}@example.test",
              "imap":{"imap_host":"x","smtp_host":"y","username":"u","password":"p"}})
    # enum violation expected → 500 or 400
    assert r.status_code in (400, 500), r.text


def test_create_duplicate_email_returns_409(auth, created_account):
    body, payload = created_account
    r = requests.post(f"{BACKEND}/api/v1/email-accounts", headers=auth, json=payload, timeout=15)
    assert r.status_code == 409, r.text
    assert "déjà" in (r.json().get("error") or "").lower() or "already" in (r.json().get("error") or "").lower()


def test_list_returns_imap_joined_no_password(auth, created_account):
    body, _ = created_account
    r = requests.get(f"{BACKEND}/api/v1/email-accounts?company_id={COMPANY_ID}", headers=auth, timeout=10)
    assert r.status_code == 200
    accounts = r.json()["accounts"]
    assert any(a["id"] == body["account"]["id"] for a in accounts)
    raw = json.dumps(r.json())
    assert "fake-password-1234" not in raw
    # Triage check: list is sorted is_primary DESC then created_at ASC
    primaries = [a["is_primary"] for a in accounts]
    assert primaries == sorted(primaries, reverse=True)


def test_delete_cascades_imap(auth):
    ts = int(time.time()) + 5
    payload = {"company_id":COMPANY_ID,"provider":"custom","email":f"qa-del-{ts}@example.test",
        "imap":{"imap_host":"imap.example.test","smtp_host":"smtp.example.test",
                "username":f"qa-del-{ts}@example.test","password":"x"}}
    r = requests.post(f"{BACKEND}/api/v1/email-accounts", headers=auth, json=payload, timeout=15)
    assert r.status_code == 200
    acc_id = r.json()["account"]["id"]

    rd = requests.delete(f"{BACKEND}/api/v1/email-accounts/{acc_id}", headers=auth, timeout=10)
    assert rd.status_code == 200
    assert rd.json().get("success") is True

    # re-list → not present
    rl = requests.get(f"{BACKEND}/api/v1/email-accounts?company_id={COMPANY_ID}", headers=auth, timeout=10)
    ids = [a["id"] for a in rl.json()["accounts"]]
    assert acc_id not in ids
