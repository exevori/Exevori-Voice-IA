import React, { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, Wrench } from "lucide-react";
import { Button } from "../ui/button.jsx";
import { Badge } from "../ui/badge.jsx";
import { requestAdminJson } from "../../utils/admin-company.js";
import { PROVISIONING_CHECK_LABELS, provisioningDetail, provisioningSummary } from "../../utils/provisioning-health.js";

const API = import.meta.env.VITE_API_URL || "";

export default function ProvisioningHealthPanel({ companyId, token, disabled = false, onBusy, onChanged }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState("");
  const requestId = useRef(null);
  const reader = useRef(null);

  const load = useCallback(async () => {
    reader.current?.abort();
    const controller = new AbortController(); reader.current = controller;
    setLoading(true); setError(null); setReport(null); setConfirm(false);
    try {
      const value = await requestAdminJson(`${API}/api/v1/admin/companies/${companyId}/provisioning-health`, { token, signal: controller.signal });
      if (!controller.signal.aborted) setReport(value);
    } catch (err) { if (!controller.signal.aborted) setError(err.message); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [companyId, token]);

  useEffect(() => { void load(); return () => reader.current?.abort(); }, [load]);

  async function repair(event) {
    event.preventDefault();
    if (busy || disabled) return;
    setBusy(true); onBusy(true); setError(null); setNotice(null);
    try {
      const result = await requestAdminJson(`${API}/api/v1/admin/companies/${companyId}/provisioning-repair`, {
        token, method: "POST", headers: { "X-Request-Id": requestId.current },
        body: JSON.stringify({ confirm_company_id: companyId, reason: reason.trim() }),
      });
      setReport(result.health); setConfirm(false);
      setNotice(result.success ? (result.changed ? "Réparation vérifiée. Aucun numéro acheté, aucun agent créé." : "Les ressources étaient déjà cohérentes.")
        : "Réparation non entièrement confirmée. Consultez les contrôles ci-dessous.");
      onChanged();
    } catch (err) {
      setReport(null); setConfirm(false);
      setError(`${err.message} Relancez le diagnostic avant toute nouvelle tentative.`);
    } finally { setBusy(false); onBusy(false); }
  }

  const summary = provisioningSummary(report);
  return <section className="space-y-3 border-t border-border pt-3" aria-label="Diagnostic du provisionnement">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="text-sm font-semibold text-text-primary">Diagnostic du provisionnement</h4>
      <Button size="sm" variant="outline" disabled={loading || busy || disabled} onClick={() => void load()}><RefreshCw size={13} /> Vérifier</Button>
    </div>
    {loading && <p role="status" className="flex items-center gap-2 text-xs text-text-secondary"><Loader2 size={13} className="animate-spin" /> Vérification des ressources chez les fournisseurs…</p>}
    {error && <p role="alert" className="text-sm text-brand-red">{error}</p>}
    {notice && <p role="status" className="text-sm text-text-primary">{notice}</p>}
    {report && <>
      <div className="flex flex-wrap items-center gap-2"><Badge variant={summary.variant}>{summary.label}</Badge><span className="text-xs text-text-tertiary">{new Date(report.checked_at).toLocaleString("fr-CA")}</span></div>
      <ul className="space-y-2">{report.checks.map(row => <li key={row.key} className="text-xs">
        <span className="font-semibold text-text-primary">{PROVISIONING_CHECK_LABELS[row.key]} : </span>
        <span className={row.state === "ok" ? "text-text-secondary" : "text-brand-orange"}>{provisioningDetail(row.code)}</span>
        {row.issues?.length > 1 && <ul className="ml-4 mt-1 list-disc text-text-secondary">{row.issues.slice(1).map(issue => <li key={issue}>{provisioningDetail(issue)}</li>)}</ul>}
      </li>)}</ul>
      {report.repair?.available && !confirm && <Button size="sm" variant="outline" disabled={busy || disabled} onClick={() => {
        setConfirm(true); setReason(""); requestId.current = crypto.randomUUID();
      }}><Wrench size={13} /> Réparer</Button>}
      {!report.repair?.available && summary.variant !== "green" && <p className="text-xs text-text-tertiary">Réparation automatique bloquée. Corrigez l’accès fournisseur ou faites vérifier les références par Exevori.</p>}
    </>}
    {confirm && <form onSubmit={repair} className="space-y-2 rounded-lg border border-brand/30 p-3">
      <p className="text-xs text-text-secondary">Confirmer la restauration des références manquantes, la liaison du numéro non assigné ou la réconciliation de l’état de provisionnement. Aucun achat, suppression ou remplacement d’agent. Ne modifiez pas les ressources dans les dashboards fournisseurs pendant cette opération.</p>
      <label className="block text-xs text-text-secondary">Motif<textarea required minLength={3} maxLength={500} disabled={busy} value={reason} onChange={event => setReason(event.target.value)} className="mt-1 w-full rounded-lg border border-border bg-bg-input p-2 text-sm text-text-primary" /></label>
      <div className="flex gap-2"><Button size="sm" type="submit" disabled={busy || disabled || reason.trim().length < 3}>{busy && <Loader2 size={13} className="animate-spin" />}Confirmer la réparation</Button><Button size="sm" type="button" variant="ghost" disabled={busy} onClick={() => setConfirm(false)}>Annuler</Button></div>
    </form>}
    <p className="text-xs text-text-tertiary">Contrôle de configuration, pas un appel de test réel. Une incohérence d’identité ou une ressource absente exige une intervention manuelle.</p>
  </section>;
}
