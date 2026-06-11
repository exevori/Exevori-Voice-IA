# 📨 PROMPT À COPIER-COLLER À EMERGENT.SH

> Ce document est destiné à être copié-collé EN ENTIER comme premier message à Emergent.sh.
> Il agit comme un brief de CTO pour cadrer le travail et minimiser les coûts en crédits.

---

## 🧑‍💼 PROMPT (à copier intégralement)

```
Bonjour Emergent,

Tu es un développeur senior qui va construire la V1 production de notre SaaS
"Exevori Voice IA". Je suis Karim, product owner (Lévis, Québec).

Je te confie un projet où le BACKEND est DÉJÀ 100% codé.
Ton rôle n'est PAS de tout réécrire — c'est de :

1. Démarrer le backend tel quel sans le modifier
2. Construire le FRONTEND React qui consomme l'API existante
3. Brancher les intégrations réelles (Twilio, ElevenLabs, Stripe)
4. Déployer en production

═══════════════════════════════════════════════════════════
RÈGLES ABSOLUES — VIOLATION = REPRISE DU CODE
═══════════════════════════════════════════════════════════

🚫 NE JAMAIS hardcoder le nom "Léa" dans le frontend.
   Toujours utiliser : config.assistant_name || "Assistant"
   Chaque PME nomme son assistante librement (Antonella, Marie, etc.)

🚫 NE JAMAIS modifier les fichiers backend existants sans me demander.
   Le backend a été audité, testé, validé. Toute modif = risque.

🚫 NE JAMAIS recréer un module qui existe déjà.
   Vérifie backend/modules/ avant de créer quoi que ce soit.

🚫 NE JAMAIS faire de mode clair (light mode) en V1.
   Dark only, palette Linear/Cursor (variables dans global.css).

🚫 NE JAMAIS écrire du texte hardcodé dans le frontend.
   Toujours t("clé") via react-i18next.
   Clés FR + EN existent dans frontend/src/i18n/locales/

🚫 NE JAMAIS appeler directement Supabase depuis le frontend pour les données métier.
   Toujours via les routes API documentées dans docs/EMERGENT-REFERENCE.md.

═══════════════════════════════════════════════════════════
LECTURE OBLIGATOIRE AVANT DE COMMENCER (dans cet ordre)
═══════════════════════════════════════════════════════════

1. README.md                          ← Vue d'ensemble (5 min)
2. docs/EMERGENT-WORKSHEET.md         ← FEUILLE DE TRAVAIL fichier-par-fichier (LE PLUS IMPORTANT)
3. docs/EMERGENT-DESIGN.md            ← Spec visuelle (image cible + briques GitHub)
4. design-reference/dashboard-reference.png   ← L'IMAGE CIBLE
5. design-reference/DashboardPrototype.jsx    ← Prototype style de référence
6. docs/EMERGENT-REFERENCE.md         ← 130 routes API à utiliser
7. design-reference/branding/         ← Logos officiels Exevori Voice IA

GARDE OUVERT EN PERMANENCE :
- docs/EMERGENT-WORKSHEET.md
- docs/EMERGENT-REFERENCE.md
- design-reference/dashboard-reference.png

═══════════════════════════════════════════════════════════
STACK IMPOSÉE (NE PAS DÉVIER)
═══════════════════════════════════════════════════════════

Frontend  : React 18 + Vite + i18next + Tailwind + shadcn/ui
Charts    : Tremor (sparklines KPI) + Recharts (déjà installé)
Effets    : Aceternity UI (Glowing Effect, Card Spotlight) — copy-paste only
Animation : framer-motion (déjà dans package.json)
Auth      : Supabase Auth (@supabase/supabase-js, déjà installé)
State     : React Context (pas de Redux, pas de Zustand)
API calls : fetch natif (pas d'axios pour rester léger)
Backend   : NE PAS TOUCHER (Node.js + Express, ports 3000/3100/8080/8081)

═══════════════════════════════════════════════════════════
ÉCONOMIE DE CRÉDITS — COMMENT TRAVAILLER EFFICACEMENT
═══════════════════════════════════════════════════════════

✅ COPY-PASTE les composants shadcn/ui via `npx shadcn@latest add <name>`
   au lieu de tout réécrire à la main.

✅ COPY-PASTE les blocs Aceternity UI depuis ui.aceternity.com
   (pas d'installation, juste copier les fichiers JSX).

✅ Utilise EMERGENT-WORKSHEET.md comme guide fichier-par-fichier.
   Chaque fichier y est décrit avec : chemin exact, dépendances, code minimum requis.
   Ne dévie pas.

✅ Avant de créer un composant, vérifie qu'il n'existe pas déjà :
   ls frontend/src/components/

✅ Pour les pages similaires (Calls / Outbound, Emails, Tickets) :
   construis UN composant de liste réutilisable (DataTable.jsx),
   puis instancie-le avec props différentes.

✅ Pour les badges (status, priorité, urgence) :
   un seul composant Badge.jsx avec variants.

✅ Pour les KPI cards :
   un seul composant KpiCard.jsx réutilisé 4× dans le dashboard.

✅ Tests : pas de tests unitaires en V1.
   Tests manuels avec mock data (npm run seed).

❌ NE PAS générer du code spéculatif "au cas où".
❌ NE PAS refactoriser ce qui n'est pas demandé.
❌ NE PAS ajouter de librairies hors stack imposée.

═══════════════════════════════════════════════════════════
LIVRABLE ATTENDU PAR PHASE
═══════════════════════════════════════════════════════════

Phase 0 (Jour 1)    : Setup local, backend qui démarre, /health OK
Phase 1 (Jour 2)    : Login + InviteAccept fonctionnels avec vrai user Supabase
Phase 2 (Jours 3-5) : Dashboard PME avec données réelles + design ≥90% image cible
Phase 3 (Sem 2-3)   : CRM + Import CSV
Phase 4 (Sem 3-4)   : Calls + Emails (validation brouillons IA)
Phase 5 (Sem 4-5)   : Calendar + Knowledge + Onboarding wizard
Phase 6 (Sem 5-6)   : Config voix + Billing Stripe multi-devise
Phase 7 (Sem 6-7)   : Support tickets + 6 pages Admin Exevori
Phase 8 (Sem 7)     : Intégrations réelles (Twilio, ElevenLabs, Stripe prod)
Phase 9 (Sem 8)     : Premier client Exevori onboardé + déploiement Fly.io

À chaque fin de phase :
1. Démo live de ce qui a été construit
2. Commit Git avec tag (phase-1, phase-2, etc.)
3. Validation par moi avant de passer à la suivante

═══════════════════════════════════════════════════════════
PARTICULARITÉS MÉTIER À RESPECTER
═══════════════════════════════════════════════════════════

💰 PRIX MULTI-DEVISE (même chiffre, devise selon pays) :
   - Solo 79, Démarrage 159, Essentiel 319, Pro 529, Entreprise 949
   - CA → CAD + TPS 5% + TVQ 9.975% + installation 319$ (CA UNIQUEMENT)
   - US → USD sans taxe, sans installation
   - EU → EUR sans taxe, sans installation
   - Reste du monde → USD sans taxe, sans installation
   - Stripe Tax activé automatiquement pour le Canada

🌍 BILINGUE FR/EN avec détection automatique pendant les appels.
   Interface par défaut en FR-CA.

🎙️ MULTI-VOIX flexible (FR-CA / FR-FR / multilingue).
   3 onglets dans le sélecteur de voix.
   Preview audio obligatoire avant choix.

📞 ASSISTANTE PERSONNALISABLE par chaque PME (nom + ton + voix + langue).

🎨 LOGO : Exevori Voice IA — utiliser design-reference/branding/exevori-logo.png
   dans la sidebar + login + emails. Header avec "EXEVORI" + "VOICE IA"
   en dessous comme dans le fichier exevori-voice-ia-target.png.

═══════════════════════════════════════════════════════════
COMMENT ME POSER UNE QUESTION
═══════════════════════════════════════════════════════════

Si tu hésites entre 2 approches, demande-moi.
Format de question :

"Question : <situation>
Option A : <approche 1>
Option B : <approche 2>
Mon avis : <ta recommandation>
Impact crédits : <estimation>"

Ne suppose pas. Demande. Cela coûte 1 message et économise 10× le temps.

═══════════════════════════════════════════════════════════
COMMENCE MAINTENANT
═══════════════════════════════════════════════════════════

Ouvre docs/EMERGENT-WORKSHEET.md et commence par la Phase 0, Tâche 0.1.
Avance fichier par fichier, dans l'ordre exact donné.
Ne saute aucune étape.

Bon développement.

Karim — Exevori (Lévis, Québec)
karim@exevori.com
```

