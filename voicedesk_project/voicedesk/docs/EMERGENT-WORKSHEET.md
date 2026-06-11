# 📝 EMERGENT-WORKSHEET — Feuille de travail fichier par fichier

> **LE DOCUMENT LE PLUS IMPORTANT POUR EMERGENT.**
> Chaque tâche = un ou plusieurs fichiers précis, avec ce qu'il faut faire dedans.
> Suis l'ordre. Ne saute rien. Coche au fur et à mesure.

---

# 🔧 PHASE 0 — Setup (Jour 1)

## Tâche 0.1 — Installation
```bash
# À la racine du projet
npm run install:all
```
**Vérification :** `ls node_modules backend/node_modules frontend/node_modules` → 3 dossiers.

## Tâche 0.2 — Créer projet Supabase
1. Aller sur https://supabase.com → New Project
2. **Région : Canada Central (Montréal)** ← OBLIGATOIRE (Loi 25)
3. Noter : Project URL, anon key, service_role key

## Tâche 0.3 — Configurer `.env`
**Fichier :** `.env` (à la racine, copie de `.env.example`)

Remplir UNIQUEMENT ces 5 variables pour la Phase 0 :
```bash
SUPABASE_URL=<ton-url>
SUPABASE_ANON_KEY=<ton-anon>
SUPABASE_SERVICE_ROLE_KEY=<ton-service-role>
VITE_SUPABASE_URL=<ton-url>
VITE_SUPABASE_ANON_KEY=<ton-anon>
```
Le reste viendra Phase 8.

## Tâche 0.4 — Exécuter les 7 migrations dans Supabase
Aller dans Supabase Dashboard → SQL Editor → exécuter dans l'ordre :
```
infra/migrations/001_initial_schema.sql
infra/migrations/002_crm_operations.sql
infra/migrations/003_billing.sql
infra/migrations/004_tickets.sql
infra/migrations/005_voice_library.sql
infra/migrations/006_notifications.sql
infra/migrations/007_multi_currency.sql
```
**Vérification :** Table Editor → 35 tables visibles.

## Tâche 0.5 — Importer mock data
```bash
npm run seed
```
**Vérification :** Table `companies` = 5 lignes, `contacts` = 7 lignes, `voice_library` = 6 lignes.

## Tâche 0.6 — Démarrer
```bash
npm run dev
```
**Vérification :**
- `curl http://localhost:3000/health` → `{"status":"ok"}`
- Ouvrir `http://localhost:5173` → page Login s'affiche

---

# 🧪 PHASE 1 — Validation backend (Jour 2)

## Tâche 1.1 — Créer super_admin Exevori
**Supabase Dashboard → Auth → Add user**
- Email : `admin@exevori.com`
- Password : choisir
- Auto-confirm : ✅

**SQL Editor :**
```sql
INSERT INTO profiles (user_id, email, full_name, role, status, preferred_language)
VALUES (
  (SELECT id FROM auth.users WHERE email = 'admin@exevori.com'),
  'admin@exevori.com', 'Karim — Exevori', 'super_admin', 'active', 'fr-CA'
);
```

## Tâche 1.2 — Test login frontend
1. Ouvrir `http://localhost:5173/login`
2. Se connecter avec admin@exevori.com
3. **Vérification :** Redirection vers `/dashboard`, sidebar visible avec logo Exevori

## Tâche 1.3 — Test invitation PME (création garage test)
**Postman/curl :**
```bash
# 1. Récupérer JWT
TOKEN=$(curl -X POST 'https://<projet>.supabase.co/auth/v1/token?grant_type=password' \
  -H "apikey: <anon>" -H "Content-Type: application/json" \
  -d '{"email":"admin@exevori.com","password":"<mdp>"}' | jq -r .access_token)

# 2. Créer une PME test
curl -X POST http://localhost:3000/api/v1/auth/invite \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "company_name": "Garage Test Lévis",
    "contact_name": "Pierre Test",
    "contact_email": "test@garage.ca",
    "phone": "+14185551234",
    "city": "Lévis",
    "sector": "Automobile",
    "plan": "demarrage"
  }'
```
**Vérification :** Token retourné, table `invitations` mise à jour.

