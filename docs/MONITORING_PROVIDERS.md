# Monitoring fournisseurs — Tâche 15

## Périmètre et activation

`GET /api/v1/admin/provider-status` est réservé aux `super_admin`. Le worker
s'exécute toutes les 60 secondes sans page ouverte. Les rafraîchissements
rapprochés réutilisent la mesure ; chaque observation porte son propre horodatage.

Avant activation en production :

1. Valider puis appliquer `voicedesk_project/voicedesk/migrations/016_provider_monitoring.sql`
   dans un environnement de test. Cette migration n'a pas été exécutée par Codex.
2. Vérifier les six configurations existantes, `EMAIL_FROM`, `RESEND_API_KEY` et
   renseigner `MONITORING_ALERT_EMAIL` avec le(s) destinataire(s) administrateur.
3. Laisser `DISABLE_BACKGROUND_JOBS` et `DISABLE_PROVIDER_MONITOR` différents de `true`.
4. Avec une clé Resend limitée à l'envoi, le contrôle des domaines peut répondre
   403. Ne pas élargir cette clé automatiquement : une clé distincte peut être
   fournie dans `RESEND_MONITORING_API_KEY` après validation de Karim.

Aucune nouvelle dépendance ni aucun service tiers n'est ajouté.

## Sens des sondes

| Fournisseur | Requête en lecture seule | Validation |
| --- | --- | --- |
| Twilio | GET compte maître | SID correspondant et statut `active` |
| ElevenLabs | GET utilisateur | Réponse avec identifiant utilisateur |
| Groq | GET modèles | Liste non vide |
| Supabase | SELECT id sur companies, limite 0 | Requête Data API exécutée, aucune donnée client retournée |
| Stripe | GET balance | Objet `balance`, aucun solde exposé |
| Resend | GET domaines, limite 1 | Liste de domaines, aucun domaine exposé |

Sources : [Twilio](https://www.twilio.com/docs/iam/api/account),
[ElevenLabs](https://elevenlabs.io/docs/api-reference/user/get),
[Groq](https://console.groq.com/docs/models),
[Stripe](https://docs.stripe.com/api/balance/balance_retrieve),
[Resend](https://resend.com/docs/api-reference/domains/list-domains).

Ces sondes vérifient un accès API, pas un parcours métier complet. Elles ne
produisent ni appel, ni paiement, ni courriel de test. Les contrôles sont bornés
à 5 secondes et interrompent la requête réseau. Les erreurs brutes et les clés
ne sont jamais retournées au navigateur ni stockées dans l'historique.

Clé absente/invalide : non configuré. HTTP 401/403 : accès refusé, pas panne
globale présumée. Autres échecs : contrôle en échec. Après 150 secondes sans
mesure, l'interface affiche une mesure périmée, même si elle était verte.

## Historique et alertes

Les trois tables de monitoring ont RLS forcée ; `anon` et `authenticated` n'ont
aucun privilège. Les RPC sont `SECURITY INVOKER` et réservées à `service_role`.
Les baux et jetons de fencing empêchent plusieurs workers d'enregistrer le même
contrôle ou d'acquitter le travail d'un autre worker.

Une barre représente 15 minutes et conserve le pire état mesuré. Une période
sans mesure reste inconnue. Les fenêtres avec moins de 10 observations sont
signalées partielles. Les données brutes restent au plus environ 48 heures
(purge horaire bornée), les alertes terminales environ 30 jours.

Après plus de cinq minutes d'échec observé continu (`down` ou `unauthorized`),
une seule alerte durable est créée par incident. Un trou de surveillance de
plus de 150 secondes remet le compteur à zéro. Les alertes restent livrables
après le rétablissement : notamment lorsque Resend lui-même était indisponible.
Le texte décrit donc une observation passée et renvoie au monitoring pour l'état
actuel. L'acceptation Resend n'est pas une preuve de réception par le destinataire.

Les tentatives utilisent une clé d'idempotence stable et des retries progressifs.
La fenêtre est bornée à 23 heures pour rester dans la fenêtre d'idempotence
Resend de 24 heures ; ensuite une livraison non confirmée reste visible en échec.

## Limites du secours

Si la persistance Supabase échoue, les sondes continuent en mémoire. Une panne
Supabase observée pendant plus de cinq minutes peut déclencher directement un
courriel Resend. Ce secours n'est pas durable : un redémarrage remet son compteur
à zéro et plusieurs processus peuvent chacun envoyer une alerte. La déduplication
forte multi-instance n'est garantie que lorsque la base fonctionne.

Si Supabase et Resend sont simultanément indisponibles, aucun courriel ne peut
partir. Si le backend entier est arrêté, il ne peut pas se surveiller lui-même.
Un moniteur externe nécessiterait une autorisation distincte ; aucun n'a été ajouté.

## Validation

Tests automatisés locaux : sondes simulées, six fournisseurs, absence de clés,
401/403/429/5xx, réponse incohérente, interruption timeout, rôle admin, protections
contre rafraîchissements concurrents, baux, retries et secours Supabase,
affichage inconnu/périmé et historique incomplet. Les tests de contrat SQL ne
remplacent pas une exécution PostgreSQL.

À vérifier dans la base de test avant mise en production :

- Réexécuter la migration pour confirmer son idempotence.
- `anon` et `authenticated` : lecture des trois tables et appel des six RPC refusés.
- Deux sessions `service_role` : un contrôle dû ne doit être réclamé qu'une fois.
- Résultat avec ancien jeton ou bail expiré : `record_provider_check` retourne false.
- Échecs espacés d'une minute pendant six minutes : une seule alerte.
- Rétablissement puis nouvel incident : nouvelle alerte distincte.
- Incident Resend puis rétablissement : l'ancienne alerte reste réclamable.
- Acquittement avec mauvais jeton : refus ; acquittement valide : état sent.
- Historique : six fournisseurs, fenêtres manquantes non remplies artificiellement.

Les appels fournisseurs réels, l'envoi d'alerte et l'exécution SQL restent des
vérifications d'intégration à effectuer sur un environnement autorisé.
