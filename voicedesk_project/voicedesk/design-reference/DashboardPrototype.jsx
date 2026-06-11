// ============================================================
// EXEVORI VOICEDESK AI — Dashboard V0
// MODULE  : Dashboard principal complet
// VERSION : 1.0.0
// ============================================================

import { useState, useRef, useEffect } from "react";
import {
  LayoutDashboard, Phone, Mail, Calendar, Users, BookOpen,
  Brain, Lightbulb, BarChart2, Settings, Bell, Check, X,
  Clock, AlertCircle, Search, Plus, MessageSquare, Send,
  TrendingUp, ChevronRight, Database, Key, Globe, Filter,
  CheckCircle, XCircle, RefreshCw, FileText, Shield, Bot,
  User, Star, Mic, PhoneOff, PhoneIncoming, Volume2, Zap,
  Edit3, Trash2, Copy, ExternalLink, Activity, Info, ChevronDown,
  MoreHorizontal, ArrowUpRight, Wifi, WifiOff, Eye, Archive
} from "lucide-react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, CartesianGrid
} from "recharts";

// --- STYLES CONSTANTS ---
const C = {
  bg: "#080C18",
  sidebar: "#0C1020",
  card: "#111827",
  cardHover: "#161E2E",
  border: "rgba(255,255,255,0.07)",
  borderStrong: "rgba(255,255,255,0.14)",
  primary: "#3B82F6",
  primaryDim: "rgba(59,130,246,0.15)",
  cyan: "#06B6D4",
  cyanDim: "rgba(6,182,212,0.15)",
  purple: "#8B5CF6",
  purpleDim: "rgba(139,92,246,0.15)",
  pink: "#EC4899",
  pinkDim: "rgba(236,72,153,0.15)",
  green: "#10B981",
  greenDim: "rgba(16,185,129,0.15)",
  yellow: "#F59E0B",
  yellowDim: "rgba(245,158,11,0.15)",
  red: "#EF4444",
  redDim: "rgba(239,68,68,0.15)",
  textPrimary: "#F1F5F9",
  textSecondary: "#94A3B8",
  textTertiary: "#64748B",
};

const card = {
  background: C.card,
  border: `1px solid ${C.border}`,
  borderRadius: 12,
  padding: "16px 20px",
};

// --- MOCK DATA ---
const CONFIG = {
  org: { name: "Exevori", location: "Lévis, Québec", sector: "IA & SaaS" },
  assistant: {
    name: "Léa",
    voice: "Nova (Naturelle)",
    language: "Français (CA)",
    tone: "Professionnel & Chaleureux",
    greeting: "Bonjour, je suis Léa de chez Exevori. Que puis-je faire pour vous aujourd'hui ?",
    confidence_threshold: 80,
    autonomy: "Élevé",
    status: "online"
  }
};

const ANALYTICS = [
  { day: "13/05", appels: 95, courriels: 280, rdv: 18 },
  { day: "14/05", appels: 110, courriels: 295, rdv: 21 },
  { day: "15/05", appels: 102, courriels: 310, rdv: 19 },
  { day: "16/05", appels: 88, courriels: 268, rdv: 16 },
  { day: "17/05", appels: 120, courriels: 320, rdv: 22 },
  { day: "18/05", appels: 115, courriels: 335, rdv: 20 },
  { day: "19/05", appels: 128, courriels: 342, rdv: 24 },
];

const PIE_DATA = [
  { name: "Appels", value: 45, color: C.primary },
  { name: "Courriels", value: 25, color: C.cyan },
  { name: "Rendez-vous", value: 15, color: C.purple },
  { name: "Autres", value: 15, color: C.pink },
];

const LIVE_CALLS = [
  { id: 1, name: "Sarah Mitchell", phone: "+1 (555) 234-9876", status: "in_progress", duration: "02:15", intent: "Demande de rendez-vous", summary: "Souhaite planifier une démo onboarding.", company: "TechCorp Inc.", confidence: 94 },
  { id: 2, name: "David Thompson", phone: "+1 (555) 876-5432", status: "in_progress", duration: "01:47", intent: "Demande de prix", summary: "Intéressé par le plan entreprise et modules additionnels.", company: "BrightPath", confidence: 78 },
  { id: 3, name: "Mark Anderson", phone: "+1 (555) 345-6789", status: "on_hold", duration: "00:45", intent: "Support technique", summary: "Problème de connexion au tableau de bord.", company: "GlobalTech", confidence: 61 },
];

const RECENT_CALLS = [
  { id: 4, name: "Marie Tremblay", time: "14:32", intent: "Rendez-vous", status: "completed", confidence: 94 },
  { id: 5, name: "Pierre Gagnon", time: "13:55", intent: "Information", status: "transferred", confidence: 62 },
  { id: 6, name: "Lisa Chen", time: "13:21", intent: "Prix", status: "draft_created", confidence: 78 },
  { id: 7, name: "Jean Fortin", time: "12:47", intent: "Annulation RDV", status: "completed", confidence: 96 },
  { id: 8, name: "Sophie Lavoie", time: "12:10", intent: "Info services", status: "completed", confidence: 89 },
];

const EMAILS_DATA = [
  { id: 1, from: "alex.johnson@acmecorp.com", name: "Alex Johnson", company: "Acme Corporation", subject: "Demande de proposition commerciale", preview: "Bonjour, nous aimerions recevoir une proposition détaillée pour vos services d'automatisation IA...", time: "09:15", status: "draft_pending", level: 2, confidence: 76 },
  { id: 2, from: "partnerships@brightpath.com", name: "Équipe Partnerships", company: "BrightPath Consulting", subject: "Opportunité de partenariat stratégique", preview: "Nous aimerions explorer une collaboration potentielle avec votre équipe...", time: "08:42", status: "acknowledged", level: 1, confidence: 91 },
  { id: 3, from: "info@globex.com", name: "Support Globex", company: "Globex.com", subject: "Demande de support urgente", preview: "J'ai de la difficulté à accéder à mon compte depuis hier soir...", time: "07:31", status: "draft_pending", level: 2, confidence: 55 },
  { id: 4, from: "nova@techsolutions.ca", name: "Pierre Bernard", company: "NovaTech Solutions", subject: "Suivi devis agent IA", preview: "Suite à notre conversation téléphonique, je vous envoie les informations demandées...", time: "07:05", status: "replied", level: 2, confidence: 88 },
  { id: 5, from: "lisa.wang@synapse.io", name: "Lisa Wang", company: "Synapse Digital", subject: "Intérêt pour SaaS personnalisé", preview: "Bonjour, nous développons actuellement notre plateforme interne et cherchons un partenaire...", time: "06:30", status: "acknowledged", level: 1, confidence: 83 },
];

const APPOINTMENTS = [
  { id: 1, client: "Acme Corporation", contact: "Sarah Mitchell", date: "Mai 19", time: "10:00", type: "Démo produit", status: "confirmed", channel: "Google Meet" },
  { id: 2, client: "BrightPath Consulting", contact: "Marie-Claire Dubois", date: "Mai 19", time: "14:30", type: "Consultation initiale", status: "confirmed", channel: "Téléphone" },
  { id: 3, client: "NovaTech Solutions", contact: "Pierre Bernard", date: "Mai 20", time: "11:00", type: "Revue de solution", status: "pending", channel: "Zoom" },
  { id: 4, client: "Global Innovations", contact: "Thomas Lefebvre", date: "Mai 21", time: "09:30", type: "Rendez-vous initial", status: "confirmed", channel: "En personne" },
  { id: 5, client: "Synapse Digital", contact: "Lisa Wang", date: "Mai 22", time: "15:00", type: "Présentation SaaS", status: "pending", channel: "Google Meet" },
];

const LEADS_DATA = [
  { id: 1, name: "Acme Corporation", contact: "Sarah M.", status: "qualified", sector: "Tech", need: "Agent IA + Automatisation", urgency: "high", source: "call", budget: "5 000–10 000$/mois" },
  { id: 2, name: "Global Innovations", contact: "T. Lefebvre", status: "hot_lead", sector: "Finance", need: "SaaS PME + CRM", urgency: "high", source: "email", budget: "3 000–5 000$/mois" },
  { id: 3, name: "BrightPath Consulting", contact: "Marie-Claire D.", status: "appointment_set", sector: "Conseil", need: "Automatisation IA", urgency: "medium", source: "call", budget: "2 000–4 000$/mois" },
  { id: 4, name: "NovaTech Solutions", contact: "P. Bernard", status: "new", sector: "Manufacturier", need: "Site web + Agent IA", urgency: "low", source: "form", budget: "1 500–3 000$/mois" },
  { id: 5, name: "Synapse Digital", contact: "L. Wang", status: "callback_required", sector: "Marketing", need: "Agent courriel + Social", urgency: "medium", source: "email", budget: "2 500–4 500$/mois" },
];

