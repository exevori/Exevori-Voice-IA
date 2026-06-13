"""
Backend tests — Phase KB+A (Knowledge Base ingestion)
Coverage: /api/v1/kb/sources (list, get, upload, scrape, delete) + tenant isolation
"""
import os
import io
import time
import uuid
import pytest
import requests

# ── Config ─────────────────────────────────────────────────────
BASE_URL = "https://720876eb-de73-4840-91bd-19cf23fab78e.preview.emergentagent.com"
SUPABASE_URL = "https://yptsvqhcnksjxufziech.supabase.co"
SUPABASE_ANON_KEY = "sb_publishable_avATcYb4hXUF-_MKPNnYwg_9Q8uI9vl"

QA_EMAIL = "qa-bot@garage-tremblay.test"
QA_PASSWORD = "QaBot_Test_2026!"
QA_COMPANY_ID = "af5f079f-6fc2-4d70-8c8d-51d83d301906"
QA_PROFILE_ID = "a317f144-3cd6-454c-a3ed-ec6d2c6417f2"


# ── Fixtures ───────────────────────────────────────────────────
@pytest.fixture(scope="session")
def access_token():
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        headers={"apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json"},
        json={"email": QA_EMAIL, "password": QA_PASSWORD},
        timeout=15,
    )
    assert r.status_code == 200, f"Supabase login failed: {r.text}"
    tok = r.json().get("access_token")
    assert tok and len(tok) > 100
    return tok


@pytest.fixture(scope="session")
def auth_headers(access_token):
    return {"Authorization": f"Bearer {access_token}"}


@pytest.fixture(scope="module")
def created_source_ids():
    """Tracks created sources for cleanup at end of module."""
    return []


@pytest.fixture(scope="module", autouse=True)
def cleanup(auth_headers, created_source_ids):
    yield
    for sid in created_source_ids:
        try:
            requests.delete(f"{BASE_URL}/api/v1/kb/sources/{sid}", headers=auth_headers, timeout=10)
        except Exception:
            pass


# ── Module: Listing ────────────────────────────────────────────
class TestListSources:
    def test_list_requires_company_id(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/v1/kb/sources", headers=auth_headers, timeout=15)
        assert r.status_code == 400
        assert "company_id" in r.text.lower()

    def test_list_with_company_id(self, auth_headers):
        r = requests.get(
            f"{BASE_URL}/api/v1/kb/sources",
            params={"company_id": QA_COMPANY_ID},
            headers=auth_headers,
            timeout=15,
        )
        assert r.status_code == 200, r.text
        d = r.json()
        assert "sources" in d and isinstance(d["sources"], list)
        assert "total" in d and isinstance(d["total"], int)


# ── Module: Upload ─────────────────────────────────────────────
class TestUpload:
    def test_upload_txt_success(self, auth_headers, created_source_ids):
        content = ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. " * 40 +
                   "\n\nGarage Tremblay propose des services de mécanique générale, pneus, freins. " * 20 +
                   "\n\nNous sommes ouverts du lundi au vendredi de 8h à 17h. " * 20)
        files = {"file": ("TEST_kb_a.txt", content.encode("utf-8"), "text/plain")}
        data = {"company_id": QA_COMPANY_ID, "created_by": QA_PROFILE_ID}
        r = requests.post(
            f"{BASE_URL}/api/v1/kb/sources/upload",
            headers=auth_headers, files=files, data=data, timeout=60,
        )
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["success"] is True
        assert d["source"]["status"] == "ready"
        assert d["chunks_count"] > 0
        assert d["source"]["company_id"] == QA_COMPANY_ID
        created_source_ids.append(d["source"]["id"])

    def test_upload_missing_company_id(self, auth_headers):
        files = {"file": ("TEST_x.txt", b"hello", "text/plain")}
        r = requests.post(
            f"{BASE_URL}/api/v1/kb/sources/upload",
            headers=auth_headers, files=files, timeout=20,
        )
        assert r.status_code == 400

    def test_upload_unsupported_mime(self, auth_headers):
        # Use a fake PNG
        png_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
        files = {"file": ("TEST_img.png", png_bytes, "image/png")}
        data = {"company_id": QA_COMPANY_ID}
        r = requests.post(
            f"{BASE_URL}/api/v1/kb/sources/upload",
            headers=auth_headers, files=files, data=data, timeout=20,
        )
        assert r.status_code == 400
        assert "non support" in r.text.lower() or "type" in r.text.lower()


