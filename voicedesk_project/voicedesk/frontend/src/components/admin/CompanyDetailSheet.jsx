import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertCircle, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "../ui/sheet.jsx";
import { Button } from "../ui/button.jsx";
import { Badge } from "../ui/badge.jsx";
import { elevenLabsDashboardUrl, money, requestAdminJson, stripeLabel } from "../../utils/admin-company.js";
import ProvisioningHealthPanel from "./ProvisioningHealthPanel.jsx";

const API = import.meta.env.VITE_API_URL || "";
const ACTIONS = {
  suspend: { label: "Suspendre l’accès", detail: "L’accès au produit sera suspendu. La facturation Stripe continue ; cette action ne résilie pas l’abonnement." },
  reactivate: { label: "Réactiver l’accès", detail: "L’accès sera rétabli après vérification de l’abonnement actif ou de l’essai valide." },
  impersonate: { label: "Ouvrir l’espace client", detail: "Votre accès administrateur à cet espace sera inscrit dans le journal d’audit." },
  "resend-welcome": { label: "Renvoyer la bienvenue", detail: "Le courriel sera envoyé au contact enregistré de cette entreprise." },
  "resync-provisioning": { label: "Relancer le provisioning", detail: "La relance applique les verrous existants et conserve les ressources déjà provisionnées. Si aucune ressource n’existe, elle peut provisionner un numéro dédié." },
};

function date(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed.toLocaleString("fr-CA") : "—";
}

function Field({ label, value }) {
  return <div className="min-w-0"><dt className="text-xs text-text-tertiary">{label}</dt><dd className="mt-1 break-words text-sm text-text-primary">{value ?? "—"}</dd></div>;
}

function Panel({ title, children }) {
  return <section className="space-y-3 rounded-xl border border-border bg-bg-card p-4"><h3 className="font-semibold text-text-primary">{title}</h3>{children}</section>;
}

