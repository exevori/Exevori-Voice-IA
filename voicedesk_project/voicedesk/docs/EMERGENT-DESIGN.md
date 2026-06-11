# 🎨 EMERGENT-DESIGN — Spécification interface ultra premium

> **Document de référence visuelle pour Emergent.sh.**
> L'objectif : reproduire le plus fidèlement possible le dashboard de référence
> (image `design-reference/dashboard-reference.png` + prototype `design-reference/DashboardPrototype.jsx`).

---

## 🧱 Briques GitHub à utiliser (validées)

### 1. shadcn/ui — Base des composants
```bash
npx shadcn@latest init
```
- **Repo** : https://github.com/shadcn-ui/ui
- **Usage** : Tous les composants de base (Button, Card, Dialog, Tabs, Dropdown, Tooltip, Sheet)
- **Philosophy** : Copy-paste, on possède le code

### 2. satnaing/shadcn-admin — Structure dashboard
- **Repo** : https://github.com/satnaing/shadcn-admin
- **Usage** : Layout sidebar collapsible + Cmd+K search + structure des pages
- **À copier** : `AppSidebar`, `Header`, le routing TanStack/React-Router pattern

### 3. Tremor — Charts et KPI
```bash
npm install @tremor/react
```
- **Repo** : https://github.com/tremorlabs/tremor
- **Usage** : SparkAreaChart (mini-graphiques dans les KPI cards), AreaChart, DonutChart, ProgressBar
- **Alternative** : Recharts (déjà dans le projet) fonctionne aussi

### 4. Aceternity UI — Effets premium dark
- **Site** : https://ui.aceternity.com/components
- **Usage** : Esthétique Linear/Cursor dark premium
- **Composants à copier** :
  - `Glowing Effect` (bordure lumineuse au hover des cards — comme Cursor)
  - `Card Spotlight` (effet spotlight sur les cards importantes)
  - `Background Gradient` (gradient animé pour la carte Assistant Profile)
  - `Sparkles` (effet sur les éléments AI actifs)

### 5. Lucide React — Icônes (déjà installé)
- Cohérence avec les icônes du prototype

---

## 🎨 Design System (extrait de l'image de référence)

### Palette de couleurs

```css
:root {
  /* ── Backgrounds ── */
  --bg-primary:    #080C18;     /* Fond principal très sombre bleu-noir */
  --bg-sidebar:    #0C1020;     /* Sidebar légèrement plus claire */
  --bg-card:       #111827;     /* Cards */
  --bg-card-hover: #161E2E;     /* Cards au hover */
  --bg-input:      #0A0F1C;     /* Inputs */

  /* ── Borders ── */
  --border:        rgba(255,255,255,0.07);   /* Bordure subtile */
  --border-strong: rgba(255,255,255,0.14);   /* Bordure accentuée */
  --border-glow:   rgba(59,130,246,0.35);    /* Bordure glow bleue */

  /* ── Couleurs d'accent ── */
  --primary:   #3B82F6;   /* Bleu principal */
  --cyan:      #06B6D4;   /* Cyan (emails) */
  --purple:    #8B5CF6;   /* Violet (RDV) */
  --pink:      #EC4899;   /* Rose (leads) */
  --green:     #10B981;   /* Vert (succès, en ligne, live) */
  --yellow:    #F59E0B;   /* Orange (attention, pending) */
  --red:       #EF4444;   /* Rouge (urgent, hot lead) */

  /* ── Dim variants (fonds de badges) ── */
  --primary-dim: rgba(59,130,246,0.15);
  --green-dim:   rgba(16,185,129,0.15);
  --yellow-dim:  rgba(245,158,11,0.15);
  --red-dim:     rgba(239,68,68,0.15);

  /* ── Texte ── */
  --text-primary:   #F1F5F9;   /* Blanc cassé */
  --text-secondary: #94A3B8;   /* Gris clair */
  --text-tertiary:  #64748B;   /* Gris sourd */

  /* ── Effets ── */
  --glow-blue:  0 0 24px rgba(59,130,246,0.25);
  --glow-green: 0 0 8px rgba(16,185,129,0.6);
  --gradient-brand: linear-gradient(135deg, #3B82F6, #8B5CF6);
}
```

