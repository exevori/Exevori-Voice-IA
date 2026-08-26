# Tâche 10 — Prérequis de mise en production voix

Ne pas activer les appels sortants tant que tous les contrôles suivants ne sont
pas confirmés.

- Exécuter les migrations `010`, `011`, puis `012` dans cet ordre, après revue
  SQL, et vérifier les politiques RLS/GRANT.
- Définir `ELEVENLABS_CUSTOM_LLM_AGENT_SECRETS_JSON` avec un secret distinct
  pour chaque agent. En production, le backend échoue volontairement fermé si
  ce mapping est absent ou invalide.
- Configurer le même secret sur l'agent correspondant dans ElevenLabs et
  vérifier le header `x-elevenlabs-agent-id` sur le Custom LLM.
- Limiter la durée de conversation sortante ElevenLabs à 10 minutes et garder
  `OUTBOUND_RESERVED_MINUTES=10`; sinon `block_at_limit` ne garantit pas
  l'absence de dépassement.
- Activer les retries ElevenLabs pour le webhook `post_call_transcription`.
  ElevenLabs ne retente pas `call_initiation_failure`; les états ambigus sont
  donc conservés sans rappel automatique, puis escaladés par la réconciliation
  locale.
- Pour chaque file en `manual_review`, vérifier d'abord ElevenLabs et Twilio,
  puis utiliser `POST /api/v1/outbound/manual-review/:queueId/resolve` avec un
  compte `super_admin`, le `company_id` actif et une résolution explicite. Ne
  jamais choisir `confirmed_not_dispatched` sans preuve fournisseur.
- Vérifier `ELEVENLABS_WEBHOOK_SECRET`, la signature du webhook et un test de
  livraison signé avant tout appel réel.
- Attendre que `/health` retourne HTTP 200 avec
  `outbound_worker.ready=true`, `post_call_worker.ready=true` et
  `custom_llm_auth.ready=true`.
- Régler `TRUST_PROXY_HOPS` au nombre exact de proxies du déploiement et
  confirmer que deux adresses clientes produisent bien deux clés de limiteur.
- Tester sur deux tenants : consentement explicite, DNC, plage horaire,
  abonnement/quota, numéro sortant et absence de double appel concurrent.

L'ancien service public `voice-outbound` sur le port 8081 est supprimé. Il ne
doit pas être recréé ni déployé.
