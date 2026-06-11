# 🗺️ EMERGENT-ROADMAP — Feuille de route détaillée

> **Document maître stratégique pour Emergent.sh.**
> Lis-moi en premier pour avoir la vue d'ensemble en 10 phases sur 8 semaines.
>
> ⚡ **Pour l'exécution concrète fichier-par-fichier : `docs/EMERGENT-WORKSHEET.md`**
> ⚡ **Pour le prompt à copier-coller au démarrage : `docs/EMERGENT-PROMPT.md`**

---

## 📋 Vue d'ensemble

VoiceDesk IA est un SaaS multi-tenant pour PME québécoises. Le backend est **complètement codé** (15 modules, ~8 500 lignes). Tu dois :

1. **Configurer l'environnement** (Phase 0)
2. **Démarrer et valider le backend** (Phase 1)
3. **Construire les pages frontend manquantes** (Phases 2-8)
4. **Connecter les intégrations réelles** (Phase 9)
5. **Onboarder le premier client** (Phase 10)

**Durée estimée : 8 semaines.** Tu peux paralléliser certaines phases.

---

# 🎯 PHASE 0 — Setup initial (Jour 1, ~2 heures)

## Étape 0.1 — Lecture obligatoire

**Lis ces 4 fichiers dans l'ordre :**