### Typographie

```css
font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;

/* Titres de page    */ font-size: 18px; font-weight: 700;
/* Titres de cards   */ font-size: 14-15px; font-weight: 600;
/* Valeurs KPI       */ font-size: 26-28px; font-weight: 700;
/* Texte normal      */ font-size: 13px;
/* Texte secondaire  */ font-size: 11-12px;
/* Micro-labels      */ font-size: 10px;
```

### Espacements et rayons

```css
/* Cards          */ border-radius: 12px; padding: 16-20px;
/* Badges/pills   */ border-radius: 20px; padding: 2px 8px;
/* Boutons        */ border-radius: 8px;
/* Avatars        */ border-radius: 50%;
/* Gaps grilles   */ gap: 12px;
```

---

## 📐 ANATOMIE DE L'ÉCRAN DASHBOARD (image de référence)

### Layout global

```
┌──────────┬──────────────────────────────────────────────────────┐
│          │  TOP BAR (56-64px) : titre + statut IA + cloche + user│
│ SIDEBAR  ├──────────────────────────────────────────────────────┤
│ (220-    │  RANGÉE 1 : 4 KPI cards + Assistant Profile (à droite)│
│  240px)  ├──────────────────────────────────────────────────────┤
│          │  RANGÉE 2 : Live Calls │ Appointments │ Emails │ CRM  │
│ fixe,    ├──────────────────────────────────────────────────────┤
│ sombre   │  RANGÉE 3 : Business Memory │ Suggestions │ Analytics │
└──────────┴──────────────────────────────────────────────────────┘
```

### 1. SIDEBAR (gauche, fixe)

```
Éléments de haut en bas :
┌────────────────────────┐
│ ❖ Logo (gradient bleu) │  ← Logo "X" dans carré gradient + nom
├────────────────────────┤
│ ● Dashboard      ←actif│  ← Item actif : fond bleu dim + bordure
│ ☎ Calls         [3]    │     gauche bleue 3px + texte bleu
│ ✉ Emails        [17]   │  ← Badges rouges pour les compteurs
│ ▦ Appointments         │
│ ◉ CRM                  │
│ ▤ Knowledge Base       │
│ ◈ Business Memory      │
│ ✦ Learning Sugg. [5]   │
│ ▣ Analytics            │
│ ⚙ Settings             │
├────────────────────────┤
│ AI Usage Today         │  ← Carte usage en bas
│ 78% ▓▓▓▓▓▓▓░░          │     avec barre de progression
│ of daily limit         │
└────────────────────────┘
```

**Détails techniques :**
- Largeur : 220-240px, fond `--bg-sidebar`
- Items : 36-40px de haut, icône 16-18px + label 12-13px
- Item actif : `background: var(--primary-dim)` + `border-left: 3px solid var(--primary)`
- Badges : pilule rouge dim avec compteur

### 2. TOP BAR

```
┌─────────────────────────────────────────────────────────────────┐
│ Exevori VoiceDesk AI          ● AI Assistant   ↀ waveform  🔔³ 👤│
│ AI Receptionist Platform        Online                           │
└─────────────────────────────────────────────────────────────────┘
```

- Titre + sous-titre à gauche
- **Indicateur "AI Assistant Online"** : dot vert avec glow (`box-shadow: var(--glow-green)`)
- **Mini waveform animée** (audio bars qui bougent) — utiliser CSS animation ou SVG animé
- Cloche notifications avec badge rouge compteur
- Avatar utilisateur + nom + chevron

### 3. KPI CARDS (rangée 1) — LE PLUS IMPORTANT

