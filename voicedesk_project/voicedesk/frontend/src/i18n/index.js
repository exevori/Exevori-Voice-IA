// ============================================================
// VOICEDESK IA — SETUP i18n (Frontend)
//
// Inspiré de : github.com/i18next/react-i18next
// Stack : i18next + react-i18next + LanguageDetector
//
// Ordre de détection :
//   1. localStorage (choix précédent de l'utilisateur)
//   2. user.preferred_language (depuis le profile Supabase)
//   3. navigator.language (langue du navigateur)
//   4. Défaut : fr-CA
// ============================================================

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import frTranslations from "./locales/fr.json";
import enTranslations from "./locales/en.json";

const SUPPORTED_LANGUAGES = ["fr-CA", "en-CA"];

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      "fr-CA": { translation: frTranslations },
      "fr":    { translation: frTranslations },  // Alias fallback
      "en-CA": { translation: enTranslations },
      "en":    { translation: enTranslations },  // Alias fallback
    },
    fallbackLng: "fr-CA",
    supportedLngs: SUPPORTED_LANGUAGES,
    nonExplicitSupportedLngs: true, // accepte "fr" → "fr-CA"

    detection: {
      order: ["localStorage", "navigator", "htmlTag"],
      lookupLocalStorage: "voicedesk_language",
      caches: ["localStorage"],
    },

    interpolation: {
      escapeValue: false, // React s'en occupe déjà
      format: function (value, format, lng) {
        if (format === "currency") {
          return new Intl.NumberFormat(lng, {
            style: "currency",
            currency: lng.startsWith("fr") ? "CAD" : "CAD",
          }).format(value);
        }
        if (format === "date") {
          return new Intl.DateTimeFormat(lng, {
            dateStyle: "long",
          }).format(new Date(value));
        }
        if (format === "datetime") {
          return new Intl.DateTimeFormat(lng, {
            dateStyle: "short",
            timeStyle: "short",
          }).format(new Date(value));
        }
        return value;
      },
    },

    react: {
      useSuspense: false,
    },

    debug: false,
  });

// Helper : changer de langue + sauvegarder préférence côté serveur
export async function setLanguage(lng, userId = null) {
  await i18n.changeLanguage(lng);
  localStorage.setItem("voicedesk_language", lng);

  // Sauvegarder dans le profil utilisateur si connecté
  if (userId) {
    try {
      await fetch("/api/v1/auth/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferred_language: lng }),
      });
    } catch (err) {
      console.error("Failed to save language preference:", err);
    }
  }
}

// Helper : initialiser la langue depuis le profil utilisateur après login
export function initLanguageFromProfile(profile) {
  if (profile?.preferred_language) {
    i18n.changeLanguage(profile.preferred_language);
    localStorage.setItem("voicedesk_language", profile.preferred_language);
  }
}

export { SUPPORTED_LANGUAGES };
export default i18n;
