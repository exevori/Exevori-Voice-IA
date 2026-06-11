# Module Knowledge Base

Base de connaissances officielles (FAQ, services, prix, politiques).

**Routes :**
- `GET    /api/v1/knowledge` - Liste filtrée + groupée par catégorie
- `POST   /api/v1/knowledge` - Création (détecte doublons)
- `PATCH  /api/v1/knowledge/:id`
- `DELETE /api/v1/knowledge/:id` - Soft delete (status=archived)
- `POST   /api/v1/knowledge/bulk-import`
- `GET    /api/v1/knowledge/search/semantic` - Recherche pour voice/inbound
- `GET    /api/v1/knowledge/stats/overview`