Chaque carte contient :

```
┌──────────────────────────────┐
│ ◉ icon    Calls Today        │  ← Icône dans carré coloré dim
│           128                │  ← Grande valeur 28px bold
│ ↑ 18% vs yesterday  ∿∿∿∿     │  ← Trend vert + SPARKLINE
└──────────────────────────────┘
```

**Les 4 KPI de l'image :**
| KPI | Icône | Couleur | Sparkline |
|-----|-------|---------|-----------|
| Calls Today (128) | Phone | Bleu | Mini area chart bleue |
| Appointments Booked (24) | Calendar | Violet | Mini area chart violette |
| Emails Processed (342) | Mail | Cyan | Mini area chart cyan |
| New Leads (19) | Users | Rose | Mini area chart rose |

**Implémentation sparkline avec Tremor :**
```jsx
import { SparkAreaChart } from "@tremor/react";

<SparkAreaChart
  data={last7days}
  categories={["value"]}
  index="day"
  colors={["blue"]}
  className="h-8 w-20"
/>
```

Ou avec Recharts (déjà installé) :
```jsx
<ResponsiveContainer width={80} height={32}>
  <AreaChart data={trend}>
    <Area type="monotone" dataKey="v" stroke="#3B82F6"
          fill="url(#sparkGradient)" strokeWidth={2} />
  </AreaChart>
</ResponsiveContainer>
```

### 4. ASSISTANT PROFILE CARD (à droite) — SIGNATURE VISUELLE

C'est LA carte qui donne le caractère premium :

```
┌─────────────────────────────┐
│ Assistant Profile      Edit │
│                             │
│      ╭─────────╮            │  ← AVATAR avec anneau gradient
│      │ avatar  │            │     bleu→violet ANIMÉ (rotation)
│      ╰─────────╯            │
│   Assistant Name            │
│   [Léa            ✎]        │  ← Nom DYNAMIQUE (config.assistant_name)
│                             │
│   Voice  [Nova (Naturelle)▾]│  ← Dropdowns sombres
│   Tone   [Professional ▾]   │
│                             │
│   Greeting Message          │
│   ┌─────────────────────┐   │
│   │ "Bonjour, je suis…" │   │  ← Encadré avec player audio
│   │ ▶ ∿∿∿∿∿∿∿∿∿∿        │   │     + waveform violette
│   └─────────────────────┘   │
└─────────────────────────────┘
```

**Avatar IA — 3 options par ordre de préférence :**
1. **Anneau gradient animé** autour d'un avatar (CSS `conic-gradient` + `@keyframes rotate`) — simple et premium
2. **Aceternity "Background Gradient"** component pour le conteneur
3. Image générée (femme professionnelle stylisée) en `/public/avatars/` — fournie par le client plus tard

```css
.avatar-ring {
  background: conic-gradient(from var(--angle), #3B82F6, #8B5CF6, #EC4899, #3B82F6);
  animation: rotate-ring 4s linear infinite;
  padding: 3px;
  border-radius: 50%;
}
```

⚠️ **RÈGLE ABSOLUE** : le nom affiché vient TOUJOURS de `config.assistant_name` — jamais hardcodé.

### 5. LIVE CALLS CARD

```
┌────────────────────────────────────┐
│ Live Calls  [3 Active]             │  ← Badge vert dim "3 Active"
│                                    │
│ ● Sarah Mitchell      In Progress  │  ← Dot vert PULSANT (animation)
│   +1 (555) 234-9876        02:15   │  ← Timer monospace
│   Intent: Book Appointment         │  ← Intent en cyan
│   Summary: Wants to schedule...    │
│ ─────────────────────────────────  │
│ ● David Thompson      In Progress  │
│ ◐ Mark Anderson       On Hold      │  ← Jaune si on hold
│                                    │
│ View All Calls →                   │
└────────────────────────────────────┘
```

