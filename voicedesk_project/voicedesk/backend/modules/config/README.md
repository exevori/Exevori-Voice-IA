# Module Config

Configuration personnalisée de l'assistante IA par PME.

**Routes :**
- `GET    /api/v1/config?company_id=...`
- `POST   /api/v1/config` - Création initiale
- `PATCH  /api/v1/config` - Mise à jour partielle
- `GET    /api/v1/config/voices` - Catalogue depuis voice_library
- `GET    /api/v1/config/tones`
- `POST   /api/v1/config/test-voice` - Preview audio ElevenLabs

**Cœur du multi-tenant** : chaque PME a SA propre config (nom, voix, ton, salutations).
