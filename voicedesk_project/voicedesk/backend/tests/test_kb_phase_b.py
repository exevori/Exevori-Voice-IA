"""
Backend tests — Phase KB+B (Embeddings + Semantic Search)
Coverage:
  - POST /api/v1/kb/sources/upload  → auto-embed
  - POST /api/v1/kb/sources/scrape  → auto-embed
  - POST /api/v1/kb/sources/search  → semantic search
  - POST /api/v1/kb/sources/:id/reembed
  - Auth enforcement
"""
import uuid
import time
import pytest
import requests

BASE_URL = "https://720876eb-de73-4840-91bd-19cf23fab78e.preview.emergentagent.com"
SUPABASE_URL = "https://yptsvqhcnksjxufziech.supabase.co"
SUPABASE_ANON_KEY = "sb_publishable_avATcYb4hXUF-_MKPNnYwg_9Q8uI9vl"

QA_EMAIL = "qa-bot@garage-tremblay.test"
QA_PASSWORD = "QaBot_Test_2026!"
QA_COMPANY_ID = "af5f079f-6fc2-4d70-8c8d-51d83d301906"
QA_PROFILE_ID = "a317f144-3cd6-454c-a3ed-ec6d2c6417f2"

GARAGE_TXT = """Garage Tremblay — Mécanique automobile à Québec

Services offerts:
- Changement de pneus d'hiver et d'été
- Alignement et balancement de roues
- Freins (plaquettes, disques, étriers)
- Vidange d'huile et entretien préventif
- Diagnostic électronique OBD-II
- Réparation de suspension

Prix indicatifs:
- Changement de 4 pneus d'hiver: 85 CAD (montage + balancement inclus)
- Entreposage saisonnier des pneus: 75 CAD par saison
- Vidange d'huile synthétique: 89 CAD
- Inspection complète: 65 CAD
- Diagnostic OBD-II: 95 CAD

Horaires d'ouverture:
Lundi au vendredi: 8h00 à 17h30
Samedi: 9h00 à 14h00
Dimanche: fermé

Paiements acceptés:
Comptant, Interac, Visa, Mastercard, American Express.
Nous offrons aussi le financement Accord D pour les réparations majeures.

Adresse:
1245 boulevard Charest Ouest, Québec, QC G1N 2C9
Téléphone: 418-555-7890
Courriel: info@garage-tremblay.test

Garantie:
Toutes nos réparations mécaniques sont garanties 12 mois ou 20 000 km.
"""


@pytest.fixture(scope="session")
def access_token():
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        headers={"apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json"},
        json={"email": QA_EMAIL, "password": QA_PASSWORD},
        timeout=15,
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture(scope="session")
def auth_headers(access_token):
    return {"Authorization": f"Bearer {access_token}"}


@pytest.fixture(scope="module")
def created_ids():
    return []


@pytest.fixture(scope="module", autouse=True)
def cleanup(auth_headers, created_ids):
    yield
    for sid in created_ids:
        try:
            requests.delete(f"{BASE_URL}/api/v1/kb/sources/{sid}", headers=auth_headers, timeout=15)
        except Exception:
            pass


@pytest.fixture(scope="module")
def garage_source(auth_headers, created_ids):
    """Upload Garage Tremblay TXT once for reuse across search tests."""
    files = {"file": ("TEST_kbb_garage.txt", GARAGE_TXT.encode("utf-8"), "text/plain")}
    data = {"company_id": QA_COMPANY_ID, "created_by": QA_PROFILE_ID}
    r = requests.post(
        f"{BASE_URL}/api/v1/kb/sources/upload",
        headers=auth_headers, files=files, data=data, timeout=120,
    )
    assert r.status_code == 200, r.text
    d = r.json()
    created_ids.append(d["source"]["id"])
    return d


# ── Module: Auto-embed on upload ───────────────────────────────
class TestUploadEmbed:
    def test_upload_returns_embeddings_ready(self, garage_source):
        assert garage_source["success"] is True
        assert garage_source["embeddings_ready"] is True
        assert garage_source["source"]["embeddings_ready_at"]
        assert garage_source["chunks_count"] >= 1

    def test_get_source_has_embeddings_ready_at(self, auth_headers, garage_source):
        sid = garage_source["source"]["id"]
        r = requests.get(f"{BASE_URL}/api/v1/kb/sources/{sid}", headers=auth_headers, timeout=20)
        assert r.status_code == 200
        s = r.json()["source"]
        assert s["embeddings_ready_at"] is not None


# ── Module: Auto-embed on scrape ───────────────────────────────
class TestScrapeEmbed:
    def test_scrape_wikipedia_embeds(self, auth_headers, created_ids):
        r = requests.post(
            f"{BASE_URL}/api/v1/kb/sources/scrape",
            headers={**auth_headers, "Content-Type": "application/json"},
            json={"company_id": QA_COMPANY_ID, "url": "https://fr.wikipedia.org/wiki/Pneu",
                  "created_by": QA_PROFILE_ID},
            timeout=180,
        )
        assert r.status_code == 200, r.text
        d = r.json()
        created_ids.append(d["source"]["id"])
        assert d["embeddings_ready"] is True
        assert d["source"]["embeddings_ready_at"]
        assert d["chunks_count"] > 0