**Dot pulsant (CSS) :**
```css
.live-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 6px var(--green);
  animation: pulse 2s ease-in-out infinite;
}
@keyframes pulse {
  50% { opacity: 0.5; transform: scale(0.85); }
}
```

### 6. UPCOMING APPOINTMENTS

```
┌──────────────────────────────────┐
│ Upcoming Appointments  View Cal →│
│                                  │
│ ┌────┐ 10:00 AM                  │  ← Bloc date bleu dim
│ │MAY │ Demo Call with Acme Corp  │     (mois + jour)
│ │ 19 │ Product Demo   [Confirmed]│  ← Badge statut vert
│ └────┘                           │
│ ┌────┐ 2:30 PM                   │
│ │MAY │ Consultation BrightPath   │
│ │ 19 │ Onboarding     [Confirmed]│
│ └────┘                           │
│ ┌────┐ 11:00 AM        [Pending] │  ← Badge jaune si pending
│ │MAY │ Review NovaTech           │
│ │ 20 │                           │
└──────────────────────────────────┘
```

### 7. EMAIL HANDLING

```
┌──────────────────────────────────┐
│ Email Handling      View Inbox → │
│                                  │
│ Ⓜ Alex Johnson          9:15 AM  │  ← Avatar/initiale coloré
│   Request for Proposal           │
│   Hi, can you send over the...   │
│ ─────────────────────────────────│
│ Ⓟ Partnerships Team     8:42 AM  │
│ ⓘ info@globex.com       7:31 AM  │
│                                  │
│ ✎ Draft Reply              [3] → │  ← Footer bouton brouillons
└──────────────────────────────────┘
```

### 8. CRM / LEADS

```
┌──────────────────────────────────┐
│ CRM / Leads          View All →  │
│                                  │
│ Ⓐ Acme Corporation   [Hot Lead] │  ← Badge ROUGE "Hot Lead"
│   Interested in Demo             │
│ Ⓖ Global Innov.     [Warm Lead] │  ← Badge JAUNE
│ Ⓝ NovaTech          [Customer]  │  ← Badge VERT
└──────────────────────────────────┘
```

### 9. BUSINESS MEMORY

```
┌──────────────────────────────────┐
│ Business Memory       View All → │
│ Ava learns and remembers key     │  ← "Ava" = config.assistant_name !
│ information about your business. │
│                                  │
│ ┌────────┐  ┌────────┐           │  ← Grille 2x2 de tuiles
│ │ ⚙ 24   │  │ ❓ 18  │           │     icône + count + label
│ │Services│  │  FAQs  │           │
│ └────────┘  └────────┘           │
│ ┌────────┐  ┌────────┐           │
│ │ $ 7    │  │ ⚐ 12   │           │
│ │Pricing │  │Procedur│           │
│ └────────┘  └────────┘           │
└──────────────────────────────────┘
```

### 10. LEARNING SUGGESTIONS

```
┌──────────────────────────────────┐
│ Learning Suggestions   [5 New]   │  ← Badge bleu compteur
│                                  │
│ New service: AI Voice Integr.    │
│ Source: Website     ✓  ✎  ✗     │  ← 3 boutons : approve (vert),
│ ─────────────────────────────────│     edit (bleu), reject (rouge)
│ Updated pricing for Enterprise   │
│ Source: Pricing Page ✓  ✎  ✗    │
│                                  │
│ View All Suggestions →           │
└──────────────────────────────────┘
```

### 11. ANALYTICS OVERVIEW

```
┌────────────────────────────────────────────────┐
│ Analytics Overview              View Reports → │
│                                                │
│ Total Interactions    Interactions by Type     │
│ 2,846                                          │
│ ↑21% vs last 7 days       ╭────╮               │
│                           │2846│  ● Calls 45%  │
│ ∿∿∿∿∿∿∿∿∿ (area chart)    │Total│ ● Emails 25% │
│ May 13 ... May 19         ╰────╯  ● Appts 15%  │
│                          (donut)  ● Others 15% │
└────────────────────────────────────────────────┘
```

