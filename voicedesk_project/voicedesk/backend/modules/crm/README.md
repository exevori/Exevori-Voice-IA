# Module CRM

Gestion contacts + notes + historique cross-canal.

**Routes :**
- `GET    /api/v1/contacts` - Liste filtrée + pagination
- `POST   /api/v1/contacts` - Création (avec détection doublons)
- `GET    /api/v1/contacts/:id` - Détail + tout l'historique
- `PATCH  /api/v1/contacts/:id`
- `DELETE /api/v1/contacts/:id`
- `GET    /api/v1/contacts/lookup/find` - Recherche par téléphone/email (utilisé par voice)
- `POST   /api/v1/contacts/:id/notes`
- `GET    /api/v1/contacts/stats/overview`
