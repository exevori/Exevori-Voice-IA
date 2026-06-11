# Module Admin (Exevori)

Dashboard global + suivi rentabilité + gestion clients.

**Routes (super_admin uniquement) :**
- `GET  /api/v1/admin/dashboard` - MRR, ARR, churn, marges
- `GET  /api/v1/admin/companies/:id/profitability` - Rentabilité client
- `POST /api/v1/admin/credits` - Crédits/rabais/gratuités
- `POST /api/v1/admin/companies/:id/suspend`
- `POST /api/v1/admin/companies/:id/reactivate`
- `POST /api/v1/admin/invoices/:id/mark-paid` - Mode manuel
- `GET  /api/v1/admin/usage/all`
