"""
Phase Reports+B — Backend tests for /api/v1/reports/export/{csv,pdf}
Iteration 8
"""
import os
import re
import pytest
import requests

# Public preview URL (provided by reviewer)
BASE_URL = "https://720876eb-de73-4840-91bd-19cf23fab78e.preview.emergentagent.com"
API = f"{BASE_URL}/api/v1"

QA_EMAIL = "qa-bot@garage-tremblay.test"
QA_PASS = "QaBot_Test_2026!"
QA_COMPANY = "af5f079f-6fc2-4d70-8c8d-51d83d301906"

# Supabase login (the project uses supabase-js client-side; backend reads Bearer JWT)
SUPABASE_URL = "https://yptsvqhcnksjxufziech.supabase.co"
SUPABASE_ANON = "sb_publishable_avATcYb4hXUF-_MKPNnYwg_9Q8uI9vl"


@pytest.fixture(scope="session")
def token():
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        json={"email": QA_EMAIL, "password": QA_PASS},
        headers={"apikey": SUPABASE_ANON, "Content-Type": "application/json"},
        timeout=15,
    )
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    j = r.json()
    tk = j.get("access_token")
    assert tk
    return tk


@pytest.fixture(scope="session")
def auth_headers(token):
    return {"Authorization": f"Bearer {token}"}


# ─── CSV ──────────────────────────────────────────────────────────────────
class TestCSVExport:
    def test_csv_unauthenticated_401(self):
        r = requests.get(f"{API}/reports/export/csv", params={"company_id": QA_COMPANY, "period": "week"}, timeout=20)
        assert r.status_code == 401

    def test_csv_missing_company_400(self, auth_headers):
        r = requests.get(f"{API}/reports/export/csv", params={"period": "week"}, headers=auth_headers, timeout=20)
        assert r.status_code == 400

    def test_csv_week_headers_and_content(self, auth_headers):
        r = requests.get(f"{API}/reports/export/csv",
                         params={"company_id": QA_COMPANY, "period": "week"},
                         headers=auth_headers, timeout=30)
        assert r.status_code == 200, r.text
        ct = r.headers.get("content-type", "")
        assert "text/csv" in ct.lower() and "charset=utf-8" in ct.lower()
        cd = r.headers.get("content-disposition", "")
        assert "attachment" in cd.lower()
        m = re.search(r'filename="?([^"]+)"?', cd)
        assert m, f"no filename in: {cd}"
        fname = m.group(1)
        assert re.match(r"exevori-rapport-.*-week-\d{8}\.csv", fname), f"bad fname: {fname}"

        body = r.content
        assert body.startswith(b"\xef\xbb\xbf"), "missing UTF-8 BOM"
        text = body.decode("utf-8-sig")
        assert ";" in text, "expected ';' delimiter"
        assert "Métrique;Valeur" in text
        assert "Entreprise;Garage Tremblay" in text
        assert "Période;7 derniers jours" in text
        assert "ROI — Économisé" in text
        assert "Comptages — Appels" in text
        assert "── Série temporelle ──" in text

    @pytest.mark.parametrize("period,label", [
        ("today", "Aujourd'hui"),
        ("week",  "7 derniers jours"),
        ("month", "Ce mois-ci"),
        ("year",  "Cette année"),
    ])
    def test_csv_all_periods(self, auth_headers, period, label):
        r = requests.get(f"{API}/reports/export/csv",
                         params={"company_id": QA_COMPANY, "period": period},
                         headers=auth_headers, timeout=30)
        assert r.status_code == 200
        text = r.content.decode("utf-8-sig")
        assert f"Période;{label}" in text, f"label mismatch for {period}"

    def test_csv_empty_company_no_crash(self, auth_headers):
        """random UUID with no data must still generate a CSV with zeros."""
        random_id = "00000000-0000-0000-0000-000000000001"
        r = requests.get(f"{API}/reports/export/csv",
                         params={"company_id": random_id, "period": "week"},
                         headers=auth_headers, timeout=30)
        assert r.status_code == 200
        text = r.content.decode("utf-8-sig")
        assert "NaN" not in text
        # KPIs should be 0
        assert re.search(r"Interactions gérées;0\b", text)
        assert re.search(r"Rendez-vous pris;0\b", text)