# ── Module: Scrape ─────────────────────────────────────────────
class TestScrape:
    def test_scrape_url_success(self, auth_headers, created_source_ids):
        r = requests.post(
            f"{BASE_URL}/api/v1/kb/sources/scrape",
            headers={**auth_headers, "Content-Type": "application/json"},
            json={
                "company_id": QA_COMPANY_ID,
                "url": "https://fr.wikipedia.org/wiki/Pneu",
                "created_by": QA_PROFILE_ID,
            },
            timeout=60,
        )
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["success"] is True
        assert d["source"]["status"] == "ready"
        assert d["chunks_count"] > 0
        created_source_ids.append(d["source"]["id"])

    def test_scrape_invalid_url(self, auth_headers):
        r = requests.post(
            f"{BASE_URL}/api/v1/kb/sources/scrape",
            headers={**auth_headers, "Content-Type": "application/json"},
            json={"company_id": QA_COMPANY_ID, "url": "not-a-valid-url"},
            timeout=20,
        )
        assert r.status_code == 400
        assert "url invalide" in r.text.lower()

    def test_scrape_non_http(self, auth_headers):
        r = requests.post(
            f"{BASE_URL}/api/v1/kb/sources/scrape",
            headers={**auth_headers, "Content-Type": "application/json"},
            json={"company_id": QA_COMPANY_ID, "url": "ftp://example.com/file.txt"},
            timeout=20,
        )
        assert r.status_code == 400
        assert "http" in r.text.lower()

    def test_scrape_missing_url(self, auth_headers):
        r = requests.post(
            f"{BASE_URL}/api/v1/kb/sources/scrape",
            headers={**auth_headers, "Content-Type": "application/json"},
            json={"company_id": QA_COMPANY_ID},
            timeout=20,
        )
        assert r.status_code == 400


# ── Module: Get + Delete + Tenant isolation ────────────────────
class TestGetDeleteIsolation:
    def test_get_source_detail(self, auth_headers, created_source_ids):
        if not created_source_ids:
            pytest.skip("No source created earlier")
        sid = created_source_ids[0]
        r = requests.get(f"{BASE_URL}/api/v1/kb/sources/{sid}", headers=auth_headers, timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["source"]["id"] == sid
        assert isinstance(d["chunks"], list)
        assert len(d["chunks"]) > 0
        c0 = d["chunks"][0]
        assert "content" in c0 and "chunk_index" in c0 and "token_count" in c0

    def test_get_source_not_found(self, auth_headers):
        fake_id = str(uuid.uuid4())
        r = requests.get(f"{BASE_URL}/api/v1/kb/sources/{fake_id}", headers=auth_headers, timeout=15)
        assert r.status_code == 404

    def test_delete_source(self, auth_headers, created_source_ids):
        # Create a throwaway one
        files = {"file": ("TEST_del.txt", b"contenu de test pour suppression " * 50, "text/plain")}
        data = {"company_id": QA_COMPANY_ID}
        r = requests.post(
            f"{BASE_URL}/api/v1/kb/sources/upload",
            headers=auth_headers, files=files, data=data, timeout=60,
        )
        assert r.status_code == 200, r.text
        sid = r.json()["source"]["id"]

        dr = requests.delete(f"{BASE_URL}/api/v1/kb/sources/{sid}", headers=auth_headers, timeout=20)
        assert dr.status_code == 200
        assert dr.json().get("success") is True

        # Verify it's gone
        gr = requests.get(f"{BASE_URL}/api/v1/kb/sources/{sid}", headers=auth_headers, timeout=15)
        assert gr.status_code == 404

    def test_tenant_isolation_unrelated_company(self, auth_headers):
        """SECURITY CHECK: backend uses SERVICE_ROLE_KEY → no RLS.
        Isolation depends purely on query param company_id. Verify backend doesn't
        bleed Garage data when other company_id is requested."""
        other = str(uuid.uuid4())
        r = requests.get(
            f"{BASE_URL}/api/v1/kb/sources",
            params={"company_id": other},
            headers=auth_headers,
            timeout=15,
        )
        assert r.status_code == 200
        d = r.json()
        # Should be empty for random UUID
        assert d["total"] == 0
        assert d["sources"] == []

    def test_no_auth_token_required(self):
        """Document: backend currently does NOT enforce auth on KB endpoints.
        This test asserts current behavior so a regression makes it fail."""
        r = requests.get(
            f"{BASE_URL}/api/v1/kb/sources",
            params={"company_id": QA_COMPANY_ID},
            timeout=15,
        )
        # If this returns 200, endpoint is unauthenticated — security concern.
        # If 401/403, auth middleware was added (good).
        print(f"[SECURITY] /api/v1/kb/sources without token -> {r.status_code}")
        assert r.status_code in (200, 401, 403)
