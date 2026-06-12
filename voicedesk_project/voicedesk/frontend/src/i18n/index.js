// ============================================================
// EXEVORI VOICE IA — SETUP i18n (Frontend)
// Stack : i18next + react-i18next + LanguageDetector
// ============================================================

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import frTranslations from "./locales/fr.json";
import enTranslations from "./locales/en.json";

const SUPPORTED_LANGUAGES = ["fr", "en"];
export const LANGUAGE_LABELS = { fr: "Français (CA)", en: "English (CA)" };

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      fr: { translation: frTranslations },
      en: { translation: enTranslations },
    },
    fallbackLng: "fr",
    lng: "fr",
    supportedLngs: SUPPORTED_LANGUAGES,
    nonExplicitSupportedLngs: true,
    load: "languageOnly",

    detection: {
      order: ["localStorage", "htmlTag", "navigator"],
      lookupLocalStorage: "voicedesk_language",
      caches: ["localStorage"],
    },

    interpolation: {
      escapeValue: false,
      format: function (value, format, lng) {
        if (format === "currency") {
          return new Intl.NumberFormat(lng === "fr" ? "fr-CA" : "en-CA", {
            style: "currency",
            currency: "CAD",
          }).format(value);
        }
        if (format === "date") {
          return new Intl.DateTimeFormat(lng === "fr" ? "fr-CA" : "en-CA", {
            dateStyle: "long",
          }).format(new Date(value));
        }
        if (format === "datetime") {
          return new Intl.DateTimeFormat(lng === "fr" ? "fr-CA" : "en-CA", {
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

// Map les valeurs server-side (fr-CA / en-CA) vers nos codes simplifiés (fr / en)
function normalizeLng(lng) {
  if (!lng) return "fr";
  const short = String(lng).toLowerCase().split("-")[0];
  return SUPPORTED_LANGUAGES.includes(short) ? short : "fr";
}

export async function setLanguage(lng, userId = null) {
  const norm = normalizeLng(lng);
  await i18n.changeLanguage(norm);
  localStorage.setItem("voicedesk_language", norm);

  if (userId) {
    try {
      await fetch("/api/v1/auth/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferred_language: norm === "fr" ? "fr-CA" : "en-CA" }),
      });
    } catch (err) {
      console.error("Failed to save language preference:", err);
    }
  }
}

export function initLanguageFromProfile(profile) {
  if (profile?.preferred_language) {
    const norm = normalizeLng(profile.preferred_language);
    i18n.changeLanguage(norm);
    localStorage.setItem("voicedesk_language", norm);
  }
}

export { SUPPORTED_LANGUAGES };
export default i18n;