---

## 📋 Variantes courtes (si Emergent a une limite de caractères)

### Version 1 (très courte, 500 caractères)

```
Construis le frontend de "Exevori Voice IA" (SaaS multi-tenant Quebec).
Backend déjà codé, ne pas modifier.
1. Lis docs/EMERGENT-WORKSHEET.md (feuille de travail fichier-par-fichier)
2. Lis docs/EMERGENT-DESIGN.md (image cible: design-reference/dashboard-reference.png)
3. Stack: React + Vite + shadcn/ui + Tremor + Aceternity UI + i18n (FR/EN)
4. Règle absolue: pas de texte hardcodé, pas de "Léa" en dur, dark mode only
Commence par Phase 0 Tâche 0.1. Suis l'ordre exact. Demande si tu hésites.
```

### Version 2 (moyenne, 1500 caractères)

```
Tu construis le frontend de "Exevori Voice IA", SaaS multi-tenant Québec.
Le backend (15 modules Node.js) est codé et validé. Tu n'y touches PAS.

Ton travail :
1. Frontend React (Vite + shadcn/ui + Tremor + Aceternity UI + i18n FR/EN)
2. Brancher les ~130 routes API existantes
3. Reproduire le design de design-reference/dashboard-reference.png à ≥90%

Lecture obligatoire dans cet ordre :
1. README.md
2. docs/EMERGENT-WORKSHEET.md (LE plus important — feuille fichier-par-fichier)
3. docs/EMERGENT-DESIGN.md (specs visuelles)
4. docs/EMERGENT-REFERENCE.md (routes API)

Règles absolues :
- Ne JAMAIS hardcoder "Léa" → utiliser config.assistant_name
- Ne JAMAIS écrire de texte hardcodé → t("clé") via i18n
- Dark mode only, palette dans global.css
- Multi-devise : 79/159/319/529/949 partout, taxes CA uniquement, installation CA uniquement
- Logo Exevori dans design-reference/branding/

Économie de crédits :
- Copy-paste shadcn/ui via `npx shadcn add <name>`
- Copy-paste Aceternity UI depuis le site
- Composants réutilisables (DataTable, KpiCard, Badge)
- Pas de refactoring spéculatif

Commence Phase 0 Tâche 0.1 dans EMERGENT-WORKSHEET.md.

Karim — Exevori
```

---

## 🎯 Bonus : message de suivi à envoyer périodiquement

À envoyer à Emergent après chaque fin de phase :

```
Phase X terminée — bravo.

Avant Phase X+1 :
1. Liste ce qui a été construit (fichiers + composants)
2. Liste ce qui a posé problème
3. Estime le coût en crédits restant pour aller à 100%

Si crédits insuffisants, propose une priorisation
(qu'est-ce qu'on coupe / qu'on reporte).

Continue Phase X+1 dans EMERGENT-WORKSHEET.md.
```
