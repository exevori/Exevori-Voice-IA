# Tâche 20 — Centre de notifications

## Livré

- Cloche dans le header, nombre de notifications non lues, fenêtre modale native accessible (focus/Échap), 50 dernières alertes, actualisation toutes les 30 secondes.
- Lecture individuelle et « tout marquer lu » confirmées par le serveur. Un instantané serveur empêche de marquer lue une nouvelle alerte arrivée après l’affichage. Les erreurs ne deviennent ni un compteur zéro ni une réussite fictive.
- Isolation par `user_id` ET `company_id` pour les clients. Le super-admin voit uniquement les notifications qui lui sont adressées, avec l’entreprise concernée. La vue client d’impersonation ne permet pas de consulter/modifier les notifications personnelles.
- Liens internes limités aux rubriques autorisées. Aucun HTML non fiable rendu et aucune redirection vers une URL externe. Les liens de ticket utilisent le paramètre réel `?ticket=` ; les alertes administrateur d’activation/facturation ouvrent Administration, où l’entreprise doit être sélectionnée.
- Schéma conservé : `type` reste la sévérité info/success/warning/error ; ajout de `event_type`, `event_key` idempotente et `payload`. `read` historique reste compatible avec `read_at`.
- Rétention capturée à la création depuis les paramètres de l’entreprise (90 jours par défaut). Les contenus expirés sont exclus de l’API immédiatement puis nettoyés par le travail horaire borné. Les clés techniques d’événement restent comme traces anti-doublon, sans corps ni téléphone. Une suppression utilisateur masque et nettoie la notification, sans détruire sa clé anti-rejeu. Les anciennes notifications sans échéance ne sont pas réécrites automatiquement.
- Courriel test transactionnel vers l’identité authentifiée, sans destinataire choisi dans le corps de requête, limité à 3 tests par heure/utilisateur/processus. Résultat Resend vérifié. Les préférences restent personnelles et les mises à jour partielles ne réinitialisent pas les autres catégories.

## Événements et destinataires

| Événement | Source effective | Destinataires |
| --- | --- | --- |
| Nouveau ticket | INSERT ticket, même transaction | Membres actifs de l’entreprise + super-admins actifs |
| Réponse publique support | INSERT message après le premier message | Client → super-admins ; agent → membres de l’entreprise ; auteur exclu |
| Note interne | Aucune notification client | Non publiée dans le centre |
| Activation terminée / échouée | Transition `onboarding_progress.provisioning_status` | Entreprise + super-admins |
| Paiement échoué | Transition de l’abonnement vers `overdue` | Entreprise + super-admins |
| Quota atteint | Compteur abonnement ou durées des appels entrants/sortants | Entreprise + super-admins, une alerte par période |
| Appel entrant à reprendre | Statut d’appel enregistré OU callback Twilio signé non abouti | Membres actifs de l’entreprise propriétaire du numéro |

En V1, tout appel entrant enregistré comme manqué/non abouti est considéré comme nécessitant un suivi ; aucune importance n’est inventée depuis un transcript. Un échec Twilio avant création d’une conversation ElevenLabs peut produire une alerte autonome avec le numéro de rappel lorsqu’il est disponible. **Cette alerte n’invente pas de fiche d’appel ni de résumé** : si aucun appel n’a été enregistré, le lien ouvre la liste et le numéro figure dans l’alerte. Aucun rappel automatique, aucun contournement du consentement/DNC.

Le HMAC Twilio reste vérifié avant le routeur. Le tenant provient du numéro appelé actif en base, pas d’un `company_id` reçu. Un callback tardif ne dégrade pas une fiche déjà terminée/transférée. Un échec d’écriture renvoie une erreur pour permettre la nouvelle livraison. Les erreurs d’écriture de l’état de paiement ne sont plus avalées par le handler Stripe.

Les émissions in-app et les transitions métier sont dans la même transaction SQL, avec clé unique par destinataire/événement. Le courriel support reste géré par l’outbox durable de la Tâche 13 : pas de second envoi ajouté. Aucun nouveau fournisseur, SDK ou secret.

## Application et vérifications

Migration `020_notification_center.sql` **préparée, non exécutée**. Appliquer après 019, avec validation opérateur, avant déploiement de ce backend. Les déclencheurs lisent les profils/abonnements pour les destinataires et événements ; ils ne changent pas les données Auth, profils, entreprises ou abonnements. Le callback manqué peut mettre à jour le statut d’une fiche d’appel existante, après signature et contrôle tenant.

Fonctions `SECURITY INVOKER`, EXECUTE retiré à PUBLIC/anon/authenticated, service_role seulement. RLS maintenue et GRANT explicites. Le nettoyage démarre dans le bloc existant `DISABLE_BACKGROUND_JOBS !== "true"` ; aucun travail lancé pendant les tests locaux. Erreurs de maintenance : journal neutre et nouvelle tentative, sans téléphone/secret dans les logs.

Validation locale : vrai client supabase-js avec transport simulé + HTTP Express local, contrôle structurel du SQL, tests JS et build Vite. **Pas de validation PostgreSQL réelle**, pas de webhook live, pas de courriel ni d’appel envoyé pendant les tests. Le CLI Supabase/PostgreSQL local étant indisponible, le fichier suit la numérotation du dépôt.

Recette autorisée avant production : appliquer sur l’environnement QA, vérifier RLS/ACL/advisors, générer les sept événements, redélivrer chaque webhook, vérifier absence de doublons, note interne invisible au client, notifications de deux tenants isolées, ID tiers refusé, panne DB visible, nouvelle alerte conservée pendant « tout lu », callbacks inconnus/masqués, reprise du nettoyage et contenu expiré inaccessible. Tester les compteurs avec deux appels simultanés franchissant le quota.
