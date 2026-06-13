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

### Phase Reports+A — Dashboard ROI + TimeSavedCard (DONE — 13 juin 2026)
- **Backend** `modules/reports/index.js` (nouveau, agrégation pure, **READ-ONLY**) :
  - `GET /api/v1/reports/summary?company_id=...&period=today|week|month|year` → response `{period, kpis, time_saved, series, counts}`
  - 4 KPIs : `total_handled` (calls+emails), `appointments_booked`, `time_saved_seconds`, `recovery_rate_pct`
  - `time_saved` détaillé : `sans_lea_seconds`, `avec_lea_seconds`, `saved_seconds`, `saved_hours`, `saved_cad`, `hourly_rate_cad` + `breakdown` (calls / emails / appointments / overhead)
  - Facteurs ROI configurables `.env` : `PME_HOURLY_RATE_CAD=35`, `SEC_PER_EMAIL_WITHOUT_AI=180`, `SEC_PER_APPOINTMENT_BOOK=300`, `SEC_PER_DRAFT_VALIDATION=60`, `SEC_PER_TRANSFER=120`
  - `series` granularité adaptative : hour (today) / day (week+month) / month (year)
- **Frontend nouvelle page** `pages/Reports.jsx` routée sur `/analytics` et `/reports` :
  - PeriodSelector 4 boutons + Refresh
  - 4 KPI cards avec couleurs distinctes (purple/blue/green/pink)
  - **TimeSavedCard détaillée** : Sans Léa (strikethrough red) / Avec Léa (vert) / Vous économisez (gros, vert + équivalent $CAD)
  - Tremor LineChart 2 séries (Appels purple / Courriels cyan)
  - Breakdown card avec 4 rows (calls / emails / appts / overhead)
- **Frontend nouveau composant** `components/dashboard/TimeSavedCard.jsx` — **monté aussi sur main Dashboard** sous les KPIs (effet wow démo immédiat)
  - Démo Garage Tremblay 7j : Sans Léa 49 min → Avec Léa 1 min → Économie **48 min ≈ 28 $ CAD**
- **Testing iteration_7** : **14/14 backend + 100% frontend PASS**
- ⚠️ Points trackés (non-bloquants, Phase 8 hardening) :
  - `/summary` n'enforce pas `JWT.user.company_id == query.company_id` → user authentifié pourrait théoriquement requêter une autre PME
  - 2 fetchs identiques simultanés sur /analytics (Reports + TimeSavedCard chacun) — V1 acceptable, optimisable plus tard
  - `formatDuration` dupliqué dans TimeSavedCard + Reports → extraire à `/lib/format.js`

### Phase Reports+B — Export PDF / CSV (DONE — 13 juin 2026)
- **Backend** ajouté au module reports :
  - `GET /api/v1/reports/export/csv?company_id=...&period=...` → CSV UTF-8 (BOM) avec séparateur `;` (Excel Québec FR), 3 sections (KPIs + ROI + Série temporelle)
  - `GET /api/v1/reports/export/pdf?company_id=...&period=...` → PDF A4 mono-page via `pdfkit` (header Exevori + 4 KPIs grid 2x2 + carte ROI vert avec montant économisé + détail comptages + footer Lévis Québec)
  - Filename canonique : `exevori-rapport-{company-slug}-{period}-YYYYMMDD.{csv|pdf}`
  - Helper `buildSummaryPayload` réutilisé par `/summary`, `/export/csv`, `/export/pdf` — DRY
- **Frontend** composant `ExportButtons` dans le header de Reports.jsx :
  - 2 boutons CSV / PDF avec icônes lucide + Loader2 spinner pendant download
  - `fetch` blob + `URL.createObjectURL` + `<a download>` + extraction du filename depuis `Content-Disposition`
- **Deps ajoutées** : `pdfkit ^0.19.1`, `csv-stringify ^6.x`
- **Testing iteration_8 + iteration_9** : 
  - Backend 17/17 PASS (iteration_8) — auth, validation, 4 périodes, signatures fichiers, BOM UTF-8, cohérence cross-endpoint
  - 1 bug trouvé iteration_8 : `<ExportButtons />` déclaré mais pas monté dans JSX. **Fixé** ligne 86 de Reports.jsx.
  - Frontend retest iteration_9 : **5/5 downloads PASS** sur 4 périodes × 2 formats, 0 erreur console

### Phase KB+B — Embeddings & Semantic Search (DONE — 13 juin 2026)
- **DB migration** `migrations/002_kb_plus_b.sql` exécutée manuellement par user :
  - Colonne `knowledge_sources.embeddings_ready_at TIMESTAMPTZ` (tracking ingest)
  - Index ivfflat cosine `idx_kc_embedding_ivfflat` sur `knowledge_chunks.embedding` (lists=100)
  - Fonction Postgres `match_kb_chunks(p_company_id, p_query_embed, p_match_count, p_min_similarity)` — réutilisable Phase 8 (Léa appellera la function via Supabase RPC pendant un appel)
