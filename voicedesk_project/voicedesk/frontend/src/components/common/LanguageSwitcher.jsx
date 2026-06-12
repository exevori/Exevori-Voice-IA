// ============================================================
// EXEVORI VOICE IA — LANGUAGE SWITCHER (Tailwind)
// ============================================================

import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Globe, Check } from "lucide-react";
import { setLanguage } from "../../i18n";
import { useAuth } from "../../contexts/AuthContext.jsx";

const LANGUAGES = [
  { code: "fr", short: "FR", label: "Français (CA)" },
  { code: "en", short: "EN", label: "English (CA)" },
];

export default function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const current = i18n.language?.startsWith("fr") ? "fr" : "en";

  const handleSelect = async (code) => {
    await setLanguage(code, user?.id);
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        data-testid="lang-switcher-trigger"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-text-secondary hover:text-text-primary hover:bg-white/5 transition-colors"
      >
        <Globe size={14} />
        <span className="text-xs font-semibold">{current.toUpperCase()}</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-40 mt-2 w-44 origin-top-right rounded-lg border border-border bg-bg-elevated/95 backdrop-blur-xl shadow-2xl py-1 animate-fade-in">
            {LANGUAGES.map((lang) => (
              <button
                key={lang.code}
                onClick={() => handleSelect(lang.code)}
                data-testid={`lang-option-${lang.code}`}
                className={`flex w-full items-center justify-between rounded-md px-3 py-1.5 text-xs transition-colors hover:bg-white/5 ${
                  current === lang.code ? "text-text-primary" : "text-text-secondary"
                }`}
              >
                <span>{lang.label}</span>
                {current === lang.code && <Check size={12} className="text-brand-purple" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
