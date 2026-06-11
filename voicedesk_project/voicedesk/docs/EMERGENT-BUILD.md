# 📘 EMERGENT-BUILD — Guide complet de construction

> Document de référence pour Emergent.sh.
> Pour démarrer rapidement : voir `EMERGENT-START.md`.

---

## 🎯 Vision du produit

**VoiceDesk IA** = Assistant vocal IA multi-tenant pour PME québécoises (1 à 50 employés).

### Cas d'usage
- Une PME garde son numéro Bell/Vidéotron/Telus
- Configure un renvoi vers un numéro Twilio assigné par VoiceDesk
- L'assistant IA répond aux appels, prend des messages, planifie des RDV
- Gère aussi les courriels (Niveau 1 auto, Niveau 2 brouillons validés)
- Alimente un CRM avec notes automatiques
- Apprend progressivement (suggestions validées humainement)

### Cible commerciale
Garages, dentistes, cliniques privées, comptables, avocats de quartier, entrepreneurs en rénovation, agences web, salons esthétiques, courtiers.

### Premier cas test
**Exevori** (Lévis, Québec) — entreprise IA/SaaS qui pilote le projet. Assistante test : "Léa".

⚠️ **"Léa" n'est qu'un exemple.** Chaque PME nomme sa propre assistante.

---

## 🏗️ Architecture monorepo

```
voicedesk/
├── backend/        # Node.js + Express + 15 modules
├── frontend/       # React + Vite + i18n
├── shared/         # Constantes communes
├── infra/          # Docker + migrations + scripts + mock data
└── docs/           # Documentation (vous êtes ici)
```

### Stack technique

| Couche | Choix | Justification |
|--------|-------|---------------|
| **Frontend** | React 18 + Vite + i18next | Standard, rapide, multilingue intégré |
| **Backend** | Node.js 20 + Express + Fastify (voice) | Mature, performant, écosystème npm |
| **DB** | Supabase Postgres (Montréal) | Loi 25 compliance + Auth + RLS gratuit |
| **AI** | DeepSeek V3 via Fireworks.ai | 95% moins cher que GPT-4, qualité équivalente |
| **STT** | Twilio ConversationRelay + Deepgram | Streaming temps réel, Quebec accent |
| **TTS** | ElevenLabs Flash v2.5 | 75ms latence, voix multilingues |
| **Téléphonie** | Twilio Programmable Voice | Standard de facto |
| **Email** | Resend | Simple, peu cher, deliverability haute |
| **Paiement** | Stripe (CAD) | Subscriptions + metering + portal client |
| **Calendrier** | Calendly v2 + Google Calendar | Webhook + OAuth |

---

## 🧩 Backend — 15 modules

### 1. `modules/auth/` — Authentification

Login + invitations + reset password via Supabase Auth.

**Routes principales** :
- `POST /api/v1/auth/invite` — Admin crée une entreprise + invitation
- `POST /api/v1/auth/invite/accept` — Acceptation + création mot de passe
- `GET /api/v1/auth/me` — Profil + company

### 2. `modules/config/` — Configuration assistante

Le cœur du multi-tenant. Chaque PME configure :
- Nom de l'assistante (ex: "Léa", "Antonella", "Marie")
- Voix (depuis voice_library)
- Ton (professional, warm, casual, formal)
- Langue principale (fr-CA, fr-FR, en-CA)
- Salutations + signature

### 3. `modules/dashboard/` — KPIs PME

Agrégation cross-module pour la première page.
- Appels du jour/semaine/mois
- Courriels reçus
- RDV à venir
- Hot leads
- Brouillons à valider
- Alertes (essai expirant, paiement en retard, etc.)

### 4. `modules/crm/` — Contacts

CRUD contacts + notes + historique cross-canal (appels + courriels + RDV).
Auto-détection des doublons par téléphone/email.

### 5. `modules/calendar/` — Rendez-vous

Calendly v2 + Google Calendar + saisie manuelle.
Webhooks pour sync en temps réel.

### 6. `modules/email/` — Courriels bilingues

- **Niveau 1** : Accusé de réception automatique
- **Niveau 2** : Brouillon généré par IA, validation humaine

Détection automatique FR/EN du message.

### 7. `modules/learning/` — Apprentissage contrôlé

L'IA détecte des patterns (questions fréquentes, infos services).
**L'humain valide** avant intégration dans la KB.

CRON toutes les 6h pour scan automatique.

### 8. `modules/knowledge/` — Base de connaissances

CRUD entrées de la KB officielle de l'entreprise.
Catégories : FAQ, services, pricing, hours, policies, contact.

Utilisé en lecture par `voice/inbound.js` pendant les appels.

### 9. `modules/billing/` — Stripe complet

- Stripe Checkout pour l'abonnement initial
- Customer Portal pour gérer la carte
- Usage tracking en temps réel (minutes voix)
- Webhook `/webhooks/stripe` pour les events
- 2 modes overage :
  - `pay_as_you_go` : continue + facture overage
  - `block_at_limit` : bloque à la limite (choix client)

