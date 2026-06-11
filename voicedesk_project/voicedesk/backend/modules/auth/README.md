# Module Auth

Authentification + Invitations + Reset password via Supabase Auth.

**Routes :**
- `POST /api/v1/auth/invite` - Créer invitation (admin Exevori)
- `POST /api/v1/auth/invite/resend`
- `GET  /api/v1/auth/invite/verify/:token`
- `POST /api/v1/auth/invite/accept` - Accepter + créer mot de passe
- `POST /api/v1/auth/reset-password`
- `GET  /api/v1/auth/me` - Profile + company
- `POST /api/v1/auth/logout`

**Dépendances :** Supabase Auth + Resend (emails) + lib/email-templates.js
