# Module Learning

Apprentissage contrôlé : l'IA détecte des patterns mais l'humain valide.

**Routes :**
- `GET   /api/v1/learning/suggestions` - Liste suggestions en attente
- `POST  /api/v1/learning/suggestions/:id/approve` - → knowledge_base
- `POST  /api/v1/learning/suggestions/:id/reject`
- `POST  /api/v1/learning/suggestions/:id/modify`

**CRON :** Toutes les 6h, scan automatique des conversations pour détecter patterns.