---

# 🎨 PHASE 2 — Setup design system (Jours 3-4)

## Tâche 2.1 — Installer les briques UI
```bash
cd frontend
npx shadcn@latest init     # Choisir : New York, Slate, oui CSS variables
npm install @tremor/react framer-motion class-variance-authority clsx tailwind-merge
```

## Tâche 2.2 — Configurer Tailwind
**Fichier :** `frontend/tailwind.config.js` (créer si absent)
```javascript
/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        background: "rgb(8 12 24)",      // --bg-primary
        sidebar: "rgb(12 16 32)",         // --bg-sidebar
        card: "rgb(17 24 39)",            // --bg-card
        primary: "#3B82F6",
        cyan: "#06B6D4",
        purple: "#8B5CF6",
        pink: "#EC4899",
        green: "#10B981",
        yellow: "#F59E0B",
        red: "#EF4444",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
    },
  },
};
```

## Tâche 2.3 — Installer les composants shadcn essentiels
```bash
cd frontend
npx shadcn@latest add button card badge tabs dropdown-menu dialog
npx shadcn@latest add tooltip avatar separator skeleton sheet
npx shadcn@latest add input label textarea select switch
npx shadcn@latest add table popover command
```
**Vérification :** `ls src/components/ui/` → 18+ fichiers.

## Tâche 2.4 — Copy-paste Aceternity UI
Aller sur https://ui.aceternity.com et copier ces 3 composants :
1. **Glowing Effect** → `frontend/src/components/ui/glowing-effect.jsx`
2. **Card Spotlight** → `frontend/src/components/ui/card-spotlight.jsx`
3. **Background Gradient** → `frontend/src/components/ui/background-gradient.jsx`

(Copy-paste pur depuis le site, pas de modification.)

---

# 🏗️ PHASE 3 — Layout + Composants communs (Jours 4-5)

## Tâche 3.1 — Améliorer la Sidebar avec logo Exevori
**Fichier :** `frontend/src/components/layout/Layout.jsx` (déjà existe)

**À faire :** Vérifier que le logo Exevori s'affiche correctement.
Le composant utilise déjà `/branding/exevori-logo.png`.

**Si problème d'affichage :**
```jsx
<img
  src="/branding/exevori-logo.png"
  alt="Exevori"
  className="w-10 h-10 object-contain drop-shadow-[0_0_8px_rgba(139,92,246,0.4)]"
/>
```

## Tâche 3.2 — Composant Badge réutilisable
**Fichier :** `frontend/src/components/common/Badge.jsx` (créer)

```jsx
// Variants : success, warning, danger, info, neutral
// Tailles : sm, md
// Couleurs basées sur les --color-dim de global.css
import { cn } from "@/lib/utils";

const variants = {
  success: "bg-green-500/15 text-green-400 border-green-500/20",
  warning: "bg-yellow-500/15 text-yellow-400 border-yellow-500/20",
  danger:  "bg-red-500/15 text-red-400 border-red-500/20",
  info:    "bg-blue-500/15 text-blue-400 border-blue-500/20",
  neutral: "bg-slate-500/15 text-slate-400 border-slate-500/20",
};

export function Badge({ variant = "neutral", size = "sm", children }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1 rounded-full border font-medium",
      size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-3 py-1 text-xs",
      variants[variant]
    )}>
      {children}
    </span>
  );
}
```

## Tâche 3.3 — Composant StatusBadge intelligent
**Fichier :** `frontend/src/components/common/StatusBadge.jsx` (créer)