# ── Module: Search ─────────────────────────────────────────────
class TestSearch:
    def test_search_relevant_query(self, auth_headers, garage_source):
        r = requests.post(
            f"{BASE_URL}/api/v1/kb/sources/search",
            headers={**auth_headers, "Content-Type": "application/json"},
            json={"company_id": QA_COMPANY_ID,
                  "query": "Combien coute un changement de pneus dhiver?",
                  "topK": 3},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["success"] is True
        assert d["query"] == "Combien coute un changement de pneus dhiver?"
        assert isinstance(d["results"], list)
        assert 1 <= len(d["results"]) <= 3
        assert "latency_ms" in d
        # Check structure
        r0 = d["results"][0]
        for key in ("chunk_id", "source_id", "source_name", "source_type",
                    "chunk_index", "content", "similarity"):
            assert key in r0, f"missing key {key}"
        # similarity in [0..1]
        for res in d["results"]:
            assert 0.0 <= res["similarity"] <= 1.0
        # sorted DESC by similarity
        sims = [r["similarity"] for r in d["results"]]
        assert sims == sorted(sims, reverse=True)

    def test_search_empty_query(self, auth_headers):
        r = requests.post(
            f"{BASE_URL}/api/v1/kb/sources/search",
            headers={**auth_headers, "Content-Type": "application/json"},
            json={"company_id": QA_COMPANY_ID, "query": "", "topK": 3},
            timeout=15,
        )
        assert r.status_code == 400

    def test_search_missing_company_id(self, auth_headers):
        r = requests.post(
            f"{BASE_URL}/api/v1/kb/sources/search",
            headers={**auth_headers, "Content-Type": "application/json"},
            json={"query": "hello"},
            timeout=15,
        )
        assert r.status_code == 400

    def test_search_unknown_company_returns_empty(self, auth_headers):
        other = str(uuid.uuid4())
        r = requests.post(
            f"{BASE_URL}/api/v1/kb/sources/search",
            headers={**auth_headers, "Content-Type": "application/json"},
            json={"company_id": other, "query": "anything", "topK": 3},
            timeout=30,
        )
        assert r.status_code == 200
        d = r.json()
        assert d["success"] is True
        assert d["results"] == []


# ── Module: Reembed ────────────────────────────────────────────
class TestReembed:
    def test_reembed_ok(self, auth_headers, garage_source):
        sid = garage_source["source"]["id"]
        chunks_count = garage_source["chunks_count"]
        r = requests.post(
            f"{BASE_URL}/api/v1/kb/sources/{sid}/reembed",
            headers={**auth_headers, "Content-Type": "application/json"},
            json={"company_id": QA_COMPANY_ID},
            timeout=60,
        )
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["success"] is True
        assert d["embedded_count"] == chunks_count
        assert d["embeddings_ready_at"]
        assert "latency_ms" in d

    def test_reembed_wrong_tenant_403(self, auth_headers, garage_source):
        sid = garage_source["source"]["id"]
        other = str(uuid.uuid4())
        r = requests.post(
            f"{BASE_URL}/api/v1/kb/sources/{sid}/reembed",
            headers={**auth_headers, "Content-Type": "application/json"},
            json={"company_id": other},
            timeout=15,
        )
        assert r.status_code == 403, r.text
        assert "tenant" in r.text.lower() or "autre" in r.text.lower()

    def test_reembed_not_found_404(self, auth_headers):
        fake = str(uuid.uuid4())
        r = requests.post(
            f"{BASE_URL}/api/v1/kb/sources/{fake}/reembed",
            headers={**auth_headers, "Content-Type": "application/json"},
            json={"company_id": QA_COMPANY_ID},
            timeout=15,
        )
        assert r.status_code == 404
        assert "introuvable" in r.text.lower() or "not found" in r.text.lower()


# ── Module: Auth enforcement (KB+A regression + KB+B) ──────────
class TestAuthRequired:
    def test_search_without_auth_401(self):
        r = requests.post(
            f"{BASE_URL}/api/v1/kb/sources/search",
            headers={"Content-Type": "application/json"},
            json={"company_id": QA_COMPANY_ID, "query": "hello"},
            timeout=15,
        )
        assert r.status_code == 401

    def test_reembed_without_auth_401(self):
        r = requests.post(
            f"{BASE_URL}/api/v1/kb/sources/{uuid.uuid4()}/reembed",
            headers={"Content-Type": "application/json"},
            json={"company_id": QA_COMPANY_ID},
            timeout=15,
        )
        assert r.status_code == 401

    def test_list_without_auth_401(self):
        r = requests.get(
            f"{BASE_URL}/api/v1/kb/sources",
            params={"company_id": QA_COMPANY_ID},
            timeout=15,
        )
        assert r.status_code == 401
