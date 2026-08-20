// ============================================================
// EXEVORI VOICE IA — FACTURATION CLIENT
// Toutes les valeurs affichées proviennent de l'API billing.
// ============================================================

import React, { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  CalendarClock,
  CreditCard,
  ExternalLink,
  Gauge,
  ReceiptText,
  RefreshCw,
  ShieldCheck,
  TrendingUp,
  WalletCards,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Button } from "../components/ui/button.jsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card.jsx";

const API = import.meta.env.VITE_API_URL || "";

const STATUS_META = {
  active: { label: "Actif", variant: "green" },
  active_paid: { label: "Actif", variant: "green" },
  trial: { label: "Essai", variant: "cyan" },
  trialing: { label: "Essai", variant: "cyan" },
  overdue: { label: "Paiement en retard", variant: "orange" },
  past_due: { label: "Paiement en retard", variant: "orange" },
  pending_payment: { label: "Paiement requis", variant: "orange" },
  incomplete: { label: "Paiement requis", variant: "orange" },
  suspended: { label: "Suspendu", variant: "red" },
  suspended_overage: { label: "Quota atteint", variant: "red" },
  cancelled: { label: "Annulé", variant: "ghost" },
  canceled: { label: "Annulé", variant: "ghost" },
  unpaid: { label: "Impayé", variant: "red" },
};

const INVOICE_STATUS_META = {
  paid: { label: "Payée", variant: "green" },
  open: { label: "À payer", variant: "orange" },
  draft: { label: "Brouillon", variant: "ghost" },
  void: { label: "Annulée", variant: "ghost" },
  uncollectible: { label: "Irrécouvrable", variant: "red" },
};

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatNumber(value, maximumFractionDigits = 1) {
  const number = finiteNumber(value);
  return number === null
    ? "—"
    : new Intl.NumberFormat("fr-CA", { maximumFractionDigits }).format(number);
}

function formatMoney(value, currency) {
  const number = finiteNumber(value);
  if (number === null) return "—";

  const normalizedCurrency =
    typeof currency === "string" && currency.trim()
      ? currency.trim().toUpperCase()
      : null;

  if (!normalizedCurrency) return formatNumber(number, 2);

  try {
    return new Intl.NumberFormat("fr-CA", {
      style: "currency",
      currency: normalizedCurrency,
      maximumFractionDigits: 2,
    }).format(number);
  } catch {
    return `${formatNumber(number, 2)} ${normalizedCurrency}`;
  }
}