```jsx
// Mapping automatique status → variant + label i18n
import { Badge } from "./Badge.jsx";
import { useTranslation } from "react-i18next";

const STATUS_MAP = {
  // Calls
  in_progress: { variant: "success", icon: "🟢" },
  on_hold: { variant: "warning", icon: "⏸" },
  completed: { variant: "neutral", icon: "✓" },
  transferred: { variant: "warning", icon: "↪" },

  // Emails
  draft_pending: { variant: "warning" },
  acknowledged: { variant: "success" },
  replied: { variant: "success" },

  // Leads
  qualified: { variant: "info" },
  hot_lead: { variant: "danger" },
  new: { variant: "neutral" },

  // Tickets
  open: { variant: "warning" },
  resolved: { variant: "success" },
  closed: { variant: "neutral" },
};

export function StatusBadge({ status, size = "sm" }) {
  const { t } = useTranslation();
  const config = STATUS_MAP[status] || { variant: "neutral" };
  return (
    <Badge variant={config.variant} size={size}>
      {config.icon} {t(`status.${status}`)}
    </Badge>
  );
}
```

## Tâche 3.4 — KpiCard avec sparkline
**Fichier :** `frontend/src/components/common/KpiCard.jsx` (créer)

```jsx
import { Card } from "@/components/ui/card";
import { SparkAreaChart } from "@tremor/react";
import { ArrowUp, ArrowDown } from "lucide-react";

export function KpiCard({ icon: Icon, label, value, change, trend, color = "blue" }) {
  const isPositive = change > 0;
  return (
    <Card className="p-4 bg-card border-white/5 hover:border-white/10 transition-all">
      <div className="flex items-start justify-between mb-3">
        <div className={`w-9 h-9 rounded-lg bg-${color}-500/15 flex items-center justify-center`}>
          <Icon className={`w-4 h-4 text-${color}-400`} />
        </div>
        {trend && (
          <SparkAreaChart
            data={trend}
            index="day"
            categories={["value"]}
            colors={[color]}
            className="h-8 w-20"
          />
        )}
      </div>
      <div className="text-2xl font-bold text-white mb-1">{value}</div>
      <div className="flex items-center gap-2">
        <div className="text-xs text-slate-400">{label}</div>
        {change !== undefined && (
          <div className={`flex items-center gap-1 text-xs ${isPositive ? "text-green-400" : "text-red-400"}`}>
            {isPositive ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
            {Math.abs(change)}%
          </div>
        )}
      </div>
    </Card>
  );
}
```

## Tâche 3.5 — DataTable réutilisable (CRITIQUE — réutilisé partout)
**Fichier :** `frontend/src/components/common/DataTable.jsx` (créer)

```jsx
// Table générique avec : header trié, search, pagination, sélection, actions
// Utilisée par : Calls, Outbound, Emails, CRM, Tickets, Admin Clients, etc.
import { useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";

export function DataTable({ columns, data, searchKey, onRowClick }) {
  const [search, setSearch] = useState("");

  const filtered = searchKey
    ? data.filter(row => String(row[searchKey] || "").toLowerCase().includes(search.toLowerCase()))
    : data;

  return (
    <div className="space-y-3">
      {searchKey && (
        <Input
          placeholder="Rechercher..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="max-w-sm bg-card border-white/10"
        />
      )}
      <div className="rounded-lg border border-white/5 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-white/5 hover:bg-transparent">
              {columns.map(col => (
                <TableHead key={col.key} className="text-slate-400">{col.label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((row, i) => (
              <TableRow
                key={row.id || i}
                className="border-white/5 hover:bg-white/[0.02] cursor-pointer"
                onClick={() => onRowClick?.(row)}
              >
                {columns.map(col => (
                  <TableCell key={col.key}>
                    {col.render ? col.render(row) : row[col.key]}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
```

---

# 📊 PHASE 4 — Dashboard PME (Jours 6-8)

## Tâche 4.1 — Page Dashboard complète
**Fichier :** `frontend/src/pages/Dashboard.jsx` (existe en squelette → compléter)

**Structure exacte (cf. design-reference/dashboard-reference.png) :**
```jsx
// 1. Header : titre + period selector (Today/Week/Month)
// 2. 4 KPI cards : Calls Today, Appointments Booked, Emails Processed, New Leads
// 3. Grille 3 colonnes :
//    - col 1 : Live Calls (3 active) + Upcoming Appointments
//    - col 2 : Email Handling + CRM / Leads
//    - col 3 : Assistant Profile (carte signature avec avatar)
// 4. Grille 2 colonnes bas :
//    - col 1 : Business Memory + Learning Suggestions
//    - col 2 : Analytics Overview (area chart + donut)
```