### 10. `modules/tickets/` — Support pro

SLA tracking par priorité :
| Priorité | 1ère réponse | Résolution |
|----------|--------------|------------|
| 🔴 urgent | 1h | 4h |
| 🟠 high | 4h | 24h |
| 🔵 normal | 24h | 72h |
| ⚪ low | 48h | 7j |

Notes internes (invisibles client) + assignment.

### 11. `modules/admin/` — Dashboard Exevori

Pour `super_admin` uniquement :
- MRR, ARR, churn, marges en temps réel
- Rentabilité par client (revenu vs coût infra)
- Système de crédits/rabais/gratuités
- Suspension/réactivation
- Marquer factures comme payées (mode manuel)

### 12. `modules/voice-library/` — Multi-voix flexible

Architecture sans limites en dur :
- Table `voice_library` (catalogue géré par Exevori)
- Table `services` (configurables par PME)
- Table `voice_assignments` (1 voix par service ou plusieurs)
- Table `plan_limits` (limites par forfait, sans toucher au code)

Filtres : FR-CA (Québec) | FR-FR (France) | multilingue.

### 13. `modules/onboarding/` — Workflow 4 étapes

1. Configuration assistante (nom, ton, langue UI)
2. Choix de la voix
3. Services activés + premières connaissances
4. Test d'appel

### 14. `modules/import/` — Import CSV/Excel intelligent

Parsing assisté par DeepSeek pour détecter les colonnes (nom, email, phone, etc.).
Import par batch de 100, skip doublons configurable.

### 15. `modules/notifications/` — Notifications unifiées

In-app (cloche) + email selon préférences utilisateur.
Helpers exportés pour les autres modules :

```javascript
import { notify, notifyCompany, notifyAdmins } from "../notifications/index.js";

await notify({
  user_id, company_id,
  type: "warning", category: "billing",
  title: "Paiement en retard",
  email: { subject, html } // optionnel
});
```

---

## 🔌 Modules transversaux

### `lib/logger.js` — Logger structuré

JSON en production (Datadog/Axiom compatible), coloré en dev.

```javascript
import { logger } from "./lib/logger.js";
logger.info("Call completed", { company_id, duration: 142 });
```

### `lib/email-templates.js` — Templates centralisés

Tous les emails transactionnels FR/EN en un seul endroit :
- `invitationEmail`
- `passwordResetEmail`
- `trialEndingEmail`
- `paymentFailedEmail`
- `newTicketEmail`
- `acknowledgmentEmail`

### `middleware/auth.js` — Auth Express

```javascript
import { requireAuth, requireRole } from "./middleware/auth.js";

app.use("/api/v1/contacts", requireAuth, crmRouter);
app.use("/api/v1/admin", requireAuth, requireRole("super_admin"), adminRouter);
```

Injecte automatiquement `req.user.company_id` depuis le JWT.

### `webhooks/` — Webhooks externes

- `/webhooks/gmail-push` — Gmail Push API (nouveaux courriels)
- `/webhooks/twilio/status` — Statuts appels Twilio
- `/webhooks/twilio/amd` — Answering Machine Detection
- `/webhooks/resend` — Bounces + complaints
- `/webhooks/stripe` — Routé vers billing module

---

## 🎨 Frontend — Architecture React

### Structure

```
frontend/src/
├── App.jsx                 # Entry + router
├── components/
│   ├── layout/Layout.jsx   # Sidebar + header + i18n switcher
│   ├── auth/Login.jsx
│   ├── auth/InviteAccept.jsx
│   └── common/
│       ├── LanguageSwitcher.jsx
│       └── NotificationBell.jsx
├── pages/                  # Pages métier (à étendre)
│   └── Dashboard.jsx
├── contexts/AuthContext.jsx
├── i18n/                   # FR + EN
├── styles/global.css       # Design system
└── utils/                  # auth-helpers, crm-helpers
```

### Pattern d'une page typique

```javascript
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../contexts/AuthContext.jsx";

const API = import.meta.env.VITE_API_URL;

export default function Calls() {
  const { t } = useTranslation();
  const { token } = useAuth();
  const [calls, setCalls] = useState([]);

  useEffect(() => {
    fetch(`${API}/api/v1/calls`, {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then(r => r.json())
      .then(data => setCalls(data.calls));
  }, [token]);

  return (
    <div>
      <h1>{t("calls.title")}</h1>
      {calls.map(c => <CallCard key={c.id} call={c} />)}
    </div>
  );
}
```

---

## 🗄️ Base de données — 34 tables

Voir `docs/SCHEMA.sql` pour le schéma complet.

### Tables critiques

