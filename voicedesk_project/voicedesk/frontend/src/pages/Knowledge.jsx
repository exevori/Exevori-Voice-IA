// ============================================================
// EXEVORI VOICE IA — PAGE KNOWLEDGE (KB+A)
// Upload PDF/DOCX/TXT/MD + Scrape URL + Liste sources + Delete
// ============================================================

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BookOpen, Upload, Link as LinkIcon, FileText, Globe, Trash2,
  Loader2, AlertCircle, CheckCircle2, Sparkles, Pencil, ChevronRight, Brain, RefreshCw,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Button } from "../components/ui/button.jsx";
import { Input } from "../components/ui/input.jsx";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../components/ui/sheet.jsx";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs.jsx";
import DataTable, { RowActionButton } from "../components/common/DataTable.jsx";
import SearchWidget from "../components/kb/SearchWidget.jsx";
import { cn } from "../lib/utils.js";

const API = import.meta.env.VITE_API_URL || "";

const STATUS_META = {
  pending:    { label: "En attente", variant: "ghost",   icon: Loader2 },
  processing: { label: "Traitement", variant: "default", icon: Loader2 },
  ready:      { label: "Prêt",       variant: "green",   icon: CheckCircle2 },
  error:      { label: "Erreur",     variant: "red",     icon: AlertCircle },
};

const TYPE_META = {
  upload: { label: "Fichier", icon: FileText },
  url:    { label: "URL",     icon: Globe },
  manual: { label: "Manuel",  icon: Pencil },
};

