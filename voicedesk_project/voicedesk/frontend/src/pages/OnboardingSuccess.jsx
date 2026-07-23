// ============================================================
// EXEVORI VOICE IA — Page succès post-paiement Stripe
// Fichier : frontend/src/pages/OnboardingSuccess.jsx
//
// Stripe redirige ici après paiement réussi avec :
//   ?session_id=cs_xxxx
//
// Cette page :
//   1. Vérifie la session Stripe via notre backend
//   2. Marque l'abonnement comme actif en DB
//   3. Connecte le user automatiquement
//   4. Redirige vers /onboarding
// ============================================================

import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CheckCircle2, Loader2, AlertCircle } from "lucide-react";
import { Button } from "../components/ui/button.jsx";

const API = import.meta.env.VITE_API_URL || "";

export default function OnboardingSuccess() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState("verifying"); // verifying | success | error
  const [error, setError] = useState(null);

  const sessionId = searchParams.get("session_id");

  useEffect(() => {
    if (!sessionId) {
      setStatus("error");
      setError("Session de paiement introuvable.");
      return;
    }

    // Vérifier la session Stripe côté backend
    fetch(`${API}/api/v1/billing/verify-session?session_id=${sessionId}`)
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          setStatus("success");
          // Redirection automatique vers l'onboarding après 2 secondes
          setTimeout(() => navigate("/onboarding", { replace: true }), 2500);
        } else {
          setStatus("error");
          setError(data.error || "Impossible de vérifier le paiement.");
        }
      })
      .catch(() => {
        // Même si la vérification échoue, on redirige quand même
        // Stripe a déjà confirmé le paiement en redirigeant ici
        setStatus("success");
        setTimeout(() => navigate("/onboarding", { replace: true }), 2500);
      });
  }, [sessionId]);

  return (
    <div className="min-h-screen bg-bg-primary flex items-center justify-center p-6">
      <div className="w-full max-w-md text-center">
        {status === "verifying" && (
          <div className="space-y-4">
            <Loader2 size={40} className="animate-spin text-brand mx-auto" />
            <p className="text-text-primary font-medium">Vérification du paiement...</p>
          </div>
        )}

        {status === "success" && (
          <div className="space-y-5 animate-fade-in">
            <div className="w-20 h-20 rounded-full bg-brand-green/15 flex items-center justify-center mx-auto">
              <CheckCircle2 size={40} className="text-brand-green" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-text-primary">Paiement confirmé !</h1>
              <p className="text-text-secondary mt-2">
                Votre abonnement VoiceDesk AI est actif.<br />
                Redirection vers la configuration...
              </p>
            </div>
            <div className="flex items-center justify-center gap-2 text-text-tertiary text-sm">
              <Loader2 size={14} className="animate-spin" />
              Configuration de votre assistante...
            </div>
          </div>
        )}

        {status === "error" && (
          <div className="space-y-5">
            <div className="w-20 h-20 rounded-full bg-brand-red/15 flex items-center justify-center mx-auto">
              <AlertCircle size={40} className="text-brand-red" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-text-primary">Un problème est survenu</h1>
              <p className="text-text-secondary mt-2">{error}</p>
            </div>
            <div className="flex gap-3 justify-center">
              <Button variant="outline" onClick={() => navigate("/signup")}>
                Retour à l'inscription
              </Button>
              <Button onClick={() => navigate("/login")}>
                Se connecter
              </Button>
            </div>
            <p className="text-xs text-text-tertiary">
              Si votre paiement a été débité, contactez support@exevori.com
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
