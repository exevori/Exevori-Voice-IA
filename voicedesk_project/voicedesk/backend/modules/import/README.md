# Module Import (CSV/Excel)

Import intelligent de contacts avec parsing assisté par IA.

**Workflow :**
1. Upload → preview avec auto-détection colonnes (heuristique + DeepSeek)
2. Détection des doublons potentiels
3. Validation par l'admin
4. Import par batch de 100, skip doublons configurable

**Routes :**
- `POST /api/v1/import/preview` - Upload + analyse
- `POST /api/v1/import/execute` - Importer après validation
- `POST /api/v1/import/manual` - Saisie manuelle (max 50)

**Détection patterns :** nom/name, courriel/email, téléphone/phone, entreprise/company