export default function Knowledge() {
  const { t, i18n } = useTranslation();
  const { token, effectiveCompanyId, profile } = useAuth();
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("upload");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [scrapeUrl, setScrapeUrl] = useState("");
  const [noteTitle, setNoteTitle] = useState("");
  const [noteBody, setNoteBody] = useState("");

  const load = useCallback(async () => {
    if (!token || !effectiveCompanyId) { setLoading(false); return; }
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/v1/kb/sources?company_id=${effectiveCompanyId}&limit=200`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json();
      setSources(d.sources || []);
    } catch (e) {
      console.error("[KB] load:", e);
    } finally {
      setLoading(false);
    }
  }, [token, effectiveCompanyId]);

  useEffect(() => { load(); }, [load]);

  const handleUpload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("company_id", effectiveCompanyId);
      if (profile?.id) fd.append("created_by", profile.id);
      const r = await fetch(`${API}/api/v1/kb/sources/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setToast({
        type: "success",
        msg: t("kb.toast.uploaded", "{{name}} importé — {{count}} chunks créés", {
          name: file.name, count: d.chunks_count,
        }),
      });
      load();
    } catch (e) {
      setToast({ type: "error", msg: e.message });
    } finally {
      setBusy(false);
    }
  };

  const handleScrape = async () => {
    if (!scrapeUrl.trim()) return;
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/v1/kb/sources/scrape`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          company_id: effectiveCompanyId,
          url: scrapeUrl.trim(),
          created_by: profile?.id || null,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setToast({
        type: "success",
        msg: t("kb.toast.scraped", "URL importée — {{count}} chunks créés", { count: d.chunks_count }),
      });
      setScrapeUrl("");
      load();
    } catch (e) {
      setToast({ type: "error", msg: e.message });
    } finally {
      setBusy(false);
    }
  };

  const handleManualNote = async () => {
    if (!noteTitle.trim() || !noteBody.trim()) return;
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/v1/kb/sources/manual`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          company_id: effectiveCompanyId,
          name: noteTitle.trim(),
          content: noteBody.trim(),
          created_by: profile?.id || null,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setToast({
        type: "success",
        msg: t("kb.toast.manualSaved", "Note « {{name}} » enregistrée — {{count}} chunks créés", {
          name: noteTitle, count: d.chunks_count,
        }),
      });
      setNoteTitle("");
      setNoteBody("");
      load();
    } catch (e) {
      setToast({ type: "error", msg: e.message });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (source) => {
    if (!window.confirm(t("kb.confirmDelete", "Supprimer définitivement « {{name}} » et ses chunks ?", { name: source.name }))) return;
    try {
      const r = await fetch(`${API}/api/v1/kb/sources/${source.id}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(await r.text());
      setSources((arr) => arr.filter((s) => s.id !== source.id));
      setToast({ type: "success", msg: t("kb.toast.deleted", "Source supprimée") });
    } catch (e) {
      setToast({ type: "error", msg: e.message });
    }
  };

  const handleReembed = async (source) => {
    // marker UI: on flag la source comme "reembedding" en local
    setSources((arr) => arr.map((s) => s.id === source.id ? { ...s, _reembedding: true } : s));
    try {
      const r = await fetch(`${API}/api/v1/kb/sources/${source.id}/reembed`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ company_id: effectiveCompanyId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setSources((arr) => arr.map((s) => s.id === source.id
        ? { ...s, _reembedding: false, embeddings_ready_at: d.embeddings_ready_at }
        : s));
      setToast({
        type: "success",
        msg: t("kb.toast.reembedded", "{{name}} ré-indexé — {{count}} chunks", { name: source.name, count: d.embedded_count }),
      });
    } catch (e) {
      setSources((arr) => arr.map((s) => s.id === source.id ? { ...s, _reembedding: false } : s));
      setToast({ type: "error", msg: e.message });
    }
  };

  const totals = useMemo(() => ({
    sources: sources.length,
    chunks:  sources.reduce((acc, s) => acc + (s.chunks_count || 0), 0),
    ready:   sources.filter((s) => s.status === "ready").length,
    indexed: sources.filter((s) => s.embeddings_ready_at).length,
  }), [sources]);

  const hasReadySources = useMemo(
    () => sources.some((s) => s.status === "ready" && s.embeddings_ready_at),
    [sources]
  );

  const columns = useMemo(() => [
    {
      key: "type",
      header: t("kb.col.type", "Type"),
      width: "110px",
      render: (r) => {
        const m = TYPE_META[r.type] || TYPE_META.manual;
        const Icon = m.icon;
        return <Badge variant="ghost" className="text-[10px]"><Icon size={10} /> {m.label}</Badge>;
      },
    },
    {
      key: "name",
      header: t("kb.col.name", "Source"),
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-text-primary">{r.name}</div>
          {r.url && <div className="truncate text-[10px] text-text-tertiary">{r.url}</div>}
        </div>
      ),
    },
    {
      key: "chunks_count",
      header: t("kb.col.chunks", "Chunks"),
      width: "100px",
      render: (r) => (
        <span className="font-mono text-xs text-text-secondary tabular-nums">{r.chunks_count || 0}</span>
      ),
    },
    {
      key: "size_bytes",
      header: t("kb.col.size", "Taille"),
      width: "100px",
      render: (r) => (
        <span className="font-mono text-[11px] text-text-tertiary tabular-nums">{formatBytes(r.size_bytes)}</span>
      ),
    },
    {
      key: "status",
      header: t("kb.col.status", "État"),
      width: "130px",
      render: (r) => <StatusBadge status={r.status} />,
    },
    {
      key: "embeddings_ready_at",
      header: t("kb.col.indexed", "Indexé IA"),
      width: "120px",
      render: (r) => (
        r._reembedding
          ? <Badge variant="default" className="text-[10px]" data-testid={`indexed-busy-${r.id}`}><Loader2 size={10} className="animate-spin" /> {t("kb.indexed.busy", "En cours")}</Badge>
          : r.embeddings_ready_at
            ? <Badge variant="green" className="text-[10px]" data-testid={`indexed-ready-${r.id}`}><Brain size={10} /> {t("kb.indexed.ready", "Indexé")}</Badge>
            : r.status === "ready"
              ? <Badge variant="ghost" className="text-[10px]" data-testid={`indexed-missing-${r.id}`}><AlertCircle size={10} /> {t("kb.indexed.missing", "À indexer")}</Badge>
              : <span className="text-[10px] text-text-tertiary">—</span>
      ),
    },
    {
      key: "created_at",
      header: t("kb.col.imported", "Importé"),
      width: "150px",
      render: (r) => <span className="text-[11px] text-text-tertiary">{formatRelative(r.created_at, i18n.language)}</span>,
    },
  ], [t, i18n.language]);

  return (
    <div className="space-y-5 animate-fade-in" data-testid="kb-page">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-tertiary mb-1">
            <BookOpen size={11} /> {t("kb.kicker", "Base de connaissances")}
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary" data-testid="kb-title">
            {t("kb.title", "Connaissances")}
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            {t("kb.subtitle", "Nourrissez votre assistante : importez vos documents et URLs.")}
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <Stat label={t("kb.stats.sources", "Sources")} value={totals.sources} testId="stat-sources" />
          <Stat label={t("kb.stats.chunks", "Chunks")}   value={totals.chunks}   testId="stat-chunks" />
          <Stat label={t("kb.stats.ready", "Prêts")}     value={totals.ready}    testId="stat-ready" />
          <Stat label={t("kb.stats.indexed", "Indexés")} value={totals.indexed}  testId="stat-indexed" />
        </div>
      </div>

      {/* Ingest panel */}
      <div className="rounded-xl border border-border bg-bg-card/60 backdrop-blur-sm overflow-hidden" data-testid="kb-ingest">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="border-b border-border w-full justify-start rounded-none bg-transparent px-3 pt-3">
            <TabsTrigger value="upload" data-testid="tab-upload">
              <Upload size={12} /> {t("kb.upload.tab", "Téléverser un fichier")}
            </TabsTrigger>
            <TabsTrigger value="url" data-testid="tab-url">
              <LinkIcon size={12} /> {t("kb.url.tab", "Importer depuis une URL")}
            </TabsTrigger>
            <TabsTrigger value="manual" data-testid="tab-manual">
              <Pencil size={12} /> {t("kb.manual.tab", "Note manuelle")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="upload" className="p-4">
            <UploadDropzone onFile={handleUpload} busy={busy} t={t} />
          </TabsContent>

          <TabsContent value="url" className="p-4 space-y-2">
            <label className="text-[11px] uppercase tracking-wider text-text-secondary">
              {t("kb.url.label", "URL publique (page web, doc en ligne)")}
            </label>
            <div className="flex items-center gap-2">
              <Input
                value={scrapeUrl}
                onChange={(e) => setScrapeUrl(e.target.value)}
                placeholder="https://exemple-immobilier.ca/a-propos"
                onKeyDown={(e) => { if (e.key === "Enter" && !busy) handleScrape(); }}
                data-testid="scrape-url-input"
              />
              <Button onClick={handleScrape} disabled={busy || !scrapeUrl.trim()} data-testid="scrape-url-button">
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                {t("kb.url.action", "Importer")}
              </Button>
            </div>
            <p className="text-[11px] text-text-tertiary">
              {t("kb.url.hint", "Le contenu HTML est nettoyé puis découpé en chunks. Les SPAs JS-only ne sont pas supportées en V1.")}
            </p>
          </TabsContent>

          <TabsContent value="manual" className="p-4 space-y-2">
            <label className="text-[11px] uppercase tracking-wider text-text-secondary">
              {t("kb.manual.titleLabel", "Titre de la note")}
            </label>
            <Input
              value={noteTitle}
              onChange={(e) => setNoteTitle(e.target.value)}
              placeholder={t("kb.manual.titlePlaceholder", "Ex: Prix changement pneus hiver 2026")}
              data-testid="manual-title-input"
              maxLength={200}
            />
            <label className="text-[11px] uppercase tracking-wider text-text-secondary block mt-2">
              {t("kb.manual.bodyLabel", "Contenu")}
            </label>
            <textarea
              value={noteBody}
              onChange={(e) => setNoteBody(e.target.value)}
              placeholder={t("kb.manual.bodyPlaceholder", "Tapez ou collez votre note — prix, horaires, FAQs internes, procédures...")}
              data-testid="manual-body-input"
              rows={8}
              className="w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-brand-purple/30 focus:border-brand-purple/50 resize-y"
            />
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-text-tertiary">
                {noteBody.length} {t("kb.manual.chars", "caractères")} · {t("kb.manual.hint", "Minimum 30, maximum 200 000")}
              </p>
              <Button
                onClick={handleManualNote}
                disabled={busy || !noteTitle.trim() || noteBody.trim().length < 30}
                data-testid="manual-submit-button"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Pencil size={14} />}
                {t("kb.manual.action", "Enregistrer la note")}
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {/* Sources table */}
      <DataTable
        testId="kb-sources-table"
        columns={columns}
        data={sources}
        rowKey="id"
        loading={loading}
        onRowClick={(row) => setSelectedId(row.id)}
        rowActions={(row) => (
          <div className="flex items-center gap-1">
            {row.status === "ready" && (
              <RowActionButton
                onClick={() => handleReembed(row)}
                data-testid={`reembed-source-${row.id}`}
                disabled={row._reembedding}
                title={t("kb.reembed.tooltip", "Régénérer les embeddings IA")}
              >
                {row._reembedding ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              </RowActionButton>
            )}
            <RowActionButton onClick={() => setSelectedId(row.id)} data-testid={`view-source-${row.id}`}>
              <ChevronRight size={14} />
            </RowActionButton>
            <RowActionButton onClick={() => handleDelete(row)} data-testid={`delete-source-${row.id}`} className="text-red-300 hover:bg-brand-red/10">
              <Trash2 size={13} />
            </RowActionButton>
          </div>
        )}
        emptyState={{
          icon: BookOpen,
          title: t("kb.empty.title", "Aucune source"),
          description: t("kb.empty.default", "Téléversez un fichier ou collez une URL pour commencer."),
        }}
      />

      <SourceDetailSheet
        sourceId={selectedId}
        open={!!selectedId}
        onClose={() => setSelectedId(null)}
        token={token}
        companyId={effectiveCompanyId}
        t={t}
        onChunkUpdated={load}
      />

      {/* KB+B — Widget "Testez votre IA" */}
      <SearchWidget
        token={token}
        companyId={effectiveCompanyId}
        hasReadySources={hasReadySources}
      />

      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}
    </div>
  );
}

// ─── Subcomponents ─────────────────────────────────────────────
function UploadDropzone({ onFile, busy, t }) {
  const [drag, setDrag] = useState(false);
  const inputRef = React.useRef();
  return (
    <div
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 cursor-pointer transition-all",
        drag ? "border-brand-purple bg-brand-purple/10"
             : "border-border bg-bg-card hover:border-brand-purple/40 hover:bg-white/3"
      )}
      data-testid="upload-dropzone"
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-purple/10 text-brand-purple mb-2">
        {busy ? <Loader2 size={18} className="animate-spin" /> : <Upload size={18} />}
      </div>
      <div className="text-sm font-medium text-text-primary">
        {busy ? t("kb.upload.processing", "Traitement en cours...") : t("kb.upload.drop", "Glissez un fichier ici")}
      </div>
      <div className="mt-0.5 text-[11px] text-text-tertiary">
        {t("kb.upload.hint", "PDF, DOCX, TXT, MD — max 25 Mo")}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.docx,.txt,.md,.markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"
        className="hidden"
        onChange={(e) => onFile(e.target.files[0])}
        data-testid="upload-input"
      />
    </div>
  );
}

function SourceDetailSheet({ sourceId, open, onClose, token, companyId, t, onChunkUpdated }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!sourceId || !token) return;
    setLoading(true);
    fetch(`${API}/api/v1/kb/sources/${sourceId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [sourceId, token]);

  const s = data?.source;
  const chunks = data?.chunks || [];

  const handleChunkSaved = (updated) => {
    setData((prev) => prev ? {
      ...prev,
      chunks: prev.chunks.map((c) => c.id === updated.id ? { ...c, ...updated } : c),
    } : prev);
    if (onChunkUpdated) onChunkUpdated();
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent data-testid="source-detail-sheet" className="overflow-y-auto sm:max-w-2xl">
        {loading || !s ? (
          <>
            <SheetHeader><SheetTitle className="sr-only">Chargement</SheetTitle></SheetHeader>
            <div className="p-6 space-y-3">
              <div className="h-6 w-2/3 rounded bg-white/5 animate-pulse" />
              <div className="h-4 w-1/3 rounded bg-white/5 animate-pulse" />
              <div className="h-32 rounded bg-white/5 animate-pulse" />
            </div>
          </>
        ) : (
          <>
            <SheetHeader>
              <SheetTitle data-testid="source-detail-name">{s.name}</SheetTitle>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <Badge variant="ghost" className="text-[10px]">{TYPE_META[s.type]?.label}</Badge>
                <StatusBadge status={s.status} />
                <span className="text-text-tertiary">{s.chunks_count} chunks · {formatBytes(s.size_bytes)}</span>
              </div>
              {s.error_message && (
                <div className="mt-2 rounded-md border border-brand-red/30 bg-brand-red/10 p-2 text-xs text-red-300">
                  <AlertCircle size={11} className="inline mr-1" /> {s.error_message}
                </div>
              )}
            </SheetHeader>
            <div className="px-6 py-4">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary mb-2">
                {t("kb.detail.chunks", "Aperçu des chunks")} ({chunks.length})
              </h4>
              <ul className="space-y-2" data-testid="chunks-preview">
                {chunks.slice(0, 30).map((c) => (
                  <ChunkRow
                    key={c.id}
                    chunk={c}
                    token={token}
                    companyId={companyId}
                    t={t}
                    onSaved={handleChunkSaved}
                  />
                ))}
                {chunks.length > 30 && (
                  <li className="text-center text-[11px] text-text-tertiary py-2">… +{chunks.length - 30} chunks supplémentaires</li>
                )}
              </ul>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function StatusBadge({ status }) {
  const m = STATUS_META[status] || STATUS_META.pending;
  const Icon = m.icon;
  return (
    <Badge variant={m.variant} className="text-[10px]" data-testid={`source-status-${status}`}>
      <Icon size={10} className={status === "processing" ? "animate-spin" : ""} /> {m.label}
    </Badge>
  );
}

function Stat({ label, value, testId }) {
  return (
    <div
      className="rounded-md border border-border bg-white/3 px-3 py-1.5 text-center"
      data-testid={testId}
      aria-label={`${value} ${label}`}
    >
      <div className="text-base font-bold text-text-primary tabular-nums leading-none">{value}</div>
      <div className="text-[9px] uppercase tracking-wider text-text-tertiary mt-1">{label}</div>
    </div>
  );
}

function Toast({ toast, onClose }) {
  useEffect(() => { const id = setTimeout(onClose, 4500); return () => clearTimeout(id); }, [toast, onClose]);
  return (
    <div
      role="status"
      data-testid="toast"
      className={cn(
        "fixed bottom-6 right-6 z-50 max-w-md rounded-lg border px-4 py-3 text-sm shadow-xl animate-fade-in",
        toast.type === "success" && "border-brand-green/30 bg-brand-green/10 text-emerald-100",
        toast.type === "error"   && "border-brand-red/30   bg-brand-red/10   text-red-200",
        toast.type === "warn"    && "border-brand-orange/30 bg-brand-orange/10 text-amber-100"
      )}
    >
      {toast.msg}
    </div>
  );
}

// Composant chunk éditable (Phase Bonus KB — édition manuelle des chunks)
function ChunkRow({ chunk, token, companyId, t, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(chunk.content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const start = () => { setDraft(chunk.content); setEditing(true); setError(null); };
  const cancel = () => { setEditing(false); setError(null); };

  const save = async () => {
    const txt = draft.trim();
    if (txt.length < 10) { setError(t("kb.chunk.tooShort", "Trop court (< 10 caractères)")); return; }
    if (txt === chunk.content) { setEditing(false); return; }
    setSaving(true); setError(null);
    try {
      const r = await fetch(`${API}/api/v1/kb/chunks/${chunk.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ company_id: companyId, content: txt }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      if (onSaved) onSaved(d.chunk);
      setEditing(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <li
      className={cn("rounded-md border bg-white/3 p-3 transition-colors",
        editing ? "border-brand-purple/40 bg-brand-purple/5" : "border-border hover:border-brand-purple/20"
      )}
      data-testid={`chunk-${chunk.chunk_index}`}
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-mono text-text-tertiary">#{chunk.chunk_index}</span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-text-tertiary">{chunk.token_count} tok</span>
          {!editing ? (
            <button
              onClick={start}
              data-testid={`chunk-edit-${chunk.chunk_index}`}
              className="rounded p-1 text-text-tertiary hover:text-brand-purple hover:bg-brand-purple/10 transition-colors"
              title={t("kb.chunk.edit", "Éditer ce chunk")}
            >
              <Pencil size={11} />
            </button>
          ) : (
            <>
              <button
                onClick={cancel}
                disabled={saving}
                data-testid={`chunk-cancel-${chunk.chunk_index}`}
                className="rounded px-1.5 py-0.5 text-[10px] text-text-tertiary hover:text-text-primary"
              >
                {t("kb.chunk.cancel", "Annuler")}
              </button>
              <button
                onClick={save}
                disabled={saving}
                data-testid={`chunk-save-${chunk.chunk_index}`}
                className="rounded bg-brand-purple/20 px-2 py-0.5 text-[10px] font-medium text-brand-purple hover:bg-brand-purple/30 disabled:opacity-50"
              >
                {saving ? <Loader2 size={10} className="animate-spin inline" /> : t("kb.chunk.save", "Enregistrer")}
              </button>
            </>
          )}
        </div>
      </div>
      {editing ? (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            data-testid={`chunk-edit-textarea-${chunk.chunk_index}`}
            rows={6}
            className="w-full rounded border border-border bg-bg-card px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-2 focus:ring-brand-purple/30 resize-y"
          />
          {error && <div className="mt-1 text-[10px] text-red-300">{error}</div>}
          <div className="mt-1 text-[10px] text-text-tertiary">
            {draft.length} {t("kb.manual.chars", "caractères")}
          </div>
        </>
      ) : (
        <p className="text-xs leading-relaxed text-text-secondary whitespace-pre-wrap break-words line-clamp-6">
          {chunk.content}
        </p>
      )}
    </li>
  );
}

function formatBytes(bytes) {
  if (bytes == null) return "—";
  const n = Number(bytes);
  if (n < 1024)         return `${n} o`;
  if (n < 1024 * 1024)  return `${(n / 1024).toFixed(1)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}
function formatRelative(iso, lang) {
  if (!iso) return "—";
  const locale = lang?.startsWith("fr") ? "fr-CA" : "en-CA";
  const d = new Date(iso);
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (Math.abs(diff) < 60)     return locale === "fr-CA" ? "À l'instant" : "Just now";
  const min = Math.floor(diff / 60);
  if (Math.abs(min) < 60)      return locale === "fr-CA" ? `il y a ${min} min` : `${min} min ago`;
  const h = Math.floor(min / 60);
  if (Math.abs(h) < 24)        return locale === "fr-CA" ? `il y a ${h} h` : `${h} h ago`;
  const days = Math.floor(h / 24);
  if (Math.abs(days) < 7)      return locale === "fr-CA" ? `il y a ${days} j` : `${days} d ago`;
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(d);
}
