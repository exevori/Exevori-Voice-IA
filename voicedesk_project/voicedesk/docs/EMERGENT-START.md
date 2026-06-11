# 🚀 EMERGENT-START — Démarrage en 30 minutes

Guide ultra-rapide pour démarrer VoiceDesk IA sur Emergent.sh.

---

## ⏱️ Phase 1 — Setup (10 min)

### 1.1 Cloner le projet

```bash
git clone <repo> voicedesk
cd voicedesk
```

### 1.2 Installer toutes les dépendances

```bash
npm run install:all
# Installe : root + backend + frontend
```

### 1.3 Configurer les variables d'environnement

```bash
cp .env.example .env
```

Variables **OBLIGATOIRES** pour démarrer :

```bash
# Supabase (créer un projet sur supabase.com région Montréal)
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...

# Frontend Vite (mêmes valeurs)
VITE_SUPABASE_URL=https://xxx.supabase.co
VITE_SUPABASE_ANON_KEY=...
VITE_API_URL=http://localhost:3000
```

Variables **OPTIONNELLES** au démarrage (peuvent être ajoutées plus tard) :

```bash
# Pour activer la voix (Phase 2)
TWILIO_ACCOUNT_SID=...
ELEVENLABS_API_KEY=...

# Pour activer l'IA (Phase 2)
FIREWORKS_API_KEY=...

# Pour activer Stripe (Phase 3)
STRIPE_SECRET_KEY=...

# Pour activer les courriels (Phase 2)
RESEND_API_KEY=...
```

---

## ⏱️ Phase 2 — Base de données (5 min)

### 2.1 Créer le schéma Supabase

Aller sur **Supabase Dashboard → SQL Editor** et exécuter dans l'ordre :

```
1. infra/migrations/001_initial_schema.sql       (Auth + SaaS de base)
2. infra/migrations/002_crm_operations.sql       (Contacts, calls, emails)
3. infra/migrations/003_billing.sql              (Stripe + invoices)
4. infra/migrations/004_tickets.sql              (Support tickets)
5. infra/migrations/005_voice_library.sql        (Multi-voix flexible)
6. infra/migrations/006_notifications.sql        (Notifications in-app)
```

### 2.2 Importer les données mock

```bash
npm run seed
# Importe les 24 fichiers JSON dans infra/data/
```

---

## ⏱️ Phase 3 — Démarrer (5 min)

### Option A — Développement local

```bash
npm run dev
# → Backend  : http://localhost:3000
# → Frontend : http://localhost:5173
```

Pour tout démarrer (gateway IA + voice servers inclus) :

```bash
npm run dev:all
```

### Option B — Docker

```bash
npm run docker:up
# Lance 5 services : backend, frontend, gateway, voice-inbound, voice-outbound
```

### Vérifier que ça marche

```bash
curl http://localhost:3000/health
# → { "status": "ok", "service": "voicedesk-backend", ... }
```

Ouvrir `http://localhost:5173` dans le navigateur.

---

## ⏱️ Phase 4 — Construction du frontend (Emergent — phase principale)

Emergent doit maintenant construire les pages manquantes.

### Pages déjà fournies (squelettes) :

```
✅ frontend/src/components/auth/Login.jsx
✅ frontend/src/components/auth/InviteAccept.jsx
✅ frontend/src/components/layout/Layout.jsx (avec sidebar + i18n switcher)
✅ frontend/src/components/common/LanguageSwitcher.jsx
✅ frontend/src/components/common/NotificationBell.jsx
✅ frontend/src/pages/Dashboard.jsx (skeleton avec KPIs)
✅ frontend/src/contexts/AuthContext.jsx
✅ frontend/src/styles/global.css (design system)
```

### Pages à construire (par Emergent) :

```
🔨 Pages métier (client) :
   - Calls.jsx          (liste appels + détail + transcript)
   - Outbound.jsx       (missions sortantes + déclenchement)
   - Emails.jsx         (boîte + brouillons à valider)
   - CRM.jsx            (contacts + recherche + détail fiche)
   - Calendar.jsx       (RDV + intégration Calendly)
   - Knowledge.jsx      (KB + suggestions IA à valider)
   - Config.jsx         (assistant + voix + services + facturation)
   - Support.jsx        (tickets client)

🔨 Pages admin (super_admin Exevori) :
   - AdminDashboard.jsx (MRR, ARR, churn, marges)
   - AdminClients.jsx   (liste clients + rentabilité par client)
   - AdminTickets.jsx   (tous tickets cross-clients + SLA)
   - AdminVoices.jsx    (catalogue voice_library + sync ElevenLabs)
   - AdminBilling.jsx   (factures + crédits + suspensions)
   - AdminAnalytics.jsx (analytics globales)
```

### Tous les composants doivent :

1. **Utiliser i18n** :
```javascript
import { useTranslation } from "react-i18next";
const { t } = useTranslation();
<h1>{t("page.title")}</h1>
```

2. **Utiliser le contexte auth** :
```javascript
import { useAuth } from "../contexts/AuthContext.jsx";
const { token, profile } = useAuth();
```

3. **Appeler les routes API** :
```javascript
const API = import.meta.env.VITE_API_URL;
fetch(`${API}/api/v1/contacts`, {
  headers: { Authorization: `Bearer ${token}` }
})
```

Toutes les routes sont documentées dans `docs/EMERGENT-REFERENCE.md`.

---

## 🆘 Problèmes courants

### Backend ne démarre pas

```bash
# Vérifier les vars Supabase
echo $SUPABASE_URL
echo $SUPABASE_SERVICE_ROLE_KEY

# Vérifier les modules
ls backend/modules/
# Doit contenir 15 dossiers
```

### Frontend ne charge pas

```bash
# Vérifier l'install
cd frontend && npm install

# Vérifier les vars Vite
cat ../.env | grep VITE_
```

### Erreur "Cannot find module"

```bash
# Réinstaller tout
rm -rf node_modules backend/node_modules frontend/node_modules
npm run install:all
```

### Erreur Supabase RLS

Vérifier que les 6 migrations ont bien été exécutées dans l'ordre, et que les policies RLS sont actives.

---

## 📖 Prochaines lectures

| Document | Quand le lire |
|----------|---------------|
| `EMERGENT-BUILD.md` | Architecture complète et patterns de construction |
| `EMERGENT-REFERENCE.md` | Référence exhaustive des 130 routes API |
| `ARCHITECTURE.md` | Décisions techniques (DeepSeek, Twilio, etc.) |

---

**Vous êtes prêt. Bonne construction! 🎙️**
