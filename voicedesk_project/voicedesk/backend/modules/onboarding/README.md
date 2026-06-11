# Module Onboarding

Workflow 4 étapes pour les nouveaux clients.

**Étapes :**
1. Configuration de l'assistante (nom, ton, langue UI)
2. Choix de la voix (parmi voice_library, filtre par accent)
3. Services activés + premières connaissances KB
4. Test d'appel + activation finale

**Routes :**
- `GET   /api/v1/onboarding`
- `POST  /api/v1/onboarding/step/1`
- `POST  /api/v1/onboarding/step/2`
- `POST  /api/v1/onboarding/step/3`
- `POST  /api/v1/onboarding/step/4`
- `POST  /api/v1/onboarding/skip`
