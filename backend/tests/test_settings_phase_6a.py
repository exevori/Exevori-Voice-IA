# Phase 6A — Settings backend tests (company + team modules)
import os
import time
import pytest
import requests

BASE_URL = "https://720876eb-de73-4840-91bd-19cf23fab78e.preview.emergentagent.com"
COMPANY_ID = "af5f079f-6fc2-4d70-8c8d-51d83d301906"
USER_ID = "cd8e2abc-1eb5-4b35-91af-e838065b3823"
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


# ─── AUTH GUARD ───
class TestAuthGuard:
    def test_company_get_without_token_returns_401(self):
        r = requests.get(f"{BASE_URL}/api/v1/company?company_id={COMPANY_ID}", timeout=10)
        assert r.status_code == 401

    def test_team_get_without_token_returns_401(self):
        r = requests.get(f"{BASE_URL}/api/v1/team?company_id={COMPANY_ID}", timeout=10)
        assert r.status_code == 401

    def test_company_patch_without_token_returns_401(self):
        r = requests.patch(f"{BASE_URL}/api/v1/company", json={"company_id": COMPANY_ID, "website": "x"}, timeout=10)
        assert r.status_code == 401


# ─── COMPANY MODULE ───
class TestCompany:
    def test_get_company(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/v1/company?company_id={COMPANY_ID}", headers=auth_headers, timeout=10)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "company" in data
        c = data["company"]
        assert c["id"] == COMPANY_ID
        assert c["name"] == "Garage Tremblay"
        # fields presence
        for k in ["contact_name", "contact_email", "phone", "city", "province", "country",
                  "preferred_language", "plan", "status", "created_at", "updated_at"]:
            assert k in c, f"Missing field: {k}"

    def test_patch_company_updates_website(self, auth_headers):
        new_site = f"https://garage-tremblay.ca?t={int(time.time())}"
        r = requests.patch(f"{BASE_URL}/api/v1/company",
                           headers=auth_headers,
                           json={"company_id": COMPANY_ID, "website": new_site},
                           timeout=10)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get("success") is True
        assert data["company"]["website"] == new_site
        # Verify via GET
        g = requests.get(f"{BASE_URL}/api/v1/company?company_id={COMPANY_ID}", headers=auth_headers, timeout=10)
        assert g.json()["company"]["website"] == new_site

    def test_patch_company_whitelist_ignores_plan(self, auth_headers):
        # Capture original plan
        orig = requests.get(f"{BASE_URL}/api/v1/company?company_id={COMPANY_ID}", headers=auth_headers, timeout=10).json()["company"]
        original_plan = orig["plan"]
        # Try to patch plan AND a valid field
        r = requests.patch(f"{BASE_URL}/api/v1/company",
                           headers=auth_headers,
                           json={"company_id": COMPANY_ID, "plan": "enterprise", "city": orig.get("city") or "Lévis"},
                           timeout=10)
        assert r.status_code == 200, r.text
        assert r.json()["company"]["plan"] == original_plan, "plan should be ignored by whitelist"

    def test_patch_company_missing_company_id_returns_400(self, auth_headers):
        r = requests.patch(f"{BASE_URL}/api/v1/company",
                           headers=auth_headers,
                           json={"website": "https://x.ca"},
                           timeout=10)
        assert r.status_code == 400

    def test_patch_company_no_valid_field_returns_400(self, auth_headers):
        r = requests.patch(f"{BASE_URL}/api/v1/company",
                           headers=auth_headers,
                           json={"company_id": COMPANY_ID, "plan": "enterprise"},
                           timeout=10)
        assert r.status_code == 400
        assert "Aucun champ valide" in r.json().get("error", "")


# ─── TEAM MODULE ───
class TestTeam:
    def test_get_team(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/v1/team?company_id={COMPANY_ID}", headers=auth_headers, timeout=10)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "members" in data and "invitations" in data
        emails = [m.get("email") for m in data["members"]]
        assert QA_EMAIL in emails, f"qa-bot not in members: {emails}"
        qa = next(m for m in data["members"] if m["email"] == QA_EMAIL)
        assert qa["role"] == "company_admin"
        assert qa["status"] == "active"

    def test_cancel_unknown_invitation_returns_404(self, auth_headers):
        fake_id = "00000000-0000-0000-0000-000000000000"
        r = requests.post(f"{BASE_URL}/api/v1/team/invitations/{fake_id}/cancel",
                          headers=auth_headers, timeout=10)
        assert r.status_code == 404, r.text

    def test_patch_member_missing_company_id_returns_400(self, auth_headers):
        # Validation only — do NOT actually mutate qa-bot
        r = requests.patch(f"{BASE_URL}/api/v1/team/members/{USER_ID}",
                           headers=auth_headers,
                           json={"status": "active"},  # missing company_id
                           timeout=10)
        assert r.status_code == 400

    def test_patch_member_no_valid_field_returns_400(self, auth_headers):
        r = requests.patch(f"{BASE_URL}/api/v1/team/members/{USER_ID}",
                           headers=auth_headers,
                           json={"company_id": COMPANY_ID, "role": "hacker"},
                           timeout=10)
        assert r.status_code == 400

    def test_patch_member_unknown_user_returns_404(self, auth_headers):
        fake_user = "00000000-0000-0000-0000-000000000099"
        r = requests.patch(f"{BASE_URL}/api/v1/team/members/{fake_user}",
                           headers=auth_headers,
                           json={"company_id": COMPANY_ID, "status": "suspended"},
                           timeout=10)
        assert r.status_code == 404
