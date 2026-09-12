# Tâche 19 — Onboarding rechargeable

## Fonctionnement livré

- Chargement serveur au montage et lors du changement d’entreprise/session. Aucun GET ne crée de progression.
- Étapes 1 et 2 : configuration + progression dans une transaction verrouillée. Chaque étape enregistrée devient immuable dans ce parcours ; les modifications ultérieures se font dans Paramètres.
- Étape 3 : FAQ bornées, sauvegardées avant indexation via le RAG existant. Après échec, reprise du même contenu avec origine déterministe, sans marquer l’étape réussie avant tous les embeddings. Une FAQ vide est autorisée, mais pas une question sans réponse.
- Activation : URL historique `POST /onboarding/step/5`, abonnement et verrous du service existant conservés. La préparation en base ne pré-marque jamais `in_progress`.
- La préparation capture la configuration sous verrou. Un autre onglet Paramètres ne peut modifier voix/accueil/personnalité pendant l’activation ; les mises à jour techniques et rollback du numéro/agent restent autorisées. Un conflit de verrous est une erreur à relire/réessayer, jamais une réussite fictive.
- Suivi toutes les 3 secondes, requêtes séquentielles, arrêt visible à 3 minutes. Le délai du navigateur n’annule pas un achat côté fournisseur. Après un résultat inconnu, relire le statut ; aucun achat ni nouvelle tentative automatique. Le verrou renouvelable serveur dure 5 minutes.
- L’administrateur prépare une fenêtre de 20 minutes avec son téléphone E.164, puis appelle lui-même le numéro professionnel. Aucun appel sortant automatique ne contourne consentement/DNC/quota.
- Seul le webhook ElevenLabs HMAC valide peut confirmer : statut fournisseur `done`, direction explicitement `inbound`, SID Twilio valide, durée 5–1200 secondes, horodatage fournisseur dans la fenêtre, téléphone appelant et numéro assigné exacts, même entreprise et appel/job durable déjà enregistré.
- Les variables dynamiques du client ne constituent pas une preuve. Un événement sans métadonnées téléphoniques complètes ne valide pas l’onboarding ; le support doit vérifier la configuration fournisseur.
- Un webhook retardé peut confirmer le test jusqu’à 24 heures après la fenêtre, mais son heure réelle de début doit rester dans la fenêtre. Les refus de traitement suivent le nettoyage confidentialité existant et ne valident pas le test.
- `POST /step/4` ne fait que constater la preuve ; `/skip` refuse le contournement. Les membres non administrateurs peuvent consulter, pas modifier/activer.

## Migration et limites de vérification

`019_onboarding_resume.sql` est préparée, **non exécutée**. Appliquer après 009–018 et avant ce backend, uniquement après validation opérateur. La CLI Supabase et un serveur PostgreSQL local ne sont pas disponibles : fichier numéroté selon la convention existante, tests structurels SQL et requêtes Supabase simulées, pas de prétention à une validation PostgreSQL réelle ou à des tests cross-tenant en production.

Les RPC sont `SECURITY INVOKER`, avec `EXECUTE` retiré à PUBLIC/anon/authenticated et accordé au seul backend `service_role`. Les protections RLS/GRANT des tables métier restent celles de la migration 009. Aucun utilisateur Auth/profil/abonnement n’est créé ou modifié pendant les tests. Le code de l’étape 1 conserve la mise à jour du nom de l’assistante et de la langue dans `companies` (signalée à Karim avant implémentation).

Les anciennes valeurs `completed_at` ne sont pas transformées en preuves. Aucun reset ni backfill automatique des comptes existants. Un ancien compte provisionné mais incohérent passe par le diagnostic de provisioning administrateur, pas par un écrasement de sa configuration.

## Contrôle après application autorisée

1. Confirmer les six nouvelles colonnes de test/progression, les RPC et leurs ACL ; lancer les advisors.
2. Deux entreprises QA : tenter GET progression/statut et POST étapes/test avec l’autre `company_id` → 403. Répéter en rôle `company_user` sur les mutations → 403.
3. Enregistrer chaque étape, fermer/recharger : reprise exacte. Provoquer un échec d’embedding : FAQ encore présente, étape non terminée, reprise sans doublon de source.
4. Double clic / deux onglets d’activation : un seul service obtient le verrou. Couper le réseau puis relire le statut, vérifier un seul numéro/agent. Ne pas relancer tant qu’une opération garde le verrou.
5. Sans appel, même avec `call_id`, `twilio_number` ou `completed_at` forgé dans POST `/step/4` : 409.
6. Armer un test et appeler le numéro depuis le téléphone déclaré ; raccrocher après quelques phrases. Webhook signé → preuve enregistrée puis UI terminée. Recharger et vérifier que la preuve demeure.
7. Vérifier les rejets : signature invalide, appel sortant, ancien appel, autre tenant/numéro, appelant masqué, test expiré, refus de traitement.
8. Vérifier qu’un webhook redélivré après panne DB est idempotent et qu’aucun transcript/secret n’apparaît dans les réponses d’onboarding.

Références : [webhooks ElevenLabs](https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks), [fonctions PostgreSQL et privilèges Supabase](https://supabase.com/docs/guides/database/functions).