- **Area chart** : Recharts AreaChart avec gradient fill + points
- **Donut chart** : Recharts PieChart avec `innerRadius` + total au centre

---

## 🧬 PROTOTYPE FOURNI

Le fichier **`design-reference/DashboardPrototype.jsx`** contient un prototype React fonctionnel complet du dashboard avec :

- Les 11 pages navigables
- Toutes les couleurs exactes du design system
- Les composants StatusBadge, ConfidenceDot, StatCard, SectionTitle
- Les graphiques Recharts configurés (AreaChart, PieChart)
- La simulation d'appel avec API IA

**⚠️ Ce prototype est une RÉFÉRENCE DE STYLE, pas du code de production.**
Emergent doit :
1. S'inspirer des styles inline pour créer des classes Tailwind/CSS propres
2. Remplacer les mock data par les vraies routes API (docs/EMERGENT-REFERENCE.md)
3. Décomposer en composants réutilisables
4. Garder le même rendu visuel final

---

## ✨ NIVEAU DE FINITION ATTENDU (premium)

### Micro-interactions obligatoires

```
☐ Hover sur cards : élévation subtile + bordure plus visible
  transition: all 0.2s ease;
  hover → border-color: var(--border-strong); transform: translateY(-1px);

☐ Dots "live" pulsants (appels en cours, statut en ligne)

☐ Sparklines animées au chargement (animation d'entrée gauche→droite)

☐ Skeleton loaders sur toutes les données async (pas de page blanche)

☐ Transitions de page douces (fade/slide léger, framer-motion)

☐ Badge compteurs avec animation "pop" quand le nombre change

☐ Waveform audio animée (top bar + greeting player)

☐ Avatar IA avec anneau gradient rotatif
```

### Effets Aceternity à intégrer (sélectifs, pas partout)

```
☐ "Glowing Effect" sur la carte Assistant Profile (bordure réactive souris)
☐ "Card Spotlight" sur les KPI cards au hover
☐ "Background Gradient" animé derrière l'avatar IA
```

### Ce qu'il NE faut PAS faire

```
✗ Pas de fond blanc / mode clair (V1 = dark only)
✗ Pas d'animations lourdes qui ralentissent (60fps minimum)
✗ Pas de glassmorphism excessif (subtil seulement)
✗ Pas de couleurs hors palette
✗ Pas de "Léa" ou "Ava" hardcodé — TOUJOURS config.assistant_name
✗ Pas d'ombres portées noires lourdes (préférer les glows colorés subtils)
```

---

## 📱 Responsive

```
Desktop (>1280px)  : Layout complet 3-4 colonnes comme l'image
Laptop (1024-1280) : KPI sur 2 rangées, cards sur 2 colonnes
Tablet (768-1024)  : Sidebar collapsible (icônes seules), 2 colonnes
Mobile (<768px)    : Sidebar en drawer, tout en 1 colonne, KPI 2x2
```

---

## 🌍 i18n — Rappel

Tous les textes de l'interface utilisent `t("...")`. L'image de référence est en anglais mais l'interface est **FR par défaut** :

| Image (EN) | Interface FR |
|------------|--------------|
| Calls Today | Appels aujourd'hui |
| Appointments Booked | Rendez-vous pris |
| Emails Processed | Courriels traités |
| New Leads | Nouveaux prospects |
| Live Calls | Appels en direct |
| Business Memory | Mémoire d'entreprise |
| Learning Suggestions | Suggestions d'apprentissage |
| AI Usage Today | Utilisation IA aujourd'hui |

Les clés existent déjà dans `frontend/src/i18n/locales/fr.json` et `en.json`.

---

## 🎯 Ordre de construction recommandé

