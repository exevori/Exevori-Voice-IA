# Exevori Voice IA — PRD

## Original problem statement
SaaS d'assistante vocale IA pour PME au Québec. Stack: Node.js (Express) backend, React/Vite frontend, Supabase (Postgres + Auth + RLS), Tailwind + shadcn/ui + Tremor. Multilingue FR-CA (défaut) / EN-CA. Architecture multi-tenant avec RLS strict. Le nom de l'assistante n'est jamais hardcodé — toujours lu depuis `assistant_configs.name`.

## User personas
- **Karim (Super Admin Exevori)** — `contact@exevori.com`. Vue globale + impersonation des PME clientes.
- **PME (admin/agent)** — accède au dashboard de SA PME uniquement (RLS company_id).

## Core requirements
- Auth Supabase email/password
- Dashboard PME avec KPIs + Tremor charts + Impersonation pour super_admin
- CRM Contacts: liste filtrée + détail (3 tabs) + CRUD + import CSV avec mapping dynamique
- i18n FR-CA / EN-CA (par profil utilisateur)
- Multi-tenant: RLS strict côté Supabase

## What's been implemented

### Phase 1 — Login (DONE)
- `Login.jsx` + `AuthContext` + Supabase signInWithPassword
- Routes protégées

### Phase 2 — Dashboard (DONE)
- `Dashboard.jsx` avec KPI cards dynamiques
- Tremor charts (volume appels, conversion)
- `ImpersonationSwitcher` pour super_admin avec persistance localStorage
- Assistant profile : nom lu depuis `assistant_configs.name` (jamais hardcodé)

### Phase 3A — Liste Contacts (DONE)
- `DataTable.jsx` réutilisable + `FilterBar.jsx`
- Page `Contacts.jsx` avec filtres statut, search, pagination
- Détail contact via Sheet slide-in (3 tabs: Infos / Historique / Notes)

### Phase 3B — CRUD + Import CSV (DONE — 12 juin 2026)
- **ContactForm** (`/components/contacts/ContactForm.jsx`) — créer + éditer (Sheet)
- **ImportWizard** (`/components/contacts/ImportWizard.jsx`) — 3 étapes (Upload → Mapping → Résultat)
  - Auto-détection fuzzy multi-mots (FR/EN) : `Nom Complet → full_name`, `Mail → email`, `Tel Portable → phone`, etc.
  - 13 champs cibles supportés (incl. tags multi-séparateurs, notes concaténables, status, urgency, next_action)
  - **Gestion doublons** par ordre de priorité `email > phone > full_name` avec 3 stratégies (`skip` / `overwrite` / `create anyway`)
  - Validation: au moins une colonne mappée à full_name OU email OU phone
- **Delete contact** depuis le Sheet de détail avec confirmation
- **Toast** léger pour confirmations (create/update/delete/import)
- Backend `/modules/import/index.js` réécrit pour format `{csvHeader: field}` + `duplicate_action` enum

### Phase 4A — Appels (DONE — 12 juin 2026)
- Backend `modules/calls/index.js` (nouveau) : `GET /api/v1/calls` (liste filtrée + enrichissement contact), `GET /api/v1/calls/stats` (counts par status/intent), `GET /api/v1/calls/:id` (détail + parseTranscript défensif)
- Frontend `pages/Calls.jsx` : DataTable réutilisée (3A) avec 7 colonnes (Heure / Contact / Téléphone / Durée / Intent IA / Status / Confiance%) + FilterBar par status + search + Sheet détail avec Résumé IA + bouton "Voir fiche contact" → `/contacts?focus=<id>`
- Frontend `components/calls/TranscriptView.jsx` — composant réutilisable (Phase 8) : bulles chat-style (assistant gauche / caller droite / transfer séparateur orange), accepte array JSON / string-JSON / texte brut
- Seed `seed-phase4-mock.js` — 7 appels FR plausibles pour Garage Tremblay (variés : completed/in_progress/transferred/abandoned + intents pneus/freins/urgence/promo)
- `assistant_name` toujours lu depuis `assistant_configs.name` (jamais hardcodé)
- Testing iteration_2 : **100% PASS** sur tous les flows critiques

