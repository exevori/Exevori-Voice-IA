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

### Testing (Iteration 1 — 12 juin 2026)
- ✅ Tous les flows critiques passent (100% frontend)
- ✅ Fuzzy auto-mapping : 6/6 colonnes détectées sur en-têtes FR multi-mots
- ✅ Import 3 lignes : `imported=3, errors=0`
- ✅ CRUD complet validé (create / read / update / delete)
- Rapport: `/app/test_reports/iteration_1.json`

## Backlog priorisé

### P0 (next)
- **Phase 4** — Dashboards Calls + Emails (real-time logs Twilio + Resend)

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