**Routes API à appeler :**
- `GET /api/v1/dashboard/stats?period=today` → KPIs
- `GET /api/v1/dashboard/activity?limit=10` → Activité récente
- `GET /api/v1/dashboard/alerts` → Alertes

## Tâche 4.2 — Carte Assistant Profile (LA carte signature)
**Fichier :** `frontend/src/components/dashboard/AssistantProfileCard.jsx` (créer)

Spécifications visuelles dans `docs/EMERGENT-DESIGN.md` section 4.

Points clés :
- Avatar avec **anneau gradient animé** (CSS `conic-gradient` + rotation)
- Nom = `config.assistant_name` (jamais hardcodé)
- Dropdowns pour Voice + Tone (modifiables inline)
- Encadré greeting avec **player audio** + waveform animée violette
- Glowing Effect Aceternity sur le hover de la carte

## Tâche 4.3 — Live Calls + dots pulsants
**Fichier :** `frontend/src/components/dashboard/LiveCallsCard.jsx` (créer)

```jsx
// Dot CSS pulsant pour les appels actifs :
<div className="w-2 h-2 rounded-full bg-green-400 shadow-[0_0_6px_rgba(16,185,129,0.8)] animate-pulse" />

// Polling toutes les 5 secondes : GET /api/v1/calls?status=in_progress
```

## Tâche 4.4 — Business Memory (grille 2×2)
**Fichier :** `frontend/src/components/dashboard/BusinessMemoryCard.jsx` (créer)

```
┌─────────┬─────────┐
│ 24      │ 18      │
│Services │ FAQs    │
├─────────┼─────────┤
│ 7       │ 12      │
│Pricing  │Procedure│
└─────────┴─────────┘
```
Compte depuis `knowledge_base` groupé par `category`.

## Tâche 4.5 — Learning Suggestions avec actions
**Fichier :** `frontend/src/components/dashboard/LearningSuggestionsCard.jsx` (créer)

3 boutons par suggestion :
- ✅ Approve → `POST /api/v1/learning/suggestions/:id/approve`
- ✎ Edit → ouvre modal
- ❌ Reject → `POST /api/v1/learning/suggestions/:id/reject`

## Tâche 4.6 — Analytics avec Recharts
**Fichier :** `frontend/src/components/dashboard/AnalyticsCard.jsx` (créer)

- AreaChart 7 jours (volume interactions) avec gradient fill
- PieChart donut : répartition Calls/Emails/Appointments/Others

Données : `GET /api/v1/dashboard/stats?period=week`

---

# 👥 PHASE 5 — CRM + Import (Semaine 2-3)

## Tâche 5.1 — Page CRM
**Fichier :** `frontend/src/pages/CRM.jsx` (créer)

```jsx
// 1. Top bar : filtres status + source + urgence + recherche
// 2. DataTable (réutiliser frontend/src/components/common/DataTable.jsx)
//    Colonnes : Nom, Entreprise, Téléphone, Statut, Urgence, Dernier contact, Actions
// 3. Click row → naviguer vers /crm/:id
// 4. Bouton "+ Importer CSV" en haut à droite

// Route : GET /api/v1/contacts?status=&source=&urgency=&search=&limit=50
```

## Tâche 5.2 — Page Détail Contact
**Fichier :** `frontend/src/pages/ContactDetail.jsx` (créer)

3 tabs :
- **Infos** : formulaire éditable
- **Historique** : timeline cross-canal (appels + emails + RDV + notes)
- **Notes** : liste + ajout

Routes :
- `GET /api/v1/contacts/:id`
- `PATCH /api/v1/contacts/:id`
- `POST /api/v1/contacts/:id/notes`

## Tâche 5.3 — Import CSV Wizard (3 étapes)
**Fichiers à créer :**
1. `frontend/src/pages/Import.jsx` — orchestrateur
2. `frontend/src/components/import/Step1Upload.jsx` — drag&drop
3. `frontend/src/components/import/Step2Mapping.jsx` — preview + détection colonnes
4. `frontend/src/components/import/Step3Confirm.jsx` — validation + import