### Phase 4B — Courriels (DONE — 13 juin 2026)
- Backend `modules/email/index.js` étendu :
  - `GET /api/v1/emails` (NOUVEAU) — liste boîte de réception avec filtres status/classification/search + enrichissement contact
  - `GET /api/v1/emails/:id` (NOUVEAU) — détail email + draft associé (best-effort)
  - `PATCH /api/v1/emails/drafts/:id` (NOUVEAU) — sauvegarde inline du body/subject
  - `GET /drafts`, `POST /drafts/:id/approve`, `/reject`, `/regenerate` **FIXÉS** (mauvaise relation Supabase `emails!related_email_id` → hydration manuelle via `email_id` ; colonnes inexistantes `rejection_reason`/`regenerated_count`/status `approved_pending_send` violant CHECK constraint → simplification + log dans `ai_reasoning`)
- Frontend `pages/Emails.jsx` : 2 Tabs (Boîte de réception avec DataTable+FilterBar / Brouillons à valider avec liste de DraftCard) + badge orange counter sur tab brouillons + EmailDetailSheet avec bouton "Voir le brouillon de réponse"
- Frontend `components/emails/DraftCard.jsx` — composant **réutilisable Phase 8+ et Phase 10+** : 4 actions (Approve+envoi Resend / Edit inline subject+body / Regenerate avec instruction optionnelle / Reject avec motif), affiche source meta + confidence pill colorée + ai_reasoning
- Seed `seed-phase4b-emails.js` — 5 emails (devis pneus, confirmation RDV, garantie, spam B2B, support freins) + 3 drafts FR plausibles pour Garage Tremblay

### Phase 4A BONUS — Live badge sur /calls (DONE — 13 juin 2026)
- Polling `GET /api/v1/calls/stats` toutes les 5s
- `LiveBadge` avec animation `animate-ping` (dot rouge clignotant) si `by_status.in_progress > 0`
- Texte dynamique : "X en direct" (compteur tabular-nums)
- Réutilisable Phase 8 quand Twilio sera branché

### Testing (Iteration 4 — 13 juin 2026, URGENT bug fix)
- 🚨 **Login bug bloquant résolu (100% PASS)** :
  - **Root cause #1** : Node v22 downgradé à v20 par le superviseur Emergent → `@supabase/realtime-js` crashe au démarrage (« Node.js 20 detected without native WebSocket support ») → backend Express ne démarrait pas → les defaults Emergent (uvicorn Python sur 8001 + CRA sur 3000) prenaient la place.
  - **Root cause #2** : `Login.jsx` appelait `navigate('/dashboard')` **avant** que `onAuthStateChange` ait mis à jour `user` dans `AuthContext` → `ProtectedRoute` voyait `!user` et redirigeait en boucle vers `/login`.
  - **Fix #1** : Node ré-installé en v22 via `curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs`. Backend Express relancé sur 8001 + Vite sur 3000.
  - **Fix #2** : `Login.jsx` refactoré pour utiliser `useEffect([user])` qui navigue dès que `user` est set. Bonus : redirige aussi si user déjà connecté à l'arrivée sur `/login`.
- ✅ Validation : login + persistance localStorage + nav vers /calls /emails + reload → tous OK
- Rapport: `/app/test_reports/iteration_4.json`

