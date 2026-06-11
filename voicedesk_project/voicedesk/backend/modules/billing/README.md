# Module Billing (Stripe)

Abonnements + usage tracking + customer portal + webhooks.

**Routes :**
- `POST /api/v1/billing/checkout` - Stripe Checkout session
- `POST /api/v1/billing/portal` - Customer Portal
- `GET  /api/v1/billing/me` - Mon abonnement + consommation
- `POST /api/v1/billing/overage-policy` - pay_as_you_go | block_at_limit
- `POST /api/v1/billing/change-plan` - Avec prorata Stripe
- `POST /api/v1/billing/track-usage` - Interne (appelé par voice/email)
- `POST /webhooks/stripe` - Tous les events Stripe