export default function CompanyDetailSheet({ company, token, onClose, onChanged, onImpersonate }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [action, setAction] = useState(null);
  const [reason, setReason] = useState("");
  const [requestId, setRequestId] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async signal => {
    setLoading(true);
    setError(null);
    try {
      const result = await requestAdminJson(`${API}/api/v1/admin/companies/${company.id}`, { token, signal });
      if (!signal?.aborted) setData(result);
    } catch (err) {
      if (!signal?.aborted) setError(err.message);
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [company.id, token]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const chooseAction = value => {
    setAction(value); setReason(""); setError(null); setNotice(null);
    setRequestId(crypto.randomUUID());
  };

  const submit = async event => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await requestAdminJson(`${API}/api/v1/admin/companies/${company.id}/${action}`, {
        token, method: "POST", headers: { "X-Request-Id": requestId },
        body: JSON.stringify({ confirm_company_id: company.id, reason: reason.trim() }),
      });
      if (action === "impersonate") {
        onImpersonate(result.company); onClose(); navigate("/dashboard");
        return;
      }
      const message = action === "resend-welcome"
        ? `Courriel accepté pour envoi à ${result.recipient}.`
        : action === "resync-provisioning" && result.reused_existing
          ? "Les ressources déjà provisionnées ont été conservées. Aucun nouveau numéro n’a été acheté."
          : "Action terminée. La fiche a été actualisée.";
      const warning = result.warning === "auth_cache_refresh_pending"
        ? " Le changement d’accès peut prendre jusqu’à une minute."
        : result.warning ? " La confirmation finale dans le journal d’audit reste à vérifier." : "";
      setNotice(message + warning);
      setAction(null);
      onChanged();
      await load();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const current = data?.company || company;
  const phones = data?.telephony?.phone_numbers || [];
  const assistant = data?.telephony?.assistant;
  const agentIds = [...new Set([assistant?.elevenlabs_agent_id, ...phones.map(phone => phone.elevenlabs_agent_id)].filter(Boolean))];
  const suspended = ["suspended", "suspended_overage"].includes(current.status);

  return (
    <Sheet open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <SheetContent className="flex max-w-[760px] flex-col">
        <SheetHeader className="pr-14">
          <SheetTitle>{current.name}</SheetTitle>
          <SheetDescription>Fiche client · entreprise, abonnement, téléphonie et consommation</SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-text-tertiary">Actualisé : {date(data?.generated_at)}</p>
            <Button variant="outline" size="sm" disabled={loading || busy} onClick={() => void load()}><RefreshCw size={13} /> Actualiser</Button>
          </div>
          {error && <div role="alert" className="flex gap-2 rounded-lg border border-brand-red/30 bg-brand-red/10 p-3 text-sm text-brand-red"><AlertCircle size={16} className="shrink-0" />{error}</div>}
          {notice && <p role="status" className="rounded-lg border border-brand/30 bg-brand/10 p-3 text-sm text-text-primary">{notice}</p>}
          {loading && <p className="flex items-center gap-2 text-sm text-text-tertiary"><Loader2 size={16} className="animate-spin" /> Lecture de la fiche…</p>}
          {data && <>
            <Panel title="Entreprise et contact">
              <dl className="grid gap-4 sm:grid-cols-2">
                <Field label="Contact" value={current.contact_name} /><Field label="Courriel" value={current.contact_email} />
                <Field label="Téléphone" value={current.phone} /><Field label="Localisation" value={[current.city, current.province, current.billing_country || current.country].filter(Boolean).join(", ")} />
                <Field label="Secteur" value={current.sector} /><Field label="Site web" value={current.website} />
                <Field label="Création" value={date(current.created_at)} /><Field label="Accès au produit" value={current.status} />
              </dl>
            </Panel>
            <Panel title="Abonnement et paiement">
              <div className="flex flex-wrap items-center gap-2"><Badge variant={data.stripe.state !== "verified" ? "orange" : ["active", "trialing"].includes(data.stripe.subscription_status) ? "green" : "red"}>{stripeLabel(data.stripe)}</Badge><span className="text-xs text-text-tertiary">Vérifié : {date(data.stripe.checked_at)}</span></div>
              <dl className="grid gap-4 sm:grid-cols-2">
                <Field label="Forfait enregistré" value={data.subscription?.plan_name} /><Field label="Cycle" value={data.subscription?.billing_cycle === "annual" ? "Annuel" : data.subscription?.billing_cycle === "monthly" ? "Mensuel" : "—"} />
                <Field label="État local de facturation" value={data.subscription?.payment_status} /><Field label="Fin de l’essai" value={date(data.stripe.trial_ends_at || data.subscription?.trial_ends_at)} />
                <Field label="Client Stripe" value={data.subscription?.stripe_customer_id} /><Field label="Abonnement Stripe" value={data.subscription?.stripe_subscription_id} />
              </dl>
              {data.stripe.cancel_at_period_end && <p className="text-xs text-brand-orange">Annulation programmée en fin de période.</p>}
            </Panel>
            <Panel title="Téléphonie et assistante">
              <dl className="grid gap-4 sm:grid-cols-2"><Field label="Assistante" value={assistant?.assistant_name} /><Field label="Provisioning" value={data.onboarding?.provisioning_status || "Non démarré"} /></dl>
              {phones.length ? phones.map(phone => <div key={phone.id} className="rounded-lg border border-border p-3"><p className="text-sm font-semibold text-text-primary">{phone.phone_number} <Badge variant={phone.status === "active" ? "green" : "orange"}>{phone.status}</Badge></p><p className="mt-1 break-all font-mono text-xs text-text-tertiary">Twilio : {phone.twilio_phone_sid || "Identifiant absent"}</p></div>) : <p className="text-sm text-text-secondary">Aucun numéro dédié enregistré.</p>}
              {!phones.length && data.telephony.legacy_phone?.phone_number && <p className="text-xs text-brand-orange">Ancienne configuration Twilio : {data.telephony.legacy_phone.phone_number}. Rattachement à contrôler.</p>}
              {agentIds.map(id => <div key={id} className="flex flex-wrap items-center gap-2 text-xs"><span className="break-all font-mono text-text-secondary">Agent : {id}</span>{elevenLabsDashboardUrl(id) && <a className="inline-flex items-center gap-1 text-brand" href={elevenLabsDashboardUrl(id)} target="_blank" rel="noopener noreferrer">Dashboard ElevenLabs <ExternalLink size={11} /></a>}</div>)}
              {!agentIds.length && <p className="text-xs text-brand-orange">Aucun agent ElevenLabs enregistré.</p>}
              <ProvisioningHealthPanel companyId={company.id} token={token} disabled={busy} onBusy={setBusy} onChanged={() => { onChanged(); void load(); }} />
            </Panel>
            <Panel title="Consommation du mois">
              <p className="text-xs text-text-tertiary">Mois civil en UTC · minutes mesurées sur les appels enregistrés</p>
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4"><Field label="Entrants" value={data.usage.inbound_calls} /><Field label="Sortants" value={data.usage.outbound_calls} /><Field label="Minutes" value={data.usage.minutes} /><Field label="Coûts infra enregistrés" value={money(data.usage.infrastructure_cost_usd)} /></dl>
              {data.usage.cost_state === "not_available" && <p className="text-xs text-brand-orange">Le coût d’infrastructure n’est pas encore disponible pour cette période.</p>}
              {data.usage.cost_breakdown.map(row => <div key={row.resource_type} className="flex justify-between gap-3 text-xs text-text-secondary"><span>{row.resource_type}</span><span>{money(row.total_cost_usd)}</span></div>)}
            </Panel>
            <Panel title="Actions administrateur">
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={busy || loading} onClick={() => chooseAction("impersonate")}>Ouvrir l’espace client</Button>
                {current.status !== "cancelled" && <Button size="sm" variant={suspended ? "outline" : "destructive"} disabled={busy || loading} onClick={() => chooseAction(suspended ? "reactivate" : "suspend")}>{suspended ? "Réactiver l’accès" : "Suspendre l’accès"}</Button>}
                <Button size="sm" variant="outline" disabled={busy || loading || suspended || current.status === "cancelled"} onClick={() => chooseAction("resend-welcome")}>Renvoyer la bienvenue</Button>
                <Button size="sm" variant="outline" disabled={busy || loading || suspended || current.status === "cancelled"} onClick={() => chooseAction("resync-provisioning")}>Relancer le provisioning</Button>
              </div>
              {action && <form onSubmit={submit} className="space-y-3 rounded-lg border border-brand/30 p-3">
                <h4 className="text-sm font-semibold text-text-primary">{ACTIONS[action].label} — {current.name}</h4>
                <p className="text-xs text-text-secondary">{ACTIONS[action].detail}</p>
                {action !== "resend-welcome" && <label className="block text-xs text-text-secondary">Motif de l’action<textarea required minLength={3} maxLength={500} disabled={busy} value={reason} onChange={event => setReason(event.target.value)} className="mt-1 w-full rounded-lg border border-border bg-bg-input p-2 text-sm text-text-primary" /></label>}
                <div className="flex gap-2"><Button size="sm" type="submit" disabled={busy || (action !== "resend-welcome" && reason.trim().length < 3)}>{busy ? <Loader2 size={13} className="animate-spin" /> : null}Confirmer</Button><Button size="sm" type="button" variant="ghost" disabled={busy} onClick={() => setAction(null)}>Annuler</Button></div>
              </form>}
            </Panel>
          </>}
        </div>
      </SheetContent>
    </Sheet>
  );
}