Routes :
- `POST /api/v1/import/preview` (multipart file)
- `POST /api/v1/import/execute` (multipart file + mapping JSON)

---

# 📞 PHASE 6 — Calls + Emails (Semaine 3-4)

## Tâche 6.1 — Page Calls (liste appels entrants)
**Fichier :** `frontend/src/pages/Calls.jsx` (créer)

DataTable avec colonnes : Heure, Nom, Téléphone, Durée, Intent, Status, Confiance.
Bouton détail → `/calls/:id`.

## Tâche 6.2 — Page Détail Appel
**Fichier :** `frontend/src/pages/CallDetail.jsx` (créer)

- Header : nom + téléphone + durée + status badge
- Section "Résumé IA" (depuis `ai_summary`)
- Section "Transcript" (depuis `ai_transcript`) — composant TranscriptView
- Section "Score de confiance" + actions admin
- Bouton "Voir contact" → `/crm/:contact_id`

## Tâche 6.3 — Composant TranscriptView
**Fichier :** `frontend/src/components/calls/TranscriptView.jsx` (créer)

Affichage style chat :
- Messages assistant à gauche (avatar Exevori)
- Messages caller à droite (initiale)
- Timestamps relatifs

## Tâche 6.4 — Page Outbound (missions sortantes)
**Fichier :** `frontend/src/pages/Outbound.jsx` (créer)

2 tabs :
- **Missions** : liste + bouton "Nouvelle mission"
- **Appels** : DataTable des outbound_calls

Modal nouvelle mission : wizard 4 sources (calendar / crm_filter / csv_import / manual)

## Tâche 6.5 — Page Emails
**Fichier :** `frontend/src/pages/Emails.jsx` (créer)

3 tabs :
- **Inbox** : DataTable emails reçus
- **Brouillons à valider** (badge rouge avec compteur) : cards inline avec boutons Approve / Edit / Regenerate / Reject
- **Envoyés**

## Tâche 6.6 — Composant DraftCard
**Fichier :** `frontend/src/components/emails/DraftCard.jsx` (créer)

```jsx
// Carte avec :
// - Destinataire + sujet + preview
// - Confidence badge (jaune si < 80%)
// - 4 boutons : ✓ Approuver | ✎ Modifier | 🔄 Régénérer | ✗ Refuser
// - Edit mode : textarea editable + bouton "Sauvegarder"

// Routes :
// POST /api/v1/emails/drafts/:id/approve
// POST /api/v1/emails/drafts/:id/regenerate
// PATCH /api/v1/emails/drafts/:id (edit)
// POST /api/v1/emails/drafts/:id/reject
```

---

# 📅 PHASE 7 — Calendar + Knowledge + Onboarding (Semaine 4-5)

## Tâche 7.1 — Page Calendar
**Fichier :** `frontend/src/pages/Calendar.jsx` (créer)

Utiliser `react-big-calendar` ou construire une vue simple :
- Vue mois / semaine / jour
- RDV depuis `GET /api/v1/calendar/appointments`
- Click sur slot vide → modal "Nouveau RDV"
- Click sur RDV → modal détail + modifier/annuler

## Tâche 7.2 — Page Knowledge
**Fichier :** `frontend/src/pages/Knowledge.jsx` (créer)

2 tabs :
- **Mes connaissances** : DataTable + bouton "+ Ajouter" + filtre par catégorie
- **Suggestions IA** (badge bleu compteur pending) : cards avec actions Approve/Edit/Reject

## Tâche 7.3 — Page Onboarding (wizard 4 étapes — CRITIQUE)
**Fichier :** `frontend/src/pages/Onboarding.jsx` (créer)

