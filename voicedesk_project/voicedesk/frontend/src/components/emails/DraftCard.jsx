// ============================================================
// EXEVORI VOICE IA — DRAFT CARD (composant réutilisable)
// Validation humaine de brouillons IA (emails, SMS Phase 10+, post-call Phase 8+).
//
// Props :
//  - draft: { id, subject, body, to_email, ai_confidence, ai_reasoning, status, created_at }
//  - sourceLabel: ex. "Re: Demande devis pneus" (sujet email source)
//  - sourceMeta: ex. { name: "Marie Lavoie", email: "...", summary: "..." }
//  - onApprove: (id, { body, subject }) → Promise
//  - onReject:  (id, reason) → Promise
//  - onRegenerate: (id, instruction) → Promise
//  - onSaveEdit: (id, { body, subject }) → Promise
//
// État interne :
//  - mode: "view" | "edit"
//  - busy: action en cours
// ============================================================

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check, X, RefreshCcw, Pencil, Save, AlertCircle,
  Sparkles, Loader2, Mail, MessageSquare,
} from "lucide-react";
import { Button } from "../ui/button.jsx";
import { Badge } from "../ui/badge.jsx";
import { Textarea } from "../ui/textarea.jsx";
import { Input } from "../ui/input.jsx";
import { cn } from "../../lib/utils.js";