```
1. Installer les briques : shadcn/ui + Tremor + framer-motion
2. Copier le design system CSS (variables ci-dessus) dans global.css
3. Construire la Sidebar (depuis shadcn-admin comme base)
4. Construire la TopBar avec indicateur IA + waveform
5. Construire le composant KpiCard avec sparkline (Tremor)
6. Construire AssistantProfileCard (la carte signature)
7. Construire les 6 autres cards du dashboard
8. Assembler le Dashboard complet
9. Comparer côte à côte avec l'image de référence
10. Itérer jusqu'à correspondance visuelle ≥ 90%
```

**Critère de succès : un utilisateur qui voit l'image de référence puis l'app ne doit pas voir de différence de qualité.**


---

## 🏷️ LOGO EXEVORI VOICE IA — usage obligatoire

Le branding du produit utilise le logo **Exevori Voice IA** :

```
design-reference/branding/
├── exevori-logo.png              ← Le E 3D isolé (à utiliser dans la sidebar)
├── exevori-voice-ia-target.png   ← Le rendu final souhaité (logo + texte)
└── exevori-agency-header.png     ← Référence header agence (contexte)

frontend/public/branding/
├── exevori-logo.png              ← Disponible via /branding/exevori-logo.png
└── exevori-voice-ia-full.png     ← Logo complet pour landing/marketing
```

### Où afficher le logo

| Endroit | Variant | Taille |
|---------|---------|--------|
| Sidebar (haut) | Logo E 3D + "EXEVORI" / "VOICE IA" en dessous | 40×40px |
| Login page | Logo complet (image full) | 280px largeur |
| Email transactionnel | Logo E 3D + texte | 60px |
| Favicon | Logo E 3D | 32×32 |

### Implémentation sidebar (déjà fournie)

```jsx
<div className="sidebar-brand">
  <img
    src="/branding/exevori-logo.png"
    alt="Exevori"
    className="brand-logo-img"
  />
  <div>
    <div className="brand-title">EXEVORI</div>
    <div className="brand-subtitle">VOICE IA</div>
  </div>
</div>
```

CSS associé (dans `frontend/src/styles/global.css`) :

```css
.brand-logo-img {
  width: 40px;
  height: 40px;
  object-fit: contain;
  filter: drop-shadow(0 0 8px rgba(139, 92, 246, 0.4));
}

.brand-title {
  background: linear-gradient(135deg, #ffffff, #b794f6);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  font-weight: 700;
  letter-spacing: 0.05em;
}

.brand-subtitle {
  color: var(--text-tertiary);
  font-size: 10px;
  letter-spacing: 0.15em;
}
```

### ⚠️ Règles obligatoires

```
✓ TOUJOURS utiliser le logo officiel (pas de redessin)
✓ TOUJOURS afficher "EXEVORI" en gradient blanc→violet
✓ TOUJOURS "VOICE IA" en sous-titre légèrement espacé
✓ TOUJOURS un glow violet subtil derrière le logo (drop-shadow)

✗ JAMAIS de fond blanc derrière le logo
✗ JAMAIS de logo "VoiceDesk" — le produit s'appelle Exevori Voice IA
✗ JAMAIS modifier les couleurs du logo (bleu→violet gradient propriétaire)
```

### Référence visuelle finale

Le rendu attendu est dans `design-reference/branding/exevori-voice-ia-target.png` :
- Logo E 3D à gauche (bleu→violet gradient avec circuits électroniques)
- "EXEVORI" en grand, blanc/argenté avec léger gradient
- "VOICE IA" en sous-titre, plus petit, avec lignes décoratives de part et d'autre

Pour reproduire dans le frontend, le composant Layout.jsx est déjà configuré avec
le logo E 3D + texte "EXEVORI" / "VOICE IA". Si besoin du logo complet (login,
emails, marketing), utiliser directement `/branding/exevori-voice-ia-full.png`.
