// ============================================================
// EXEVORI VOICE IA — IMPORT CSV WIZARD
// 3 étapes : Upload → Mapping → Résultat
// Mapping dynamique inspiré Pipedrive/HubSpot
// ============================================================

import React, { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Upload, FileText, ChevronRight, ChevronLeft, Check, X,
  AlertTriangle, Loader2, CheckCircle2, Users, Sparkles, RefreshCw,
} from "lucide-react";
import { Button } from "../ui/button.jsx";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "../ui/sheet.jsx";
import { Select } from "../ui/select.jsx";
import { cn } from "../../lib/utils.js";

const API = import.meta.env.VITE_API_URL || "";

// Champs cibles supportés (alignés avec backend mapRowToContact)
const FIELD_OPTIONS = [
  { value: "ignore",       label: "— Ne pas importer —" },
  { value: "full_name",    label: "Nom complet" },
  { value: "first_name",   label: "Prénom" },
  { value: "last_name",    label: "Nom de famille" },
  { value: "email",        label: "Courriel" },
  { value: "phone",        label: "Téléphone" },
  { value: "company",      label: "Entreprise" },
  { value: "status",       label: "Statut (new/cold/warm/hot/customer)" },
  { value: "urgency",      label: "Urgence (low/normal/high)" },
  { value: "main_need",    label: "Besoin principal" },
  { value: "budget",       label: "Budget" },
  { value: "next_action",  label: "Prochaine action" },
  { value: "tags",         label: "Tags (séparés par , ; ou |)" },
  { value: "notes",        label: "Notes" },
];

