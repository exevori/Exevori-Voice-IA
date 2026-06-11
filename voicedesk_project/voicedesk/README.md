# 🎙️ VoiceDesk IA

> **Assistant vocal IA pour PME québécoises.**
> Voix entrante + sortante + courriels + CRM + apprentissage validé.
> Multi-tenant. Bilingue FR/EN. Architecture monorepo prête pour Emergent.sh.

---

## 📁 Structure du monorepo

```
voicedesk/
├── backend/              # API Node.js + AI Gateway + Voice servers
│   ├── index.js          # Serveur principal (port 3000)
│   ├── lib/              # Logger + email templates
│   ├── middleware/       # Auth middleware
│   ├── modules/          # 15 modules métier
│   ├── webhooks/         # Gmail Push + Twilio + Stripe
│   ├── gateway/          # AI Gateway DeepSeek (port 3100)
│   └── voice/            # Twilio + ElevenLabs (ports 8080, 8081)
│
├── frontend/             # React + Vite + i18n FR/EN
│   ├── src/
│   │   ├── App.jsx       # Entry point
│   │   ├── components/   # UI components
│   │   ├── pages/        # Pages (à étendre par Emergent)
│   │   ├── contexts/     # Auth context
│   │   ├── i18n/         # Traductions FR + EN
│   │   ├── styles/       # CSS global
│   │   └── utils/        # Helpers
│   ├── vite.config.js
│   └── index.html
│
├── shared/               # Constantes communes (PLANS, ROUTES, SLA)
│
├── infra/                # DevOps + DB + Mock data
│   ├── migrations/       # 6 fichiers SQL versionnés
│   ├── scripts/          # Seed mock data
│   ├── data/             # 24 fichiers JSON mock
│   ├── docker-compose.yml
│   ├── Dockerfile.backend
│   ├── Dockerfile.frontend
│   └── Dockerfile.service
│
├── docs/                 # Documentation
│   ├── EMERGENT-START.md     # Démarrage rapide
│   ├── EMERGENT-BUILD.md     # Guide complet pour Emergent
│   ├── EMERGENT-REFERENCE.md # Référence API
│   ├── ARCHITECTURE.md       # Décisions techniques
│   └── SCHEMA.sql            # Schéma DB complet (référence)
│
├── package.json          # npm workspaces (root)
├── .env.example          # 45+ variables d'environnement
└── .gitignore
```

---

## 🚀 Démarrage rapide

### 1. Installer

```bash
npm install:all
# Installe les dépendances racine + backend + frontend
```

### 2. Configurer

```bash
cp .env.example .env
# Éditer .env avec vos vraies clés API
```

### 3. Initialiser la base de données

```bash
# Coller infra/migrations/001 à 006 dans Supabase SQL Editor
# Puis importer les mock data :
npm run seed
```

### 4. Démarrer en développement

```bash
npm run dev
# Lance backend (3000) + frontend (5173) en parallèle

# Ou pour tout démarrer (gateway + voice servers inclus) :
npm run dev:all
```

### 5. Démarrer avec Docker

```bash
npm run docker:up      # Démarre tout (5 services)
npm run docker:logs    # Voir les logs
npm run docker:down    # Arrêter
```

---

## 📊 Statistiques du projet

```
Total fichiers        : 105+
Backend modules       : 15 (auth, config, dashboard, crm, calendar,
                        email, learning, knowledge, billing, tickets,
                        admin, voice-library, onboarding, import, notifications)
Lignes code JS        : ~8 000
Routes API            : ~130 endpoints
Tables Supabase       : 34 (avec RLS)
Migrations DB         : 6 versionnées
Mock data             : 24 fichiers JSON
i18n                  : 400+ clés (FR + EN)
Composants React      : 8 (extensible par Emergent)
```

---

## 🎯 Ce qui est déjà fait

