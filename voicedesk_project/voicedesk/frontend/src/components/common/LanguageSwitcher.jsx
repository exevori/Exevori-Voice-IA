// ============================================================
// VOICEDESK IA — LANGUAGE SWITCHER
// Bascule FR/EN avec sauvegarde de la préférence
// ============================================================

import React from "react";
import { useTranslation } from "react-i18next";
import { Globe, Check } from "lucide-react";
import { setLanguage } from "../../i18n";
import { useAuth } from "../../contexts/AuthContext.jsx";

export default function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const { user } = useAuth();
  const [open, setOpen] = React.useState(false);

  const currentLang = i18n.language.startsWith("fr") ? "fr-CA" : "en-CA";

  const languages = [
    { code: "fr-CA", label: "Français", flag: "🇨🇦" },
    { code: "en-CA", label: "English",  flag: "🇨🇦" },
  ];

  const handleSelect = async (code) => {
    await setLanguage(code, user?.id);
    setOpen(false);
  };

  return (
    <div className="language-switcher">
      <button
        className="lang-toggle"
        onClick={() => setOpen(!open)}
        title="Change language"
      >
        <Globe size={18} />
        <span>{currentLang === "fr-CA" ? "FR" : "EN"}</span>
      </button>

      {open && (
        <>
          <div className="lang-backdrop" onClick={() => setOpen(false)} />
          <div className="lang-dropdown">
            {languages.map(lang => (
              <button
                key={lang.code}
                className={"lang-option" + (currentLang === lang.code ? " active" : "")}
                onClick={() => handleSelect(lang.code)}
              >
                <span>{lang.flag}</span>
                <span>{lang.label}</span>
                {currentLang === lang.code && <Check size={14} />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