export default function DraftCard({
  draft,
  sourceLabel,
  sourceMeta,
  onApprove,
  onReject,
  onRegenerate,
  onSaveEdit,
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState("view");
  const [body, setBody] = useState(draft.body || "");
  const [subject, setSubject] = useState(draft.subject || "");
  const [busy, setBusy] = useState(null); // approve | reject | regen | save | null
  const [showRegen, setShowRegen] = useState(false);
  const [regenInstr, setRegenInstr] = useState("");
  const [showReject, setShowReject] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [error, setError] = useState(null);

  useEffect(() => {
    setBody(draft.body || "");
    setSubject(draft.subject || "");
  }, [draft.id, draft.body, draft.subject]);

  const run = async (kind, fn) => {
    setBusy(kind); setError(null);
    try { await fn(); } catch (e) { setError(e.message || String(e)); }
    finally { setBusy(null); }
  };

  const conf = Number(draft.ai_confidence ?? 0);
  const confTone =
    conf >= 85 ? "border-brand-green/30 bg-brand-green/8 text-brand-green" :
    conf >= 60 ? "border-brand-orange/30 bg-brand-orange/8 text-amber-200" :
                 "border-brand-red/30 bg-brand-red/8 text-brand-red";

  return (
    <article
      className="rounded-xl border border-border bg-bg-card/60 backdrop-blur-sm overflow-hidden"
      data-testid={`draft-card-${draft.id}`}
    >
      {/* Header — contexte source */}
      <header className="px-4 py-3 border-b border-border bg-white/3">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-brand-purple/15 text-brand-purple shrink-0">
            <Mail size={15} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] uppercase tracking-wider text-text-tertiary">
                {t("emails.draft.replyTo", "Brouillon de réponse à")}
              </span>
              {sourceMeta?.name && (
                <span className="text-xs font-medium text-text-primary truncate">
                  {sourceMeta.name}
                </span>
              )}
              {sourceMeta?.email && (
                <span className="text-[10px] text-text-tertiary truncate">
                  &lt;{sourceMeta.email}&gt;
                </span>
              )}
            </div>
            {sourceLabel && (
              <div className="mt-0.5 truncate text-sm text-text-secondary">{sourceLabel}</div>
            )}
            {sourceMeta?.summary && (
              <div className="mt-1 text-[11px] text-text-tertiary line-clamp-2 italic" data-testid="source-summary">
                « {sourceMeta.summary} »
              </div>
            )}
          </div>
          <span
            className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-semibold", confTone)}
            data-testid={`draft-confidence-${draft.id}`}
            title={t("emails.draft.confidenceTitle", "Confiance de l'IA")}
          >
            <Sparkles size={9} />
            {conf}%
          </span>
        </div>
      </header>

      {/* Body — view OR edit */}
      <div className="px-4 py-4 space-y-3">
        {mode === "edit" ? (
          <>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-text-tertiary mb-1 block">
                {t("emails.draft.subject", "Objet")}
              </label>
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                data-testid={`draft-edit-subject-${draft.id}`}
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-text-tertiary mb-1 block">
                {t("emails.draft.body", "Corps")}
              </label>
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={10}
                className="font-mono text-[13px] leading-relaxed"
                data-testid={`draft-edit-body-${draft.id}`}
              />
            </div>
          </>
        ) : (
          <>
            <div className="font-medium text-text-primary text-[13px]" data-testid={`draft-subject-${draft.id}`}>
              {draft.subject}
            </div>
            <pre className="whitespace-pre-wrap break-words text-sm leading-relaxed text-text-secondary font-sans" data-testid={`draft-body-${draft.id}`}>
              {draft.body}
            </pre>
          </>
        )}

        {draft.ai_reasoning && mode === "view" && (
          <div className="rounded-md border border-border bg-white/3 px-3 py-2 text-[11px] text-text-tertiary flex items-start gap-2" data-testid={`draft-reasoning-${draft.id}`}>
            <MessageSquare size={11} className="mt-0.5 text-brand-purple shrink-0" />
            <span><strong className="text-text-secondary">IA :</strong> {draft.ai_reasoning}</span>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 rounded-md border border-brand-red/30 bg-brand-red/10 px-3 py-2 text-xs text-red-300">
            <AlertCircle size={12} />{error}
          </div>
        )}

        {/* Mini-form régénération */}
        {showRegen && (
          <div className="rounded-md border border-brand-purple/20 bg-brand-purple/5 p-3 space-y-2" data-testid={`regen-panel-${draft.id}`}>
            <label className="text-[10px] uppercase tracking-wider text-brand-purple">
              {t("emails.draft.regenInstr", "Instruction pour la régénération (optionnel)")}
            </label>
            <Input
              value={regenInstr}
              onChange={(e) => setRegenInstr(e.target.value)}
              placeholder={t("emails.draft.regenPlaceholder", "Ex. : plus court, ton plus formel...")}
              data-testid={`regen-instruction-${draft.id}`}
            />
            <div className="flex items-center gap-2 justify-end">
              <Button size="sm" variant="ghost" onClick={() => { setShowRegen(false); setRegenInstr(""); }} disabled={!!busy}>
                {t("common.cancel", "Annuler")}
              </Button>
              <Button
                size="sm"
                onClick={() => run("regen", async () => {
                  await onRegenerate(draft.id, regenInstr);
                  setShowRegen(false);
                  setRegenInstr("");
                })}
                disabled={busy === "regen"}
                data-testid={`regen-confirm-${draft.id}`}
              >
                {busy === "regen" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCcw size={12} />}
                {t("emails.draft.regenerate", "Régénérer")}
              </Button>
            </div>
          </div>
        )}

        {/* Mini-form rejet */}
        {showReject && (
          <div className="rounded-md border border-brand-red/20 bg-brand-red/5 p-3 space-y-2" data-testid={`reject-panel-${draft.id}`}>
            <label className="text-[10px] uppercase tracking-wider text-brand-red">
              {t("emails.draft.rejectReason", "Motif du rejet (optionnel)")}
            </label>
            <Input
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder={t("emails.draft.rejectPlaceholder", "Ex. : ton inapproprié, info erronée...")}
              data-testid={`reject-reason-${draft.id}`}
            />
            <div className="flex items-center gap-2 justify-end">
              <Button size="sm" variant="ghost" onClick={() => { setShowReject(false); setRejectReason(""); }} disabled={!!busy}>
                {t("common.cancel", "Annuler")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                className="text-red-300 hover:text-red-200"
                onClick={() => run("reject", async () => {
                  await onReject(draft.id, rejectReason);
                  setShowReject(false);
                  setRejectReason("");
                })}
                disabled={busy === "reject"}
                data-testid={`reject-confirm-${draft.id}`}
              >
                {busy === "reject" ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
                {t("emails.draft.confirmReject", "Confirmer rejet")}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Actions footer */}
      <footer className="px-4 py-3 border-t border-border bg-white/3 flex items-center justify-end gap-2 flex-wrap">
        {mode === "edit" ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setMode("view");
                setBody(draft.body || "");
                setSubject(draft.subject || "");
              }}
              disabled={!!busy}
              data-testid={`draft-cancel-edit-${draft.id}`}
            >
              {t("common.cancel", "Annuler")}
            </Button>
            <Button
              size="sm"
              onClick={() => run("save", async () => {
                await onSaveEdit(draft.id, { body, subject });
                setMode("view");
              })}
              disabled={busy === "save"}
              data-testid={`draft-save-edit-${draft.id}`}
            >
              {busy === "save" ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              {t("common.save", "Enregistrer")}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowReject((s) => !s)}
              disabled={!!busy}
              className="text-red-300 hover:text-red-200 hover:bg-brand-red/10"
              data-testid={`draft-reject-${draft.id}`}
            >
              <X size={12} /> {t("common.reject", "Refuser")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowRegen((s) => !s)}
              disabled={!!busy}
              data-testid={`draft-regenerate-${draft.id}`}
            >
              <RefreshCcw size={12} /> {t("emails.draft.regenerate", "Régénérer")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setMode("edit")}
              disabled={!!busy}
              data-testid={`draft-edit-${draft.id}`}
            >
              <Pencil size={12} /> {t("common.edit", "Modifier")}
            </Button>
            <Button
              size="sm"
              onClick={() => run("approve", async () => {
                await onApprove(draft.id, { body, subject });
              })}
              disabled={busy === "approve"}
              data-testid={`draft-approve-${draft.id}`}
            >
              {busy === "approve" ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              {t("emails.draft.approve", "Approuver & envoyer")}
            </Button>
          </>
        )}
      </footer>
    </article>
  );
}
