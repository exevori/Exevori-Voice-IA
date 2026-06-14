# Phase Bonus KB — POST /api/v1/kb/sources/manual + PATCH /api/v1/kb/chunks/:id
import time
import pytest
import requests

BASE_URL = "https://720876eb-de73-4840-91bd-19cf23fab78e.preview.emergentagent.com"
COMPANY_ID = "af5f079f-6fc2-4d70-8c8d-51d83d301906"
QA_EMAIL = "qa-bot@garage-tremblay.test"
QA_PASSWORD = "QaBot_Test_2026!"
SUPABASE_URL = "https://yptsvqhcnksjxufziech.supabase.co"
SUPABASE_ANON_KEY = "sb_publishable_avATcYb4hXUF-_MKPNnYwg_9Q8uI9vl"

MANUAL_URL = f"{BASE_URL}/api/v1/kb/sources/manual"
PATCH_CHUNK_URL = f"{BASE_URL}/api/v1/kb/chunks"
SEARCH_URL = f"{BASE_URL}/api/v1/kb/sources/search"
SOURCES_URL = f"{BASE_URL}/api/v1/kb/sources"

_created_source_ids = []


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
def headers(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


@pytest.fixture(scope="session", autouse=True)
def cleanup(token):
    yield
    h = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    for sid in _created_source_ids:
        try:
            requests.delete(f"{SOURCES_URL}/{sid}?company_id={COMPANY_ID}", headers=h, timeout=15)
        except Exception:
            pass


# ===== Backend tests =====

class TestManualSourceCreate:
    def test_create_manual_source_success(self, headers):
        body = {
            "company_id": COMPANY_ID,
            "name": "TEST_KB_Bonus_Note_A",
            "content": "Voici nos prix Garage Tremblay pour 2026: changement pneus hiver 85$. "
                       "Horaires lun-ven 8h-17h. Paiement carte ou comptant. "
                       "Test minimum 30 caractères atteint largement.",
        }
        r = requests.post(MANUAL_URL, headers=headers, json=body, timeout=60)
        assert r.status_code == 200, f"{r.status_code} {r.text}"
        data = r.json()
        assert data.get("success") is True
        src = data.get("source")
        assert src and src.get("id")
        assert src.get("type") == "manual"
        assert src.get("name") == "TEST_KB_Bonus_Note_A"
        assert src.get("status") == "ready"
        assert (src.get("chunks_count") or data.get("chunks_count", 0)) >= 1
        assert data.get("embeddings_ready") is True
        assert src.get("embeddings_ready_at")
        _created_source_ids.append(src["id"])

    def test_create_manual_content_too_short(self, headers):
        body = {"company_id": COMPANY_ID, "name": "TEST_short", "content": "trop court"}
        r = requests.post(MANUAL_URL, headers=headers, json=body, timeout=20)
        assert r.status_code == 400
        assert "trop court" in r.json().get("error", "").lower()

    def test_create_manual_content_too_long(self, headers):
        body = {
            "company_id": COMPANY_ID,
            "name": "TEST_long",
            "content": "A" * 200_001,
        }
        r = requests.post(MANUAL_URL, headers=headers, json=body, timeout=30)
        assert r.status_code == 400
        assert "trop long" in r.json().get("error", "").lower()

    def test_create_manual_missing_company_id(self, headers):
        r = requests.post(MANUAL_URL, headers=headers,
                          json={"name": "x", "content": "abcdefghijklmnopqrstuvwxyz0123456"},
                          timeout=20)
        assert r.status_code == 400

    def test_create_manual_missing_name(self, headers):
        r = requests.post(MANUAL_URL, headers=headers,
                          json={"company_id": COMPANY_ID,
                                "content": "abcdefghijklmnopqrstuvwxyz0123456"},
                          timeout=20)
        assert r.status_code == 400

    def test_create_manual_missing_content(self, headers):
        r = requests.post(MANUAL_URL, headers=headers,
                          json={"company_id": COMPANY_ID, "name": "x"}, timeout=20)
        assert r.status_code == 400

    def test_create_manual_no_token(self):
        r = requests.post(MANUAL_URL,
                          headers={"Content-Type": "application/json"},
                          json={"company_id": COMPANY_ID, "name": "x",
                                "content": "abcdefghijklmnopqrstuvwxyz0123456"},
                          timeout=20)
        assert r.status_code == 401


# Shared fixture: a manual source for chunk-patch tests
@pytest.fixture(scope="module")
def manual_source_for_patch(token):
    h = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    body = {
        "company_id": COMPANY_ID,
        "name": "TEST_KB_Bonus_Note_PatchTarget",
        "content": "Garage Tremblay flux paiements: Visa Mastercard AMEX comptant. "
                   "Aucun cheque accepte. Horaires ete et hiver identiques 8h-17h. "
                   "Service alignement disponible sur rendez-vous.",
    }
    r = requests.post(MANUAL_URL, headers=h, json=body, timeout=60)
    assert r.status_code == 200, r.text
    src = r.json()["source"]
    _created_source_ids.append(src["id"])

    # Get chunk ids
    r2 = requests.get(f"{SOURCES_URL}/{src['id']}?company_id={COMPANY_ID}", headers=h, timeout=20)
    assert r2.status_code == 200, r2.text
    chunks = r2.json().get("chunks") or []
    assert len(chunks) >= 1
    return {"source_id": src["id"], "chunk_id": chunks[0]["id"],
            "original_content": chunks[0]["content"], "embeddings_ready_at": src.get("embeddings_ready_at")}


class TestPatchChunk:
    def test_patch_chunk_success_and_persistence(self, headers, manual_source_for_patch):
        chunk_id = manual_source_for_patch["chunk_id"]
        new_content = ("PATCH_TEST_MARKER xyzqzz uniquephrase: nouvelle politique "
                       "remboursement applicable 2026 sous conditions specifiques.")
        r = requests.patch(f"{PATCH_CHUNK_URL}/{chunk_id}", headers=headers,
                           json={"company_id": COMPANY_ID, "content": new_content},
                           timeout=60)
        assert r.status_code == 200, f"{r.status_code} {r.text}"
        data = r.json()
        assert data.get("success") is True
        ch = data.get("chunk")
        assert ch and ch.get("id") == chunk_id
        assert ch.get("content") == new_content.strip()
        assert isinstance(ch.get("token_count"), int) and ch["token_count"] > 0

    def test_patch_updates_source_embeddings_ready_at(self, headers, manual_source_for_patch):
        sid = manual_source_for_patch["source_id"]
        prev_ts = manual_source_for_patch["embeddings_ready_at"]
        # Already PATCHed above. Get source and verify embeddings_ready_at advanced.
        r = requests.get(f"{SOURCES_URL}/{sid}?company_id={COMPANY_ID}", headers=headers, timeout=20)
        assert r.status_code == 200
        src = r.json().get("source") or r.json()
        new_ts = src.get("embeddings_ready_at")
        assert new_ts and new_ts != prev_ts, f"expected updated timestamp, prev={prev_ts}, new={new_ts}"

    def test_patch_chunk_content_too_short(self, headers, manual_source_for_patch):
        cid = manual_source_for_patch["chunk_id"]
        r = requests.patch(f"{PATCH_CHUNK_URL}/{cid}", headers=headers,
                           json={"company_id": COMPANY_ID, "content": "abc"}, timeout=20)
        assert r.status_code == 400
        assert "trop court" in r.json().get("error", "").lower()

    def test_patch_chunk_content_too_long(self, headers, manual_source_for_patch):
        cid = manual_source_for_patch["chunk_id"]
        r = requests.patch(f"{PATCH_CHUNK_URL}/{cid}", headers=headers,
                           json={"company_id": COMPANY_ID, "content": "x" * 50_001}, timeout=20)
        assert r.status_code == 400
        assert "trop long" in r.json().get("error", "").lower()

    def test_patch_chunk_not_found(self, headers):
        fake = "00000000-0000-0000-0000-000000000000"
        r = requests.patch(f"{PATCH_CHUNK_URL}/{fake}", headers=headers,
                           json={"company_id": COMPANY_ID,
                                 "content": "contenu valide minimum dix caracteres ok"},
                           timeout=20)
        assert r.status_code == 404
        assert "introuvable" in r.json().get("error", "").lower()

    def test_patch_chunk_wrong_tenant(self, headers, manual_source_for_patch):
        cid = manual_source_for_patch["chunk_id"]
        other_company = "11111111-1111-1111-1111-111111111111"
        r = requests.patch(f"{PATCH_CHUNK_URL}/{cid}", headers=headers,
                           json={"company_id": other_company,
                                 "content": "contenu valide minimum dix caracteres ok"},
                           timeout=20)
        assert r.status_code == 403
        assert "autre tenant" in r.json().get("error", "").lower()

    def test_patch_chunk_search_returns_updated_content(self, headers, manual_source_for_patch):
        time.sleep(2)  # Let re-embed settle
        r = requests.post(SEARCH_URL, headers=headers,
                          json={"company_id": COMPANY_ID,
                                "query": "PATCH_TEST_MARKER nouvelle politique remboursement 2026",
                                "topK": 5, "minSimilarity": 0.0},
                          timeout=30)
        assert r.status_code == 200, r.text
        results = r.json().get("results", [])
        assert len(results) >= 1
        # Top result content should contain our unique marker
        contents = " ".join((res.get("content") or "") for res in results)
        assert "PATCH_TEST_MARKER" in contents, f"marker not in search results: {contents[:300]}"