```
✅ Architecture monorepo cohérente (backend / frontend / shared / infra / docs)
✅ AI Gateway DeepSeek (13 tâches IA)
✅ Pipeline voix Twilio + ElevenLabs (latence <700ms)
✅ Multi-voix flexible (FR-CA, FR-FR, multilingue)
✅ Bilinguisme FR/EN avec switch automatique pendant les appels
✅ Auth Supabase + invitations + reset password
✅ CRM complet avec import CSV intelligent
✅ Stripe (checkout + portal + metering + webhooks)
✅ Tickets pro avec SLA tracking
✅ Système de notifications unifié (in-app + email)
✅ 6 migrations DB versionnées
✅ Docker + docker-compose
✅ i18n complet FR + EN
```

## 🔨 Ce qu'Emergent doit construire

```
🎨 Frontend pages (8 pages métier + 6 pages admin)
🎨 Composants UI complets (Shadcn/UI recommandé)
🎨 Connexion frontend ↔ backend via les routes documentées
🧪 Tests réels avec Twilio + ElevenLabs sandbox
🚀 Déploiement production (Fly.io, Railway, ou Vercel + Render)
```

---

## 📚 Documentation

| Fichier | Contenu |
|---------|---------|
| `docs/EMERGENT-PROMPT.md` | **🎯 Prompt CTO à copier-coller à Emergent** |
| `docs/EMERGENT-WORKSHEET.md` | **📝 Feuille de travail fichier-par-fichier (LE PLUS IMPORTANT)** |
| `docs/EMERGENT-START.md` | Démarrage en 30 minutes |
| `docs/EMERGENT-BUILD.md` | Guide complet (architecture + sections) |
| `docs/EMERGENT-REFERENCE.md` | Référence exhaustive des routes API |
| `docs/ARCHITECTURE.md` | Décisions techniques et patterns |
| `docs/SCHEMA.sql` | Schéma DB complet (référence) |

---

## ⚠️ Règle critique : Multi-tenant

**Le nom "Léa" est UNIQUEMENT l'exemple Exevori.** Chaque PME nomme son assistante librement.

Le code utilise **toujours** :
```javascript
config.assistant_name || "Assistant"
```

JAMAIS de "Léa" hardcodé dans le code.

---

## 👥 Équipe & contact

- **Karim** — Product owner, ventes (Lévis, Québec)
- **Associé** — Commercial, opérations
- **Dali** — Développeur freelance → futur CTO filiale Tunisie

Plan filiale Tunisie déclenchée à 50 clients actifs.

---

## 💼 Modèle économique

**Même chiffre dans toutes les devises** — seule la devise et les taxes changent :

| Plan | 🇨🇦 Canada (CAD + TPS/TVQ) | 🇺🇸 USA (USD) | 🇪🇺 Europe (EUR) | 🌍 Monde (USD) | Minutes | Overage |
|------|------------|------|--------|-------|---------|---------|
| Solo | 79 $ + tx | 79 $ | 79 € | 79 $ | 150 | 0,35/min |
| Démarrage | 159 $ + tx | 159 $ | 159 € | 159 $ | 400 | 0,30/min |
| Essentiel | 319 $ + tx | 319 $ | 319 € | 319 $ | 1 000 | 0,25/min |
| Professionnel | 529 $ + tx | 529 $ | 529 € | 529 $ | 2 500 | 0,20/min |
| Entreprise | 949 $ + tx | 949 $ | 949 € | 949 $ | 6 000 | 0,15/min |

- 🇨🇦 Canada : prix HT + TPS (5%) + TVQ (9,975%) + **installation 319 $ (Canada uniquement)**
- 🇺🇸🇪🇺🌍 US / Europe / Monde : prix affiché = prix final, **aucune taxe, aucune installation**
- Tous les prix couvrent les frais Stripe (~3,5% amortis)

Marges brutes à l'échelle : **~94%**.
Installation : 319 $ (Canada uniquement).
Annuel : −20%.

---

**Pour commencer : ouvrez `docs/EMERGENT-START.md` 🚀**
