// ============================================================
// EXEVORI VOICE IA — Landing Page publique
// Fichier : frontend/src/pages/Landing.jsx
// Route : / (racine publique, AVANT ProtectedRoute)
//
// Inspiré de : cruip/open-react-template (MIT)
// Adapté pour VoiceDesk AI — PME québécoises
// ============================================================

import React, { useState } from "react";
import { Link } from "react-router-dom";
import {
  Phone, Mail, Calendar, Bot, CheckCircle2, ArrowRight,
  Mic, Star, ChevronDown, ChevronUp, Zap, Shield, Clock,
  BarChart3, Users, Globe,
} from "lucide-react";

// ── HERO ─────────────────────────────────────────────────────
function Hero() {
  return (
    <section className="relative overflow-hidden pt-28 pb-20 px-6 text-center">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-0 h-[50vh] w-[80vw] -translate-x-1/2 rounded-full bg-brand-purple/20 blur-[100px]" />
        <div className="absolute bottom-0 right-0 h-[30vh] w-[40vw] rounded-full bg-brand/10 blur-[100px]" />
      </div>
      <div className="relative z-10 max-w-3xl mx-auto">
        <div className="inline-flex items-center gap-2 rounded-full border border-brand/20 bg-brand/10 px-4 py-1.5 text-xs text-brand font-medium mb-6">
          <Zap size={11}/> Nouvelle génération de réception téléphonique IA
        </div>
        <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold text-text-primary leading-tight mb-6">
          Votre réceptionniste IA<br />
          <span className="gradient-text">disponible 24/7</span>
        </h1>
        <p className="text-lg text-text-secondary max-w-xl mx-auto mb-8 leading-relaxed">
          VoiceDesk AI répond à vos appels, prend vos rendez-vous, qualifie vos prospects
          et enrichit votre CRM — pendant que vous travaillez.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link to="/signup"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-6 py-3.5 text-sm font-semibold text-white hover:bg-brand/90 transition-colors">
            Commencer gratuitement <ArrowRight size={15}/>
          </Link>
          <a href="#demo"
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-border px-6 py-3.5 text-sm font-semibold text-text-secondary hover:border-brand hover:text-brand transition-colors">
            <Mic size={15}/> Écouter une démonstration
          </a>
        </div>
        <p className="text-xs text-text-tertiary mt-4">
          14 jours d'essai gratuit · Aucune carte requise · Annulable en tout temps
        </p>
      </div>

      {/* Hero visual — dashboard mockup */}
      <div className="relative z-10 max-w-4xl mx-auto mt-14">
        <div className="rounded-2xl border border-border bg-bg-card/80 backdrop-blur p-4 shadow-2xl">
          <div className="flex items-center gap-1.5 mb-3">
            <div className="w-2.5 h-2.5 rounded-full bg-brand-red/60"/>
            <div className="w-2.5 h-2.5 rounded-full bg-brand-orange/60"/>
            <div className="w-2.5 h-2.5 rounded-full bg-brand-green/60"/>
            <span className="text-[10px] text-text-tertiary ml-2">VoiceDesk AI — Tableau de bord</span>
          </div>
          <div className="grid grid-cols-4 gap-2 mb-3">
            {[
              { label: "Appels aujourd'hui", value: "128", trend: "+18%" },
              { label: "RDV pris",           value: "24",  trend: "+26%" },
              { label: "Prospects qualifiés", value: "19", trend: "+30%" },
              { label: "Taux résolution",     value: "84%", trend: "+5%" },
            ].map(k => (
              <div key={k.label} className="rounded-lg bg-bg-secondary p-2.5">
                <p className="text-[9px] text-text-tertiary">{k.label}</p>
                <p className="text-base font-bold text-text-primary">{k.value}</p>
                <p className="text-[10px] text-brand-green">{k.trend}</p>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-bg-secondary p-3">
              <p className="text-[10px] text-text-tertiary mb-2 flex items-center gap-1"><Phone size={9}/> Appels en direct — 3 actifs</p>
              {["Sarah Mitchell", "David Thompson", "Marc Gagnon"].map((n, i) => (
                <div key={n} className="flex items-center justify-between py-1 border-b border-border last:border-0">
                  <span className="text-[11px] text-text-primary">{n}</span>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${i === 2 ? "bg-brand-orange/15 text-brand-orange" : "bg-brand-green/15 text-brand-green"}`}>
                    {i === 2 ? "En attente" : "En cours"}
                  </span>
                </div>
              ))}
            </div>
            <div className="rounded-lg bg-bg-secondary p-3">
              <p className="text-[10px] text-text-tertiary mb-2 flex items-center gap-1"><Calendar size={9}/> Prochains rendez-vous</p>
              {[
                { name: "Acme Corp",    time: "10:00", type: "Démo produit" },
                { name: "BrightPath",   time: "14:30", type: "Consultation" },
                { name: "NovaTech",     time: "Demain", type: "Suivi client" },
              ].map(apt => (
                <div key={apt.name} className="flex items-center justify-between py-1 border-b border-border last:border-0">
                  <div>
                    <p className="text-[11px] text-text-primary">{apt.name}</p>
                    <p className="text-[9px] text-text-tertiary">{apt.type}</p>
                  </div>
                  <span className="text-[10px] font-mono text-brand">{apt.time}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── LOGOS ─────────────────────────────────────────────────────
function TrustBar() {
  return (
    <section className="py-8 px-6 border-y border-border bg-bg-secondary/50">
      <div className="max-w-4xl mx-auto text-center">
        <p className="text-xs text-text-tertiary uppercase tracking-wider mb-4">
          Fait confiance par des PME québécoises
        </p>
        <div className="flex flex-wrap justify-center gap-6 items-center text-text-tertiary text-sm font-medium">
          {["Garage Tremblay", "Clinique Santé Laval", "Avocat Côté & Associés",
            "Réno-Expert", "Assurances Martin"].map(n => (
            <span key={n} className="opacity-50 hover:opacity-80 transition-opacity">{n}</span>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── FEATURES ──────────────────────────────────────────────────
const FEATURES = [
  {
    icon: Phone, color: "text-brand", bg: "bg-brand/10",
    title: "Répond à vos appels 24/7",
    desc: "Votre assistante IA décroche en moins d'une seconde, se présente en français québécois et gère la conversation comme une vraie réceptionniste.",
  },
  {
    icon: Calendar, color: "text-brand-purple", bg: "bg-brand-purple/10",
    title: "Planifie vos rendez-vous",
    desc: "Détecte les demandes de rendez-vous, collecte les disponibilités et crée automatiquement l'entrée dans votre calendrier.",
  },
  {
    icon: Users, color: "text-brand-green", bg: "bg-brand-green/10",
    title: "Qualifie vos prospects",
    desc: "Pose les bonnes questions, identifie les besoins, évalue l'urgence et enrichit votre CRM avec des fiches contacts complètes.",
  },
  {
    icon: Mail, color: "text-brand-orange", bg: "bg-brand-orange/10",
    title: "Gère vos courriels",
    desc: "Classe automatiquement les courriels entrants et prépare des brouillons de réponse pour votre approbation.",
  },
  {
    icon: BarChart3, color: "text-brand", bg: "bg-brand/10",
    title: "Rapports hebdomadaires",
    desc: "Chaque lundi, recevez un résumé de l'activité de votre assistante : appels, RDV, prospects et temps économisé.",
  },
  {
    icon: Shield, color: "text-brand-purple", bg: "bg-brand-purple/10",
    title: "Sécurisé et conforme",
    desc: "Données hébergées au Canada, conformes à la Loi 25 du Québec. Isolation complète entre les clients.",
  },
];

function Features() {
  return (
    <section className="py-20 px-6" id="features">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-12">
          <h2 className="text-3xl sm:text-4xl font-bold text-text-primary mb-3">
            Tout ce qu'il faut pour ne rien perdre
          </h2>
          <p className="text-text-secondary max-w-xl mx-auto">
            VoiceDesk AI gère vos appels, courriels et rendez-vous pendant que vous vous concentrez sur votre métier.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {FEATURES.map(f => {
            const Icon = f.icon;
            return (
              <div key={f.title} className="rounded-xl border border-border bg-bg-card p-5 hover:border-brand/30 transition-colors">
                <div className={`inline-flex rounded-lg p-2.5 ${f.bg} mb-3`}>
                  <Icon size={18} className={f.color}/>
                </div>
                <h3 className="text-sm font-semibold text-text-primary mb-1.5">{f.title}</h3>
                <p className="text-xs text-text-secondary leading-relaxed">{f.desc}</p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// ── DEMO ──────────────────────────────────────────────────────
function Demo() {
  return (
    <section className="py-16 px-6 bg-bg-secondary/50 border-y border-border" id="demo">
      <div className="max-w-3xl mx-auto text-center">
        <h2 className="text-2xl sm:text-3xl font-bold text-text-primary mb-3">
          Écoutez Léa en action
        </h2>
        <p className="text-text-secondary mb-8 text-sm">
          Appelez directement notre numéro de démonstration et parlez à Léa.
        </p>
        <div className="inline-flex items-center gap-4 rounded-2xl border border-brand/20 bg-brand/5 px-8 py-6">
          <div className="w-12 h-12 rounded-full gradient-brand flex items-center justify-center shadow-lg">
            <Bot size={22} className="text-white"/>
          </div>
          <div className="text-left">
            <p className="text-xs text-text-tertiary">Numéro de démo</p>
            <p className="text-2xl font-bold font-mono text-text-primary tracking-wider">+1 (581) 700-4171</p>
            <p className="text-xs text-text-secondary mt-0.5">Répondra en français québécois · Gratuit depuis le Canada</p>
          </div>
        </div>
        <p className="text-xs text-text-tertiary mt-4">
          Posez-lui une question sur VoiceDesk, demandez un devis, ou testez une prise de rendez-vous.
        </p>
      </div>
    </section>
  );
}

// ── PRICING ───────────────────────────────────────────────────
const PLANS = [
  {
    name: "Solo",
    price: 79,
    desc: "Travailleur autonome, 1-3 employés",
    features: ["150 min d'appels/mois", "CRM basique", "Prise de RDV", "Rapport hebdo"],
    cta: "Commencer",
    popular: false,
  },
  {
    name: "Démarrage",
    price: 159,
    desc: "PME de 1 à 5 employés",
    features: ["400 min d'appels/mois", "CRM complet", "Gestion des courriels", "Suggestions KB", "Support prioritaire"],
    cta: "Commencer",
    popular: true,
  },
  {
    name: "Essentiel",
    price: 319,
    desc: "PME de 5 à 15 employés",
    features: ["1000 min d'appels/mois", "Tout Démarrage inclus", "Appels sortants", "Rapports avancés", "Onboarding dédié"],
    cta: "Commencer",
    popular: false,
  },
];

function Pricing() {
  return (
    <section className="py-20 px-6" id="pricing">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-12">
          <h2 className="text-3xl sm:text-4xl font-bold text-text-primary mb-3">
            Un prix simple, transparent
          </h2>
          <p className="text-text-secondary text-sm">
            14 jours d'essai gratuit sur tous les forfaits. Frais d'installation uniques inclus.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {PLANS.map(plan => (
            <div key={plan.name} className={`rounded-2xl border p-6 relative ${
              plan.popular
                ? "border-brand bg-brand/5 shadow-lg shadow-brand/10"
                : "border-border bg-bg-card"
            }`}>
              {plan.popular && (
                <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 bg-brand text-white text-[10px] font-bold px-3 py-1 rounded-full">
                  LE PLUS POPULAIRE
                </div>
              )}
              <h3 className="text-base font-bold text-text-primary mb-0.5">{plan.name}</h3>
              <p className="text-xs text-text-tertiary mb-4">{plan.desc}</p>
              <div className="flex items-baseline gap-1 mb-5">
                <span className="text-3xl font-bold text-text-primary">{plan.price}$</span>
                <span className="text-xs text-text-tertiary">CAD/mois</span>
              </div>
              <ul className="space-y-2 mb-6">
                {plan.features.map(f => (
                  <li key={f} className="flex items-start gap-2 text-xs text-text-secondary">
                    <CheckCircle2 size={13} className="text-brand-green shrink-0 mt-0.5"/>
                    {f}
                  </li>
                ))}
              </ul>
              <Link to="/signup"
                className={`block text-center rounded-xl py-2.5 text-sm font-semibold transition-colors ${
                  plan.popular
                    ? "bg-brand text-white hover:bg-brand/90"
                    : "border border-border text-text-secondary hover:border-brand hover:text-brand"
                }`}>
                {plan.cta} <ArrowRight size={13} className="inline ml-1"/>
              </Link>
            </div>
          ))}
        </div>
        <p className="text-center text-xs text-text-tertiary mt-6">
          TPS/TVQ calculées automatiquement pour le Canada · Paiement sécurisé via Stripe
        </p>
      </div>
    </section>
  );
}

// ── FAQ ────────────────────────────────────────────────────────
const FAQ = [
  { q: "Est-ce que VoiceDesk fonctionne avec mon numéro actuel ?", a: "Vous recevez un nouveau numéro québécois (418 ou 581) qui est attribué à votre assistante. Vous pouvez rediriger votre numéro actuel vers ce nouveau numéro, ou le donner directement à vos clients." },
  { q: "L'assistante parle-t-elle vraiment en français québécois ?", a: "Oui. Léa est configurée pour parler en français québécois avec des expressions naturelles. Vous pouvez personnaliser son nom, son ton et ses réponses types depuis votre dashboard." },
  { q: "Que se passe-t-il si mon assistante ne sait pas répondre ?", a: "Léa dit honnêtement qu'elle va transmettre la demande à votre équipe. Elle collecte les coordonnées du client et vous envoie une notification. Elle ne génère jamais de fausses informations." },
  { q: "Puis-je essayer avant de payer ?", a: "Oui — 14 jours d'essai gratuit, sans carte de crédit requise. Vous pouvez appeler votre nouveau numéro dès la fin de la configuration (environ 5 minutes)." },
  { q: "Mes données sont-elles sécurisées ?", a: "Toutes les données sont hébergées au Canada (Supabase Montreal), conformes à la Loi 25 du Québec. Chaque client a ses propres données isolées — aucun partage entre clients." },
];

function FaqSection() {
  const [open, setOpen] = useState(null);
  return (
    <section className="py-20 px-6 bg-bg-secondary/30 border-t border-border" id="faq">
      <div className="max-w-2xl mx-auto">
        <h2 className="text-2xl sm:text-3xl font-bold text-text-primary text-center mb-10">Questions fréquentes</h2>
        <div className="space-y-2">
          {FAQ.map((item, i) => (
            <div key={i} className="rounded-xl border border-border bg-bg-card overflow-hidden">
              <button onClick={() => setOpen(open === i ? null : i)}
                className="w-full flex items-center justify-between px-5 py-4 text-left">
                <span className="text-sm font-medium text-text-primary">{item.q}</span>
                {open === i ? <ChevronUp size={15} className="text-text-tertiary shrink-0 ml-3"/> : <ChevronDown size={15} className="text-text-tertiary shrink-0 ml-3"/>}
              </button>
              {open === i && (
                <div className="px-5 pb-4">
                  <p className="text-sm text-text-secondary leading-relaxed">{item.a}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── CTA FINAL ─────────────────────────────────────────────────
function CTA() {
  return (
    <section className="py-20 px-6 text-center">
      <div className="max-w-xl mx-auto">
        <div className="w-14 h-14 rounded-2xl gradient-brand flex items-center justify-center mx-auto mb-5 shadow-lg">
          <Bot size={26} className="text-white"/>
        </div>
        <h2 className="text-3xl sm:text-4xl font-bold text-text-primary mb-3">
          Prêt à ne plus manquer un appel ?
        </h2>
        <p className="text-text-secondary mb-8 text-sm">
          Votre assistante IA sera prête en moins de 5 minutes. Aucune compétence technique requise.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link to="/signup"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-6 py-3.5 text-sm font-semibold text-white hover:bg-brand/90 transition-colors">
            Commencer gratuitement <ArrowRight size={15}/>
          </Link>
          <a href="mailto:contact@exevori.com"
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-border px-6 py-3.5 text-sm font-semibold text-text-secondary hover:border-brand hover:text-brand transition-colors">
            Parler à notre équipe
          </a>
        </div>
        <p className="text-xs text-text-tertiary mt-4">14 jours gratuits · Sans carte de crédit</p>
      </div>
    </section>
  );
}

// ── HEADER / FOOTER ───────────────────────────────────────────
function Header() {
  return (
    <header className="fixed top-0 left-0 right-0 z-50 border-b border-border bg-bg-primary/80 backdrop-blur-lg">
      <div className="max-w-5xl mx-auto flex items-center justify-between px-6 h-16">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg gradient-brand flex items-center justify-center">
            <Bot size={16} className="text-white"/>
          </div>
          <span className="text-sm font-bold tracking-wide gradient-text">VoiceDesk AI</span>
          <span className="hidden sm:block text-[10px] text-text-tertiary tracking-wider">by Exevori</span>
        </div>
        <nav className="hidden md:flex items-center gap-6 text-sm text-text-secondary">
          <a href="#features" className="hover:text-text-primary transition-colors">Fonctionnalités</a>
          <a href="#demo"     className="hover:text-text-primary transition-colors">Démo</a>
          <a href="#pricing"  className="hover:text-text-primary transition-colors">Tarifs</a>
          <a href="#faq"      className="hover:text-text-primary transition-colors">FAQ</a>
        </nav>
        <div className="flex items-center gap-2">
          <Link to="/login"  className="text-sm text-text-secondary hover:text-text-primary transition-colors px-3 py-1.5">Connexion</Link>
          <Link to="/signup" className="text-sm font-semibold bg-brand text-white px-4 py-1.5 rounded-lg hover:bg-brand/90 transition-colors">
            Essai gratuit
          </Link>
        </div>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="border-t border-border py-8 px-6">
      <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-text-tertiary">
        <div className="flex items-center gap-2">
          <Bot size={13} className="text-brand"/>
          <span>VoiceDesk AI par <strong>Exevori</strong> — Lévis, Québec</span>
        </div>
        <div className="flex gap-4">
          <Link to="/login"    className="hover:text-text-primary transition-colors">Connexion</Link>
          <Link to="/signup"   className="hover:text-text-primary transition-colors">Inscription</Link>
          <a href="mailto:contact@exevori.com" className="hover:text-text-primary transition-colors">Contact</a>
          <a href="#"          className="hover:text-text-primary transition-colors">Confidentialité</a>
        </div>
        <span>© {new Date().getFullYear()} Exevori Inc.</span>
      </div>
    </footer>
  );
}

// ── EXPORT ────────────────────────────────────────────────────
export default function Landing() {
  return (
    <div className="min-h-screen bg-bg-primary font-sans">
      <Header />
      <main>
        <Hero />
        <TrustBar />
        <Features />
        <Demo />
        <Pricing />
        <FaqSection />
        <CTA />
      </main>
      <Footer />
    </div>
  );
}
