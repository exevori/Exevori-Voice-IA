# Module Voice Library (Multi-voix)

Catalogue de voix flexible + services + assignments.

**Architecture :** voice_library → voice_assignments → services
Limites configurables via `plan_limits` (pas en dur).

**Routes catalogue :**
- `GET    /api/v1/voice-library?accent=quebec|france|multilingual`
- `POST   /api/v1/voice-library` (admin)
- `POST   /api/v1/voice-library/:id/test` - Preview audio
- `POST   /api/v1/voice-library/sync-elevenlabs` (admin)

**Routes services :**
- `GET    /api/v1/voice-library/services/list?company_id=...`
- `POST   /api/v1/voice-library/services/create`

**Routes assignments :**
- `GET    /api/v1/voice-library/assignments/list`
- `POST   /api/v1/voice-library/assignments/create`
- `GET    /api/v1/voice-library/assignments/resolve?service_code=reception` - Voix à utiliser

**Phase 2/3 ready :** voice cloning, voix custom par entreprise, agents IA.