function formatDate(value) {
  if (!value) return "—";
  const rawValue = String(value);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(rawValue)
    ? new Date(`${rawValue}T12:00:00`)
    : new Date(rawValue);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("fr-CA", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("fr-CA", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function safeHttpsUrl(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function statusMeta(status) {
  return STATUS_META[status] || {
    label: status ? String(status).replaceAll("_", " ") : "Inconnu",
    variant: "outline",
  };
}

function invoiceStatusMeta(status) {
  return INVOICE_STATUS_META[status] || {
    label: status ? String(status).replaceAll("_", " ") : "Inconnue",
    variant: "outline",
  };
}

function LoadingState() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Chargement de la facturation">
      <div className="h-20 animate-pulse rounded-xl border border-border bg-bg-card" />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="h-64 animate-pulse rounded-xl border border-border bg-bg-card" />
        <div className="h-64 animate-pulse rounded-xl border border-border bg-bg-card" />
      </div>
      <div className="h-72 animate-pulse rounded-xl border border-border bg-bg-card" />
    </div>
  );
}

function PageState({ icon: Icon, title, description, action }) {
  return (
    <Card className="mx-auto max-w-2xl" data-testid="billing-page-state">
      <CardContent className="flex flex-col items-center px-6 py-12 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-orange/15 text-brand-orange">
          <Icon size={22} aria-hidden="true" />
        </div>
        <h1 className="mt-4 text-lg font-semibold text-text-primary">{title}</h1>
        <p className="mt-2 max-w-lg text-sm text-text-secondary">{description}</p>
        {action && <div className="mt-5">{action}</div>}
      </CardContent>
    </Card>
  );
}

export default function Billing() {
  const { token, profile, effectiveCompanyId } = useAuth();
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [portalError, setPortalError] = useState("");
  const [portalAction, setPortalAction] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const canManageBilling =
    profile?.role === "company_admin" || profile?.role === "super_admin";

  const loadOverview = useCallback(
    async (signal) => {
      if (!token || !effectiveCompanyId) {
        setOverview(null);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError("");

      try {
        const query = new URLSearchParams({ company_id: effectiveCompanyId });
        const response = await fetch(`${API}/api/v1/billing/me?${query}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal,
        });
        const payload = await readJson(response);

        if (response.status === 404) {
          setOverview(null);
          return;
        }
        if (!response.ok) {
          throw new Error(
            payload.error || `Impossible de charger la facturation (${response.status})`
          );
        }

        setOverview(payload && typeof payload === "object" ? payload : null);
      } catch (requestError) {
        if (requestError.name !== "AbortError") {
          setOverview(null);
          setError(
            requestError.message || "Impossible de charger les données de facturation."
          );
        }
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [token, effectiveCompanyId]
  );

  useEffect(() => {
    const controller = new AbortController();
    loadOverview(controller.signal);
    return () => controller.abort();
  }, [loadOverview, refreshKey]);

  const openPortal = async (action) => {
    if (!canManageBilling || !token || !effectiveCompanyId || portalAction) return;

    setPortalAction(action);
    setPortalError("");

    try {
      const response = await fetch(`${API}/api/v1/billing/portal`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ company_id: effectiveCompanyId, action }),
      });
      const payload = await readJson(response);

      if (!response.ok) {
        throw new Error(
          payload.error || `Impossible d'ouvrir le portail Stripe (${response.status})`
        );
      }

      const portalUrl = safeHttpsUrl(payload.portal_url);
      if (!portalUrl) {
        throw new Error("Le portail de facturation a retourné une adresse non sécurisée.");
      }

      window.location.assign(portalUrl);
    } catch (requestError) {
      setPortalError(
        requestError.message || "Impossible d'ouvrir le portail de facturation."
      );
      setPortalAction("");
    }
  };

  if (loading) return <LoadingState />;

  if (!effectiveCompanyId) {
    return (
      <PageState
        icon={ShieldCheck}
        title="Aucune entreprise sélectionnée"
        description={
          profile?.role === "super_admin"
            ? "Sélectionnez une entreprise dans le sélecteur d’impersonation pour consulter sa facturation."
            : "Votre profil n’est associé à aucune entreprise. Contactez le support Exevori."
        }
      />
    );
  }

  if (error) {
    return (
      <PageState
        icon={AlertCircle}
        title="Facturation indisponible"
        description={error}
        action={
          <Button
            type="button"
            variant="secondary"
            onClick={() => setRefreshKey((key) => key + 1)}
          >
            <RefreshCw size={15} aria-hidden="true" />
            Réessayer
          </Button>
        }
      />
    );
  }

  if (!overview?.plan || !overview?.subscription) {
    return (
      <PageState
        icon={WalletCards}
        title="Aucun abonnement"
        description="Aucune donnée de facturation n’est encore disponible pour cette entreprise."
      />
    );
  }

  const { plan, subscription, usage, forecast, payment_method: paymentMethod } = overview;
  const invoices = Array.isArray(overview.invoices) ? overview.invoices : [];
  const currentStatus = subscription.payment_status || subscription.stripe_status;
  const status = statusMeta(currentStatus);
  const portalAvailable = subscription.portal_available === true;
  const subscriptionUpdateAvailable =
    subscription.subscription_update_available === true;
  const used = finiteNumber(usage?.minutes_used);
  const included = finiteNumber(usage?.minutes_included ?? plan.minutes_included);
  const rawUsagePercentage = finiteNumber(usage?.usage_percentage);
  const usagePercentage = rawUsagePercentage === null
    ? used !== null && included > 0
      ? (used / included) * 100
      : null
    : rawUsagePercentage;
  const progressValue = usagePercentage === null
    ? 0
    : Math.min(100, Math.max(0, usagePercentage));

  return (
    <div className="space-y-5 animate-fade-in" data-testid="billing-page">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-tertiary">
            <CreditCard size={12} aria-hidden="true" /> Compte
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">Facturation</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Consultez votre forfait, votre consommation et vos factures Stripe.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setRefreshKey((key) => key + 1)}
          aria-label="Actualiser les données de facturation"
        >
          <RefreshCw size={14} aria-hidden="true" />
          Actualiser
        </Button>
      </header>

      {currentStatus === "trial" || currentStatus === "trialing" ? (
        <TrialBanner subscription={subscription} />
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <PlanCard
          plan={plan}
          subscription={subscription}
          status={status}
          canManageBilling={canManageBilling}
          portalAvailable={portalAvailable}
          subscriptionUpdateAvailable={subscriptionUpdateAvailable}
          portalAction={portalAction}
          onOpenPortal={openPortal}
        />
        <UsageCard
          plan={plan}
          subscription={subscription}
          usage={usage}
          used={used}
          included={included}
          usagePercentage={usagePercentage}
          progressValue={progressValue}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ForecastCard forecast={forecast} currency={plan.currency} />
        <PaymentMethodCard
          paymentMethod={paymentMethod}
          canManageBilling={canManageBilling}
          portalAvailable={portalAvailable}
          portalAction={portalAction}
          onOpenPortal={openPortal}
        />
      </div>

      <div aria-live="polite" aria-atomic="true">
        {portalError ? (
          <div
            className="flex items-start gap-2 rounded-lg border border-brand-red/25 bg-brand-red/5 px-4 py-3 text-sm text-brand-red"
            role="alert"
          >
            <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{portalError}</span>
          </div>
        ) : null}
      </div>

      <InvoicesCard invoices={invoices} defaultCurrency={plan.currency} />

      {overview.generated_at ? (
        <p className="text-right text-[11px] text-text-tertiary">
          Données actualisées le {formatDateTime(overview.generated_at)}
        </p>
      ) : null}
    </div>
  );
}

function TrialBanner({ subscription }) {
  const daysRemaining = finiteNumber(subscription.trial_days_remaining);
  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-brand-cyan/25 bg-brand-cyan/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
      role="status"
      data-testid="billing-trial-banner"
    >
      <div className="flex items-start gap-3">
        <CalendarClock size={18} className="mt-0.5 shrink-0 text-brand-cyan" aria-hidden="true" />
        <div>
          <p className="text-sm font-semibold text-text-primary">Période d’essai en cours</p>
          <p className="mt-0.5 text-xs text-text-secondary">
            {daysRemaining === null
              ? `Fin prévue le ${formatDate(subscription.trial_ends_at)}`
              : daysRemaining === 0
                ? "Votre période d’essai se termine aujourd’hui."
                : `${formatNumber(daysRemaining, 0)} jour${daysRemaining > 1 ? "s" : ""} restant${daysRemaining > 1 ? "s" : ""}, jusqu’au ${formatDate(subscription.trial_ends_at)}.`}
          </p>
        </div>
      </div>
      <Badge variant="cyan">Essai</Badge>
    </div>
  );
}

function PlanCard({
  plan,
  subscription,
  status,
  canManageBilling,
  portalAvailable,
  subscriptionUpdateAvailable,
  portalAction,
  onOpenPortal,
}) {
  const cycleLabel = plan.billing_cycle === "annual" ? "an" : "mois";
  const isOpening = portalAction === "subscription_update";

  return (
    <Card data-testid="billing-plan-card">
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardDescription>Forfait actuel</CardDescription>
          <CardTitle className="mt-1 text-xl">{plan.label || plan.key || "—"}</CardTitle>
        </div>
        <Badge variant={status.variant}>{status.label}</Badge>
      </CardHeader>
      <CardContent className="space-y-5">
        <div>
          <p className="text-3xl font-bold text-text-primary">
            {formatMoney(plan.price, plan.currency)}
            <span className="ml-1 text-sm font-normal text-text-tertiary">/ {cycleLabel}</span>
          </p>
          <p className="mt-1 text-xs text-text-secondary">
            {formatNumber(plan.minutes_included, 0)} minutes incluses par mois
          </p>
        </div>

        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-lg border border-border bg-white/[0.02] p-3">
            <dt className="text-xs text-text-tertiary">Période actuelle</dt>
            <dd className="mt-1 font-medium text-text-primary">
              {formatDate(subscription.current_period_start)} — {formatDate(subscription.current_period_end)}
            </dd>
          </div>
          <div className="rounded-lg border border-border bg-white/[0.02] p-3">
            <dt className="text-xs text-text-tertiary">Tarif de dépassement</dt>
            <dd className="mt-1 font-medium text-text-primary">
              {formatMoney(plan.overage_rate_per_minute, plan.currency)} / min
            </dd>
          </div>
        </dl>

        {canManageBilling ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenPortal("subscription_update")}
            disabled={
              !portalAvailable ||
              !subscriptionUpdateAvailable ||
              Boolean(portalAction)
            }
            aria-describedby={
              !portalAvailable || !subscriptionUpdateAvailable
                ? "portal-unavailable-plan"
                : undefined
            }
          >
            {isOpening ? (
              <RefreshCw size={15} className="animate-spin" aria-hidden="true" />
            ) : (
              <ExternalLink size={15} aria-hidden="true" />
            )}
            {isOpening ? "Ouverture…" : "Changer de forfait"}
          </Button>
        ) : (
          <p className="text-xs text-text-tertiary">
            Seul un administrateur de l’entreprise peut modifier le forfait.
          </p>
        )}
        {canManageBilling && (!portalAvailable || !subscriptionUpdateAvailable) ? (
          <p id="portal-unavailable-plan" className="text-xs text-text-tertiary">
            {!portalAvailable
              ? "Le portail Stripe sera disponible après l’activation de l’abonnement."
              : "Le changement en libre-service n’est pas encore disponible pour cet abonnement. Contactez le support."}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function UsageCard({
  plan,
  subscription,
  usage,
  used,
  included,
  usagePercentage,
  progressValue,
}) {
  const overage = finiteNumber(usage?.minutes_overage);
  const remaining = finiteNumber(usage?.minutes_remaining);

  return (
    <Card data-testid="billing-usage-card">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Gauge size={17} className="text-brand-purple" aria-hidden="true" />
          <CardTitle>Minutes du mois en cours</CardTitle>
        </div>
        <CardDescription>
          Période du {formatDate(subscription.current_period_start)} au {formatDate(subscription.current_period_end)}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-3xl font-bold text-text-primary">{formatNumber(used)} min</p>
            <p className="mt-1 text-xs text-text-secondary">
              sur {formatNumber(included)} minutes incluses
            </p>
          </div>
          <p className="text-lg font-semibold text-text-primary">
            {usagePercentage === null ? "—" : `${formatNumber(usagePercentage)} %`}
          </p>
        </div>

        <div>
          <div
            className="h-2.5 overflow-hidden rounded-full bg-white/5"
            role="progressbar"
            aria-label="Utilisation du quota de minutes"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progressValue)}
            aria-valuetext={
              usagePercentage === null
                ? "Utilisation inconnue"
                : `${formatNumber(usagePercentage)} pour cent du quota utilisé`
            }
          >
            <div
              className={`h-full rounded-full transition-all ${
                usagePercentage > 100
                  ? "bg-brand-red"
                  : usagePercentage >= 80
                    ? "bg-brand-orange"
                    : "bg-gradient-to-r from-brand to-brand-purple"
              }`}
              style={{ width: `${progressValue}%` }}
            />
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-lg border border-border bg-white/[0.02] p-3">
            <dt className="text-xs text-text-tertiary">Minutes restantes</dt>
            <dd className="mt-1 font-semibold text-text-primary">{formatNumber(remaining)} min</dd>
          </div>
          <div className="rounded-lg border border-border bg-white/[0.02] p-3">
            <dt className="text-xs text-text-tertiary">Dépassement actuel</dt>
            <dd className={`mt-1 font-semibold ${overage > 0 ? "text-brand-orange" : "text-text-primary"}`}>
              {formatNumber(overage)} min
            </dd>
          </div>
        </dl>

        {usage?.source ? (
          <p className="text-[11px] text-text-tertiary">
            Mesure synchronisée avec la période de facturation active.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ForecastCard({ forecast, currency }) {
  const projectedMinutes = finiteNumber(forecast?.projected_minutes);
  const projectedOverage = finiteNumber(forecast?.projected_overage_minutes);
  const projectedAmount = finiteNumber(forecast?.projected_overage_amount);

  return (
    <Card data-testid="billing-forecast-card">
      <CardHeader>
        <div className="flex items-center gap-2">
          <TrendingUp size={17} className="text-brand-orange" aria-hidden="true" />
          <CardTitle>Prévision de fin de période</CardTitle>
        </div>
        <CardDescription>Projection calculée à partir de votre consommation réelle.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {projectedMinutes === null ? (
          <p className="text-sm text-text-secondary">Prévision indisponible pour cette période.</p>
        ) : (
          <>
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <ForecastMetric label="Minutes projetées" value={`${formatNumber(projectedMinutes)} min`} />
              <ForecastMetric
                label="Dépassement projeté"
                value={`${formatNumber(projectedOverage)} min`}
                warning={projectedOverage > 0}
              />
              <ForecastMetric
                label="Montant projeté"
                value={formatMoney(projectedAmount, currency)}
                warning={projectedAmount > 0}
              />
            </dl>
            {forecast?.calculation ? (
              <details className="rounded-lg border border-border bg-white/[0.02] px-3 py-2 text-xs text-text-secondary">
                <summary className="cursor-pointer font-medium text-text-primary">
                  Comment cette prévision est calculée
                </summary>
                <p className="mt-2 leading-relaxed">{forecast.calculation}</p>
              </details>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ForecastMetric({ label, value, warning = false }) {
  return (
    <div className="rounded-lg border border-border bg-white/[0.02] p-3">
      <dt className="text-xs text-text-tertiary">{label}</dt>
      <dd className={`mt-1 text-lg font-semibold ${warning ? "text-brand-orange" : "text-text-primary"}`}>
        {value}
      </dd>
    </div>
  );
}

function PaymentMethodCard({
  paymentMethod,
  canManageBilling,
  portalAvailable,
  portalAction,
  onOpenPortal,
}) {
  const isOpening = portalAction === "payment_method_update";
  const brand = paymentMethod?.brand
    ? String(paymentMethod.brand).toUpperCase()
    : paymentMethod?.type
      ? String(paymentMethod.type).replaceAll("_", " ").toUpperCase()
      : "Moyen de paiement";

  return (
    <Card data-testid="billing-payment-method-card">
      <CardHeader>
        <div className="flex items-center gap-2">
          <CreditCard size={17} className="text-brand-cyan" aria-hidden="true" />
          <CardTitle>Moyen de paiement</CardTitle>
        </div>
        <CardDescription>Vos informations complètes restent hébergées par Stripe.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {paymentMethod ? (
          <div className="flex items-center gap-3 rounded-lg border border-border bg-white/[0.02] p-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-cyan/10 text-brand-cyan">
              <CreditCard size={19} aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-semibold text-text-primary">
                {brand}{paymentMethod.last4 ? ` •••• ${paymentMethod.last4}` : ""}
              </p>
              <p className="mt-0.5 text-xs text-text-secondary">
                {paymentMethod.exp_month && paymentMethod.exp_year
                  ? `Expire ${paymentMethod.exp_month}/${paymentMethod.exp_year}`
                  : "Géré de façon sécurisée par Stripe"}
              </p>
            </div>
          </div>
        ) : (
          <p className="rounded-lg border border-border bg-white/[0.02] p-4 text-sm text-text-secondary">
            Aucun moyen de paiement synchronisé.
          </p>
        )}

        {canManageBilling ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenPortal("payment_method_update")}
            disabled={!portalAvailable || Boolean(portalAction)}
            aria-describedby={!portalAvailable ? "portal-unavailable-payment" : undefined}
          >
            {isOpening ? (
              <RefreshCw size={15} className="animate-spin" aria-hidden="true" />
            ) : (
              <ExternalLink size={15} aria-hidden="true" />
            )}
            {isOpening ? "Ouverture…" : "Modifier le moyen de paiement"}
          </Button>
        ) : (
          <p className="text-xs text-text-tertiary">
            Seul un administrateur de l’entreprise peut modifier le moyen de paiement.
          </p>
        )}
        {canManageBilling && !portalAvailable ? (
          <p id="portal-unavailable-payment" className="text-xs text-text-tertiary">
            Le portail Stripe sera disponible après l’activation de l’abonnement.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function InvoicesCard({ invoices, defaultCurrency }) {
  return (
    <Card data-testid="billing-invoices-card">
      <CardHeader>
        <div className="flex items-center gap-2">
          <ReceiptText size={17} className="text-brand-green" aria-hidden="true" />
          <CardTitle>Historique des factures</CardTitle>
        </div>
        <CardDescription>Vos dernières factures synchronisées avec Stripe.</CardDescription>
      </CardHeader>
      <CardContent>
        {invoices.length === 0 ? (
          <div className="flex flex-col items-center rounded-lg border border-dashed border-border px-6 py-10 text-center">
            <ReceiptText size={24} className="text-text-tertiary" aria-hidden="true" />
            <p className="mt-3 text-sm font-medium text-text-primary">Aucune facture</p>
            <p className="mt-1 text-xs text-text-secondary">
              Les factures Stripe apparaîtront ici après leur émission.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-left text-sm">
              <caption className="sr-only">Historique des factures Stripe</caption>
              <thead>
                <tr className="border-b border-border text-xs text-text-tertiary">
                  <th scope="col" className="px-3 py-3 font-medium">Facture</th>
                  <th scope="col" className="px-3 py-3 font-medium">Date</th>
                  <th scope="col" className="px-3 py-3 font-medium">Montant</th>
                  <th scope="col" className="px-3 py-3 font-medium">Statut</th>
                  <th scope="col" className="px-3 py-3 text-right font-medium">Documents</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice, index) => (
                  <InvoiceRow
                    key={invoice.id || invoice.number || `${invoice.created_at}-${index}`}
                    invoice={invoice}
                    defaultCurrency={defaultCurrency}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function InvoiceRow({ invoice, defaultCurrency }) {
  const status = invoiceStatusMeta(invoice.status);
  const invoicePdfUrl = safeHttpsUrl(invoice.invoice_pdf_url);
  const hostedInvoiceUrl = safeHttpsUrl(invoice.hosted_invoice_url);
  const label = invoice.number || invoice.id || "Facture";

  return (
    <tr className="border-b border-border/70 last:border-0">
      <th scope="row" className="px-3 py-4 font-medium text-text-primary">{label}</th>
      <td className="px-3 py-4 text-text-secondary">{formatDate(invoice.created_at)}</td>
      <td className="px-3 py-4 font-medium text-text-primary">
        {formatMoney(invoice.total, invoice.currency || defaultCurrency)}
      </td>
      <td className="px-3 py-4">
        <Badge variant={status.variant}>{status.label}</Badge>
      </td>
      <td className="px-3 py-4">
        <div className="flex items-center justify-end gap-3">
          {hostedInvoiceUrl ? (
            <a
              href={hostedInvoiceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Voir la facture ${label} sur Stripe dans un nouvel onglet`}
            >
              Voir <ExternalLink size={12} aria-hidden="true" />
            </a>
          ) : null}
          {invoicePdfUrl ? (
            <a
              href={invoicePdfUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-text-secondary hover:text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Télécharger le PDF de la facture ${label} dans un nouvel onglet`}
            >
              PDF <ExternalLink size={12} aria-hidden="true" />
            </a>
          ) : null}
          {!hostedInvoiceUrl && !invoicePdfUrl ? (
            <span className="text-xs text-text-tertiary">Indisponible</span>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