| Table | Contenu |
|-------|---------|
| `companies` | Entreprises clientes |
| `profiles` | Utilisateurs (lié à auth.users) |
| `invitations` | Invitations pendantes |
| `subscriptions` | Abonnements Stripe |
| `assistant_configs` | Configuration assistante par PME |
| `contacts` | Contacts/prospects CRM |
| `contact_notes` | Notes par contact |
| `calls` | Appels entrants |
| `outbound_calls` | Appels sortants |
| `missions` | Campagnes sortantes |
| `emails` | Courriels reçus |
| `email_drafts` | Brouillons à valider |
| `appointments` | Rendez-vous |
| `knowledge_base` | KB officielle |
| `learning_suggestions` | Suggestions IA à valider |
| `voice_library` | Catalogue voix |
| `services` | Services configurables |
| `voice_assignments` | Voix → service |
| `plan_limits` | Limites par forfait |
| `usage_records` | Tracking minutes/tokens (metering) |
| `invoices` | Factures Stripe + manuelles |
| `credit_grants` | Crédits/rabais admin |
| `tickets` | Support tickets |
| `ticket_messages` | Thread conversation |
| `notifications` | Notifications in-app |
| `notification_preferences` | Préférences email |

Toutes les tables ont **RLS activée** avec `company_isolation`.

---

## 🌐 i18n FR/EN

### Détection automatique

Ordre de priorité :
1. `localStorage` (choix utilisateur)
2. `profiles.preferred_language` (depuis Supabase)
3. `navigator.language` (langue du navigateur)
4. Défaut : `fr-CA`

### Switch pendant les appels

L'AI Gateway détecte automatiquement la langue parlée :
- STT par défaut en `fr-CA`
- Si 2 messages consécutifs détectés en anglais → switch vers `en-US`
- L'assistante annonce : "I can continue in English if you prefer."

### Multi-accent français

| Code | Description |
|------|-------------|
| `fr-CA` | Français du Québec |
| `fr-FR` | Français de France |

Le système supporte les deux pour s'adapter au goût du client.

---

## 💰 Tarification

| Plan | Prix/mois | Minutes | Overage |
|------|-----------|---------|---------|
| Solo | 79 $ CAD | 150 | 0,35 $/min |
| Démarrage | 159 $ | 400 | 0,30 $/min |
| Essentiel | 319 $ | 1 000 | 0,25 $/min |
| Professionnel | 529 $ | 2 500 | 0,20 $/min |
| Entreprise | 949 $ | 6 000 | 0,15 $/min |

- **Installation** : 319 $ — Canada uniquement (non applicable US/EU/monde)
- **Annuel** : −20% de remise
- **Essai gratuit** : 14 jours
- **Marges brutes** : ~94% à l'échelle

---

## 🚀 Workflow de construction recommandé pour Emergent

### Sprint 1 (Semaine 1) — Setup + Auth
- Cloner + installer
- Configurer Supabase + migrations
- Login + InviteAccept + Dashboard squelette (déjà fournis)
- Vérifier que `/api/v1/auth/me` retourne le profil

### Sprint 2 (Semaine 2) — Dashboard + CRM
- Dashboard.jsx complet avec KPIs réels
- CRM.jsx (liste + détail + recherche)
- Import CSV (page wizard 3 étapes)

### Sprint 3 (Semaine 3) — Calls + Emails
- Calls.jsx (liste + détail + transcript)
- Emails.jsx (inbox + brouillons à valider avec edit inline)
- Outbound.jsx (missions sortantes)

### Sprint 4 (Semaine 4) — Calendar + Knowledge
- Calendar.jsx (vue mois/semaine/jour)
- Knowledge.jsx (KB + suggestions IA)
- Onboarding workflow 4 étapes

### Sprint 5 (Semaine 5) — Config + Voice library
- Config.jsx (assistant + voix + services)
- Sélecteur de voix avec preview audio (3 onglets : QC / FR / Multi)
- Billing.jsx (Stripe Checkout + Customer Portal)

### Sprint 6 (Semaine 6) — Support + Admin
- Support.jsx (tickets client)
- Admin pages (6 écrans Exevori)
- Notifications complètes (in-app + email)

### Sprint 7 (Semaine 7) — Intégrations réelles
- Twilio en sandbox puis prod
- ElevenLabs en prod
- Stripe en prod
- Calendly + Google Calendar
- Resend + Gmail Push

### Sprint 8 (Semaine 8) — Tests + Premier client
- Tests E2E
- Onboarding du premier client Exevori
- Monitoring + alertes

---

## 📚 Voir aussi

- **`EMERGENT-START.md`** — Démarrage rapide en 30 min
- **`EMERGENT-REFERENCE.md`** — Référence exhaustive des 130 routes API
- **`ARCHITECTURE.md`** — Décisions techniques détaillées
- **`SCHEMA.sql`** — Schéma DB complet
- **`shared/constants.js`** — PLANS, ROUTES, SLA partagés

---

**Pour toute question : tout est documenté. Ce projet est conçu pour qu'Emergent puisse le construire en autonomie.**
