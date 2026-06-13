// ============================================================
// EXEVORI VOICE IA — SEARCH WIDGET (Phase KB+B)
// "Testez votre IA" — semantic search live sur knowledge_chunks
//
// Affiche les 3 chunks les plus pertinents avec score % + nom source.
// Réutilisé en Phase 8 (Léa utilise searchSimilarChunks() côté backend).
// ============================================================

import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, Search, FileText, Globe, Loader2, AlertCircle, Pencil } from "lucide-react";
import { Input } from "../ui/input.jsx";
import { Button } from "../ui/button.jsx";

const API = import.meta.env.VITE_API_URL || "";

const TYPE_ICON = { upload: FileText, url: Globe, manual: Pencil };

export default function SearchWidget({ token, companyId, hasReadySources }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [latency, setLatency] = useState(null);
  const [hasSearched, setHasSearched] = useState(false);

  const runSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    setError(null);
    setResults([]);
    try {
      const r = await fetch(`${API}/api/v1/kb/sources/search`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ company_id: companyId, query: q, topK: 3 }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setResults(d.results || []);
      setLatency(d.latency_ms);
      setHasSearched(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="rounded-xl border border-brand-purple/30 bg-gradient-to-br from-brand-purple/5 via-bg-card/60 to-bg-card/40 backdrop-blur-sm p-5"
      data-testid="kb-search-widget"
    >
      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-purple/15 text-brand-purple">
          <Sparkles size={14} />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-text-primary">
            {t("kb.search.title", "Testez votre IA")}
          </h3>
          <p className="text-[11px] text-text-tertiary">
            {t("kb.search.subtitle", "Posez une question comme un client le ferait au téléphone — voyez ce que Léa retrouvera.")}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("kb.search.placeholder", "Ex: Quels sont vos prix pour les pneus dhiver?")}
          onKeyDown={(e) => { if (e.key === "Enter" && !busy) runSearch(); }}
          disabled={!hasReadySources || busy}
          data-testid="search-widget-input"
        />
        <Button
          onClick={runSearch}
          disabled={!hasReadySources || busy || !query.trim()}
          data-testid="search-widget-button"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
          {t("kb.search.action", "Tester")}
        </Button>
      </div>

      {!hasReadySources && (
        <p className="text-[11px] text-amber-300/80 flex items-center gap-1.5" data-testid="search-widget-empty-hint">
          <AlertCircle size={11} /> {t("kb.search.noSources", "Importez d'abord au moins une source pour tester.")}
        </p>
      )}

      {error && (
        <div className="mt-2 rounded-md border border-brand-red/30 bg-brand-red/10 p-2 text-xs text-red-300" data-testid="search-widget-error">
          <AlertCircle size={11} className="inline mr-1" /> {error}
        </div>
      )}

      {hasSearched && !busy && !error && results.length === 0 && (
        <div className="mt-3 rounded-md border border-border bg-white/3 p-3 text-xs text-text-secondary" data-testid="search-widget-no-results">
          {t("kb.search.noResults", "Aucun chunk pertinent trouvé. Essayez de reformuler ou enrichissez votre base de connaissances.")}
        </div>
      )}

      {results.length > 0 && (
        <div className="mt-3 space-y-2" data-testid="search-widget-results">
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-1">
            {t("kb.search.resultsLabel", "Top {{n}} chunks pertinents", { n: results.length })}
            {latency != null && <span className="ml-2 font-mono normal-case tracking-normal text-text-tertiary/70">· {latency}ms</span>}
          </div>
          {results.map((r, i) => {
            const Icon = TYPE_ICON[r.source_type] || FileText;
            const pct = Math.round((r.similarity || 0) * 100);
            const pctColor = pct >= 75 ? "text-emerald-300 bg-emerald-500/10 border-emerald-500/30"
                          : pct >= 50 ? "text-amber-300 bg-amber-500/10 border-amber-500/30"
                          : "text-text-tertiary bg-white/5 border-border";
            return (
              <div
                key={r.chunk_id}
                className="rounded-md border border-border bg-white/3 p-3 transition-colors hover:border-brand-purple/30"
                data-testid={`search-result-${i}`}
              >
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <div className="flex items-center gap-1.5 text-[11px] text-text-secondary min-w-0">
                    <Icon size={11} className="shrink-0 text-text-tertiary" />
                    <span className="truncate" data-testid={`search-result-${i}-source`}>{r.source_name}</span>
                    <span className="font-mono text-[10px] text-text-tertiary shrink-0">#{r.chunk_index}</span>
                  </div>
                  <span
                    className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] tabular-nums ${pctColor}`}
                    data-testid={`search-result-${i}-score`}
                  >
                    {pct}%
                  </span>
                </div>
                <p className="text-xs leading-relaxed text-text-secondary whitespace-pre-wrap break-words line-clamp-5" data-testid={`search-result-${i}-content`}>
                  {r.content}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
