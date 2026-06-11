# Module Email

Gestion bilingue (FR/EN) avec 2 niveaux :
- **Niveau 1** : Accusé de réception automatique
- **Niveau 2** : Brouillon généré par IA, validation humaine requise

**Routes :**
- `POST  /api/v1/emails/incoming` - Webhook Gmail Push (via /webhooks/gmail-push)
- `GET   /api/v1/emails/drafts` - Brouillons en attente
- `POST  /api/v1/emails/drafts/:id/approve`
- `POST  /api/v1/emails/drafts/:id/regenerate`
- `POST  /api/v1/emails/drafts/:id/reject`
