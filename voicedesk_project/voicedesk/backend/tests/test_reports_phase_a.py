"""
Backend tests — Phase Reports+A (ROI Dashboard + Avant/Apres)
Coverage:
  - GET /api/v1/reports/summary (today, week, month, year)
  - Auth enforcement
  - company_id validation
  - Empty company (no data) returns zeros
  - Coherence checks: totals == counts, saved_seconds = max(0, sans-avec), saved_cad math
"""
import math
import uuid
import pytest
import requests

BASE_URL = "https://720876eb-de73-4840-91bd-19cf23fab78e.preview.emergentagent.com"
SUPABASE_URL = "https://yptsvqhcnksjxufziech.supabase.co"
SUPABASE_ANON_KEY = "sb_publishable_avATcYb4hXUF-_MKPNnYwg_9Q8uI9vl"

QA_EMAIL = "qa-bot@garage-tremblay.test"
QA_PASSWORD = "QaBot_Test_2026!"
QA_COMPANY_ID = "af5f079f-6fc2-4d70-8c8d-51d83d301906"

# ROI factors (must match backend defaults / env)
PME_HOURLY_RATE_CAD = 35
SEC_PER_EMAIL_WITHOUT_AI = 180
SEC_PER_APPOINTMENT_BOOK = 300
SEC_PER_DRAFT_VALIDATION = 60
SEC_PER_TRANSFER = 120


# ─── Fixtures ────────────────────────────────────────────────
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


# ─── Helpers ────────────────────────────────────────────────
def _is_finite_number(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _assert_schema(payload, expected_granularity):
    """Validates the full response schema and that no value is null/NaN."""
    # period
    assert "period" in payload, payload
    p = payload["period"]
    for k in ["key", "label", "start", "end", "granularity"]:
        assert k in p, f"missing period.{k}"
        assert p[k] is not None
    assert p["granularity"] == expected_granularity, p

    # kpis
    assert "kpis" in payload
    k = payload["kpis"]
    for key in ["total_handled", "appointments_booked", "time_saved_seconds", "recovery_rate_pct"]:
        assert key in k, f"missing kpis.{key}"
        assert _is_finite_number(k[key]), f"kpis.{key} is not a finite number: {k[key]!r}"

    # time_saved
    assert "time_saved" in payload
    ts = payload["time_saved"]
    for key in ["sans_lea_seconds", "avec_lea_seconds", "saved_seconds",
                "saved_hours", "saved_cad", "hourly_rate_cad"]:
        assert key in ts
        assert _is_finite_number(ts[key]), f"time_saved.{key} is not finite: {ts[key]!r}"
    # breakdown
    bd = ts["breakdown"]
    for key in ["calls_seconds", "emails_seconds_equivalent",
                "appointments_seconds_equiv", "drafts_validated_seconds",
                "transfers_seconds"]:
        assert key in bd
        assert _is_finite_number(bd[key]), f"breakdown.{key} is not finite"

    # series
    assert "series" in payload
    assert isinstance(payload["series"], list)
    for row in payload["series"]:
        assert "t" in row and row["t"]
        for key in ["calls", "emails", "time_saved_seconds"]:
            assert key in row
            assert _is_finite_number(row[key])

    # counts
    assert "counts" in payload
    c = payload["counts"]
    for key in ["calls", "emails", "drafts", "appointments", "transferred"]:
        assert key in c
        assert _is_finite_number(c[key])


# ─── Tests ───────────────────────────────────────────────────
class TestAuth:
    def test_missing_token_returns_401(self):
        r = requests.get(
            f"{BASE_URL}/api/v1/reports/summary",
            params={"company_id": QA_COMPANY_ID, "period": "week"},
            timeout=15,
        )
        assert r.status_code == 401, r.text

    def test_invalid_token_returns_401(self):
        r = requests.get(
            f"{BASE_URL}/api/v1/reports/summary",
            headers={"Authorization": "Bearer not-a-real-jwt"},
            params={"company_id": QA_COMPANY_ID, "period": "week"},
            timeout=15,
        )
        assert r.status_code == 401, r.text


class TestValidation:
    def test_missing_company_id_returns_400(self, auth_headers):
        r = requests.get(
            f"{BASE_URL}/api/v1/reports/summary",
            headers=auth_headers,
            params={"period": "week"},
            timeout=15,
        )
        assert r.status_code == 400, r.text
        body = r.json()
        assert "error" in body
        assert "company_id" in body["error"].lower()


class TestPeriods:
    @pytest.mark.parametrize("period,gran", [
        ("today", "hour"),
        ("week", "day"),
        ("month", "day"),
        ("year", "month"),
    ])
    def test_period_schema_and_granularity(self, auth_headers, period, gran):
        r = requests.get(
            f"{BASE_URL}/api/v1/reports/summary",
            headers=auth_headers,
            params={"company_id": QA_COMPANY_ID, "period": period},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        _assert_schema(r.json(), expected_granularity=gran)


class TestGarageTremblayWeek:
    """Use seed data of Garage Tremblay: 11 calls, 7 emails, 4 drafts."""

    @pytest.fixture(scope="class")
    def payload(self, auth_headers):
        r = requests.get(
            f"{BASE_URL}/api/v1/reports/summary",
            headers=auth_headers,
            params={"company_id": QA_COMPANY_ID, "period": "week"},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        return r.json()

    def test_total_handled_equals_calls_plus_emails(self, payload):
        c = payload["counts"]
        k = payload["kpis"]
        assert k["total_handled"] == c["calls"] + c["emails"]

    def test_saved_seconds_non_negative_and_consistent(self, payload):
        ts = payload["time_saved"]
        expected = max(0, ts["sans_lea_seconds"] - ts["avec_lea_seconds"])
        assert ts["saved_seconds"] == expected

    def test_saved_cad_math(self, payload):
        ts = payload["time_saved"]
        expected = round((ts["saved_seconds"] / 3600.0) * PME_HOURLY_RATE_CAD * 100) / 100
        assert abs(ts["saved_cad"] - expected) < 0.02, (ts["saved_cad"], expected)

    def test_hourly_rate_is_configured(self, payload):
        assert payload["time_saved"]["hourly_rate_cad"] == PME_HOURLY_RATE_CAD

    def test_recovery_rate_pct_in_bounds(self, payload):
        rr = payload["kpis"]["recovery_rate_pct"]
        assert 0 <= rr <= 100

    def test_garage_has_meaningful_data(self, payload):
        # Seed data expects 11 calls + 7 emails => 18 handled
        assert payload["kpis"]["total_handled"] > 0
        assert payload["time_saved"]["saved_seconds"] > 0
        assert payload["counts"]["calls"] >= 1
        assert payload["counts"]["emails"] >= 1


class TestEmptyCompany:
    """Random UUID = company with no rows. Expect 200 with all zeros."""

    def test_empty_company_returns_zeros(self, auth_headers):
        rand_company = str(uuid.uuid4())
        r = requests.get(
            f"{BASE_URL}/api/v1/reports/summary",
            headers=auth_headers,
            params={"company_id": rand_company, "period": "week"},
            timeout=20,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        _assert_schema(body, expected_granularity="day")
        for v in body["kpis"].values():
            assert v == 0, body["kpis"]
        assert body["time_saved"]["saved_seconds"] == 0
        assert body["time_saved"]["saved_cad"] == 0
        for v in body["counts"].values():
            assert v == 0
