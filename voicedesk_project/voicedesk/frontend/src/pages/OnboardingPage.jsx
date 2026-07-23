// ============================================================
// EXEVORI VOICE IA — Page Onboarding client (5 étapes)
// Fichier : frontend/src/pages/Onboarding.jsx
// ============================================================

import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext.jsx";
import {
  Bot, Volume2, BookOpen, Phone, CheckCircle2,
  Loader2, ArrowRight, ArrowLeft, Sparkles
} from "lucide-react";
import { Button } from "../components/ui/button.jsx";

const API = import.meta.env.VITE_API_URL || "";

const STEPS = [
  { id: 1, label: "Votre assistante",  icon: Bot,          desc: "Nom, ton et personnalité" },
  { id: 2, label: "Voix",              icon: Volume2,       desc: "Choisir la voix de l'assistante" },
  { id: 3, label: "Connaissances",     icon: BookOpen,      desc: "Services et FAQ de base" },
  { id: 4, label: "Activation",        icon: Phone,         desc: "Obtenir votre numéro de téléphone" },
  { id: 5, label: "Prêt !",            icon: CheckCircle2,  desc: "Votre assistante est en ligne" },
];

export default function Onboarding() {
  const { token, effectiveCompanyId } = useAuth();
  const navigate = useNavigate();

  const [currentStep, setCurrentStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [provisionResult, setProvisionResult] = useState(null);
  const [error, setError] = useState(null);

  // Étape 1
  const [assistantName, setAssistantName] = useState("Léa");
  const [tone, setTone] = useState("professional");

  // Étape 2
  const [voices, setVoices] = useState([]);
  const [selectedVoice, setSelectedVoice] = useState(null);

  // Étape 3
  const [faqEntries, setFaqEntries] = useState([
    { question: "", answer: "" },
  ]);

  // Étape 4 — provisioning
  const [areaCode, setAreaCode] = useState("581");

  // Charger les voix disponibles
  useEffect(() => {
    if (currentStep === 2 && token) {
      fetch(`${API}/api/v1/voice-library?active=true`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(r => r.json())
        .then(d => setVoices(d.voices || []))
        .catch(() => {});
    }
  }, [currentStep, token]);

  const post = async (path, body) => {
    const res = await fetch(`${API}/api/v1/onboarding${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ company_id: effectiveCompanyId, ...body }),
    });
    if (!res.ok) {
      const d = await res.json();
      throw new Error(d.error || "Erreur serveur");
    }
    return res.json();
  };

  const nextStep = async () => {
    setError(null);
    setLoading(true);
    try {
      if (currentStep === 1) {
        await post("/step/1", { assistant_name: assistantName, tone });
      } else if (currentStep === 2) {
        if (!selectedVoice) throw new Error("Veuillez choisir une voix");
        await post("/step/2", { voice_library_id: selectedVoice });
      } else if (currentStep === 3) {
        const entries = faqEntries.filter(e => e.question && e.answer);
        await post("/step/3", { knowledge_entries: entries.map(e => ({ ...e, category: "FAQ" })) });
      } else if (currentStep === 4) {
        // Provisioning — peut prendre 15-30 secondes
        setProvisioning(true);
        const result = await post("/step/5", { area_code: areaCode });
        setProvisionResult(result);
        setProvisioning(false);
      }
      setCurrentStep(s => Math.min(s + 1, 5));
    } catch (err) {
      setError(err.message);
      setProvisioning(false);
    } finally {
      setLoading(false);
    }
  };

  const addFaqEntry = () => setFaqEntries(e => [...e, { question: "", answer: "" }]);
  const updateFaq = (i, field, val) =>
    setFaqEntries(e => e.map((entry, idx) => idx === i ? { ...entry, [field]: val } : entry));
  const removeFaq = (i) => setFaqEntries(e => e.filter((_, idx) => idx !== i));

  // ── Rendu des étapes ──────────────────────────────────────
  const renderStep = () => {
    switch (currentStep) {
      case 1:
        return (
          <div className="space-y-4">
            <div>
              <label className="text-xs text-text-tertiary block mb-1.5">Nom de votre assistante</label>
              <input
                value={assistantName}
                onChange={e => setAssistantName(e.target.value)}
                placeholder="Ex: Léa, Sophie, Marie..."
                className="w-full rounded-lg border border-border bg-bg-input px-3 py-2 text-sm text-text-primary outline-none focus:border-brand"
              />
              <p className="text-[11px] text-text-tertiary mt-1">Ce nom sera utilisé pour se présenter aux appelants.</p>
            </div>
            <div>
              <label className="text-xs text-text-tertiary block mb-1.5">Ton de l'assistante</label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { key: "professional", label: "Professionnel" },
                  { key: "friendly",     label: "Chaleureux" },
                  { key: "formal",       label: "Formel" },
                ].map(t => (
                  <button key={t.key} onClick={() => setTone(t.key)}
                    className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                      tone === t.key
                        ? "border-brand bg-brand/10 text-brand font-medium"
                        : "border-border text-text-secondary hover:border-brand/50"
                    }`}>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        );

      case 2:
        return (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              Choisissez la voix qui représentera votre entreprise.
            </p>
            {voices.length === 0 ? (
              <div className="flex items-center gap-2 text-text-tertiary text-sm py-4">
                <Loader2 size={15} className="animate-spin" /> Chargement des voix...
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2 max-h-72 overflow-y-auto pr-1">
                {voices.map(v => (
                  <button key={v.id} onClick={() => setSelectedVoice(v.id)}
                    className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors ${
                      selectedVoice === v.id
                        ? "border-brand bg-brand/10"
                        : "border-border hover:border-brand/50"
                    }`}>
                    <Volume2 size={16} className={selectedVoice === v.id ? "text-brand" : "text-text-tertiary"} />
                    <div>
                      <p className="text-sm font-medium text-text-primary">{v.display_name || v.name}</p>
                      <p className="text-xs text-text-tertiary">{v.accent || v.gender || "—"} · {v.languages_supported?.[0] || "fr-CA"}</p>
                    </div>
                    {selectedVoice === v.id && <CheckCircle2 size={16} className="ml-auto text-brand" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        );

      case 3:
        return (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              Ajoutez les questions-réponses de base pour que votre assistante puisse répondre correctement.
            </p>
            <div className="space-y-3 max-h-72 overflow-y-auto pr-1">
              {faqEntries.map((entry, i) => (
                <div key={i} className="rounded-lg border border-border p-3 space-y-2">
                  <input
                    value={entry.question}
                    onChange={e => updateFaq(i, "question", e.target.value)}
                    placeholder="Question du client (ex: Quels sont vos horaires ?)"
                    className="w-full rounded border border-border bg-bg-input px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-brand"
                  />
                  <textarea
                    value={entry.answer}
                    onChange={e => updateFaq(i, "answer", e.target.value)}
                    placeholder="Réponse de votre assistante..."
                    rows={2}
                    className="w-full rounded border border-border bg-bg-input px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-brand resize-none"
                  />
                  {faqEntries.length > 1 && (
                    <button onClick={() => removeFaq(i)} className="text-[11px] text-brand-red hover:underline">Supprimer</button>
                  )}
                </div>
              ))}
            </div>
            <Button variant="outline" size="sm" onClick={addFaqEntry}>
              + Ajouter une question
            </Button>
            <p className="text-[11px] text-text-tertiary">Vous pourrez en ajouter d'autres depuis la Base de connaissances.</p>
          </div>
        );

      case 4:
        return (
          <div className="space-y-4">
            <div className="rounded-xl border border-brand/20 bg-brand/5 p-4">
              <div className="flex items-start gap-3">
                <Phone size={20} className="text-brand mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-text-primary">Activation automatique</p>
                  <p className="text-sm text-text-secondary mt-1 leading-relaxed">
                    On va automatiquement acheter un numéro de téléphone québécois et configurer votre assistante.
                    Ça prend environ 20-30 secondes.
                  </p>
                </div>
              </div>
            </div>
            <div>
              <label className="text-xs text-text-tertiary block mb-1.5">Préférence de code régional</label>
              <div className="flex gap-2">
                {["581", "418", "514"].map(code => (
                  <button key={code} onClick={() => setAreaCode(code)}
                    className={`rounded-lg border px-4 py-2 text-sm font-mono transition-colors ${
                      areaCode === code ? "border-brand bg-brand/10 text-brand" : "border-border text-text-secondary"
                    }`}>
                    +1 ({code})
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-text-tertiary mt-1.5">Si le code régional choisi n'est pas disponible, on prendra le suivant automatiquement.</p>
            </div>
            {provisioning && (
              <div className="flex items-center gap-3 rounded-lg border border-border bg-bg-card p-4">
                <Loader2 size={18} className="animate-spin text-brand" />
                <div>
                  <p className="text-sm font-medium text-text-primary">Provisioning en cours...</p>
                  <p className="text-xs text-text-tertiary mt-0.5">Achat du numéro + configuration de l'agent IA</p>
                </div>
              </div>
            )}
          </div>
        );

      case 5:
        return (
          <div className="text-center space-y-4 py-4">
            <div className="flex justify-center">
              <div className="w-16 h-16 rounded-full bg-brand-green/15 flex items-center justify-center">
                <CheckCircle2 size={32} className="text-brand-green" />
              </div>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-text-primary">Votre assistante est prête !</h3>
              {provisionResult?.phone_number && (
                <p className="text-2xl font-mono font-bold text-brand mt-2">{provisionResult.phone_number}</p>
              )}
              <p className="text-sm text-text-secondary mt-2">
                C'est votre nouveau numéro professionnel. Partagez-le avec vos clients — {assistantName} répondra 24/7.
              </p>
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-brand-green/20 bg-brand-green/5 px-4 py-3">
              <Sparkles size={14} className="text-brand-green" />
              <p className="text-sm text-brand-green font-medium">
                Appelez votre nouveau numéro pour tester {assistantName} maintenant !
              </p>
            </div>
            <Button onClick={() => navigate("/dashboard")} className="gap-2">
              Aller au tableau de bord <ArrowRight size={14} />
            </Button>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-bg-tertiary flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="text-center mb-8">
          <p className="text-xs text-text-tertiary uppercase tracking-wider mb-1">VoiceDesk AI</p>
          <h1 className="text-2xl font-bold text-text-primary">Configuration de votre assistante</h1>
        </div>

        {/* Stepper */}
        <div className="flex items-center justify-center gap-0 mb-8 overflow-x-auto pb-2">
          {STEPS.map((step, i) => {
            const Icon = step.icon;
            const done = currentStep > step.id;
            const active = currentStep === step.id;
            return (
              <React.Fragment key={step.id}>
                <div className="flex flex-col items-center gap-1 min-w-[60px]">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
                    done   ? "bg-brand-green text-white" :
                    active ? "bg-brand text-white" :
                             "bg-white/5 border border-border text-text-tertiary"
                  }`}>
                    {done ? <CheckCircle2 size={14} /> : <Icon size={14} />}
                  </div>
                  <span className={`text-[10px] text-center leading-tight ${active ? "text-text-primary font-medium" : "text-text-tertiary"}`}>
                    {step.label}
                  </span>
                </div>
                {i < STEPS.length - 1 && (
                  <div className={`h-0.5 flex-1 min-w-[20px] mx-1 mb-4 transition-colors ${currentStep > step.id ? "bg-brand-green" : "bg-border"}`} />
                )}
              </React.Fragment>
            );
          })}
        </div>

        {/* Card */}
        <div className="rounded-xl border border-border bg-bg-card p-6 shadow-sm">
          {currentStep < 5 && (
            <div className="mb-5">
              <h2 className="text-base font-semibold text-text-primary">{STEPS[currentStep - 1]?.label}</h2>
              <p className="text-xs text-text-tertiary mt-0.5">{STEPS[currentStep - 1]?.desc}</p>
            </div>
          )}

          {renderStep()}

          {error && (
            <div className="mt-4 rounded-lg border border-brand-red/20 bg-brand-red/5 px-3 py-2.5">
              <p className="text-sm text-brand-red">{error}</p>
            </div>
          )}

          {currentStep < 5 && (
            <div className="flex items-center justify-between mt-6 pt-4 border-t border-border">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCurrentStep(s => Math.max(s - 1, 1))}
                disabled={currentStep === 1 || loading}
                className="gap-1"
              >
                <ArrowLeft size={13} /> Retour
              </Button>
              <Button
                onClick={nextStep}
                disabled={loading || provisioning}
                className="gap-2"
              >
                {loading || provisioning
                  ? <><Loader2 size={14} className="animate-spin" /> {currentStep === 4 ? "Activation..." : "Sauvegarde..."}</>
                  : <>{currentStep === 4 ? "Activer mon assistante" : "Continuer"} <ArrowRight size={13} /></>
                }
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