1. ✅ `README.md` (vue d'ensemble, 5 min)
2. ✅ `docs/EMERGENT-START.md` (démarrage rapide, 10 min)
3. ✅ `docs/ARCHITECTURE.md` (décisions techniques, 10 min)
4. ✅ Ce fichier `docs/EMERGENT-ROADMAP.md` (la suite)

**Garde ouvert pendant tout le projet :**
- `docs/EMERGENT-BUILD.md` (référence architecture)
- `docs/EMERGENT-REFERENCE.md` (130 routes API)
- `docs/EMERGENT-DESIGN.md` (🎨 spécification visuelle OBLIGATOIRE)
- `docs/SCHEMA.sql` (34 tables Supabase)
- `design-reference/dashboard-reference.png` (l'image cible)
- `design-reference/DashboardPrototype.jsx` (prototype de style)

## Étape 0.2 — Cloner et installer

```bash
cd voicedesk
npm run install:all
# Installe les dépendances racine + backend + frontend (~3 min)
```

## Étape 0.3 — Créer le projet Supabase

1. Aller sur https://supabase.com
2. **Créer un nouveau projet**, région : **Canada Central (Montréal)** (Loi 25)
3. Noter `Project URL`, `anon key`, `service_role key`

## Étape 0.4 — Configurer .env

```bash
cp .env.example .env
```

Édite `.env` et remplis **uniquement** ces 5 variables pour démarrer :

```bash
SUPABASE_URL=<ton-url-supabase>
SUPABASE_ANON_KEY=<ton-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<ton-service-role-key>
VITE_SUPABASE_URL=<ton-url-supabase>
VITE_SUPABASE_ANON_KEY=<ton-anon-key>
```

Le reste (Twilio, Stripe, ElevenLabs, etc.) viendra à la Phase 9.

## Étape 0.5 — Créer le schéma DB

Dans Supabase Dashboard → **SQL Editor**, exécute dans l'ordre :

```
1. infra/migrations/001_initial_schema.sql
2. infra/migrations/002_crm_operations.sql
3. infra/migrations/003_billing.sql
4. infra/migrations/004_tickets.sql
5. infra/migrations/005_voice_library.sql
6. infra/migrations/006_notifications.sql
7. infra/migrations/007_multi_currency.sql
```

**Vérification :** Va dans **Table Editor**, tu dois voir 35 tables.

## Étape 0.6 — Importer les données mock

```bash
npm run seed
```

**Vérification :** Table `companies` doit avoir 5 lignes, `contacts` 7 lignes, etc.

## Étape 0.7 — Démarrer en local

```bash
npm run dev
# Backend  → http://localhost:3000
# Frontend → http://localhost:5173
```

**Vérification finale Phase 0 :**

```bash
curl http://localhost:3000/health
# → { "status": "ok", ... }
```

Ouvre `http://localhost:5173` → tu dois voir la page Login.

---

# 🧪 PHASE 1 — Validation du backend (Jour 2)

**Objectif :** S'assurer que les 15 modules backend fonctionnent avant de construire le frontend.

## Étape 1.1 — Créer un super_admin Exevori

Dans Supabase **Auth → Users → Add user** :
- Email : `admin@exevori.com`
- Password : (choisis-en un)
- Auto-confirm : ✅

Puis dans **SQL Editor** :

```sql
-- Lier le user créé à un profile super_admin
INSERT INTO profiles (user_id, email, full_name, role, status)
VALUES (
  (SELECT id FROM auth.users WHERE email = 'admin@exevori.com'),
  'admin@exevori.com',
  'Admin Exevori',
  'super_admin',
  'active'
);
```

## Étape 1.2 — Tester l'API

Avec `curl` ou Postman :

```bash
# 1. Login via Supabase Auth (récupérer un JWT)
curl -X POST 'https://<ton-projet>.supabase.co/auth/v1/token?grant_type=password' \
  -H "apikey: <anon-key>" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@exevori.com","password":"<ton-mdp>"}'

# Copier access_token retourné

# 2. Tester /me
curl http://localhost:3000/api/v1/auth/me \
  -H "Authorization: Bearer <access_token>"
# → Doit retourner ton profile super_admin

# 3. Tester dashboard admin
curl http://localhost:3000/api/v1/admin/dashboard \
  -H "Authorization: Bearer <access_token>"
# → Doit retourner MRR, clients, etc.
```

**Si ces 3 tests passent → backend OK → tu peux construire le frontend.**

## Étape 1.3 — Lire les 15 README modules

Pour comprendre ce que fait chaque module :

```bash
cat backend/modules/auth/README.md
cat backend/modules/config/README.md
cat backend/modules/dashboard/README.md
# ... etc pour les 15 modules
```

---

# 🎨 PHASE 2 — Frontend Auth + Layout (Jours 3-5)

**Objectif :** Login fonctionnel + Layout polish + i18n switcher testé.

## Étape 2.1 — Composants déjà fournis

Ces fichiers existent et fonctionnent partiellement :

```
✅ frontend/src/App.jsx                              (router)
✅ frontend/src/contexts/AuthContext.jsx             (auth state)
✅ frontend/src/components/auth/Login.jsx            (squelette)
✅ frontend/src/components/auth/InviteAccept.jsx     (squelette)
✅ frontend/src/components/layout/Layout.jsx         (sidebar + header)
✅ frontend/src/components/common/LanguageSwitcher.jsx
✅ frontend/src/components/common/NotificationBell.jsx
✅ frontend/src/i18n/index.js + locales/fr.json + en.json
✅ frontend/src/styles/global.css                    (design system)
```

## Étape 2.2 — Tâches Phase 2

```
☐ Test du flow Login complet
☐ Améliorer error handling dans Login
☐ Tester InviteAccept (créer une invitation via /api/v1/auth/invite)
☐ Page Reset Password (nouvelle, à créer)
☐ Polish du Layout (responsive mobile, animations)
☐ Tester le LanguageSwitcher FR ↔ EN
☐ Tester la NotificationBell (créer des notifs manuellement)
```

## Étape 2.3 — Test du flow invitation

Crée une PME test via API :

```bash
curl -X POST http://localhost:3000/api/v1/auth/invite \
  -H "Authorization: Bearer <super_admin_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "company_name": "Garage Tremblay",
    "contact_name": "Pierre Tremblay",
    "contact_email": "pierre@garage-tremblay.ca",
    "phone": "+1418555-1234",
    "city": "Lévis",
    "sector": "Automobile",
    "plan": "demarrage"
  }'
```

Récupère le token retourné, va sur `http://localhost:5173/invite/<token>`, crée un mot de passe.

---

# 📊 PHASE 3 — Dashboard PME (Jours 6-8)

> 🎨 **AVANT DE COMMENCER cette phase** : lis `docs/EMERGENT-DESIGN.md` et ouvre
> `design-reference/dashboard-reference.png`. Installe les briques :
> `npx shadcn@latest init` + `npm install @tremor/react framer-motion`.
> Copie les composants Aceternity nécessaires (Glowing Effect, Card Spotlight).
> Le rendu final doit correspondre à l'image à ≥90%.

**Objectif :** Dashboard.jsx complet avec vraies données + composants UI réutilisables.

## Étape 3.1 — Composants à créer

```
☐ frontend/src/components/dashboard/KpiCard.jsx
☐ frontend/src/components/dashboard/AlertCard.jsx
☐ frontend/src/components/dashboard/ActivityItem.jsx
☐ frontend/src/components/dashboard/PeriodSelector.jsx
☐ frontend/src/components/common/Spinner.jsx
☐ frontend/src/components/common/EmptyState.jsx
```

## Étape 3.2 — Compléter Dashboard.jsx

Le squelette existe. Tâches :

```
☐ Brancher /api/v1/dashboard/stats
☐ Brancher /api/v1/dashboard/alerts
☐ Brancher /api/v1/dashboard/activity
☐ Ajouter graphiques recharts (volume appels 7 jours)
☐ Tests responsive mobile
```

**Référence API :** `docs/EMERGENT-REFERENCE.md` section Dashboard.

---

# 👥 PHASE 4 — CRM + Import (Semaine 2-3)

**Objectif :** CRUD contacts + Import CSV intelligent.

## Étape 4.1 — Pages à créer

```
☐ frontend/src/pages/CRM.jsx           (liste + recherche + filtres)
☐ frontend/src/pages/ContactDetail.jsx (détail + historique cross-canal)
☐ frontend/src/pages/Import.jsx        (wizard 3 étapes)
```

## Étape 4.2 — Composants

```
☐ frontend/src/components/crm/ContactCard.jsx
☐ frontend/src/components/crm/ContactForm.jsx
☐ frontend/src/components/crm/StatusBadge.jsx
☐ frontend/src/components/crm/UrgencyBadge.jsx
☐ frontend/src/components/crm/AddNoteModal.jsx
☐ frontend/src/components/import/UploadStep.jsx
☐ frontend/src/components/import/MappingStep.jsx
☐ frontend/src/components/import/ConfirmStep.jsx
```

## Étape 4.3 — Routes API à brancher

- `GET /api/v1/contacts` (liste + filtres)
- `POST /api/v1/contacts` (création)
- `GET /api/v1/contacts/:id` (détail + historique)
- `PATCH /api/v1/contacts/:id` (modification)
- `POST /api/v1/contacts/:id/notes` (ajouter note)
- `POST /api/v1/import/preview` (upload CSV)
- `POST /api/v1/import/execute` (importer)

---

# 📞 PHASE 5 — Calls + Emails (Semaine 3-4)

**Objectif :** Liste appels + emails + brouillons à valider.

## Étape 5.1 — Pages à créer

```
☐ frontend/src/pages/Calls.jsx              (liste appels entrants)
☐ frontend/src/pages/CallDetail.jsx         (transcript + AI summary)
☐ frontend/src/pages/Outbound.jsx           (missions sortantes)
☐ frontend/src/pages/Emails.jsx             (inbox + tab brouillons)
☐ frontend/src/pages/DraftEditor.jsx        (modifier avant envoi)
```

## Étape 5.2 — Composants clés

```
☐ frontend/src/components/calls/CallCard.jsx
☐ frontend/src/components/calls/TranscriptView.jsx
☐ frontend/src/components/calls/LiveCallIndicator.jsx
☐ frontend/src/components/emails/EmailCard.jsx
☐ frontend/src/components/emails/DraftCard.jsx (Approve / Edit / Reject / Regenerate)
☐ frontend/src/components/outbound/MissionWizard.jsx (4 sources de contacts)
```

## Étape 5.3 — Routes critiques

- `GET /api/v1/emails/drafts` (brouillons à valider)
- `POST /api/v1/emails/drafts/:id/approve`
- `POST /api/v1/emails/drafts/:id/regenerate`

---

# 📅 PHASE 6 — Calendar + Knowledge (Semaine 4-5)

**Objectif :** RDV + Base de connaissances + Suggestions IA.

## Étape 6.1 — Pages

```
☐ frontend/src/pages/Calendar.jsx            (vue mois/semaine/jour)
☐ frontend/src/pages/Knowledge.jsx           (KB + tab suggestions)
☐ frontend/src/pages/Onboarding.jsx          (wizard 4 étapes)
```

## Étape 6.2 — L'onboarding est CRITIQUE

C'est ce que voit chaque nouvelle PME. Doit être impeccable.

```
Étape 1 : Configuration (nom, ton, langue UI)
Étape 2 : Choix voix (3 onglets : 🇨🇦 Québec / 🇫🇷 France / 🌍 Multi)
            Avec PREVIEW AUDIO à chaque voix
Étape 3 : Services activés + premières connaissances
Étape 4 : Test d'appel (l'IA appelle le client)
```

## Étape 6.3 — Knowledge + suggestions

Page Knowledge avec 2 tabs :
- **Tab "Mes connaissances"** : CRUD entrées
- **Tab "Suggestions IA"** : valider/modifier/refuser (avec count d'occurrences)

---

# ⚙️ PHASE 7 — Config + Voice + Billing (Semaine 5-6)

**Objectif :** Configuration assistante + multi-voix + Stripe.

## Étape 7.1 — Pages config

```
☐ frontend/src/pages/config/ConfigAssistant.jsx   (nom, ton, langue, salutations)
☐ frontend/src/pages/config/ConfigVoices.jsx      (catalog + assignments)
☐ frontend/src/pages/config/ConfigServices.jsx    (réception, RDV, support, etc.)
☐ frontend/src/pages/config/ConfigBilling.jsx     (forfait, paiement, overage)
☐ frontend/src/pages/config/ConfigIntegrations.jsx (Calendly, Gmail, etc.)
```

## Étape 7.2 — Sélecteur de voix (CRITIQUE)

```javascript
// 3 onglets visibles selon le forfait
<Tabs>
  <Tab label="🇨🇦 Québec">
    {voices.filter(v => v.accent === "quebec").map(...)}
  </Tab>
  <Tab label="🇫🇷 France">
    {voices.filter(v => v.accent === "france").map(...)}
  </Tab>
  <Tab label="🌍 Multilingue">
    {voices.filter(v => v.language === "multi").map(...)}
  </Tab>
</Tabs>

// Pour chaque voix : bouton "Tester" qui appelle
// POST /api/v1/voice-library/:id/test (retourne stream audio MP3)
```

## Étape 7.3 — Billing avec Stripe

```
☐ Composant CheckoutButton.jsx (POST /billing/checkout → redirect)
☐ Composant ManageBillingButton.jsx (POST /billing/portal → redirect)
☐ Composant UsageMeter.jsx (visualise minutes utilisées vs incluses)
☐ Composant OveragePolicySelector.jsx (pay_as_you_go ou block_at_limit)
☐ Composant PlanCard.jsx × 5 (Solo, Démarrage, Essentiel, Pro, Entreprise)
```

---

# 🎫 PHASE 8 — Support + Admin (Semaine 6-7)

**Objectif :** Tickets client + 6 pages admin Exevori.

## Étape 8.1 — Support client

```
☐ frontend/src/pages/Support.jsx              (mes tickets)
☐ frontend/src/pages/TicketDetail.jsx         (thread + réponses)
☐ frontend/src/components/tickets/PriorityBadge.jsx
☐ frontend/src/components/tickets/SlaStatus.jsx  (at_risk, breached, on_track)
☐ frontend/src/components/tickets/NewTicketModal.jsx
```

## Étape 8.2 — Admin Exevori (6 pages)

```
☐ frontend/src/pages/admin/AdminDashboard.jsx   (MRR, ARR, churn, marges)
☐ frontend/src/pages/admin/AdminClients.jsx     (liste + rentabilité par client)
☐ frontend/src/pages/admin/AdminTickets.jsx     (tous tickets + SLA)
☐ frontend/src/pages/admin/AdminVoices.jsx      (catalogue voice_library)
☐ frontend/src/pages/admin/AdminBilling.jsx     (factures + crédits)
☐ frontend/src/pages/admin/AdminAnalytics.jsx   (analytics globales)
```

## Étape 8.3 — Composants admin clés

```
☐ MrrChart.jsx              (graphique MRR mensuel)
☐ ClientProfitability.jsx   (revenu vs coût pour un client)
☐ GrantCreditModal.jsx      (donner rabais/gratuité)
☐ SuspendClientModal.jsx    (suspendre avec raison)
☐ MarkInvoicePaidModal.jsx  (mode manuel)
```

---

# 🔌 PHASE 9 — Intégrations réelles (Semaine 7-8)

**Objectif :** Brancher Twilio, ElevenLabs, Stripe, Calendly, Gmail Push, Resend.

## Étape 9.1 — Ordre recommandé

```
1. ElevenLabs       (le plus simple, juste clé API)
2. Resend          (emails transactionnels)
3. Stripe          (test mode d'abord)
4. Calendly        (OAuth + webhooks)
5. Twilio          (numéro test + Voice Inbound)
6. Gmail Push      (Pub/Sub, le plus complexe)
```

## Étape 9.2 — ElevenLabs

```bash
# Dans .env
ELEVENLABS_API_KEY=xi-...

# Tester
curl -X POST http://localhost:3000/api/v1/voice-library/<voice-id>/test \
  -H "Authorization: Bearer <token>" \
  -d '{"text":"Bonjour, ceci est un test"}' \
  --output test.mp3
```

## Étape 9.3 — Stripe (mode test)

1. Compte Stripe + récupérer clés test
2. Configurer dans `.env`
3. Créer les produits Stripe correspondant aux 5 forfaits
4. Configurer le webhook : `https://<ngrok>.io/webhooks/stripe`
5. Tester un checkout complet

## Étape 9.4 — Twilio Voice Inbound (CRITIQUE)

1. Acheter un numéro Twilio
2. Lancer `ngrok http 8080` (expose voice/inbound localement)
3. Configurer le numéro Twilio :
   - Voice → A call comes in → Webhook → `https://<ngrok>/voice/inbound`
4. Appeler le numéro Twilio depuis ton téléphone
5. L'assistante doit répondre et tu peux lui parler

**Si ça marche : VICTOIRE.** Tu as un produit fonctionnel.

## Étape 9.5 — Gmail Push (Phase 9 finale)

Le plus complexe. Suivre le guide officiel Gmail API + Pub/Sub.
Tester avec un email envoyé vers le compte Gmail configuré.

---

# 🚀 PHASE 10 — Premier client + Production (Semaine 8)

**Objectif :** Onboarder Exevori (Karim) comme premier client + déploiement prod.

## Étape 10.1 — Tests E2E manuels

Suivre le parcours complet :

```
1. Karim reçoit invitation par email
2. Crée son mot de passe
3. Choisit assistante "Léa" + voix Charlotte (FR-CA)
4. Configure les services (Réception, RDV, Support)
5. Importe ses 200 contacts existants par CSV
6. Configure son renvoi *72 vers le numéro Twilio
7. Reçoit un premier appel test → l'IA répond
8. Reçoit un email test → l'IA prépare un brouillon
9. Valide le brouillon → email envoyé
10. Consulte son dashboard → tout est tracé
```

## Étape 10.2 — Déploiement production

### Backend → Fly.io

```bash
# Installer Fly CLI
curl -L https://fly.io/install.sh | sh

# Login
fly auth login

# Dans backend/
fly launch --name voicedesk-backend --region yul  # Montréal

# Configurer les secrets
fly secrets set SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...
fly secrets set TWILIO_ACCOUNT_SID=... # etc

# Déployer
fly deploy
```

### Frontend → Vercel ou Netlify

```bash
# Dans frontend/
vercel --prod
# ou
netlify deploy --prod
```

### Voice servers → Fly.io (containers séparés)

Idem que backend mais services voice-inbound et voice-outbound.

## Étape 10.3 — Monitoring

```
☐ Sentry pour les erreurs frontend + backend
☐ Logs Fly.io en streaming
☐ Healthchecks toutes les minutes (https://uptimerobot.com)
☐ Alertes Slack/email sur erreurs critiques
☐ Dashboard Stripe pour les paiements
```

## Étape 10.4 — Premier vrai client externe

Quand Exevori est rodé, prospecter le **premier client externe** :

```
Cible idéale :
- PME locale Lévis ou Québec
- 5 à 15 employés
- Reçoit 20-50 appels/jour
- Sera tolérant aux bugs initiaux
- Acceptera de payer 319$ (Essentiel)
```

Karim démarche personnellement. Onboarding fait main-dans-main.

---

# 📊 Vue d'ensemble — Timeline résumée

| Semaine | Phase | Livrable |
|---------|-------|----------|
| **Sem 1 jour 1-2** | Phase 0-1 | Setup + Validation backend |
| **Sem 1 jour 3-5** | Phase 2 | Auth + Layout fonctionnels |
| **Sem 1 jour 6-7 + Sem 2** | Phase 3 | Dashboard complet |
| **Sem 2-3** | Phase 4 | CRM + Import CSV |
| **Sem 3-4** | Phase 5 | Calls + Emails |
| **Sem 4-5** | Phase 6 | Calendar + Knowledge + Onboarding |
| **Sem 5-6** | Phase 7 | Config + Voice + Billing |
| **Sem 6-7** | Phase 8 | Support + Admin |
| **Sem 7** | Phase 9 | Intégrations réelles |
| **Sem 8** | Phase 10 | Premier client + Production |

---

# 🛠️ Outils et ressources

## Libraries recommandées (à installer)

```bash
# Frontend
npm install -w frontend \
  shadcn-ui \              # Composants UI premium
  date-fns \               # Manipulation dates
  zod \                    # Validation forms
  react-hook-form \        # Forms
  react-hot-toast \        # Toasts notifications
  framer-motion \          # Animations
  @tanstack/react-query    # Data fetching + cache
```

## Conventions de code

- **Composants** : PascalCase (`ContactCard.jsx`)
- **Hooks** : `useXxx` (`useDebounce`, `useContacts`)
- **API calls** : centraliser dans `frontend/src/lib/api.js` (créer ce fichier)
- **i18n** : TOUJOURS utiliser `t("...")`, jamais de texte hardcodé
- **Types** : JSDoc dans les fichiers `.js` (pas obligatoire de migrer à TS)

## Pièges à éviter

```
❌ Hardcoder "Léa" dans le code → toujours `config.assistant_name`
❌ Oublier d'envoyer le JWT dans les requêtes API
❌ Ignorer les erreurs 403 (limite forfait atteinte)
❌ Utiliser des composants qui marchent en dev mais pas en prod (vérifier les imports)
❌ Tester en mode production Stripe AVANT validation du flow en test
❌ Commit le fichier .env (vérifier .gitignore)
❌ Skipper les migrations dans l'ordre → utiliser le numéro de migration
```

---

# 🎯 Checklist de fin

Quand tu as fini, ces 30 points doivent être cochés :

## Backend
- [ ] Tous les 15 modules répondent aux requêtes
- [ ] Auth + invitations fonctionnent
- [ ] Webhooks Stripe vérifiés
- [ ] AI Gateway opérationnel
- [ ] Voice inbound testé avec vrai numéro
- [ ] Voice outbound testé avec mission test

## Frontend
- [ ] 10 pages client construites
- [ ] 6 pages admin construites
- [ ] i18n FR/EN testé partout
- [ ] Responsive mobile OK
- [ ] Sélecteur de voix avec preview audio
- [ ] Onboarding wizard 4 étapes fluide
- [ ] Dashboard PME avec vraies données
- [ ] Notifications cloche + emails

## Intégrations
- [ ] Twilio production
- [ ] ElevenLabs production
- [ ] Stripe production (avec produits créés)
- [ ] Resend production
- [ ] Calendly OAuth + webhooks
- [ ] Gmail Push opérationnel

## Production
- [ ] Backend déployé Fly.io Montréal
- [ ] Frontend déployé Vercel
- [ ] Voice servers déployés
- [ ] Domain configuré (voicedesk.ca)
- [ ] SSL/TLS valide
- [ ] Sentry + monitoring
- [ ] Healthchecks externes
- [ ] Backups Supabase configurés
- [ ] Premier client Exevori onboardé
- [ ] Premier paiement Stripe traité

---

# 🆘 Si tu es bloqué

1. **Vérifier les logs** : `npm run docker:logs` ou logs Supabase
2. **Lire le README du module** concerné (`backend/modules/<module>/README.md`)
3. **Vérifier la route** dans `docs/EMERGENT-REFERENCE.md`
4. **Vérifier la table DB** dans `docs/SCHEMA.sql`
5. **Vérifier les constantes** dans `shared/constants.js`

## Erreurs fréquentes

| Erreur | Cause probable | Solution |
|--------|----------------|----------|
| `Cannot find module 'X'` | npm install incomplet | `npm run install:all` |
| `401 Unauthorized` | JWT manquant ou expiré | Re-login |
| `403 Forbidden` | Mauvais rôle ou company | Vérifier `req.user.role` |
| `Voice library RLS` | Policy mal configurée | Re-run migration 005 |
| `Stripe webhook signature` | Wrong webhook secret | Vérifier `.env` |
| `Twilio webhook 404` | Mauvaise URL ngrok | Re-générer tunnel |

---

# 🎉 Et après ?

Une fois la **Phase 10 terminée** :

1. **Phase 11 (Mois 2-3)** : 5-10 clients pilotes payants
2. **Phase 12 (Mois 3-6)** : Scaling à 30 clients
3. **Phase 13 (Mois 6+)** : Filiale Tunisie + 100 clients

Bonne route ! 🚀

---

**Pour toute question pendant le développement, ce projet est entièrement documenté. Tout est dans `docs/`.**
