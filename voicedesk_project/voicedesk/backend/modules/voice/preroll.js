// ============================================================
// EXEVORI VOICE IA — Contextual Pre-roll Filler (Phase 8C-1)
//
// But: masquer la latence du LLM (1-3s reasoning) en faisant
// parler Léa AVANT que le LLM ait fini. Sélection contextuelle
// pour éviter "Parfait" sur un décès.
//
// Règles:
//   1. Si transcript contient des mots émotionnels négatifs → SKIP
//   2. Si transcript est une question (? ou interrogatifs) → catégorie QUESTION
//   3. Sinon → catégorie AFFIRMATION
//   4. Pas de répétition immédiate du même filler dans une session
// ============================================================

const AFFIRMATIONS = ["Très bien.", "Parfait.", "D'accord.", "OK."];
const QUESTIONS    = ["Bonne question.", "Je regarde ça.", "Voyons."];

// Mots-clés indiquant un contexte émotionnel sensible — on ne fait PAS de pré-roll
const EMOTIONAL_KEYWORDS = [
  "décès", "mort", "décédé", "décédée", "deuil", "funéraille",
  "urgent", "urgence", "panique", "panic",
  "problème grave", "catastrophe", "accident grave",
  "plainte", "mécontent", "mécontente", "fâché", "fâchée", "colère",
  "en colère", "furieux", "furieuse",
];

// Mots interrogatifs (sans accents pour matching tolérant)
const QUESTION_KEYWORDS = [
  "combien", "comment", "pourquoi", "quand", "ou est", "ou se",
  "qu'est-ce", "qu'est ce", "est-ce que", "est ce que",
  "puis-je", "puis je", "pouvez-vous", "pouvez vous",
  "pourriez", "voulez", "savez-vous", "savez vous",
  "quel ", "quelle ", "quels ", "quelles ",
];

/**
 * Détermine la catégorie d'un transcript utilisateur.
 * @returns {'AFFIRMATION'|'QUESTION'|'EMOTIONAL_SKIP'}
 */
function classify(transcript) {
  const lc = (transcript || "").toLowerCase();
  if (!lc.trim()) return "EMOTIONAL_SKIP";
  for (const k of EMOTIONAL_KEYWORDS) { if (lc.includes(k)) return "EMOTIONAL_SKIP"; }
  if (lc.includes("?")) return "QUESTION";
  for (const k of QUESTION_KEYWORDS) { if (lc.includes(k)) return "QUESTION"; }
  return "AFFIRMATION";
}

/**
 * Choisit un pré-roll en évitant la répétition immédiate du précédent.
 * @param {string} transcript
 * @param {{last?: string}} state - mutable, ex: session.prerollState
 * @returns {string|null}  null = skip (émotionnel ou désactivé)
 */
export function pickPreroll(transcript, state = {}) {
  const cat = classify(transcript);
  if (cat === "EMOTIONAL_SKIP") return null;

  const pool = cat === "QUESTION" ? QUESTIONS : AFFIRMATIONS;
  const candidates = pool.filter(p => p !== state.last);
  const choice = candidates[Math.floor(Math.random() * candidates.length)] || pool[0];
  state.last = choice;
  state.lastCategory = cat;
  return choice;
}

// Exports pour tests
export const _internals = { classify, AFFIRMATIONS, QUESTIONS, EMOTIONAL_KEYWORDS };