const INIT_SUGGESTIONS = [
  { id: 1, type: "question_frequente", question: "Quels sont vos délais habituels pour livrer un site web ?", answer: "Nos délais habituels varient entre 3 et 8 semaines selon la complexité du projet.", source: "3 appels récents", confidence: 92, detected_from: "calls", status: "pending" },
  { id: 2, type: "info_service", question: "Est-ce qu'Exevori offre de la maintenance après livraison ?", answer: "Oui, nous offrons des forfaits de maintenance mensuelle incluant mises à jour, support et hébergement.", source: "Site web + 2 appels", confidence: 88, detected_from: "website", status: "pending" },
  { id: 3, type: "prix", question: "Quel est le prix d'un agent IA de base ?", answer: "Nos agents IA démarrent à partir de 497 $/mois selon les fonctionnalités requises.", source: "2 courriels", confidence: 74, detected_from: "emails", status: "pending" },
  { id: 4, type: "question_frequente", question: "Est-ce qu'Exevori travaille avec des clients hors Québec ?", answer: "Oui, nous acceptons des clients partout au Canada et aux États-Unis. La majorité de nos projets sont réalisés à distance.", source: "4 interactions clients", confidence: 96, detected_from: "calls", status: "pending" },
];

const KNOWLEDGE_BASE = [
  { id: 1, category: "Services", title: "Sites web sur mesure", content: "Développement de sites web professionnels, responsive, optimisés SEO. Délais 3–8 semaines.", status: "active", updated: "Mai 15" },
  { id: 2, category: "Services", title: "Applications web & SaaS", content: "Développement d'applications SaaS, outils internes, dashboards. Sur devis selon complexité.", status: "active", updated: "Mai 10" },
  { id: 3, category: "Services", title: "Agents IA personnalisés", content: "Agents IA pour courriel, téléphone, rendez-vous, réseaux sociaux. À partir de 497 $/mois.", status: "active", updated: "Mai 18" },
  { id: 4, category: "Services", title: "Automatisation IA", content: "Automatisation de processus internes avec n8n, Zapier ou solutions personnalisées.", status: "active", updated: "Mai 12" },
  { id: 5, category: "FAQ", title: "Délais de livraison", content: "Sites web: 3–8 semaines. Applications: 6–16 semaines. Agents IA: 1–2 semaines de configuration.", status: "active", updated: "Mai 8" },
  { id: 6, category: "Politique", title: "Zones desservies", content: "Québec et Canada principalement. Clients à distance acceptés partout au Canada et aux États-Unis.", status: "active", updated: "Avr 30" },
  { id: 7, category: "Tarification", title: "Forfaits de maintenance", content: "Forfait de base: 199 $/mois. Forfait professionnel: 399 $/mois. Forfait entreprise: sur devis.", status: "active", updated: "Mai 5" },
];

const MEMORY_STATS = {
  static: { count: 24, label: "Mémoire statique", color: C.primary, items: ["Services", "Tarification", "Zones", "Horaires"] },
  conversational: { count: 18, label: "Mémoire conversationnelle", color: C.cyan, items: ["Questions fréquentes", "Objections", "Formulations"] },
  commercial: { count: 12, label: "Mémoire commerciale", color: C.purple, items: ["Arguments efficaces", "Offres populaires", "Profils"] },
  operational: { count: 9, label: "Mémoire opérationnelle", color: C.yellow, items: ["Règles RDV", "Procédures", "Escalades"] },
};

// --- HELPER COMPONENTS ---

const StatusBadge = ({ status, small }) => {
  const map = {
    in_progress: { label: "En cours", bg: "rgba(16,185,129,0.15)", color: "#10B981" },
    on_hold: { label: "En attente", bg: "rgba(245,158,11,0.15)", color: "#F59E0B" },
    completed: { label: "Terminé", bg: "rgba(100,116,139,0.15)", color: "#94A3B8" },
    transferred: { label: "Transféré", bg: "rgba(245,158,11,0.15)", color: "#F59E0B" },
    draft_created: { label: "Brouillon", bg: "rgba(59,130,246,0.15)", color: "#3B82F6" },
    draft_pending: { label: "Brouillon ⏳", bg: "rgba(245,158,11,0.15)", color: "#F59E0B" },
    acknowledged: { label: "Accusé ✓", bg: "rgba(16,185,129,0.15)", color: "#10B981" },
    replied: { label: "Répondu", bg: "rgba(16,185,129,0.15)", color: "#10B981" },
    confirmed: { label: "Confirmé", bg: "rgba(16,185,129,0.15)", color: "#10B981" },
    pending: { label: "En attente", bg: "rgba(245,158,11,0.15)", color: "#F59E0B" },
    qualified: { label: "Qualifié", bg: "rgba(59,130,246,0.15)", color: "#3B82F6" },
    hot_lead: { label: "Hot Lead 🔥", bg: "rgba(239,68,68,0.15)", color: "#EF4444" },
    appointment_set: { label: "RDV pris", bg: "rgba(139,92,246,0.15)", color: "#8B5CF6" },
    new: { label: "Nouveau", bg: "rgba(100,116,139,0.15)", color: "#94A3B8" },
    callback_required: { label: "À rappeler", bg: "rgba(245,158,11,0.15)", color: "#F59E0B" },
    active: { label: "Actif", bg: "rgba(16,185,129,0.15)", color: "#10B981" },
    pending_suggestion: { label: "En révision", bg: "rgba(245,158,11,0.15)", color: "#F59E0B" },
    approved: { label: "Approuvé ✓", bg: "rgba(16,185,129,0.15)", color: "#10B981" },
    rejected: { label: "Refusé", bg: "rgba(239,68,68,0.15)", color: "#EF4444" },
  };
  const cfg = map[status] || { label: status, bg: "rgba(100,116,139,0.15)", color: "#94A3B8" };
  return (
    <span style={{
      padding: small ? "2px 8px" : "3px 10px",
      borderRadius: 20,
      fontSize: small ? 11 : 12,
      fontWeight: 500,
      background: cfg.bg,
      color: cfg.color,
      whiteSpace: "nowrap"
    }}>{cfg.label}</span>
  );
};

const ConfidenceDot = ({ score }) => {
  const color = score >= 90 ? C.green : score >= 70 ? C.yellow : score >= 50 ? "#F97316" : C.red;
  return (
    <span style={{ color, fontWeight: 700, fontSize: 13 }}>{score}%</span>
  );
};

