# 📋 EMERGENT-REFERENCE — Référence API exhaustive

Toutes les routes API de VoiceDesk IA, classées par module.

**Base URL** : `http://localhost:3000` (dev) | `https://api.voicedesk.ca` (prod)

**Authentication** : Header `Authorization: Bearer <JWT_TOKEN>` sur toutes les routes sauf `/api/v1/auth/*` et `/webhooks/*`.

---

## 🔐 Auth (`/api/v1/auth`)

| Méthode | Route | Description | Auth |
|---------|-------|-------------|------|
| POST | `/invite` | Créer invitation + entreprise (admin) | super_admin |
| POST | `/invite/resend` | Renvoyer invitation | super_admin |
| GET | `/invite/verify/:token` | Vérifier validité token | Public |
| POST | `/invite/accept` | Accepter + créer mot de passe | Public |
| POST | `/reset-password` | Demander réinit mot de passe | Public |
| GET | `/me` | Profil utilisateur connecté | Requis |
| POST | `/logout` | Déconnexion | Requis |

---

## ⚙️ Config (`/api/v1/config`)

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/?company_id=...` | Récupérer config assistante |
| POST | `/` | Créer config initiale |
| PATCH | `/` | Mise à jour partielle |
| GET | `/voices?language=fr&accent=quebec` | Voix disponibles |
| GET | `/tones` | Tones disponibles |
| POST | `/test-voice` | Preview audio ElevenLabs (stream MP3) |

---

## 📊 Dashboard (`/api/v1/dashboard`)

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/stats?period=today\|week\|month` | KPIs principaux |
| GET | `/activity?limit=20` | Timeline cross-module |
| GET | `/alerts` | Alertes importantes |

---

## 👥 CRM (`/api/v1/contacts`)

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/` | Liste contacts (filtres : status, source, urgency, search) |
| POST | `/` | Créer contact (détecte doublons) |
| GET | `/:id` | Détail + historique complet |
| PATCH | `/:id` | Modifier contact |
| DELETE | `/:id` | Supprimer |
| GET | `/lookup/find?phone=...&email=...` | Recherche (utilisé par voice) |
| POST | `/:id/notes` | Ajouter note |
| GET | `/stats/overview` | Stats CRM |

---

## 📅 Calendar (`/api/v1/calendar`)

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/appointments` | Liste RDV (filtres date, contact) |
| POST | `/appointments` | Créer RDV manuel |
| PATCH | `/appointments/:id` | Modifier RDV |
| DELETE | `/appointments/:id` | Annuler RDV |
| POST | `/calendly/sync` | Sync depuis Calendly |
| POST | `/webhooks/calendly` | Webhook receiver |

---

## ✉️ Emails (`/api/v1/emails`)

| Méthode | Route | Description |
|---------|-------|-------------|
| POST | `/incoming` | Email entrant (depuis webhook Gmail) |
| GET | `/` | Liste emails reçus |
| GET | `/drafts` | Brouillons en attente |
| POST | `/drafts/:id/approve` | Approuver + envoyer |
| POST | `/drafts/:id/regenerate` | Régénérer via IA |
| POST | `/drafts/:id/edit` | Modifier brouillon |
| POST | `/drafts/:id/reject` | Refuser brouillon |

---

## 🧠 Learning (`/api/v1/learning`)

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/suggestions` | Suggestions en attente de validation |
| POST | `/suggestions/:id/approve` | Approuver → ajoute à KB |
| POST | `/suggestions/:id/reject` | Refuser |
| POST | `/suggestions/:id/modify` | Modifier puis approuver |

---

## 📚 Knowledge Base (`/api/v1/knowledge`)

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/?category=FAQ&search=...` | Liste filtrée + groupée |
| GET | `/:id` | Détail entrée |
| POST | `/` | Créer entrée (détecte doublons) |
| PATCH | `/:id` | Modifier |
| DELETE | `/:id` | Soft delete (status=archived) |
| POST | `/bulk-import` | Import en masse |
| GET | `/search/semantic?query=...` | Recherche (utilisé par voice) |
| GET | `/stats/overview` | Statistiques |

---

## 💳 Billing (`/api/v1/billing`)

| Méthode | Route | Description |
|---------|-------|-------------|
| POST | `/checkout` | Stripe Checkout session |
| POST | `/portal` | Customer Portal |
| GET | `/me` | Mon abonnement + consommation |
| POST | `/overage-policy` | `pay_as_you_go` ou `block_at_limit` |
| POST | `/change-plan` | Changer forfait (avec prorata) |
| POST | `/track-usage` | Interne (depuis voice/email) |
| POST | `/webhook-stripe` | Webhook Stripe (raw body) |

**Webhook public** : `POST /webhooks/stripe` (routé vers ce module)

---

## 🎫 Tickets (`/api/v1/tickets`)

| Méthode | Route | Description |
|---------|-------|-------------|
| POST | `/` | Créer ticket |
| GET | `/?status=open&priority=urgent` | Liste filtrée |
| GET | `/:id?is_admin=true` | Détail + messages |
| POST | `/:id/messages` | Répondre (avec is_internal pour notes) |
| PATCH | `/:id/assign` | Assigner à un agent |
| PATCH | `/:id/status` | Changer statut |
| PATCH | `/:id/priority` | Changer priorité (recalcule SLA) |
| POST | `/:id/rate` | Évaluer (1-5 étoiles) |
| GET | `/stats/overview` | Statistiques |

---

## 🎙️ Voice Library (`/api/v1/voice-library`)