// ─── Component principal ────────────────────────────────────────
export default function ImportWizard({ open, onClose, companyId, token, onImported }) {
  const { t } = useTranslation();
  const [step, setStep] = useState(1); // 1: upload, 2: mapping, 3: confirm
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [mapping, setMapping] = useState({}); // { csvHeader: field }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [defaultStatus, setDefaultStatus] = useState("new");
  const [duplicateAction, setDuplicateAction] = useState("skip"); // skip | overwrite | create
  const fileInputRef = useRef();

  const reset = () => {
    setStep(1); setFile(null); setPreview(null); setMapping({});
    setError(null); setResult(null);
  };
  const handleClose = () => { reset(); onClose(); };

  const handleFile = async (f) => {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".csv")) {
      setError(t("import.error.csv", "Seuls les fichiers .csv sont acceptés"));
      return;
    }
    setFile(f); setError(null); setLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("company_id", companyId);
      const res = await fetch(`${API}/api/v1/import/preview`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      const d = await res.json();
      setPreview(d);
      // Auto-fill mapping; fallback "ignore" si non détecté
      const initial = {};
      (d.headers || []).forEach((h) => {
        initial[h] = (d.column_mapping && d.column_mapping[h]) || "ignore";
      });
      setMapping(initial);
      setStep(2);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleExecute = async () => {
    if (!file) return;
    setLoading(true); setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("company_id", companyId);
      fd.append("column_mapping", JSON.stringify(mapping));
      fd.append("duplicate_action", duplicateAction);
      fd.append("default_status", defaultStatus);
      fd.append("default_source", "csv_import");
      const res = await fetch(`${API}/api/v1/import/execute`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      const d = await res.json();
      setResult(d);
      setStep(3);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleFinish = () => {
    onImported && onImported(result);
    handleClose();
  };

  // Validation : au moins une colonne mappée vers full_name OU email OU phone
  const mappedFields = useMemo(() => new Set(Object.values(mapping || {})), [mapping]);
  const canImport = mappedFields.has("full_name") || mappedFields.has("email") || mappedFields.has("phone");

  return (
    <Sheet open={open} onOpenChange={(o) => !o && handleClose()}>
      <SheetContent data-testid="import-wizard" className="overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle data-testid="wizard-title">
            {t("import.title", "Importer des contacts depuis un CSV")}
          </SheetTitle>
          <SheetDescription>
            {t("import.subtitle", "Téléversez votre fichier, mappez les colonnes, puis importez.")}
          </SheetDescription>

          {/* Stepper */}
          <div className="flex items-center justify-between mt-4">
            {[1, 2, 3].map((s) => (
              <React.Fragment key={s}>
                <div className="flex items-center gap-2">
                  <div className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-colors",
                    step === s ? "gradient-brand text-white shadow-glow-purple" :
                    step > s   ? "bg-brand-green/20 text-brand-green" :
                                 "bg-white/5 text-text-tertiary"
                  )}>
                    {step > s ? <Check size={12} /> : s}
                  </div>
                  <span className={cn(
                    "text-[11px] uppercase tracking-wider",
                    step === s ? "text-text-primary font-semibold" : "text-text-tertiary"
                  )}>
                    {s === 1 ? t("import.step.upload", "Téléverser") :
                     s === 2 ? t("import.step.mapping", "Mapping") :
                                t("import.step.confirm", "Résultat")}
                  </span>
                </div>
                {s < 3 && <div className="flex-1 mx-2 h-px bg-border" />}
              </React.Fragment>
            ))}
          </div>
        </SheetHeader>

        <div className="px-6 py-5">
          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-brand-red/30 bg-brand-red/10 px-3 py-2.5 text-sm text-red-300" data-testid="wizard-error">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {step === 1 && <UploadStep onPick={handleFile} fileInputRef={fileInputRef} loading={loading} t={t} />}
          {step === 2 && preview && (
            <MappingStep
              preview={preview}
              mapping={mapping}
              setMapping={setMapping}
              defaultStatus={defaultStatus}
              setDefaultStatus={setDefaultStatus}
              duplicateAction={duplicateAction}
              setDuplicateAction={setDuplicateAction}
              loading={loading}
              canImport={canImport}
              onBack={reset}
              onExecute={handleExecute}
              t={t}
            />
          )}
          {step === 3 && result && <ConfirmStep result={result} onFinish={handleFinish} t={t} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Step 1 : Upload ────────────────────────────────────────────
function UploadStep({ onPick, fileInputRef, loading, t }) {
  const [dragging, setDragging] = useState(false);
  return (
    <div className="space-y-4" data-testid="step-upload">
      <div
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) onPick(f); }}
        className={cn(
          "flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-12 cursor-pointer transition-all",
          dragging
            ? "border-brand-purple bg-brand-purple/10"
            : "border-border bg-bg-card hover:border-brand-purple/40 hover:bg-white/3"
        )}
        data-testid="drop-zone"
      >
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-purple/10 text-brand-purple mb-3">
          {loading ? <Loader2 size={22} className="animate-spin" /> : <Upload size={22} />}
        </div>
        <div className="text-sm font-medium text-text-primary">
          {loading ? t("import.uploading", "Analyse en cours...") : t("import.drop", "Glissez votre fichier CSV ici")}
        </div>
        <div className="mt-1 text-xs text-text-tertiary">
          {t("import.dropHint", "ou cliquez pour parcourir — max 10 Mo")}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => onPick(e.target.files[0])}
          data-testid="file-input"
        />
      </div>

      <div className="rounded-lg border border-border bg-white/3 p-3">
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <Sparkles size={12} className="text-brand-purple" />
          <span className="font-medium text-text-primary">{t("import.tip.title", "Conseil")}</span>
        </div>
        <p className="mt-1 text-xs text-text-tertiary">
          {t("import.tip.body", "Votre CSV doit comporter une ligne d'en-tête (Nom, Email, Téléphone, etc.). Le mappage sera auto-détecté et modifiable.")}
        </p>
      </div>
    </div>
  );
}

