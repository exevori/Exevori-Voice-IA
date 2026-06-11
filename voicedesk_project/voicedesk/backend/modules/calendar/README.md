# Module Calendar

Intégration Calendly v2 + Google Calendar + RDV manuels.

**Routes :**
- `GET    /api/v1/calendar/appointments` - Liste filtrée
- `POST   /api/v1/calendar/appointments`
- `PATCH  /api/v1/calendar/appointments/:id`
- `POST   /api/v1/calendar/calendly/sync` - Sync depuis Calendly
- `POST   /api/v1/calendar/webhooks/calendly` - Webhook reception

**Phase 2 :** Google Calendar OAuth + sync bidirectionnelle
