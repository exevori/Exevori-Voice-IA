-- ═══════════════════════════════════════════════════════════
-- EXEVORI VOICE IA — Migration Phase 8C-1
-- Active/désactive le pré-roll contextuel par PME.
-- ═══════════════════════════════════════════════════════════

ALTER TABLE assistant_configs
  ADD COLUMN IF NOT EXISTS voice_preroll_enabled BOOLEAN DEFAULT false;

COMMENT ON COLUMN assistant_configs.voice_preroll_enabled IS
  'Si true, Léa joue un pré-roll contextuel (ex: "Très bien.", "Bonne question.") AVANT d''attendre le LLM, pour masquer la latence reasoning. Skip auto sur contexte émotionnel négatif (décès, urgence, plainte).';

-- Active le pré-roll pour Exevori uniquement (test V1)
UPDATE assistant_configs
   SET voice_preroll_enabled = true
 WHERE company_id = '992724ec-a5ec-4ecd-a2f4-9f2a6afa3f65';