- **3rd party integration** : OpenAI direct via `fetch` Node 22 (PAS via emergentintegrations — embeddings non supportés par Emergent LLM Key)
  - Modèle: `text-embedding-3-small` (1536 dims)
  - Clé: `OPENAI_API_KEY=sk-proj-...` ajoutée à `/app/voicedesk_project/voicedesk/.env`
  - Coût: ~0,02 USD / 1M tokens — limite mensuelle OpenAI fixée à 5 USD avec alerte 1 USD (sécurité)
  - Projet OpenAI dédié `exevori-voice-ia` avec model access restreint à `text-embedding-3-small` uniquement
- **Backend RAG helper** `modules/kb/rag.js` (nouveau, 145 lignes) — **réutilisable Phase 8** :
  - `embedText(text)` → 1 string → vector(1536)
  - `embedBatch(texts[])` → batché par 96 (sous limite OpenAI 2048) avec retry exponentiel 3 tentatives
  - `searchSimilarChunks({company_id, query, topK, minSimilarity})` → utilise `match_kb_chunks` RPC
  - `embedChunksOfSource({source_id, company_id})` → fetch all chunks → embedBatch → update DB → set `embeddings_ready_at`
- **Backend KB router modifié** `modules/kb/index.js` :
  - `POST /upload` et `POST /scrape` appellent maintenant `embedChunksOfSource` en best-effort après chunking (si échoue, source reste `ready` sans embeddings → user peut cliquer Re-embed)
  - **NOUVEAU** `POST /sources/search` : body `{company_id, query, topK?, minSimilarity?}` → `{success, query, results, latency_ms}` — utilisé par widget UI + Phase 8 (Léa)
  - **NOUVEAU** `POST /sources/:id/reembed` : body `{company_id}` (sanity check tenant via `source.company_id===company_id`, sinon 403) → régénère embeddings
- **Frontend UI** :
  - **NOUVEAU composant** `components/kb/SearchWidget.jsx` — *"Testez votre IA"* : input + bouton Tester → 3 chunks avec score % colorisé (vert ≥75%, amber ≥50%, gris <50%) + nom source + extrait line-clamp-5. Affiche `kb.search.noSources` si aucune source indexée.
  - **Knowledge.jsx modifié** : 4e stat `stat-indexed` (compteur sources avec embeddings), nouvelle colonne `Indexé IA` (badges `indexed-ready-{id}` vert / `indexed-missing-{id}` ghost / `indexed-busy-{id}` spinner), bouton `reembed-source-{id}` (icône RefreshCw) dans rowActions sur sources ready, SearchWidget monté en bas de page
  - data-testids tous en place pour QA : `kb-search-widget`, `search-widget-input/button/empty-hint/error/no-results/results`, `search-result-{0..2}-source/-score/-content`
- **Testing iteration_6** : **100% PASS** (13/13 backend pytest + tous flows frontend e2e validés)
  - Coût OpenAI testing run : ~0,0003 USD (largement sous la limite 5 USD/mois)
  - Cleanup automatique des sources de test post-run
  - 1 nit cosmétique fixé : `Stat` component ajoute `aria-label="X label"` + `mt-1` pour espacement label/value
- ⚠️ Points trackés (non-bloquants) :
  - `embedChunksOfSource` update les chunks 1-par-1 (N round-trips Supabase) — OK pour <200 chunks/source, bulk-update à considérer Phase 8 si scale
  - `/reembed` cross-check `source.company_id === body.company_id` (déjà OK), mais idéalement on devrait dériver company_id du JWT (idem note Phase 8 de iteration_5)
  - SearchWidget Enter spam non-debouncé (mitigé par `disabled={busy}` sur button)

### Phase KB+A — Knowledge Base ingestion (DONE — 13 juin 2026)
- **DB migration** `migrations/001_kb_plus_a.sql` exécutée manuellement par user :
  - Tables `knowledge_sources` (id, company_id, type[upload/url/manual], name, url, storage_path, mime_type, size_bytes, status[pending/processing/ready/error], error_message, chunks_count, created_by) et `knowledge_chunks` (id, source_id, chunk_index, content, token_count, embedding vector(1536) [null en KB+A])
  - Extension `vector` activée + bucket Supabase Storage `kb-uploads`
  - RLS `company_isolation` sur les 2 tables
- **Backend** `modules/kb/index.js` (nouveau, 394 lignes) — monté avec `requireAuth` middleware dans `index.js` :
  - `POST /api/v1/kb/sources/upload` (multer 25 Mo, MIMEs PDF/DOCX/TXT/MD) → upload Storage + extract (pdf-parse / mammoth / utf-8) + chunk (350 tokens target, 40 overlap, via gpt-tokenizer) + insert chunks
  - `POST /api/v1/kb/sources/scrape` ({url}) → fetch 15s timeout + cheerio retire scripts/styles/nav/footer + html-to-text + chunk + insert (422 si <100 chars = SPA)
  - `GET /api/v1/kb/sources?company_id=...&status=...&limit=...&offset=...` (liste paginée)
  - `GET /api/v1/kb/sources/:id` → metadata + chunks (limit 50)
  - `DELETE /api/v1/kb/sources/:id` → cascade chunks via FK + best-effort storage delete
