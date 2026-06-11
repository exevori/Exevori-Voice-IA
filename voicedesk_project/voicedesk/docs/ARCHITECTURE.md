# 🏛️ ARCHITECTURE — Décisions techniques

## Stack

| Couche | Choix | Justification |
|--------|-------|---------------|
| Frontend | React 18 + Vite + i18next | Standard, rapide, multilingue |
| Backend | Node.js 20 + Express | Mature, écosystème npm |
| DB | Supabase Postgres (Montréal) | Loi 25 + Auth + RLS gratuit |
| AI | DeepSeek V3 via Fireworks.ai | 95% moins cher que GPT-4 |
| STT | Twilio ConversationRelay + Deepgram | Streaming temps réel |
| TTS | ElevenLabs Flash v2.5 | 75ms latence, multilingue |
| Téléphonie | Twilio | Standard de facto |
| Email | Resend | Simple, deliverability haute |
| Paiement | Stripe (CAD) | Subscriptions + metering |

## Multi-tenant

Isolation par `company_id` avec RLS Postgres :

```sql
CREATE POLICY company_isolation ON contacts USING (
  company_id = current_company_id() OR is_super_admin()
);
```

`current_company_id()` lit le JWT (`app_metadata.company_id`) injecté par Supabase Auth.

## AI Gateway centralisé

```
Backend (3000) → AI Gateway (3100) → DeepSeek
                  ↓
           Cache + Rate limiting + Cost tracking
```

13 tâches IA standardisées (conversation, summarize, classify_email, etc.).

## Voix flexible (sans limites en dur)

```
voice_library → voice_assignments → services
```

Limites gérées par table `plan_limits` (configurable par admin).

## Stripe + 2 modes overage

- `pay_as_you_go` : continue + facture overage
- `block_at_limit` : bloque à la limite (choix client)

Mode manuel disponible (virement bancaire pour PME québécoises).

## Apprentissage contrôlé

L'IA détecte des patterns mais **l'humain valide** avant intégration dans la KB.
CRON 6h scan automatique.

## Notifications unifiées

Helper `notify()` qui gère in-app + email (selon préférences).

## Sécurité

- ✅ RLS sur toutes les tables
- ✅ Middleware Auth sur toutes les routes
- ✅ Conformité Loi 25 (Supabase Montréal)
- ✅ Pas de stockage cartes (Stripe gère)
- ✅ Signatures vérifiées sur tous les webhooks

## Cible performance

| Métrique | V1 | V2 |
|----------|-----|-----|
| Latence appel | <700ms | <500ms |
| Appels simultanés | 50 | 500 |
| Courriels/min | 100 | 1 000 |

## Pas dans la V0

- WhatsApp / SMS (Phase 3)
- Voice cloning (Phase 3, architecture prête)
- pgvector (Phase 2)
- Multi-provider IA actif (Phase 2)