```jsx
// Layout : header avec progress bar 4 étapes
// État géré localement + sync avec /api/v1/onboarding

// Étape 1 : Configuration de base
//   - Input "Nom de l'assistante" (placeholder: "Léa, Marie, Antonella...")
//   - Select Genre (féminine/masculine/neutre)
//   - Select Ton (professional/warm/casual/formal)
//   - Select Langue UI (fr-CA/fr-FR/en-CA/en-US)
//   → POST /api/v1/onboarding/step/1

// Étape 2 : Choix de la voix (CRITIQUE)
//   - 3 onglets : 🇨🇦 Québec | 🇫🇷 France | 🌍 Multilingue
//   - Pour chaque voix : card avec preview audio (bouton ▶)
//   - GET /api/v1/voice-library?accent=quebec|france|multilingual
//   - POST /api/v1/voice-library/:id/test (preview)
//   → POST /api/v1/onboarding/step/2

// Étape 3 : Services + connaissances
//   - Toggle 4 services par défaut (réception, RDV, support, sortant)
//   - Bouton "+ Ajouter une connaissance" → modal Q&A
//   → POST /api/v1/onboarding/step/3

// Étape 4 : Test d'appel
//   - Input "Votre numéro de téléphone" (formatage E.164)
//   - Bouton "Lancer le test"
//   - Pendant l'appel : indicateur live + transcript en temps réel
//   → POST /api/v1/onboarding/step/4
```

## Tâche 7.4 — Composant VoiceSelector
**Fichier :** `frontend/src/components/onboarding/VoiceSelector.jsx` (créer)

Carte de voix avec :
- Avatar/icône
- Nom + accent (badge)
- Description
- Sliders : stability, similarity, speed
- Bouton ▶ Preview (joue mp3 depuis API)
- Bouton "Choisir cette voix"

---

# ⚙️ PHASE 8 — Config + Billing (Semaine 5-6)

## Tâche 8.1 — Pages config (5 sous-pages)
**Fichiers :**
- `frontend/src/pages/config/ConfigAssistant.jsx` — nom, ton, langue, greetings
- `frontend/src/pages/config/ConfigVoices.jsx` — réutilise VoiceSelector + assignments
- `frontend/src/pages/config/ConfigServices.jsx` — toggle services + edit settings
- `frontend/src/pages/config/ConfigBilling.jsx` — forfait actuel + usage + portail Stripe
- `frontend/src/pages/config/ConfigIntegrations.jsx` — connect Calendly, Gmail, etc.

Routes : `GET/PATCH /api/v1/config`

## Tâche 8.2 — Composant PlanCard (5×)
**Fichier :** `frontend/src/components/billing/PlanCard.jsx` (créer)

```jsx
// Props : plan (solo/demarrage/...), pricing (depuis /pricing?country=)
// Affiche : nom, prix, devise, taxes (CA only), minutes, overage rate
// Bouton "Choisir ce plan" → POST /api/v1/billing/checkout

// Détection pays : depuis profile.companies.billing_country
// ou via Stripe pricing endpoint
```

## Tâche 8.3 — Composant UsageMeter
**Fichier :** `frontend/src/components/billing/UsageMeter.jsx` (créer)

```jsx
// Barre de progression visuelle :
// [████████████░░░░] 1247 / 2500 min (49.9%)
//
// Couleurs adaptatives :
// 0-70%   : vert
// 70-90%  : jaune
// 90-100% : rouge
// >100%   : badge "Overage" (selon overage_policy)
```

## Tâche 8.4 — Composant OveragePolicySelector
**Fichier :** `frontend/src/components/billing/OveragePolicySelector.jsx` (créer)

2 cards radio :
- **Pay-as-you-go** : continue + facture overage
- **Block at limit** : bloque les appels à la limite

`POST /api/v1/billing/overage-policy { policy: "pay_as_you_go" | "block_at_limit" }`

---

# 🎫 PHASE 9 — Support + Admin (Semaine 6-7)

## Tâche 9.1 — Page Support (tickets client)
**Fichier :** `frontend/src/pages/Support.jsx` (créer)

- DataTable tickets avec priorité badges + SLA status
- Bouton "+ Nouveau ticket" → modal
- Click ticket → `/support/:id`

