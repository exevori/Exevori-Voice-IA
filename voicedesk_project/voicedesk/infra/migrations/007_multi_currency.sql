-- ============================================================
-- MIGRATION 007 — Support multi-devise
-- CAD (Canada + taxes), USD (USA + reste du monde), EUR (Europe)
-- Installation : Canada uniquement
-- ============================================================

-- Ajouter currency + country aux companies
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS billing_country text DEFAULT 'CA',
  ADD COLUMN IF NOT EXISTS billing_currency text DEFAULT 'CAD'
    CHECK (billing_currency IN ('CAD','USD','EUR'));

-- Ajouter currency aux subscriptions
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS currency text DEFAULT 'CAD'
    CHECK (currency IN ('CAD','USD','EUR')),
  ADD COLUMN IF NOT EXISTS installation_fee_applicable boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS installation_fee_paid boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS installation_fee_amount decimal(8,2);

-- Ajouter currency + détail taxes aux invoices
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS currency text DEFAULT 'CAD'
    CHECK (currency IN ('CAD','USD','EUR')),
  ADD COLUMN IF NOT EXISTS tax_tps decimal(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_tvq decimal(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS billing_country text;

-- Renommer les colonnes _usd vers neutre (la devise est dans currency)
-- Note : on garde les colonnes existantes pour compat, on ajoute des vues claires
COMMENT ON COLUMN invoices.subtotal_usd IS 'Montant HT dans la devise indiquée par currency (legacy name)';
COMMENT ON COLUMN invoices.total_usd IS 'Montant TTC dans la devise indiquée par currency (legacy name)';

-- Mise à jour des prix des plans (nouveaux prix avec frais Stripe couverts)
-- Les prix sont stockés dans shared/constants.js comme source de vérité applicative
-- Cette table de référence sert au reporting SQL
CREATE TABLE IF NOT EXISTS plan_pricing (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_name     text UNIQUE NOT NULL,
  price         decimal(8,2) NOT NULL,        -- Même chiffre dans toutes devises
  price_annual  decimal(10,2) NOT NULL,       -- -20%
  minutes_included integer NOT NULL,
  overage_rate  decimal(6,4) NOT NULL,
  updated_at    timestamptz DEFAULT now()
);

INSERT INTO plan_pricing (plan_name, price, price_annual, minutes_included, overage_rate) VALUES
  ('solo',          79,  758,  150,  0.35),
  ('demarrage',     159, 1526, 400,  0.30),
  ('essentiel',     319, 3062, 1000, 0.25),
  ('professionnel', 529, 5078, 2500, 0.20),
  ('entreprise',    949, 9110, 6000, 0.15)
ON CONFLICT (plan_name) DO UPDATE SET
  price = EXCLUDED.price,
  price_annual = EXCLUDED.price_annual,
  minutes_included = EXCLUDED.minutes_included,
  overage_rate = EXCLUDED.overage_rate,
  updated_at = now();

ALTER TABLE plan_pricing ENABLE ROW LEVEL SECURITY;
CREATE POLICY plan_pricing_read ON plan_pricing FOR SELECT USING (true);
CREATE POLICY plan_pricing_write ON plan_pricing FOR ALL USING (is_super_admin());

-- Fonction utilitaire : devise selon pays
CREATE OR REPLACE FUNCTION currency_for_country(country text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN country = 'CA' THEN 'CAD'
    WHEN country = 'US' THEN 'USD'
    WHEN country IN ('AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR',
                     'DE','GR','HU','IE','IT','LV','LT','LU','MT','NL',
                     'PL','PT','RO','SK','SI','ES','SE') THEN 'EUR'
    ELSE 'USD'
  END;
$$;

-- Fonction utilitaire : installation applicable ?
CREATE OR REPLACE FUNCTION installation_fee_for_country(country text)
RETURNS decimal LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN country = 'CA' THEN 319.00 ELSE 0.00 END;
$$;