// ─── Step 2 : Mapping ───────────────────────────────────────────
function MappingStep({
  preview, mapping, setMapping,
  defaultStatus, setDefaultStatus,
  duplicateAction, setDuplicateAction,
  loading, canImport, onBack, onExecute, t,
}) {
  const setMap = (header, field) => setMapping((m) => ({ ...m, [header]: field }));

  // Compter combien de colonnes mappées
  const mappedCount = Object.values(mapping).filter((v) => v && v !== "ignore").length;

  return (
    <div className="space-y-4" data-testid="step-mapping">
      {/* Récap fichier */}
      <div className="grid grid-cols-3 gap-2">
        <RecapStat label={t("import.recap.rows", "Lignes")} value={preview.total_rows} testId="recap-rows" />
        <RecapStat label={t("import.recap.columns", "Colonnes")} value={preview.headers?.length || 0} testId="recap-cols" />
        <RecapStat
          label={t("import.recap.duplicates", "Doublons")}
          value={preview.potential_duplicates || 0}
          testId="recap-dup"
          tone={preview.potential_duplicates > 0 ? "warn" : "neutral"}
        />
      </div>

      {/* Mapping */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
            {t("import.mapping.title", "Mappage des colonnes")}
          </h4>
          <span className="text-[10px] text-text-tertiary tabular-nums">
            {mappedCount}/{preview.headers?.length || 0} {t("import.mapping.mapped", "mappées")}
          </span>
        </div>

        <div className="space-y-2">
          {preview.headers.map((h) => {
            const sampleVals = preview.preview
              .slice(0, 3)
              .map((r) => r[h])
              .filter((v) => v != null && v !== "")
              .map((v) => String(v).slice(0, 30));
            return (
              <div
                key={h}
                className="flex items-center gap-2.5 rounded-lg border border-border bg-bg-card px-3 py-2"
                data-testid={`mapping-row-${h}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="truncate text-xs font-medium text-text-primary">{h}</div>
                  <div className="truncate text-[10px] text-text-tertiary">
                    {sampleVals.length ? `ex : ${sampleVals.join(" · ")}` : "—"}
                  </div>
                </div>
                <ChevronRight size={12} className="text-text-tertiary shrink-0" />
                <div className="w-48 shrink-0">
                  <Select
                    value={mapping[h] || "ignore"}
                    onValueChange={(v) => setMap(h, v)}
                    options={FIELD_OPTIONS}
                    placeholder={null}
                    testId={`select-${h}`}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Options globales */}
      <div className="grid grid-cols-2 gap-3 pt-2">
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
            {t("import.mapping.defaultStatus", "Statut par défaut")}
          </label>
          <div className="mt-1.5">
            <Select
              value={defaultStatus}
              onValueChange={setDefaultStatus}
              options={[
                { value: "new",      label: "Nouveau" },
                { value: "cold",     label: "Froid" },
                { value: "warm",     label: "Tiède" },
                { value: "hot",      label: "Chaud" },
                { value: "customer", label: "Client" },
              ]}
              placeholder={null}
              testId="default-status"
            />
          </div>
        </div>
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
            {t("import.mapping.duplicates", "Si doublon")}
          </label>
          <div className="mt-1.5">
            <Select
              value={duplicateAction}
              onValueChange={setDuplicateAction}
              options={[
                { value: "skip",      label: "Ignorer" },
                { value: "overwrite", label: "Écraser le contact existant" },
                { value: "create",    label: "Créer un nouveau contact" },
              ]}
              placeholder={null}
              testId="duplicate-action"
            />
          </div>
        </div>
      </div>

      {!canImport && (
        <div className="flex items-start gap-2 rounded-lg border border-brand-orange/30 bg-brand-orange/10 px-3 py-2 text-xs text-amber-200">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>
            {t("import.mapping.needId", "Au moins une colonne doit être mappée à : Nom complet, Courriel ou Téléphone.")}
          </span>
        </div>
      )}

      <div className="flex items-center justify-between pt-3 border-t border-border">
        <Button variant="ghost" onClick={onBack} disabled={loading} data-testid="wizard-back">
          <ChevronLeft size={14} /> {t("common.back", "Retour")}
        </Button>
        <Button onClick={onExecute} disabled={loading || !canImport} data-testid="wizard-import">
          {loading
            ? <><Loader2 size={14} className="animate-spin" /> {t("import.importing", "Import en cours...")}</>
            : <>{t("import.execute", "Importer")} <ChevronRight size={14} /></>}
        </Button>
      </div>
    </div>
  );
}

// ─── Step 3 : Confirm / Résultat ────────────────────────────────
function ConfirmStep({ result, onFinish, t }) {
  return (
    <div className="space-y-4 text-center py-2" data-testid="step-confirm">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-green/15 text-brand-green">
        <CheckCircle2 size={28} />
      </div>
      <div>
        <h3 className="text-lg font-bold text-text-primary">{t("import.done.title", "Import terminé")}</h3>
        <p className="mt-1 text-sm text-text-secondary">
          {t("import.done.subtitle", "Voici un récapitulatif :")}
        </p>
      </div>

      <div className="grid grid-cols-4 gap-2">
        <ResultStat icon={Users}          value={result.imported || 0} label={t("import.done.imported", "Importés")} color="green"   testId="res-imported" />
        <ResultStat icon={RefreshCw}      value={result.updated  || 0} label={t("import.done.updated",  "Mis à jour")} color="blue"    testId="res-updated" />
        <ResultStat icon={X}              value={result.skipped  || 0} label={t("import.done.skipped",  "Ignorés")}  color="text-tertiary" testId="res-skipped" />
        <ResultStat icon={AlertTriangle}  value={result.errors?.length || 0} label={t("import.done.errors", "Erreurs")} color="red"  testId="res-errors" />
      </div>

      {result.errors?.length > 0 && (
        <div className="rounded-lg border border-brand-red/20 bg-brand-red/5 p-3 text-left max-h-40 overflow-y-auto">
          <div className="text-[11px] font-semibold uppercase text-brand-red mb-1.5">
            {t("import.done.errorsTitle", "Détails erreurs")}
          </div>
          <ul className="space-y-1 text-xs text-text-secondary">
            {result.errors.slice(0, 10).map((e, i) => (
              <li key={i}>Ligne {e.row}: {e.message}</li>
            ))}
          </ul>
        </div>
      )}

      <Button onClick={onFinish} className="w-full" data-testid="wizard-finish">
        <Check size={14} /> {t("common.done", "Terminé")}
      </Button>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────
function RecapStat({ label, value, testId, tone = "neutral" }) {
  const tones = {
    neutral: "border-border bg-white/3 text-text-primary",
    warn:    "border-brand-orange/30 bg-brand-orange/10 text-amber-200",
  };
  return (
    <div className={cn("rounded-lg border p-2.5 text-center", tones[tone])} data-testid={testId}>
      <div className="text-lg font-bold tabular-nums">{value}</div>
      <div className="text-[10px] uppercase tracking-wider opacity-80 mt-0.5">{label}</div>
    </div>
  );
}

function ResultStat({ icon: Icon, value, label, color, testId }) {
  const colorMap = {
    green:           "bg-brand-green/10 text-brand-green border-brand-green/20",
    blue:            "bg-brand/10 text-brand border-brand/20",
    red:             "bg-brand-red/10 text-brand-red border-brand-red/20",
    "text-tertiary": "bg-white/3 text-text-tertiary border-border",
  };
  return (
    <div className={cn("rounded-lg border p-3 text-center", colorMap[color])} data-testid={testId}>
      <Icon size={16} className="mx-auto mb-1" />
      <div className="text-xl font-bold tabular-nums">{value}</div>
      <div className="text-[10px] uppercase tracking-wider opacity-80 mt-0.5">{label}</div>
    </div>
  );
}