const SectionTitle = ({ children, action, actionLabel }) => (
  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
    <h3 style={{ color: C.textPrimary, fontSize: 15, fontWeight: 600, margin: 0 }}>{children}</h3>
    {action && (
      <button onClick={action} style={{ background: "none", border: "none", color: C.primary, fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
        {actionLabel} <ChevronRight size={14} />
      </button>
    )}
  </div>
);

const StatCard = ({ label, value, change, icon: Icon, color, dimColor }) => (
  <div style={{ ...card, flex: 1, minWidth: 140 }}>
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
      <div>
        <div style={{ color: C.textSecondary, fontSize: 12, marginBottom: 8 }}>{label}</div>
        <div style={{ color: C.textPrimary, fontSize: 28, fontWeight: 700, lineHeight: 1 }}>{value}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 8 }}>
          <ArrowUpRight size={13} color={C.green} />
          <span style={{ color: C.green, fontSize: 12, fontWeight: 600 }}>+{change}%</span>
          <span style={{ color: C.textTertiary, fontSize: 11 }}>vs hier</span>
        </div>
      </div>
      <div style={{ width: 40, height: 40, borderRadius: 10, background: dimColor || "rgba(59,130,246,0.15)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Icon size={20} color={color || C.primary} />
      </div>
    </div>
  </div>
);

// --- PAGE: DASHBOARD ---
const DashboardPage = ({ setPage, suggestions, setSuggestions }) => {
  const pendingSuggestions = suggestions.filter(s => s.status === "pending");

  return (
    <div>
      {/* Stats Row */}
      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <StatCard label="Appels aujourd'hui" value="128" change={18} icon={Phone} color={C.primary} dimColor={C.primaryDim} />
        <StatCard label="Rendez-vous pris" value="24" change={26} icon={Calendar} color={C.purple} dimColor={C.purpleDim} />
        <StatCard label="Courriels traités" value="342" change={12} icon={Mail} color={C.cyan} dimColor={C.cyanDim} />
        <StatCard label="Nouveaux prospects" value="19" change={30} icon={Users} color={C.pink} dimColor={C.pinkDim} />
      </div>

      {/* Row 2: Live calls + Appointments + Email + Assistant */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 280px", gap: 12, marginBottom: 12 }}>
        {/* Live Calls */}
        <div style={card}>
          <SectionTitle action={() => setPage("calls")} actionLabel="Voir tout">
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              Appels en direct
              <span style={{ background: C.greenDim, color: C.green, borderRadius: 20, padding: "2px 8px", fontSize: 11, fontWeight: 700 }}>3 actifs</span>
            </span>
          </SectionTitle>
          {LIVE_CALLS.map(call => (
            <div key={call.id} style={{ paddingBottom: 12, marginBottom: 12, borderBottom: `1px solid ${C.border}` }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: call.status === "in_progress" ? C.green : C.yellow, boxShadow: `0 0 6px ${call.status === "in_progress" ? C.green : C.yellow}` }} />
                  <span style={{ color: C.textPrimary, fontSize: 13, fontWeight: 600 }}>{call.name}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <StatusBadge status={call.status} small />
                  <span style={{ color: C.textTertiary, fontSize: 11, fontFamily: "monospace" }}>{call.duration}</span>
                </div>
              </div>
              <div style={{ color: C.textSecondary, fontSize: 11, marginLeft: 16 }}>
                <span style={{ color: C.cyan, fontWeight: 500 }}>{call.intent}</span> — {call.summary}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, marginLeft: 16 }}>
                <span style={{ color: C.textTertiary, fontSize: 11 }}>Confiance:</span>
                <ConfidenceDot score={call.confidence} />
              </div>
            </div>
          ))}
        </div>

        {/* Upcoming Appointments */}
        <div style={card}>
          <SectionTitle action={() => setPage("appointments")} actionLabel="Agenda">
            Rendez-vous à venir
          </SectionTitle>
          {APPOINTMENTS.slice(0, 3).map(apt => (
            <div key={apt.id} style={{ display: "flex", gap: 10, marginBottom: 12 }}>
              <div style={{ background: C.primaryDim, borderRadius: 8, padding: "6px 10px", textAlign: "center", minWidth: 44 }}>
                <div style={{ color: C.primary, fontSize: 10, fontWeight: 600 }}>{apt.date.split(" ")[0].toUpperCase()}</div>
                <div style={{ color: C.textPrimary, fontSize: 16, fontWeight: 700 }}>{apt.date.split(" ")[1]}</div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ color: C.textPrimary, fontSize: 13, fontWeight: 600 }}>{apt.time} — {apt.type}</div>
                <div style={{ color: C.textSecondary, fontSize: 11, marginTop: 2 }}>{apt.client}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                  <StatusBadge status={apt.status} small />
                  <span style={{ color: C.textTertiary, fontSize: 11 }}>{apt.channel}</span>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Email Handling */}
        <div style={card}>
          <SectionTitle action={() => setPage("emails")} actionLabel="Boîte de réception">
            Gestion courriels
          </SectionTitle>
          {EMAILS_DATA.slice(0, 3).map(email => (
            <div key={email.id} style={{ marginBottom: 12, paddingBottom: 12, borderBottom: `1px solid ${C.border}` }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3 }}>
                <span style={{ color: C.textPrimary, fontSize: 12, fontWeight: 600 }}>{email.name}</span>
                <span style={{ color: C.textTertiary, fontSize: 10 }}>{email.time}</span>
              </div>
              <div style={{ color: C.cyan, fontSize: 11, marginBottom: 3, fontWeight: 500 }}>{email.subject}</div>
              <div style={{ color: C.textTertiary, fontSize: 11, marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{email.preview}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <StatusBadge status={email.status} small />
                <ConfidenceDot score={email.confidence} />
              </div>
            </div>
          ))}
          <button onClick={() => setPage("emails")} style={{ width: "100%", padding: "8px", background: C.primaryDim, border: `1px solid ${C.borderStrong}`, borderRadius: 8, color: C.primary, fontSize: 12, cursor: "pointer", fontWeight: 600 }}>
            Voir 3 brouillons à valider →
          </button>
        </div>

        {/* Assistant Profile */}
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <h3 style={{ color: C.textPrimary, fontSize: 14, fontWeight: 600, margin: 0 }}>Profil de l'assistant</h3>
            <button style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 6, color: C.textSecondary, fontSize: 11, padding: "3px 8px", cursor: "pointer" }}>Modifier</button>
          </div>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
            <div style={{ width: 60, height: 60, borderRadius: "50%", background: `linear-gradient(135deg, ${C.primary}, ${C.purple})`, display: "flex", alignItems: "center", justifyContent: "center", border: `2px solid ${C.borderStrong}` }}>
              <Bot size={28} color="white" />
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginBottom: 12 }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: C.green, boxShadow: `0 0 6px ${C.green}` }} />
            <span style={{ color: C.textSecondary, fontSize: 12 }}>Assistant en ligne</span>
          </div>
          {[
            { label: "Nom", value: CONFIG.assistant.name },
            { label: "Voix", value: CONFIG.assistant.voice },
            { label: "Langue", value: CONFIG.assistant.language },
            { label: "Ton", value: CONFIG.assistant.tone },
            { label: "Confiance min.", value: `${CONFIG.assistant.confidence_threshold}%` },
          ].map(item => (
            <div key={item.label} style={{ display: "flex", justifyContent: "space-between", marginBottom: 7 }}>
              <span style={{ color: C.textTertiary, fontSize: 11 }}>{item.label}</span>
              <span style={{ color: C.textPrimary, fontSize: 11, fontWeight: 500 }}>{item.value}</span>
            </div>
          ))}
          <div style={{ marginTop: 8, padding: "8px 10px", background: C.primaryDim, borderRadius: 8, border: `1px solid rgba(59,130,246,0.2)` }}>
            <div style={{ color: C.textTertiary, fontSize: 10, marginBottom: 2 }}>Phrase d'accueil</div>
            <div style={{ color: C.textSecondary, fontSize: 11, fontStyle: "italic", lineHeight: 1.4 }}>{CONFIG.assistant.greeting}</div>
          </div>
        </div>
      </div>

      {/* Row 3: Memory + Suggestions + Analytics */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.3fr 1.7fr", gap: 12 }}>
        {/* Business Memory */}
        <div style={card}>
          <SectionTitle action={() => setPage("memory")} actionLabel="Détails">
            Mémoire d'entreprise
          </SectionTitle>
          <p style={{ color: C.textTertiary, fontSize: 11, margin: "0 0 12px" }}>
            {CONFIG.assistant.name} apprend et mémorise les informations clés de {CONFIG.org.name}.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {Object.entries(MEMORY_STATS).map(([key, mem]) => (
              <div key={key} style={{ background: `${C.bg}`, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ color: mem.color, fontSize: 20, fontWeight: 700 }}>{mem.count}</div>
                <div style={{ color: C.textSecondary, fontSize: 11, marginTop: 2, lineHeight: 1.3 }}>{mem.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Learning Suggestions */}
        <div style={card}>
          <SectionTitle action={() => setPage("suggestions")} actionLabel="Tout réviser">
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              Suggestions d'apprentissage
              {pendingSuggestions.length > 0 && (
                <span style={{ background: C.yellowDim, color: C.yellow, borderRadius: 20, padding: "2px 8px", fontSize: 11, fontWeight: 700 }}>{pendingSuggestions.length} nouvelles</span>
              )}
            </span>
          </SectionTitle>
          {pendingSuggestions.slice(0, 3).map(s => (
            <div key={s.id} style={{ marginBottom: 10, padding: "10px 12px", background: C.bg, borderRadius: 8, border: `1px solid ${C.border}` }}>
              <div style={{ color: C.textPrimary, fontSize: 12, fontWeight: 500, marginBottom: 3, lineHeight: 1.3 }}>{s.question}</div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ color: C.textTertiary, fontSize: 10 }}>Source: {s.source}</span>
                <div style={{ display: "flex", gap: 4 }}>
                  <button onClick={() => setSuggestions(prev => prev.map(x => x.id === s.id ? { ...x, status: "approved" } : x))}
                    style={{ background: C.greenDim, border: "none", borderRadius: 6, color: C.green, width: 26, height: 26, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Check size={13} />
                  </button>
                  <button onClick={() => setSuggestions(prev => prev.map(x => x.id === s.id ? { ...x, status: "rejected" } : x))}
                    style={{ background: C.redDim, border: "none", borderRadius: 6, color: C.red, width: 26, height: 26, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <X size={13} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Analytics Overview */}
        <div style={card}>
          <SectionTitle action={() => setPage("analytics")} actionLabel="Rapports complets">
            Analytiques — 7 derniers jours
          </SectionTitle>
          <div style={{ display: "flex", gap: 16, marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{ width: 10, height: 10, borderRadius: 2, background: C.primary }} />
              <span style={{ color: C.textTertiary, fontSize: 11 }}>Appels</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{ width: 10, height: 10, borderRadius: 2, background: C.cyan }} />
              <span style={{ color: C.textTertiary, fontSize: 11 }}>Courriels</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{ width: 10, height: 10, borderRadius: 2, background: C.purple }} />
              <span style={{ color: C.textTertiary, fontSize: 11 }}>Rendez-vous</span>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={140}>
            <AreaChart data={ANALYTICS} margin={{ top: 0, right: 0, left: -30, bottom: 0 }}>
              <defs>
                <linearGradient id="gBlue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C.primary} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={C.primary} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gCyan" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C.cyan} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={C.cyan} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gPurple" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C.purple} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={C.purple} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
              <XAxis dataKey="day" tick={{ fill: C.textTertiary, fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: C.textTertiary, fontSize: 10 }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, color: C.textPrimary, fontSize: 11 }} />
              <Area type="monotone" dataKey="appels" stroke={C.primary} strokeWidth={2} fill="url(#gBlue)" />
              <Area type="monotone" dataKey="courriels" stroke={C.cyan} strokeWidth={2} fill="url(#gCyan)" />
              <Area type="monotone" dataKey="rdv" stroke={C.purple} strokeWidth={2} fill="url(#gPurple)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
};

// --- PAGE: CALLS ---
const CallsPage = () => (
  <div>
    <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
      {[
        { label: "Total aujourd'hui", value: "128", color: C.primary, dimColor: C.primaryDim, icon: Phone },
        { label: "Appels complétés", value: "89", color: C.green, dimColor: C.greenDim, icon: CheckCircle },
        { label: "Transférés", value: "23", color: C.yellow, dimColor: C.yellowDim, icon: PhoneIncoming },
        { label: "Abandonnés", value: "16", color: C.red, dimColor: C.redDim, icon: PhoneOff },
      ].map(s => <StatCard key={s.label} label={s.label} value={s.value} change={Math.floor(Math.random() * 20 + 5)} icon={s.icon} color={s.color} dimColor={s.dimColor} />)}
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
      <div style={card}>
        <SectionTitle>Appels actifs — {LIVE_CALLS.length} en cours</SectionTitle>
        {LIVE_CALLS.map(call => (
          <div key={call.id} style={{ padding: "12px", background: C.bg, borderRadius: 10, border: `1px solid ${C.border}`, marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: "50%", background: C.primaryDim, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <User size={18} color={C.primary} />
                </div>
                <div>
                  <div style={{ color: C.textPrimary, fontSize: 13, fontWeight: 600 }}>{call.name}</div>
                  <div style={{ color: C.textTertiary, fontSize: 11 }}>{call.company} · {call.phone}</div>
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <StatusBadge status={call.status} />
                <div style={{ color: C.textTertiary, fontSize: 11, marginTop: 4, fontFamily: "monospace" }}>{call.duration}</div>
              </div>
            </div>
            <div style={{ background: C.card, borderRadius: 8, padding: "8px 10px" }}>
              <div style={{ color: C.cyan, fontSize: 11, fontWeight: 600, marginBottom: 2 }}>{call.intent}</div>
              <div style={{ color: C.textSecondary, fontSize: 11 }}>{call.summary}</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
              <span style={{ color: C.textTertiary, fontSize: 11 }}>Score de confiance IA:</span>
              <ConfidenceDot score={call.confidence} />
            </div>
          </div>
        ))}
      </div>
      <div style={card}>
        <SectionTitle>Historique récent</SectionTitle>
        {RECENT_CALLS.map(call => (
          <div key={call.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 32, height: 32, borderRadius: "50%", background: C.bg, border: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <User size={15} color={C.textSecondary} />
              </div>
              <div>
                <div style={{ color: C.textPrimary, fontSize: 13, fontWeight: 500 }}>{call.name}</div>
                <div style={{ color: C.textTertiary, fontSize: 11 }}>{call.intent} · {call.time}</div>
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <StatusBadge status={call.status} small />
              <div style={{ marginTop: 4 }}><ConfidenceDot score={call.confidence} /></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  </div>
);

// --- PAGE: EMAILS ---
const EmailsPage = () => (
  <div>
    <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
      {[
        { label: "Total aujourd'hui", value: "342", color: C.cyan, dimColor: C.cyanDim, icon: Mail },
        { label: "Répondus auto.", value: "287", color: C.green, dimColor: C.greenDim, icon: CheckCircle },
        { label: "Brouillons créés", value: "38", color: C.yellow, dimColor: C.yellowDim, icon: FileText },
        { label: "À valider", value: "17", color: C.red, dimColor: C.redDim, icon: AlertCircle },
      ].map(s => <StatCard key={s.label} label={s.label} value={s.value} change={Math.floor(Math.random() * 20 + 3)} icon={s.icon} color={s.color} dimColor={s.dimColor} />)}
    </div>
    <div style={card}>
      <SectionTitle>Boîte de réception</SectionTitle>
      {EMAILS_DATA.map(email => (
        <div key={email.id} style={{ display: "flex", gap: 14, padding: "14px 0", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ width: 40, height: 40, borderRadius: "50%", background: C.primaryDim, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <User size={18} color={C.primary} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <div>
                <span style={{ color: C.textPrimary, fontSize: 13, fontWeight: 600 }}>{email.name}</span>
                <span style={{ color: C.textTertiary, fontSize: 11, marginLeft: 8 }}>— {email.company}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ background: email.level === 2 ? C.primaryDim : C.cyanDim, color: email.level === 2 ? C.primary : C.cyan, borderRadius: 6, padding: "2px 7px", fontSize: 10, fontWeight: 700 }}>
                  Niveau {email.level}
                </span>
                <span style={{ color: C.textTertiary, fontSize: 11 }}>{email.time}</span>
              </div>
            </div>
            <div style={{ color: C.textPrimary, fontSize: 12, fontWeight: 500, marginBottom: 3 }}>{email.subject}</div>
            <div style={{ color: C.textTertiary, fontSize: 11, marginBottom: 6 }}>{email.preview}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <StatusBadge status={email.status} small />
              <span style={{ color: C.textTertiary, fontSize: 11 }}>Confiance:</span>
              <ConfidenceDot score={email.confidence} />
            </div>
          </div>
        </div>
      ))}
    </div>
  </div>
);

// --- PAGE: APPOINTMENTS ---
const AppointmentsPage = () => (
  <div>
    <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
      {[
        { label: "Cette semaine", value: "24", color: C.purple, dimColor: C.purpleDim, icon: Calendar },
        { label: "Confirmés", value: "18", color: C.green, dimColor: C.greenDim, icon: CheckCircle },
        { label: "En attente", value: "6", color: C.yellow, dimColor: C.yellowDim, icon: Clock },
        { label: "Ce mois", value: "87", color: C.cyan, dimColor: C.cyanDim, icon: TrendingUp },
      ].map(s => <StatCard key={s.label} label={s.label} value={s.value} change={Math.floor(Math.random() * 25 + 5)} icon={s.icon} color={s.color} dimColor={s.dimColor} />)}
    </div>
    <div style={card}>
      <SectionTitle>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Calendrier des rendez-vous
          <button style={{ background: C.primaryDim, border: `1px solid rgba(59,130,246,0.3)`, borderRadius: 6, color: C.primary, fontSize: 11, padding: "3px 10px", cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
            <Plus size={12} /> Nouveau RDV
          </button>
        </span>
      </SectionTitle>
      {APPOINTMENTS.map(apt => (
        <div key={apt.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 0", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ background: C.primaryDim, borderRadius: 8, padding: "8px 12px", textAlign: "center", minWidth: 54 }}>
            <div style={{ color: C.primary, fontSize: 10, fontWeight: 700 }}>{apt.date.split(" ")[0].toUpperCase()}</div>
            <div style={{ color: C.textPrimary, fontSize: 18, fontWeight: 700 }}>{apt.date.split(" ")[1]}</div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ color: C.textPrimary, fontSize: 14, fontWeight: 600 }}>{apt.time} — {apt.type}</span>
              <StatusBadge status={apt.status} small />
            </div>
            <div style={{ color: C.textSecondary, fontSize: 12 }}>{apt.client} · {apt.contact}</div>
            <div style={{ color: C.textTertiary, fontSize: 11, marginTop: 2 }}>Canal: {apt.channel}</div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button style={{ background: C.primaryDim, border: "none", borderRadius: 6, color: C.primary, fontSize: 11, padding: "5px 10px", cursor: "pointer" }}>Voir</button>
            <button style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 6, color: C.textSecondary, fontSize: 11, padding: "5px 10px", cursor: "pointer" }}>Modifier</button>
          </div>
        </div>
      ))}
    </div>
  </div>
);

// --- PAGE: CRM ---
const CRMPage = () => (
  <div>
    <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
      {[
        { label: "Total prospects", value: "47", color: C.primary, dimColor: C.primaryDim, icon: Users },
        { label: "Hot Leads", value: "8", color: C.red, dimColor: C.redDim, icon: Star },
        { label: "Qualifiés", value: "15", color: C.green, dimColor: C.greenDim, icon: CheckCircle },
        { label: "RDV pris", value: "12", color: C.purple, dimColor: C.purpleDim, icon: Calendar },
      ].map(s => <StatCard key={s.label} label={s.label} value={s.value} change={Math.floor(Math.random() * 30 + 8)} icon={s.icon} color={s.color} dimColor={s.dimColor} />)}
    </div>
    <div style={card}>
      <SectionTitle>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Prospects & Clients
          <button style={{ background: C.primaryDim, border: `1px solid rgba(59,130,246,0.3)`, borderRadius: 6, color: C.primary, fontSize: 11, padding: "3px 10px", cursor: "pointer" }}>
            + Ajouter un prospect
          </button>
        </span>
      </SectionTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12 }}>
        {LEADS_DATA.map(lead => (
          <div key={lead.id} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 38, height: 38, borderRadius: "50%", background: C.primaryDim, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <span style={{ color: C.primary, fontSize: 14, fontWeight: 700 }}>{lead.name[0]}</span>
                </div>
                <div>
                  <div style={{ color: C.textPrimary, fontSize: 13, fontWeight: 600 }}>{lead.name}</div>
                  <div style={{ color: C.textTertiary, fontSize: 11 }}>{lead.contact} · {lead.sector}</div>
                </div>
              </div>
              <StatusBadge status={lead.status} small />
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <div style={{ background: C.card, borderRadius: 6, padding: "4px 8px" }}>
                <span style={{ color: C.textTertiary, fontSize: 10 }}>Besoin: </span>
                <span style={{ color: C.textSecondary, fontSize: 10 }}>{lead.need}</span>
              </div>
              <div style={{ background: C.card, borderRadius: 6, padding: "4px 8px" }}>
                <span style={{ color: C.textTertiary, fontSize: 10 }}>Budget: </span>
                <span style={{ color: C.cyan, fontSize: 10, fontWeight: 500 }}>{lead.budget}</span>
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10 }}>
              <span style={{ background: lead.urgency === "high" ? C.redDim : lead.urgency === "medium" ? C.yellowDim : C.greenDim, color: lead.urgency === "high" ? C.red : lead.urgency === "medium" ? C.yellow : C.green, borderRadius: 20, padding: "2px 8px", fontSize: 10, fontWeight: 600 }}>
                Urgence {lead.urgency === "high" ? "haute" : lead.urgency === "medium" ? "moyenne" : "basse"}
              </span>
              <button style={{ background: C.primaryDim, border: "none", borderRadius: 6, color: C.primary, fontSize: 11, padding: "4px 10px", cursor: "pointer" }}>Voir fiche →</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  </div>
);

// --- PAGE: KNOWLEDGE BASE ---
const KnowledgePage = () => (
  <div>
    <div style={{ ...card, marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <h3 style={{ color: C.textPrimary, fontSize: 15, fontWeight: 600, margin: 0 }}>Base de connaissances — {CONFIG.org.name}</h3>
        <button style={{ background: C.primaryDim, border: `1px solid rgba(59,130,246,0.3)`, borderRadius: 6, color: C.primary, fontSize: 12, padding: "5px 12px", cursor: "pointer" }}>
          + Ajouter une entrée
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 10 }}>
        {KNOWLEDGE_BASE.map(kb => (
          <div key={kb.id} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ background: C.primaryDim, color: C.primary, borderRadius: 6, padding: "2px 8px", fontSize: 11, fontWeight: 600 }}>{kb.category}</span>
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <StatusBadge status={kb.status} small />
                <span style={{ color: C.textTertiary, fontSize: 10 }}>Mis à jour: {kb.updated}</span>
              </div>
            </div>
            <div style={{ color: C.textPrimary, fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{kb.title}</div>
            <div style={{ color: C.textSecondary, fontSize: 11, lineHeight: 1.5 }}>{kb.content}</div>
            <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
              <button style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 6, color: C.textSecondary, fontSize: 10, padding: "3px 8px", cursor: "pointer" }}>Modifier</button>
              <button style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 6, color: C.red, fontSize: 10, padding: "3px 8px", cursor: "pointer" }}>Supprimer</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  </div>
);

// --- PAGE: BUSINESS MEMORY ---
const MemoryPage = () => (
  <div>
    <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
      {Object.entries(MEMORY_STATS).map(([key, mem]) => (
        <div key={key} style={{ ...card, flex: 1 }}>
          <div style={{ color: mem.color, fontSize: 28, fontWeight: 700 }}>{mem.count}</div>
          <div style={{ color: C.textPrimary, fontSize: 13, fontWeight: 500, marginTop: 4 }}>{mem.label}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 10 }}>
            {mem.items.map(item => (
              <span key={item} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 20, padding: "2px 8px", fontSize: 10, color: C.textSecondary }}>{item}</span>
            ))}
          </div>
        </div>
      ))}
    </div>
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px", background: C.bg, borderRadius: 10, marginBottom: 12, border: `1px solid rgba(59,130,246,0.2)` }}>
        <Info size={18} color={C.primary} />
        <div>
          <div style={{ color: C.textPrimary, fontSize: 13, fontWeight: 500 }}>Mémoire d'entreprise intelligente</div>
          <div style={{ color: C.textTertiary, fontSize: 11, marginTop: 2 }}>
            {CONFIG.assistant.name} apprend progressivement à partir des interactions, documents et corrections humaines. Chaque nouvelle connaissance passe par une validation avant d'être ajoutée à la mémoire officielle.
          </div>
        </div>
      </div>
      <SectionTitle>Sources d'apprentissage actives</SectionTitle>
      {[
        { source: "Site web Exevori", type: "Scraping URL", items: 12, lastSync: "Aujourd'hui 08:00", status: "active" },
        { source: "FAQ interne", type: "Document texte", items: 18, lastSync: "Hier 16:30", status: "active" },
        { source: "Appels traités", type: "Transcriptions IA", items: 847, lastSync: "En continu", status: "active" },
        { source: "Courriels analysés", type: "Analyse IA", items: 342, lastSync: "En continu", status: "active" },
        { source: "Réponses validées", type: "Validation humaine", items: 24, lastSync: "Il y a 2h", status: "active" },
      ].map(src => (
        <div key={src.source} style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 0", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ width: 36, height: 36, borderRadius: 8, background: C.primaryDim, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Database size={16} color={C.primary} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ color: C.textPrimary, fontSize: 13, fontWeight: 500 }}>{src.source}</div>
            <div style={{ color: C.textTertiary, fontSize: 11, marginTop: 2 }}>{src.type} · {src.items} éléments · Sync: {src.lastSync}</div>
          </div>
          <StatusBadge status={src.status} small />
        </div>
      ))}
    </div>
  </div>
);

// --- PAGE: LEARNING SUGGESTIONS ---
const SuggestionsPage = ({ suggestions, setSuggestions }) => {
  const [filter, setFilter] = useState("all");
  const filtered = filter === "all" ? suggestions : suggestions.filter(s => s.status === filter);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {[
          { key: "all", label: "Toutes", count: suggestions.length },
          { key: "pending", label: "À réviser", count: suggestions.filter(s => s.status === "pending").length },
          { key: "approved", label: "Approuvées", count: suggestions.filter(s => s.status === "approved").length },
          { key: "rejected", label: "Refusées", count: suggestions.filter(s => s.status === "rejected").length },
        ].map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)}
            style={{ background: filter === f.key ? C.primaryDim : C.card, border: `1px solid ${filter === f.key ? C.primary : C.border}`, borderRadius: 8, color: filter === f.key ? C.primary : C.textSecondary, fontSize: 12, padding: "6px 14px", cursor: "pointer", fontWeight: 500 }}>
            {f.label} ({f.count})
          </button>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(400px, 1fr))", gap: 12 }}>
        {filtered.map(s => (
          <div key={s.id} style={{ ...card, border: `1px solid ${s.status === "approved" ? "rgba(16,185,129,0.25)" : s.status === "rejected" ? "rgba(239,68,68,0.25)" : C.border}` }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ background: C.cyanDim, color: C.cyan, borderRadius: 6, padding: "2px 8px", fontSize: 11, fontWeight: 600 }}>
                  {s.type === "question_frequente" ? "Question fréquente" : s.type === "info_service" ? "Info service" : "Prix"}
                </span>
                <span style={{ color: C.textTertiary, fontSize: 11 }}>Source: {s.detected_from}</span>
              </div>
              <ConfidenceDot score={s.confidence} />
            </div>
            <div style={{ marginBottom: 10 }}>
              <div style={{ color: C.textTertiary, fontSize: 11, marginBottom: 4 }}>Question détectée:</div>
              <div style={{ color: C.textPrimary, fontSize: 13, fontWeight: 500, lineHeight: 1.4 }}>{s.question}</div>
            </div>
            <div style={{ background: C.bg, borderRadius: 8, padding: "10px 12px", marginBottom: 10, border: `1px solid ${C.border}` }}>
              <div style={{ color: C.textTertiary, fontSize: 11, marginBottom: 4 }}>Réponse proposée:</div>
              <div style={{ color: C.textSecondary, fontSize: 12, lineHeight: 1.5 }}>{s.answer}</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ color: C.textTertiary, fontSize: 11 }}>{s.source}</span>
              {s.status === "pending" ? (
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => setSuggestions(prev => prev.map(x => x.id === s.id ? { ...x, status: "approved" } : x))}
                    style={{ background: C.greenDim, border: `1px solid rgba(16,185,129,0.3)`, borderRadius: 6, color: C.green, fontSize: 12, padding: "5px 12px", cursor: "pointer", fontWeight: 600 }}>
                    ✓ Approuver
                  </button>
                  <button style={{ background: C.primaryDim, border: `1px solid rgba(59,130,246,0.3)`, borderRadius: 6, color: C.primary, fontSize: 12, padding: "5px 12px", cursor: "pointer", fontWeight: 600 }}>
                    Modifier
                  </button>
                  <button onClick={() => setSuggestions(prev => prev.map(x => x.id === s.id ? { ...x, status: "rejected" } : x))}
                    style={{ background: C.redDim, border: `1px solid rgba(239,68,68,0.3)`, borderRadius: 6, color: C.red, fontSize: 12, padding: "5px 12px", cursor: "pointer", fontWeight: 600 }}>
                    ✗ Refuser
                  </button>
                </div>
              ) : (
                <StatusBadge status={s.status === "approved" ? "approved" : "rejected"} />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// --- PAGE: ANALYTICS ---
const AnalyticsPage = () => (
  <div>
    <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
      {[
        { label: "Total interactions", value: "2 846", color: C.primary, dimColor: C.primaryDim, icon: Activity },
        { label: "Taux de résolution IA", value: "78%", color: C.green, dimColor: C.greenDim, icon: CheckCircle },
        { label: "Taux de transfert", value: "18%", color: C.yellow, dimColor: C.yellowDim, icon: PhoneIncoming },
        { label: "Score moyen IA", value: "84%", color: C.purple, dimColor: C.purpleDim, icon: Zap },
      ].map(s => <StatCard key={s.label} label={s.label} value={s.value} change={Math.floor(Math.random() * 15 + 3)} icon={s.icon} color={s.color} dimColor={s.dimColor} />)}
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
      <div style={card}>
        <SectionTitle>Volume d'interactions — 7 jours</SectionTitle>
        <div style={{ display: "flex", gap: 16, marginBottom: 12 }}>
          {[["appels", C.primary], ["courriels", C.cyan], ["rdv", C.purple]].map(([k, c]) => (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 10, height: 10, borderRadius: 2, background: c }} />
              <span style={{ color: C.textTertiary, fontSize: 11 }}>{k}</span>
            </div>
          ))}
        </div>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={ANALYTICS} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
            <defs>
              <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.primary} stopOpacity={0.25} /><stop offset="100%" stopColor={C.primary} stopOpacity={0} /></linearGradient>
              <linearGradient id="g2" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.cyan} stopOpacity={0.25} /><stop offset="100%" stopColor={C.cyan} stopOpacity={0} /></linearGradient>
              <linearGradient id="g3" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.purple} stopOpacity={0.25} /><stop offset="100%" stopColor={C.purple} stopOpacity={0} /></linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
            <XAxis dataKey="day" tick={{ fill: C.textTertiary, fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: C.textTertiary, fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, color: C.textPrimary, fontSize: 11 }} />
            <Area type="monotone" dataKey="appels" stroke={C.primary} strokeWidth={2} fill="url(#g1)" />
            <Area type="monotone" dataKey="courriels" stroke={C.cyan} strokeWidth={2} fill="url(#g2)" />
            <Area type="monotone" dataKey="rdv" stroke={C.purple} strokeWidth={2} fill="url(#g3)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div style={card}>
        <SectionTitle>Répartition par type</SectionTitle>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <PieChart width={200} height={180}>
            <Pie data={PIE_DATA} cx={100} cy={90} innerRadius={50} outerRadius={80} paddingAngle={3} dataKey="value">
              {PIE_DATA.map((entry, i) => <Cell key={i} fill={entry.color} />)}
            </Pie>
            <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 11 }} />
          </PieChart>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
          {PIE_DATA.map(item => (
            <div key={item.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, background: item.color }} />
                <span style={{ color: C.textSecondary, fontSize: 12 }}>{item.name}</span>
              </div>
              <span style={{ color: C.textPrimary, fontSize: 12, fontWeight: 600 }}>{item.value}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  </div>
);

// --- PAGE: CALL SIMULATION (with Claude API) ---
const SimulationPage = () => {
  const [messages, setMessages] = useState([
    { role: "assistant", content: CONFIG.assistant.greeting }
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [isCallActive, setIsCallActive] = useState(true);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = async () => {
    if (!input.trim() || loading) return;
    const userMsg = input.trim();
    setInput("");
    setMessages(prev => [...prev, { role: "user", content: userMsg }]);
    setLoading(true);

    try {
      const history = messages.map(m => ({ role: m.role, content: m.content }));
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system: `Tu es ${CONFIG.assistant.name}, la réceptionniste IA de l'entreprise ${CONFIG.org.name} située à ${CONFIG.org.location}.

Ton rôle: accueillir les prospects et clients avec professionnalisme, comprendre leur besoin, poser des questions ouvertes intelligentes, qualifier la demande et proposer un rendez-vous avec l'équipe.

Services offerts par ${CONFIG.org.name}:
- Sites web sur mesure (3-8 semaines, prix selon complexité)
- Applications web & SaaS personnalisés
- Agents IA (courriel, téléphone, réseaux sociaux) à partir de 497$/mois
- Automatisation de processus avec l'IA
- Outils internes pour PME

Ton ton: ${CONFIG.assistant.tone}.
Règles strictes:
- Ne JAMAIS inventer de prix exacts non mentionnés ci-dessus
- Ne JAMAIS promettre de résultats garantis
- Toujours proposer un rendez-vous si le prospect semble intéressé
- Si tu ne sais pas, dire honnêtement que tu vas transmettre la question à l'équipe
- Rester concis (2-4 phrases max par réponse)
- Poser une question ouverte à chaque fois pour qualifier davantage

Langue: français québécois professionnel.`,
          messages: [...history, { role: "user", content: userMsg }]
        })
      });
      const data = await response.json();
      const aiMsg = data.content?.[0]?.text || "Je suis désolée, une erreur est survenue. Permettez-moi de transférer votre demande à notre équipe.";
      setMessages(prev => [...prev, { role: "assistant", content: aiMsg }]);
    } catch (err) {
      setMessages(prev => [...prev, { role: "assistant", content: "Je suis désolée, une erreur technique est survenue. Je vais transmettre votre demande à notre équipe." }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 12 }}>
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, paddingBottom: 14, borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 42, height: 42, borderRadius: "50%", background: `linear-gradient(135deg, ${C.primary}, ${C.purple})`, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Bot size={20} color="white" />
            </div>
            <div>
              <div style={{ color: C.textPrimary, fontSize: 14, fontWeight: 600 }}>{CONFIG.assistant.name} — {CONFIG.org.name}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
                <div style={{ width: 7, height: 7, borderRadius: "50%", background: isCallActive ? C.green : C.red }} />
                <span style={{ color: C.textSecondary, fontSize: 11 }}>{isCallActive ? "Simulation d'appel active" : "Appel terminé"}</span>
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ background: C.greenDim, borderRadius: 8, padding: "5px 12px" }}>
              <span style={{ color: C.green, fontSize: 11, fontWeight: 600 }}>IA Active · Confiance: 84%</span>
            </div>
            <button onClick={() => { setMessages([{ role: "assistant", content: CONFIG.assistant.greeting }]); setIsCallActive(true); }}
              style={{ background: C.primaryDim, border: `1px solid rgba(59,130,246,0.3)`, borderRadius: 8, color: C.primary, fontSize: 11, padding: "5px 12px", cursor: "pointer" }}>
              Nouveau test
            </button>
          </div>
        </div>

        <div style={{ height: 380, overflowY: "auto", paddingRight: 4, marginBottom: 14 }}>
          {messages.map((msg, i) => (
            <div key={i} style={{ display: "flex", gap: 10, marginBottom: 12, flexDirection: msg.role === "user" ? "row-reverse" : "row" }}>
              <div style={{ width: 30, height: 30, borderRadius: "50%", background: msg.role === "user" ? C.purpleDim : C.primaryDim, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                {msg.role === "user" ? <User size={15} color={C.purple} /> : <Bot size={15} color={C.primary} />}
              </div>
              <div style={{
                maxWidth: "75%",
                padding: "10px 14px",
                borderRadius: msg.role === "user" ? "12px 12px 4px 12px" : "12px 12px 12px 4px",
                background: msg.role === "user" ? C.purpleDim : C.bg,
                border: `1px solid ${msg.role === "user" ? "rgba(139,92,246,0.25)" : C.border}`,
                color: C.textPrimary,
                fontSize: 13,
                lineHeight: 1.5
              }}>{msg.content}</div>
            </div>
          ))}
          {loading && (
            <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
              <div style={{ width: 30, height: 30, borderRadius: "50%", background: C.primaryDim, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Bot size={15} color={C.primary} />
              </div>
              <div style={{ padding: "10px 14px", borderRadius: "12px 12px 12px 4px", background: C.bg, border: `1px solid ${C.border}`, color: C.textSecondary, fontSize: 13 }}>
                {CONFIG.assistant.name} est en train de répondre...
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && sendMessage()}
            placeholder="Tapez votre message (simulez un appel client)..."
            style={{ flex: 1, background: C.bg, border: `1px solid ${C.borderStrong}`, borderRadius: 10, color: C.textPrimary, fontSize: 13, padding: "10px 14px", outline: "none" }}
          />
          <button onClick={sendMessage} disabled={loading || !input.trim()}
            style={{ background: loading || !input.trim() ? C.bg : C.primary, border: "none", borderRadius: 10, color: "white", width: 44, height: 44, cursor: loading || !input.trim() ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Send size={18} />
          </button>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
          {["Je veux un site web", "Combien ça coûte un agent IA ?", "Quel est votre délai de livraison ?", "Je voudrais un rendez-vous"].map(q => (
            <button key={q} onClick={() => setInput(q)}
              style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 20, color: C.textSecondary, fontSize: 11, padding: "4px 10px", cursor: "pointer" }}>
              {q}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={card}>
          <SectionTitle>Métriques en temps réel</SectionTitle>
          {[
            { label: "Messages échangés", value: messages.length, color: C.primary },
            { label: "Réponses IA", value: messages.filter(m => m.role === "assistant").length, color: C.cyan },
            { label: "Confiance IA", value: "84%", color: C.green },
          ].map(m => (
            <div key={m.label} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${C.border}` }}>
              <span style={{ color: C.textSecondary, fontSize: 12 }}>{m.label}</span>
              <span style={{ color: m.color, fontSize: 12, fontWeight: 700 }}>{m.value}</span>
            </div>
          ))}
        </div>
        <div style={card}>
          <SectionTitle>Questions test suggérées</SectionTitle>
          {["Quels services offrez-vous ?", "Travaillez-vous en dehors du Québec ?", "J'ai besoin d'aide urgente", "Transférez-moi à quelqu'un", "Quel est le coût d'un site web ?"].map((q, i) => (
            <button key={i} onClick={() => setInput(q)} style={{ display: "block", width: "100%", textAlign: "left", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, color: C.textSecondary, fontSize: 12, padding: "8px 10px", cursor: "pointer", marginBottom: 6 }}>
              → {q}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

// --- PAGE: SETTINGS ---
const SettingsPage = () => {
  const [assistantName, setAssistantName] = useState(CONFIG.assistant.name);
  const [greeting, setGreeting] = useState(CONFIG.assistant.greeting);
  const [threshold, setThreshold] = useState(CONFIG.assistant.confidence_threshold);
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
      <div style={card}>
        <SectionTitle>Configuration de l'assistant IA</SectionTitle>
        {[
          { label: "Nom de l'assistant", value: assistantName, onChange: setAssistantName, type: "text" },
          { label: "Entreprise", value: CONFIG.org.name, type: "text", readOnly: true },
          { label: "Localisation", value: CONFIG.org.location, type: "text", readOnly: true },
          { label: "Langue principale", value: CONFIG.assistant.language, type: "text", readOnly: true },
          { label: "Voix", value: CONFIG.assistant.voice, type: "text", readOnly: true },
          { label: "Niveau d'autonomie", value: CONFIG.assistant.autonomy, type: "text", readOnly: true },
        ].map(f => (
          <div key={f.label} style={{ marginBottom: 12 }}>
            <label style={{ color: C.textSecondary, fontSize: 12, display: "block", marginBottom: 5 }}>{f.label}</label>
            <input
              value={f.value}
              onChange={f.onChange ? e => f.onChange(e.target.value) : undefined}
              readOnly={f.readOnly}
              style={{
                width: "100%", boxSizing: "border-box",
                background: f.readOnly ? C.bg : C.bg,
                border: `1px solid ${f.readOnly ? C.border : C.borderStrong}`,
                borderRadius: 8, color: f.readOnly ? C.textTertiary : C.textPrimary,
                fontSize: 12, padding: "8px 12px", outline: "none"
              }}
            />
          </div>
        ))}
        <div style={{ marginBottom: 12 }}>
          <label style={{ color: C.textSecondary, fontSize: 12, display: "block", marginBottom: 5 }}>
            Seuil de confiance IA: <span style={{ color: threshold >= 80 ? C.green : threshold >= 60 ? C.yellow : C.red, fontWeight: 700 }}>{threshold}%</span>
          </label>
          <input type="range" min={40} max={100} step={5} value={threshold} onChange={e => setThreshold(Number(e.target.value))}
            style={{ width: "100%", accentColor: C.primary }} />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3 }}>
            <span style={{ color: C.textTertiary, fontSize: 10 }}>Permissif (40%)</span>
            <span style={{ color: C.textTertiary, fontSize: 10 }}>Strict (100%)</span>
          </div>
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ color: C.textSecondary, fontSize: 12, display: "block", marginBottom: 5 }}>Phrase d'accueil</label>
          <textarea value={greeting} onChange={e => setGreeting(e.target.value)} rows={3}
            style={{ width: "100%", boxSizing: "border-box", background: C.bg, border: `1px solid ${C.borderStrong}`, borderRadius: 8, color: C.textPrimary, fontSize: 12, padding: "8px 12px", outline: "none", resize: "vertical", fontFamily: "inherit" }} />
        </div>
        <button onClick={handleSave} style={{ width: "100%", padding: "10px", background: saved ? C.greenDim : C.primary, border: "none", borderRadius: 8, color: saved ? C.green : "white", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
          {saved ? "✓ Configuration sauvegardée" : "Sauvegarder la configuration"}
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={card}>
          <SectionTitle>Règles de transfert humain</SectionTitle>
          {["Client insiste pour parler à une personne", "Score de confiance trop bas", "Demande de prix exact", "Client mécontent ou plainte", "Sujet sensible (légal, médical, fiscal)", "Conversation confuse ou hors sujet"].map((rule, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: `1px solid ${C.border}` }}>
              <CheckCircle size={14} color={C.green} />
              <span style={{ color: C.textSecondary, fontSize: 12 }}>{rule}</span>
            </div>
          ))}
        </div>
        <div style={card}>
          <SectionTitle>Canaux de notification</SectionTitle>
          {[
            { label: "Courriel interne", status: true, icon: Mail },
            { label: "SMS (Twilio)", status: false, icon: MessageSquare },
            { label: "WhatsApp", status: false, icon: Globe },
            { label: "Dashboard", status: true, icon: Bell },
          ].map(ch => (
            <div key={ch.label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <ch.icon size={16} color={ch.status ? C.primary : C.textTertiary} />
                <span style={{ color: ch.status ? C.textPrimary : C.textTertiary, fontSize: 12 }}>{ch.label}</span>
              </div>
              <span style={{ background: ch.status ? C.greenDim : C.bg, color: ch.status ? C.green : C.textTertiary, borderRadius: 20, padding: "2px 10px", fontSize: 11, fontWeight: 600, border: `1px solid ${ch.status ? "rgba(16,185,129,0.2)" : C.border}` }}>
                {ch.status ? "Actif" : "Non configuré"}
              </span>
            </div>
          ))}
        </div>
        <div style={card}>
          <SectionTitle>API & Intégrations</SectionTitle>
          {[
            { label: "Google Calendar", status: false, icon: Calendar },
            { label: "Zoho Mail", status: false, icon: Mail },
            { label: "Twilio Voice", status: false, icon: Phone },
            { label: "Supabase", status: false, icon: Database },
          ].map(int => (
            <div key={int.label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${C.border}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <int.icon size={15} color={C.textTertiary} />
                <span style={{ color: C.textSecondary, fontSize: 12 }}>{int.label}</span>
              </div>
              <button style={{ background: C.primaryDim, border: `1px solid rgba(59,130,246,0.2)`, borderRadius: 6, color: C.primary, fontSize: 11, padding: "3px 10px", cursor: "pointer" }}>
                Connecter
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// --- SIDEBAR ---
const NAV_ITEMS = [
  { id: "dashboard", label: "Tableau de bord", icon: LayoutDashboard },
  { id: "calls", label: "Appels", icon: Phone, badge: "3" },
  { id: "emails", label: "Courriels", icon: Mail, badge: "17" },
  { id: "appointments", label: "Rendez-vous", icon: Calendar },
  { id: "crm", label: "Prospects / CRM", icon: Users },
  { id: "knowledge", label: "Base de connaissances", icon: BookOpen },
  { id: "memory", label: "Mémoire d'entreprise", icon: Brain },
  { id: "suggestions", label: "Suggestions IA", icon: Lightbulb, badge: "4" },
  { id: "analytics", label: "Analytiques", icon: BarChart2 },
  { id: "simulation", label: "Simulation d'appel", icon: Mic },
  { id: "settings", label: "Paramètres", icon: Settings },
];

const PAGE_TITLES = {
  dashboard: "Tableau de bord",
  calls: "Gestion des appels",
  emails: "Gestion des courriels",
  appointments: "Rendez-vous",
  crm: "Prospects & CRM",
  knowledge: "Base de connaissances",
  memory: "Mémoire d'entreprise intelligente",
  suggestions: "Suggestions d'apprentissage",
  analytics: "Analytiques & Rapports",
  simulation: "Simulation d'appel IA",
  settings: "Configuration de l'assistant IA",
};

// --- MAIN APP ---
export default function VoiceDeskApp() {
  const [page, setPage] = useState("dashboard");
  const [suggestions, setSuggestions] = useState(INIT_SUGGESTIONS);

  const renderPage = () => {
    const props = { setPage, suggestions, setSuggestions };
    switch (page) {
      case "dashboard": return <DashboardPage {...props} />;
      case "calls": return <CallsPage />;
      case "emails": return <EmailsPage />;
      case "appointments": return <AppointmentsPage />;
      case "crm": return <CRMPage />;
      case "knowledge": return <KnowledgePage />;
      case "memory": return <MemoryPage />;
      case "suggestions": return <SuggestionsPage suggestions={suggestions} setSuggestions={setSuggestions} />;
      case "analytics": return <AnalyticsPage />;
      case "simulation": return <SimulationPage />;
      case "settings": return <SettingsPage />;
      default: return <DashboardPage {...props} />;
    }
  };

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: C.bg, fontFamily: "'Inter', -apple-system, sans-serif" }}>
      {/* Sidebar */}
      <div style={{ width: 220, background: C.sidebar, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", flexShrink: 0 }}>
        {/* Logo */}
        <div style={{ padding: "20px 16px 16px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: C.primary, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, color: "white", fontSize: 16 }}>X</div>
            <div>
              <div style={{ color: C.textPrimary, fontSize: 13, fontWeight: 700, lineHeight: 1 }}>Exevori</div>
              <div style={{ color: C.primary, fontSize: 10, fontWeight: 500, marginTop: 2 }}>VoiceDesk AI</div>
            </div>
          </div>
        </div>

        {/* Assistant status */}
        <div style={{ padding: "10px 14px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: C.green, boxShadow: `0 0 6px ${C.green}` }} />
          <div>
            <div style={{ color: C.textPrimary, fontSize: 11, fontWeight: 600 }}>{CONFIG.assistant.name}</div>
            <div style={{ color: C.textTertiary, fontSize: 10 }}>Assistant en ligne</div>
          </div>
        </div>

        {/* Navigation */}
        <nav style={{ flex: 1, padding: "8px 0", overflowY: "auto" }}>
          {NAV_ITEMS.map(item => (
            <button key={item.id} onClick={() => setPage(item.id)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                width: "100%", padding: "9px 14px", background: page === item.id ? C.primaryDim : "none",
                border: "none", borderLeft: `3px solid ${page === item.id ? C.primary : "transparent"}`,
                color: page === item.id ? C.primary : C.textSecondary,
                cursor: "pointer", textAlign: "left", gap: 10,
                transition: "all 0.15s"
              }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <item.icon size={16} />
                <span style={{ fontSize: 12, fontWeight: page === item.id ? 600 : 400 }}>{item.label}</span>
              </div>
              {item.badge && (
                <span style={{ background: page === item.id ? C.primary : C.redDim, color: page === item.id ? "white" : C.red, borderRadius: 20, padding: "1px 6px", fontSize: 10, fontWeight: 700 }}>
                  {item.badge}
                </span>
              )}
            </button>
          ))}
        </nav>

        {/* Footer */}
        <div style={{ padding: "12px 14px", borderTop: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 28, height: 28, borderRadius: "50%", background: C.primaryDim, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <User size={13} color={C.primary} />
            </div>
            <div>
              <div style={{ color: C.textPrimary, fontSize: 11, fontWeight: 500 }}>Admin Exevori</div>
              <div style={{ color: C.textTertiary, fontSize: 9 }}>admin@exevori.com</div>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column" }}>
        {/* Top Bar */}
        <div style={{ padding: "14px 20px", background: C.sidebar, borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <div>
            <h1 style={{ color: C.textPrimary, fontSize: 17, fontWeight: 700, margin: 0 }}>{PAGE_TITLES[page]}</h1>
            {page === "dashboard" && <p style={{ color: C.textTertiary, fontSize: 11, margin: "3px 0 0" }}>Activité en temps réel · {CONFIG.org.name} · {CONFIG.org.location}</p>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ background: C.greenDim, border: `1px solid rgba(16,185,129,0.2)`, borderRadius: 8, padding: "5px 12px", display: "flex", alignItems: "center", gap: 6 }}>
              <Wifi size={12} color={C.green} />
              <span style={{ color: C.green, fontSize: 11, fontWeight: 600 }}>IA Active</span>
            </div>
            <div style={{ position: "relative" }}>
              <Bell size={18} color={C.textSecondary} style={{ cursor: "pointer" }} />
              <span style={{ position: "absolute", top: -4, right: -4, width: 15, height: 15, borderRadius: "50%", background: C.red, color: "white", fontSize: 9, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>3</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <div style={{ width: 30, height: 30, borderRadius: "50%", background: C.primaryDim, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <User size={14} color={C.primary} />
              </div>
              <span style={{ color: C.textSecondary, fontSize: 12 }}>Admin</span>
              <ChevronDown size={14} color={C.textTertiary} />
            </div>
          </div>
        </div>

        {/* Page Content */}
        <div style={{ flex: 1, padding: 16, overflowY: "auto" }}>
          {renderPage()}
        </div>
      </div>
    </div>
  );
}