### Testing (Iteration 3 — 13 juin 2026)
- ✅ Phase 4B `/emails` + LIVE badge `/calls` : **100% PASS** (login + impersonation + inbox 7 rows + filtres + détail Sheet + jump-to-draft + drafts 3 cards + Approve/Edit/Regenerate/Reject + LIVE badge 5s polling avec pulse)
- 🐛 Bug post-test détecté et corrigé hors testing : la route `/drafts/:id/approve` tentait d'écrire status `"approved_pending_send"` qui viole la CHECK constraint `email_drafts_status_check` (valeurs valides : `pending_validation`, `sent`, `rejected`). Fix : toujours utiliser `"sent"` après approve manuel + warning Resend logué dans `ai_reasoning`. Contract API : `{success, sent_via_resend, send_warning}`.
- Rapport: `/app/test_reports/iteration_3.json`

### Testing (Iteration 2 — 12 juin 2026)
- ✅ Phase 4A `/calls` : **100% PASS** (login + impersonation + table 11 rows + filtres + détail Sheet + TranscriptView + bouton "Voir fiche contact")
- Rapport: `/app/test_reports/iteration_2.json`

### Testing (Iteration 1 — 12 juin 2026)
- ✅ Tous les flows critiques passent (100% frontend)
- ✅ Fuzzy auto-mapping : 6/6 colonnes détectées sur en-têtes FR multi-mots
- ✅ Import 3 lignes : `imported=3, errors=0`
- ✅ CRUD complet validé (create / read / update / delete)
- Rapport: `/app/test_reports/iteration_1.json`

## Backlog priorisé

### P0 (next)
- **Phase 8** OU **Phase 9** au choix client :
  - **Phase 8** — Branchement intégrations réelles : Twilio (voice webhook → table `calls`), ElevenLabs (TTS), Resend (real `RESEND_API_KEY` au lieu du placeholder). Le LIVE badge sera alors connecté à des appels réels et le bouton Approve enverra réellement les courriels.
  - **Phase 9** — Déploiement Vercel (frontend) + Fly.io (backend) pour démos clients.

### P1
- **Phase 8** — Intégrations: Twilio (voice), ElevenLabs (TTS), Resend (mail)
- **Phase 9** — Déploiement Vercel (frontend) + Fly.io (backend)
- **Refactor**: Découper `Contacts.jsx` (660 lignes) → `/components/contacts/{DetailSheet,InfoTab,HistoryTab,NotesTab}.jsx`
- **Refactor**: Extraire les `fetch()` éparpillés vers `lib/contactsApi.js`
- **A11y**: Ajouter `data-testid` par option sur `<Select>` (form-status-option-{hot,warm,...}) pour QA déterministe

### P2 (Future)
- **Phase 5/6/7** — Outbound dialer, Knowledge Base tuning, AI fine-tuning (différées après 1er client)

## Known issues
- Console: Supabase realtime WSS échoue (`wss://localhost/...`) — cosmétique uniquement, n'affecte aucun flow.
- Environnement: la conteneurisation Emergent peut reset Node v22 → v20 au restart superviseur. Workaround : `apt-get install -y nodejs` + relancer `node index.js` sur port 8001.

## Tech stack
- Frontend: React 18, Vite, Tailwind, shadcn/ui, Tremor, framer-motion, i18next, lucide-react
- Backend: Node.js v22, Express, multer, csv-parse, @supabase/supabase-js
- DB/Auth: Supabase (Postgres + RLS + Auth)

## Key API endpoints
- `GET /api/v1/auth/me`
- `GET|POST /api/v1/contacts`, `GET|PATCH|DELETE /api/v1/contacts/:id`
- `POST /api/v1/import/preview` (multipart: file, company_id)
- `POST /api/v1/import/execute` (multipart: file, company_id, column_mapping JSON, duplicate_action, default_status)

## Files of reference
- `frontend/src/pages/Contacts.jsx` — page principale + Sheets pour form/wizard/détail
- `frontend/src/components/contacts/ContactForm.jsx`
- `frontend/src/components/contacts/ImportWizard.jsx`
- `backend/modules/import/index.js`
- `backend/modules/crm/index.js`
- `test-jwt.js` — JWT minting (admin)
- `set-test-password.js` — set test password for E2E
