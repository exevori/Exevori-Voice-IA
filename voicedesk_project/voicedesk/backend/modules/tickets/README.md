# Module Tickets (Support)

Système de tickets pro avec SLA tracking.

**SLA par priorité :**
| Priorité | 1ère réponse | Résolution |
|----------|--------------|------------|
| 🔴 urgent | 1h | 4h |
| 🟠 high | 4h | 24h |
| 🔵 normal | 24h | 72h |
| ⚪ low | 48h | 7j |

**Routes :**
- `POST  /api/v1/tickets`
- `GET   /api/v1/tickets`
- `GET   /api/v1/tickets/:id?is_admin=true`
- `POST  /api/v1/tickets/:id/messages` (avec is_internal pour notes)
- `PATCH /api/v1/tickets/:id/assign`
- `PATCH /api/v1/tickets/:id/status`
- `POST  /api/v1/tickets/:id/rate`
- `GET   /api/v1/tickets/stats/overview`

**CRON :** Vérification SLA toutes les 15 minutes (escalade si dépassement).