- **Frontend** `pages/Knowledge.jsx` (461 lignes) :
  - Tabs Upload (dropzone drag&drop + click) / URL (input + Importer)
  - DataTable des sources (Type / Nom / Chunks / Taille / État / Importé) + actions view/delete
  - SourceDetailSheet avec preview chunks + token_count par chunk
  - 3 stats compactes (Sources / Chunks / Prêts) + Toast système 4.5s
  - Tous les `data-testid` en place (kb-page, kb-title, tab-upload, tab-url, upload-dropzone, scrape-url-input, kb-sources-table, source-detail-sheet, chunks-preview, etc.)
- **Compte test QA bot** créé (`qa-bot@garage-tremblay.test` / `QaBot_Test_2026!`, role `company_admin` ISOLÉ à Garage Tremblay) — scripts `create-qa-bot.mjs` + `delete-qa-bot.mjs`
- **Testing iteration_5** : **100% PASS** (14/14 backend pytest + 7/7 frontend flows)
- ⚠️ **Findings sécurité documentés pour Phase 8** : le backend ne cross-check pas `JWT.user → profile.company_id` vs `req.body/query.company_id` — un user authentifié pourrait théoriquement passer un UUID d'un autre tenant. À durcir en Phase 8 (ajout middleware `enforceTenantOwnership`).

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

### P0 (next) — Ordre validé par Karim (mis à jour 13 juin 2026)
1. ~~**Phase KB+B**~~ ✅ DONE
2. ~~**Phase Reports+A élargie**~~ ✅ DONE
3. ~~**Phase Reports+B**~~ ✅ DONE
4. ~~**Phase 6A — Settings UI**~~ ✅ DONE
5. **Phase 6B — Email multi-comptes** (~50 crédits) **← NEXT, après validation visuelle 6A + credentials OAuth**
   - Migration DB requise (tables `email_accounts`, `oauth_tokens`, `imap_configs`, colonne `email_account_id` sur `emails`) — Karim doit donner GO + exécuter
   - 3 providers : OAuth Gmail/Workspace + OAuth Outlook/M365 + IMAP/SMTP universel (Zoho, Hostpapa, OVH, etc.)
   - Chiffrement AES-256-GCM (clé maître `ENCRYPTION_KEY` 32 bytes en `.env`)
   - UI Wizard 3 étapes (provider → credentials → persona/auto_reply/kb_filter)
   - Multi-persona : `assistant_configs` devient multi-instance par PME (chaque email peut avoir sa propre Léa)
   - Tests : 3 comptes factices, RLS strict, IMAP serveur test, chiffrement/déchiffrement
6. **Phase 6C** — Calendar multi-provider (Google Calendar + Outlook Calendar) (~15 crédits)
7. **Phase 6D** — Twilio config par PME (~5 crédits)
8. **Phase 6E** — Notifications canaux + Resend pour invites (~5 crédits)
9. **Phase 9** — Déploiement Vercel + Fly.io Montréal + `.nvmrc` (Node v22)
10. **Phase 8** — Twilio + ElevenLabs + DeepSeek réels + hardening sécurité
11. 🎙️ **Test Léa COMPLET** self-dogfooding (démo commerciale)
12. 🎨 **Phase Esthétique finale** (~25-35 crédits — passe globale)
13. 🚀 Démarchage commercial

### P1
- **Phase 8 — Hardening sécurité** : ajouter middleware `enforceTenantOwnership` qui valide `JWT.user → profile.company_id` vs `req.body/query.company_id` sur tous les endpoints KB (et progressivement CRM/Calls/Emails). High priority avant prod.
- **Phase 9** — Déploiement Vercel (frontend) + Fly.io (backend) + `.nvmrc` pour fixer Node v22
- **Phase 8 (suite)** — Branchement intégrations réelles : Twilio (voice webhook → `calls`), ElevenLabs (TTS), Resend (real `RESEND_API_KEY`)
- **Refactor**: Découper `Contacts.jsx` (660 lignes) → `/components/contacts/{DetailSheet,InfoTab,HistoryTab,NotesTab}.jsx`
- **Refactor**: Extraire les `fetch()` éparpillés vers `lib/contactsApi.js`
- **A11y mineur** : `SourceDetailSheet` → ajouter `SheetDescription` pour silence Radix warning
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
d.
- **Phase 9** — Déploiement Vercel (frontend) + Fly.io (backend) + `.nvmrc` pour fixer Node v22
- **Phase 8 (suite)** — Branchement intégrations réelles : Twilio (voice webhook → `calls`), ElevenLabs (TTS), Resend (real `RESEND_API_KEY`)
- **Refactor**: Découper `Contacts.jsx` (660 lignes) → `/components/contacts/{DetailSheet,InfoTab,HistoryTab,NotesTab}.jsx`
- **Refactor**: Extraire les `fetch()` éparpillés vers `lib/contactsApi.js`
- **A11y mineur** : `SourceDetailSheet` → ajouter `SheetDescription` pour silence Radix warning
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