## Tâche 9.2 — Page TicketDetail
**Fichier :** `frontend/src/pages/TicketDetail.jsx` (créer)

- Header : ticket # + sujet + priority + status
- Thread de messages (chat style)
- Composer reply + attachments
- Sidebar : SLA timer + assigned to + rating (post-resolution)

## Tâche 9.3 — Pages Admin Exevori (6 pages)

**Fichiers :**

### `frontend/src/pages/admin/AdminDashboard.jsx`
```
- KPIs : MRR, ARR, churn, marges
- Graphique MRR mensuel (12 mois)
- Liste alertes (trial ending, payment failed, SLA breached)
Route : GET /api/v1/admin/dashboard
```

### `frontend/src/pages/admin/AdminClients.jsx`
```
- DataTable de toutes les companies
- Colonnes : Nom, Plan, MRR, Marge, Usage %, Statut, Actions
- Click client → AdminClientDetail
```

### `frontend/src/pages/admin/AdminClientDetail.jsx`
```
- Rentabilité détaillée (revenus vs coûts infra)
- Historique factures
- Boutons : Donner crédit, Suspendre, Marquer payé manuellement
Route : GET /api/v1/admin/companies/:id/profitability
```

### `frontend/src/pages/admin/AdminTickets.jsx`
Tous les tickets cross-clients + SLA tracking + assignment.

### `frontend/src/pages/admin/AdminVoices.jsx`
Catalogue `voice_library` éditable + bouton "Sync ElevenLabs".

### `frontend/src/pages/admin/AdminBilling.jsx`
- Factures (toutes) + bouton "Marquer payée" (mode manuel)
- Crédits accordés
- Stripe webhook events log

---

# 🔌 PHASE 10 — Intégrations réelles (Semaine 7-8)

## Tâche 10.1 — ElevenLabs (le plus simple, à faire en premier)
**Fichier .env :**
```bash
ELEVENLABS_API_KEY=xi-...
```
**Test :**
```bash
curl -X POST http://localhost:3000/api/v1/voice-library/<voice-id>/test \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"text":"Bonjour, ceci est un test"}' \
  --output test.mp3
open test.mp3
```

## Tâche 10.2 — Resend (emails transactionnels)
**Fichier .env :**
```bash
RESEND_API_KEY=re_...
```
1. Créer compte Resend
2. Vérifier domaine `voicedesk.ca` (DNS records)
3. Test : créer une nouvelle invitation → vérifier inbox

## Tâche 10.3 — Stripe (test mode)
1. Compte Stripe en mode test
2. Créer 5 produits (Solo, Démarrage, Essentiel, Pro, Entreprise)
3. Configurer **Stripe Tax** pour le Canada
4. Configurer webhook : `https://<ngrok>/webhooks/stripe`
5. **Fichier .env :**
```bash
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```
6. Test checkout complet avec carte test `4242 4242 4242 4242`

## Tâche 10.4 — Calendly v2
1. Compte Calendly + OAuth app
2. Configurer scopes + redirect URI
3. **Fichier .env :**
```bash
CALENDLY_CLIENT_ID=...
CALENDLY_CLIENT_SECRET=...
```
4. Connecter depuis ConfigIntegrations
5. Webhook `/webhooks/calendly` → sync RDV

## Tâche 10.5 — Twilio Voice Inbound (le plus critique)
1. Acheter un numéro Twilio (région Canada)
2. `ngrok http 8080` (expose voice/inbound)
3. Configurer le numéro :
   - Voice → A call comes in → Webhook → `https://<ngrok>/voice/inbound`
4. **Fichier .env :**
```bash
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1...
PUBLIC_DOMAIN=https://<ngrok>
```
5. **Appeler le numéro depuis ton téléphone → l'assistante doit répondre**

## Tâche 10.6 — Gmail Push (le plus complexe — peut être Phase 11)
Suivre : https://developers.google.com/gmail/api/guides/push
- Configurer Google Cloud Pub/Sub
- Subscriber au topic dans `webhooks/gmail-push`
- Tester avec email réel

---

# 🚀 PHASE 11 — Premier client + Production (Semaine 8)