# ─── PDF ──────────────────────────────────────────────────────────────────
class TestPDFExport:
    def test_pdf_unauthenticated_401(self):
        r = requests.get(f"{API}/reports/export/pdf", params={"company_id": QA_COMPANY, "period": "week"}, timeout=20)
        assert r.status_code == 401

    def test_pdf_missing_company_400(self, auth_headers):
        r = requests.get(f"{API}/reports/export/pdf", params={"period": "week"}, headers=auth_headers, timeout=20)
        assert r.status_code == 400

    def test_pdf_week_signature_and_size(self, auth_headers):
        r = requests.get(f"{API}/reports/export/pdf",
                         params={"company_id": QA_COMPANY, "period": "week"},
                         headers=auth_headers, timeout=30)
        assert r.status_code == 200, r.text[:300] if hasattr(r, "text") else ""
        assert "application/pdf" in r.headers.get("content-type", "").lower()
        cd = r.headers.get("content-disposition", "")
        assert "attachment" in cd.lower()
        m = re.search(r'filename="?([^"]+)"?', cd)
        assert m
        fname = m.group(1)
        assert re.match(r"exevori-rapport-.*-week-\d{8}\.pdf", fname), f"bad fname: {fname}"

        body = r.content
        assert len(body) > 1500, f"pdf too small: {len(body)}"
        head = body[:8]
        assert head.startswith(b"%PDF-1."), f"bad signature: {head!r}"

        # Try PyPDF2 readability
        try:
            import PyPDF2
            import io
            reader = PyPDF2.PdfReader(io.BytesIO(body))
            assert len(reader.pages) >= 1
        except ImportError:
            pass  # signature + size sufficient

    @pytest.mark.parametrize("period", ["today", "week", "month", "year"])
    def test_pdf_all_periods(self, auth_headers, period):
        r = requests.get(f"{API}/reports/export/pdf",
                         params={"company_id": QA_COMPANY, "period": period},
                         headers=auth_headers, timeout=30)
        assert r.status_code == 200
        assert r.content[:8].startswith(b"%PDF-1.")
        assert len(r.content) > 1500

    def test_pdf_empty_company_no_crash(self, auth_headers):
        random_id = "00000000-0000-0000-0000-000000000001"
        r = requests.get(f"{API}/reports/export/pdf",
                         params={"company_id": random_id, "period": "week"},
                         headers=auth_headers, timeout=30)
        assert r.status_code == 200
        assert r.content[:8].startswith(b"%PDF-1.")
        assert len(r.content) > 800  # smaller PDF but still valid


# ─── Coherence CSV vs /summary ────────────────────────────────────────────
class TestCoherence:
    def test_csv_roi_matches_summary_endpoint(self, auth_headers):
        r1 = requests.get(f"{API}/reports/summary",
                          params={"company_id": QA_COMPANY, "period": "week"},
                          headers=auth_headers, timeout=30)
        assert r1.status_code == 200
        summary = r1.json()
        saved_seconds = summary["kpis"]["time_saved_seconds"]

        # format like backend's formatDurationFr
        def fmt(s):
            s = max(0, round(s or 0))
            if s < 60: return f"{s} s"
            m = s // 60
            if m < 60: return f"{m} min"
            h = m // 60
            rem = m % 60
            return f"{h} h" if rem == 0 else f"{h} h {str(rem).zfill(2)}"

        expected = fmt(saved_seconds)

        r2 = requests.get(f"{API}/reports/export/csv",
                          params={"company_id": QA_COMPANY, "period": "week"},
                          headers=auth_headers, timeout=30)
        assert r2.status_code == 200
        text = r2.content.decode("utf-8-sig")
        line = next((ln for ln in text.splitlines() if ln.startswith("ROI — Économisé;")), None)
        assert line is not None, "ROI — Économisé row missing"
        value = line.split(";", 1)[1].strip()
        assert value == expected, f"CSV ROI={value!r} vs summary fmt={expected!r}"
