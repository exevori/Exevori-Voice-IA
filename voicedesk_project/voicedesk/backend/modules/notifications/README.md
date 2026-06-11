# Module Notifications

Notifications unifiées : in-app (cloche) + email selon préférences.

**Helpers exportés (utilisés par autres modules) :**
```javascript
import { notify, notifyCompany, notifyAdmins } from "../notifications/index.js";

await notify({
  user_id, company_id,
  type: "warning",
  category: "billing",
  title: "Paiement en retard",
  body: "Mettez à jour votre carte",
  link: "/config/billing",
  email: { subject, html } // optionnel
});
```

**Routes :**
- `GET    /api/v1/notifications`
- `GET    /api/v1/notifications/unread-count`
- `POST   /api/v1/notifications/:id/read`
- `POST   /api/v1/notifications/mark-all-read`
- `DELETE /api/v1/notifications/:id`
- `GET    /api/v1/notifications/preferences`
- `PATCH  /api/v1/notifications/preferences`