## Tâche 11.1 — Tests E2E manuels
Parcours complet "Karim devient son propre premier client Exevori" :

1. Karim s'envoie une invitation à `karim@exevori.com`
2. Reçoit l'email (Resend prod), clique le lien
3. Crée son mot de passe
4. Onboarding 4 étapes :
   - Assistante "Léa", voix Charlotte FR-CA
   - Services : réception + RDV
   - Connaissances : services Exevori
5. Configure son renvoi *72 vers le numéro Twilio
6. Reçoit un appel test → IA répond
7. Envoie un email test → IA prépare un brouillon
8. Valide le brouillon → email envoyé
9. Consulte son dashboard → tout est tracé

## Tâche 11.2 — Déploiement Backend Fly.io Montréal
```bash
cd backend
fly launch --name voicedesk-backend --region yul
fly secrets set $(cat ../.env | xargs)
fly deploy
```

## Tâche 11.3 — Déploiement Frontend Vercel
```bash
cd frontend
vercel --prod
# Configurer les vars VITE_* dans le dashboard Vercel
```

## Tâche 11.4 — Déploiement Voice Servers Fly.io
```bash
cd backend
fly launch --name voicedesk-voice-inbound --region yul --config voice-inbound.toml
fly launch --name voicedesk-voice-outbound --region yul --config voice-outbound.toml
```

## Tâche 11.5 — Reconfigurer Twilio en production
- URL webhook : `https://voicedesk-voice-inbound.fly.dev/voice/inbound`
- Status callbacks : `https://voicedesk-backend.fly.dev/webhooks/twilio/status`

## Tâche 11.6 — Monitoring
- Sentry pour erreurs frontend + backend
- UptimeRobot pour healthchecks `/health`
- Stripe Dashboard pour paiements
- Slack webhook pour alertes critiques

---

# 📋 Checklist finale (à valider avant de livrer le premier client)

```
BACKEND
☐ /health répond
☐ Auth + invitations fonctionnent
☐ Webhook Stripe signé et vérifié
☐ AI Gateway opérationnel
☐ Voice inbound testé avec vrai numéro
☐ Voice outbound testé avec mission test

FRONTEND
☐ Login + Layout responsive
☐ Dashboard PME ≥90% de l'image cible
☐ CRM + Import CSV
☐ Calls + Emails + Calendar + Knowledge
☐ Onboarding wizard 4 étapes
☐ Config + sélecteur voix avec preview audio
☐ Billing Stripe multi-devise
☐ 6 pages admin Exevori
☐ Notifications cloche + emails
☐ i18n FR/EN testé partout
☐ Mobile responsive

INTÉGRATIONS
☐ ElevenLabs production
☐ Resend production (domaine vérifié)
☐ Stripe production avec produits créés
☐ Calendly OAuth
☐ Twilio production
☐ Gmail Push (optionnel V1)

PRODUCTION
☐ Backend déployé Fly.io Montréal
☐ Frontend déployé Vercel
☐ Voice servers déployés
☐ Domain voicedesk.ca + SSL
☐ Sentry + UptimeRobot configurés
☐ Karim onboardé comme premier client
☐ Premier paiement Stripe traité
```

---

# 🆘 Si tu es bloqué

| Erreur | Solution |
|--------|----------|
| `Cannot find module 'X'` | `npm run install:all` |
| `401 Unauthorized` API | Vérifier `Authorization: Bearer <token>` |
| `Vite import error` | Vérifier l'alias `@/` dans vite.config.js |
| `Tailwind classes don't work` | Vérifier `tailwind.config.js` content paths |
| `Supabase RLS error` | Re-run la migration concernée |
| `Stripe webhook signature fail` | Vérifier `STRIPE_WEBHOOK_SECRET` dans `.env` |
| `Twilio webhook 404` | Re-générer le tunnel ngrok et reconfigurer |

**Pour toute autre question : ouvre les docs `docs/` ou demande-moi.**

---

**Fin de la feuille de travail. Bonne construction. 🚀**

Karim — Exevori (Lévis, Québec)