### Catalogue (admin)

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/?accent=quebec\|france\|multilingual` | Liste filtrée + groupée |
| GET | `/:id` | Détail voix |
| POST | `/` | Ajouter voix (admin) |
| PATCH | `/:id` | Modifier |
| POST | `/:id/deactivate` | Désactiver |
| POST | `/:id/test` | Preview audio |
| POST | `/sync-elevenlabs` | Sync depuis ElevenLabs (admin) |

### Services (PME)

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/services/list?company_id=...` | Services de l'entreprise |
| POST | `/services/create` | Créer service |
| PATCH | `/services/:id` | Modifier |
| DELETE | `/services/:id` | Soft delete |

### Voice Assignments

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/assignments/list` | Assignments de l'entreprise |
| POST | `/assignments/create` | Lier voix → service |
| DELETE | `/assignments/:id` | Supprimer assignment |
| GET | `/assignments/resolve?service_code=reception` | Voix à utiliser |

### Plan Limits (admin)

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/plan-limits/:company_id` | Limites de l'entreprise |
| GET | `/plan-limits-admin/list` | Liste tous les plans (admin) |
| PATCH | `/plan-limits-admin/:plan_name` | Modifier limites (admin) |

---

## 🎓 Onboarding (`/api/v1/onboarding`)

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/?company_id=...` | État + next_action |
| POST | `/step/1` | Configuration de base |
| POST | `/step/2` | Choix voix + création services |
| POST | `/step/3` | Services activés + KB |
| POST | `/step/4` | Test d'appel + activation |
| POST | `/skip` | Sauter une étape |

---

## 📥 Import (`/api/v1/import`)

| Méthode | Route | Description |
|---------|-------|-------------|
| POST | `/preview` | Upload + analyse colonnes |
| POST | `/execute` | Importer après validation |
| POST | `/manual` | Saisie manuelle (max 50) |

---

## 🔔 Notifications (`/api/v1/notifications`)

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/?unread_only=true` | Liste notifications |
| GET | `/unread-count` | Badge cloche |
| POST | `/:id/read` | Marquer lu |
| POST | `/mark-all-read` | Tout marquer lu |
| DELETE | `/:id` | Supprimer |
| GET | `/preferences` | Préférences email |
| PATCH | `/preferences` | Modifier préférences |

---

## 👑 Admin (`/api/v1/admin`) — super_admin uniquement

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/dashboard` | KPIs Exevori (MRR, ARR, marges) |
| GET | `/companies/:id/profitability` | Rentabilité par client |
| POST | `/credits` | Donner crédit/rabais |
| POST | `/companies/:id/suspend` | Suspendre client |
| POST | `/companies/:id/reactivate` | Réactiver client |
| POST | `/invoices/:id/mark-paid` | Marquer payé (mode manuel) |
| GET | `/usage/all` | Consommation tous clients |

---

## 🌐 Webhooks externes (`/webhooks`)

| Méthode | Route | Source |
|---------|-------|--------|
| POST | `/gmail-push` | Google Cloud Pub/Sub |
| POST | `/twilio/status` | Twilio status callbacks |
| POST | `/twilio/amd` | Twilio AMD (Answering Machine) |
| POST | `/resend` | Resend events (bounce, delivery) |
| POST | `/calendly` | Calendly webhooks |
| POST | `/stripe` | Stripe events (routé vers billing) |

---

## 🔌 AI Gateway (`/api/ai`) — Port 3100

Service séparé, appelé par les modules backend.

| Méthode | Route | Description |
|---------|-------|-------------|
| POST | `/respond` | Tâche IA générique avec routing |
| GET | `/health` | Health check |
| GET | `/tasks` | Liste des 13 tâches disponibles |

**13 tâches IA** :
- `conversation` (appel entrant en cours)
- `summarize_call` (résumé post-appel)
- `classify_intent` (intention de l'appel)
- `outbound_conversation`
- `generate_outbound_script`
- `analyze_outbound_result`
- `classify_email`
- `generate_email_draft`
- `regenerate_email_draft`
- `detect_learning_patterns`
- `generate_suggested_answer`
- `parse_import` (mapping colonnes CSV)
- `detect_language` (FR/EN)

---

## 🎙️ Voice Servers — Ports 8080 + 8081

### Voice Inbound (`http://localhost:8080`)

| Route | Description |
|-------|-------------|
| `POST /voice/inbound` | Entry point Twilio (TwiML) |
| `WS /voice/inbound/stream` | WebSocket ConversationRelay |

### Voice Outbound (`http://localhost:8081`)

| Route | Description |
|-------|-------------|
| `POST /outbound/call` | Déclencher appel sortant |
| `POST /outbound/twiml` | TwiML pour Twilio |
| `WS /outbound/stream` | WebSocket ConversationRelay |

---

## 📝 Format de réponse standard

### Succès

```json
{
  "success": true,
  "data": { ... }
}
```

ou directement les données :

```json
{
  "contacts": [...],
  "total": 47,
  "limit": 50,
  "offset": 0
}
```

### Erreur

```json
{
  "error": "code_machine_lisible",
  "message": "Message lisible par l'utilisateur"
}
```

Codes d'erreur communs :
- `unauthorized` (401) — Token manquant ou invalide
- `forbidden` (403) — Pas la permission
- `not_found` (404) — Ressource introuvable
- `duplicate_contact` (409) — Doublon détecté
- `plan_limit_reached` (403) — Limite forfait atteinte
- `rate_limited` (429) — Trop de requêtes
- `internal_error` (500) — Erreur serveur

---

**Total : ~130 routes API documentées.**

Tout est dans le code — ce document est la référence exhaustive.
