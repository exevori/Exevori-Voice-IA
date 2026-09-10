// ============================================================
// EXEVORI VOICE IA — IMPERSONATION SWITCHER
// Permet au super_admin de "View as PME" pour les démos
// ============================================================

import React, { useEffect, useState } from "react";
import { Building2, Eye, X, ChevronDown } from "lucide-react";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { requestAdminJson } from "../../utils/admin-company.js";
import { Button } from "../ui/button.jsx";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "../ui/sheet.jsx";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "../ui/dropdown-menu.jsx";

export default function ImpersonationSwitcher() {
  const { token, impersonatedCompany, impersonateCompany, impersonationSession, impersonationError } = useAuth();
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selected,setSelected] = useState(null);
  const [reason,setReason] = useState("");
  const [requestId,setRequestId] = useState(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");

  useEffect(() => {
    if (!token || impersonatedCompany) return;
    const controller = new AbortController();
    setLoading(true);
    requestAdminJson(`${import.meta.env.VITE_API_URL || ""}/api/v1/admin/companies`,{token,signal:controller.signal})
      .then((d) => setCompanies(d.companies || []))
      .catch(err => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token,impersonatedCompany]);

  const handleSelect = (c) => {
    setSelected(c); setReason(""); setError(""); setRequestId(crypto.randomUUID());
  };

  const handleExit = async () => {
    setBusy(true); setError("");
    try { await impersonateCompany(null); window.location.href = "/admin"; }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  const confirm = async event => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try { await impersonateCompany(selected,reason.trim(),requestId); window.location.href = "/dashboard"; }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  if (impersonatedCompany) {
    return (
      <div
        className="flex items-center gap-2 rounded-lg border border-brand-purple/30 bg-brand-purple/10 px-3 py-1.5 text-xs"
        data-testid="impersonation-active"
      >
        <Eye size={14} className="text-brand-purple" />
        <span className="text-text-secondary">Vue PME :</span>
        <span className="font-medium text-text-primary">{impersonatedCompany.name}</span>
        <span className="text-text-tertiary">jusqu’à {new Date(impersonationSession.expires_at).toLocaleTimeString("fr-CA",{hour:"2-digit",minute:"2-digit"})}</span>
        {(error || impersonationError) && <span role="alert" className="text-brand-red">{error || impersonationError}</span>}
        <button
          onClick={handleExit}
          disabled={busy}
          className="ml-1 rounded p-0.5 text-text-tertiary hover:text-text-primary hover:bg-white/5 transition-colors"
          title="Terminer la vue client et enregistrer sa fin"
          data-testid="impersonation-exit"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  return (
    <><DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          data-testid="impersonation-trigger"
          className="flex items-center gap-2 rounded-lg border border-border bg-white/3 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary hover:border-border-strong transition-all"
        >
          <Building2 size={14} />
          <span>Voir comme PME</span>
          <ChevronDown size={12} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>Vue client auditée — 30 minutes</DropdownMenuLabel>
        {error && <p role="alert" className="p-3 text-xs text-brand-red">{error}</p>}
        <DropdownMenuSeparator />
        {loading && (
          <div className="px-3 py-2 text-xs text-text-tertiary">Chargement…</div>
        )}
        {!loading && companies.length === 0 && (
          <div className="px-3 py-2 text-xs text-text-tertiary">Aucune PME enregistrée</div>
        )}
        {!loading &&
          companies.map((c) => (
            <DropdownMenuItem
              key={c.id}
              onSelect={() => handleSelect(c)}
              data-testid={`impersonation-option-${c.id}`}
              className="cursor-pointer"
            >
              <Building2 size={14} className="text-brand-purple" />
              <div className="flex-1">
                <div className="font-medium text-text-primary">{c.name}</div>
                <div className="text-[10px] text-text-tertiary">
                  {[c.city, c.country].filter(Boolean).join(", ")} • {c.plan || "—"}
                </div>
              </div>
            </DropdownMenuItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
    <Sheet open={!!selected} onOpenChange={open=>{if(!open && !busy)setSelected(null);}}>
      <SheetContent>
        <SheetHeader><SheetTitle>Ouvrir la vue de {selected?.name}</SheetTitle>
          <SheetDescription>Le début, la fin et les actions sont journalisés sous votre identité administrateur. L’accès est limité à cette entreprise.</SheetDescription>
        </SheetHeader>
        <form onSubmit={confirm} className="space-y-4 p-6">
          <label className="block text-sm text-text-primary">Motif de l’accès
            <textarea required minLength={3} maxLength={500} value={reason} onChange={e=>setReason(e.target.value)} className="mt-2 w-full rounded border border-border bg-bg-input p-3" />
          </label>
          <p className="text-xs text-text-secondary">N’inscrivez aucun secret ni renseignement personnel dans le motif.</p>
          {error && <p role="alert" className="text-brand-red">{error}</p>}
          <Button disabled={busy || reason.trim().length < 3} type="submit">{busy ? "Ouverture…" : "Confirmer la vue client"}</Button>
        </form>
      </SheetContent>
    </Sheet></>
  );
}
