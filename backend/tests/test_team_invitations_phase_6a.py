# Phase 6A — Team Invitations endpoint tests (retest iteration_11)
# Targets POST /api/v1/team/invitations and POST /api/v1/team/invitations/:id/cancel
import time
import pytest
import requests

BASE_URL = "https://720876eb-de73-4840-91bd-19cf23fab78e.preview.emergentagent.com"
COMPANY_ID = "af5f079f-6fc2-4d70-8c8d-51d83d301906"
QA_EMAIL = "qa-bot@garage-tremblay.test"
QA_PASSWORD = "QaBot_Test_2026!"
SUPABASE_URL = "https://yptsvqhcnksjxufziech.supabase.co"
SUPABASE_ANON_KEY = "sb_publishable_avATcYb4hXUF-_MKPNnYwg_9Q8uI9vl"


@pytest.fixture(scope="session")
def token():
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        headers={"apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json"},
        json={"email": QA_EMAIL, "password": QA_PASSWORD},
        timeout=15,
    )
    assert r.status_code == 200, f"Supabase login failed: {r.status_code} {r.text}"
    return r.json()["access_token"]


@pytest.fixture
def auth_headers(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


# Track created invitations for cleanup
_created_ids = []


@pytest.fixture(scope="session", autouse=True)
def cleanup(token):
    yield
    # Cleanup any remaining pending invitations from this run
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    for inv_id in _created_ids:
        try:
            requests.post(f"{BASE_URL}/api/v1/team/invitations/{inv_id}/cancel",
                          headers=headers, timeout=10)
        except Exception:
            pass
    # Also list current pending qa-* and cancel
    try:
        r = requests.get(f"{BASE_URL}/api/v1/team?company_id={COMPANY_ID}",
                         headers=headers, timeout=10)
        if r.status_code == 200:
            for inv in r.json().get("invitations", []):
                e = inv.get("email", "")
                if (e.startswith("qa-test-") or e.startswith("qa-ui-invite-") or
                    e.startswith("qa-dup-") or e.startswith("qa-cancel-")) and inv.get("status") == "pending":
                    requests.post(f"{BASE_URL}/api/v1/team/invitations/{inv['id']}/cancel",
                                  headers=headers, timeout=10)
    except Exception:
        pass


class TestCreateInvitation:
    def test_create_invitation_success(self, auth_headers):
        email = f"qa-test-{int(time.time()*1000)}@example.test"
        r = requests.post(f"{BASE_URL}/api/v1/team/invitations",
                          headers=auth_headers,
                          json={"company_id": COMPANY_ID, "email": email, "role": "company_member"},
                          timeout=10)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get("success") is True
        inv = data["invitation"]
        assert inv["email"] == email
        assert inv["role"] == "company_member"
        assert inv["status"] == "pending"
        assert "id" in inv and "expires_at" in inv and "created_at" in inv
        assert "invite_url" in data
        _created_ids.append(inv["id"])

    def test_create_invitation_invalid_role(self, auth_headers):
        email = f"qa-test-{int(time.time()*1000)}@example.test"
        r = requests.post(f"{BASE_URL}/api/v1/team/invitations",
                          headers=auth_headers,
                          json={"company_id": COMPANY_ID, "email": email, "role": "admin"},
                          timeout=10)
        assert r.status_code == 400, r.text
        assert "role" in r.json().get("error", "").lower()

    def test_create_invitation_invalid_role_foo(self, auth_headers):
        email = f"qa-test-{int(time.time()*1000)}@example.test"
        r = requests.post(f"{BASE_URL}/api/v1/team/invitations",
                          headers=auth_headers,
                          json={"company_id": COMPANY_ID, "email": email, "role": "foo"},
                          timeout=10)
        assert r.status_code == 400, r.text

    def test_create_invitation_malformed_email(self, auth_headers):
        r = requests.post(f"{BASE_URL}/api/v1/team/invitations",
                          headers=auth_headers,
                          json={"company_id": COMPANY_ID, "email": "not-an-email", "role": "company_member"},
                          timeout=10)
        assert r.status_code == 400, r.text
        assert "courriel" in r.json().get("error", "").lower() or "invalid" in r.json().get("error", "").lower()

    def test_create_invitation_missing_company_id(self, auth_headers):
        r = requests.post(f"{BASE_URL}/api/v1/team/invitations",
                          headers=auth_headers,
                          json={"email": f"qa-test-{int(time.time()*1000)}@example.test", "role": "company_member"},
                          timeout=10)
        assert r.status_code == 400

    def test_create_invitation_missing_email(self, auth_headers):
        r = requests.post(f"{BASE_URL}/api/v1/team/invitations",
                          headers=auth_headers,
                          json={"company_id": COMPANY_ID, "role": "company_member"},
                          timeout=10)
        assert r.status_code == 400

    def test_create_invitation_existing_member_returns_409(self, auth_headers):
        r = requests.post(f"{BASE_URL}/api/v1/team/invitations",
                          headers=auth_headers,
                          json={"company_id": COMPANY_ID, "email": QA_EMAIL, "role": "company_member"},
                          timeout=10)
        assert r.status_code == 409, r.text
        assert "membre" in r.json().get("error", "").lower()

    def test_create_invitation_duplicate_pending_returns_409(self, auth_headers):
        email = f"qa-dup-{int(time.time()*1000)}@example.test"
        # First create
        r1 = requests.post(f"{BASE_URL}/api/v1/team/invitations",
                           headers=auth_headers,
                           json={"company_id": COMPANY_ID, "email": email, "role": "company_member"},
                           timeout=10)
        assert r1.status_code == 200, r1.text
        _created_ids.append(r1.json()["invitation"]["id"])
        # Second create should 409
        r2 = requests.post(f"{BASE_URL}/api/v1/team/invitations",
                           headers=auth_headers,
                           json={"company_id": COMPANY_ID, "email": email, "role": "company_member"},
                           timeout=10)
        assert r2.status_code == 409, r2.text
        assert "attente" in r2.json().get("error", "").lower()

    def test_create_invitation_without_token_returns_401(self):
        r = requests.post(f"{BASE_URL}/api/v1/team/invitations",
                          headers={"Content-Type": "application/json"},
                          json={"company_id": COMPANY_ID, "email": "x@y.test", "role": "company_member"},
                          timeout=10)
        assert r.status_code == 401


class TestCancelInvitation:
    def test_cancel_invitation_success_and_idempotent(self, auth_headers):
        email = f"qa-cancel-{int(time.time()*1000)}@example.test"
        # Create
        r = requests.post(f"{BASE_URL}/api/v1/team/invitations",
                          headers=auth_headers,
                          json={"company_id": COMPANY_ID, "email": email, "role": "company_member"},
                          timeout=10)
        assert r.status_code == 200, r.text
        inv_id = r.json()["invitation"]["id"]
        _created_ids.append(inv_id)
        # Cancel
        c1 = requests.post(f"{BASE_URL}/api/v1/team/invitations/{inv_id}/cancel",
                           headers=auth_headers, timeout=10)
        assert c1.status_code == 200, c1.text
        body1 = c1.json()
        assert body1.get("success") is True
        assert body1["invitation"]["status"] == "cancelled"
        # Re-cancel — must still return 200 (idempotent)
        c2 = requests.post(f"{BASE_URL}/api/v1/team/invitations/{inv_id}/cancel",
                           headers=auth_headers, timeout=10)
        assert c2.status_code == 200, c2.text
