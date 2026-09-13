# Recette V1 professionnelle — Tâche 21

Document préparé le **13 septembre 2026**, pour la branche `feature/v1-professionnel`.
Référence applicative : `4239242c009eaf57de9b578ad89f901e3a0983df` (Tâche 20).
Source de vérité : `voicedesk_project/voicedesk/`.

**Statut : guide prêt ; recette réelle NON EXÉCUTÉE ; validation Karim EN ATTENTE.**
Les tests locaux ne prouvent ni l'exécution des migrations PostgreSQL, ni l'isolation avec de vrais JWT, ni le fonctionnement des fournisseurs en production. Aucun résultat manuel ci-dessous n'est présumé réussi.

## 1. Autorisations et préparation

Avant de commencer, Karim désigne l'environnement QA, son URL frontend/API, le projet Supabase et les ressources fournisseurs dédiées. Aucun déploiement, achat, envoi, migration ou modification d'un compte réel n'est autorisé par la simple lecture de ce guide.

- Utiliser des entreprises, personnes, courriels et numéros de test contrôlés par les testeurs ; aucun prospect ni client réel. Les appels Twilio/ElevenLabs et certains courriels peuvent être facturés : budget et destinataires à autoriser explicitement.
- Stripe en mode test pour les parcours de paiement. Ne jamais mélanger les clés, prix, clients et webhooks test/live. Pas de transaction réelle pour « vérifier » le produit sans accord distinct.
- Prévenir Karim avant toute opération créant/modifiant les données `auth.users`, `profiles`, `companies` ou `subscriptions`. Les inscriptions et changements de forfait de cette recette le feront dans le seul environnement QA autorisé.
- Karim crée via l'UI publique deux comptes indépendants, **QA Alpha** et **QA Bêta**, chacun dans une entreprise distincte. Préparer aussi un super-admin QA et un membre `company_user` invité par Alpha. Ne pas fabriquer ces rôles par un UPDATE SQL improvisé.
- Utiliser des profils navigateur séparés pour Alpha, Bêta et le super-admin. Identifier le propriétaire Alpha (`company_admin` + propriétaire explicite), l'administrateur et le membre. Un compte historique sans propriétaire passe par l'action administrateur prévue.
- Aucun secret dans Git, capture, ticket, rapport, historique de shell ou `.env` local. Injecter les secrets dans l'environnement d'exécution approuvé ; ne relever que leur **présence**, jamais leurs valeurs. Ne pas partager de HAR non expurgé.
- Aucun nouveau fournisseur, aucun Vercel, aucun push direct sur `main`. Ne jamais utiliser l'agent maître ou le numéro de Léa production pour provoquer une panne, tester un rollback ou une réparation.

### Base et migrations — étape bloquante

1. Vérifier que le projet Supabase cible est `ACTIVE_HEALTHY` ; sinon demander sa réactivation à Karim.
2. Inventorier le schéma réel et le registre de migrations. Ne pas déduire « exécuté » de la présence d'un fichier Git et ne pas rejouer aveuglément tous les scripts.
3. Faire valider les SQL complets et le plan de sauvegarde/restauration ; appliquer uniquement les migrations manquantes, dans l'ordre, d'abord en QA. Les dépendances de cette version vont de `009_rls_hardening.sql` à `020_notification_center.sql`, sur le socle existant 001–008.
4. Les migrations **016, 017, 018, 019 et 020 sont documentées comme préparées, non exécutées par Codex**. Le statut distant des migrations antérieures doit être vérifié, pas supposé. En particulier, **018 doit précéder ce backend** : l'absence des RPC de session entraîne volontairement un refus d'accès.
5. Contrôler RLS, GRANT, droits d'exécution des RPC et advisors. Comparer aux exceptions explicites de chaque migration ; les tables/RPC métier backend-only ne doivent pas être exposées à `anon`/`authenticated`. Ne jamais rétablir des GRANT larges pour faire disparaître un 403.
6. Tester réellement les transactions, verrous, baux, rollbacks et doublons SQL en QA. Les tests structurels JS ne valident pas la syntaxe ni le comportement d'un serveur PostgreSQL réel.

Contrôles en lecture seule à conserver dans les preuves techniques (sans données client) :

```sql
SELECT tablename, policyname, roles::text, cmd
FROM pg_policies WHERE schemaname = 'public'
ORDER BY tablename, policyname;

SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated', 'service_role')
ORDER BY table_name, grantee, privilege_type;

SELECT routine_schema, routine_name, grantee, privilege_type
FROM information_schema.routine_privileges
WHERE routine_schema = 'public'
ORDER BY routine_name, grantee;
```

Compléter ces vues par de vrais essais sous les rôles concernés : la vue des privilèges dépend aussi de l'identité qui l'interroge et ne remplace pas les tests d'accès.

### Configuration de l'environnement d'exécution

Vérifier la présence dans le **`.env` de l'environnement d'exécution (production)** lors de la préparation de la production, et des équivalents QA pendant cette recette. Référence exhaustive : [`.env.example`](../voicedesk_project/voicedesk/.env.example), sans copier de vraies valeurs dans le dépôt.

| Groupe | Points de contrôle |
| --- | --- |
| Supabase/Auth | URL, clés anon/service côté approprié, URLs de retour login/récupération/paramètres autorisées, confirmations de courriel et SMTP configurés ; service_role jamais dans Vite |
| Téléphonie | Twilio SID/token, ElevenLabs API/master/signature ; secret Custom LLM unique par agent via `ELEVENLABS_CUSTOM_LLM_AGENT_SECRETS_JSON` ; aucun secret global de développement utilisé en production |
| IA et RAG | Groq, Fireworks, modèle d'embeddings et dimension compatibles avec la migration ; URL d'import dans `KB_SCRAPE_ALLOWED_DOMAINS` si le scénario URL est utilisé |
| Calendly | OAuth client/secret/redirect URI, webhook signé, clé de chiffrement ; permissions nécessaires réellement accordées ; ne pas activer la conformité Enterprise sans capacité validée |
| Stripe | Clés et webhook du même mode, correspondance prix/forfaits, configuration du portail ; taxe activée uniquement si configurée et validée |
| Transactionnel | Resend et `EMAIL_FROM` vérifié, boîte de réception QA, `MONITORING_ALERT_EMAIL` ; droits de monitoring Resend distincts si nécessaires et autorisés |
| Réseau/runtime | URL frontend/backend publiques exactes, HTTPS, proxy de confiance exact, URL publique de validation Twilio cohérente ; worker et secrets propres à l'environnement |

Endpoints à configurer/tester :

- Stripe : `POST /webhooks/stripe` (corps brut + signature).
- ElevenLabs post-appel : `POST /api/voice/call-complete` (corps brut + signature).
- Twilio : callbacks sous `/webhooks/twilio`, notamment `POST /webhooks/twilio/status` ; signature calculée sur l'URL publique exacte et le formulaire.
- Calendly : `POST /webhooks/calendly/:connectionId` ; callback OAuth `/api/v1/calendar/oauth/callback`.

**Attention aux travaux de fond :** `DISABLE_BACKGROUND_JOBS=true` n'arrête pas tous les workers. Pour une inspection QA sans effets de fond, arrêter aussi explicitement `DISABLE_PRIVACY_RETENTION_JOB`, `DISABLE_PRIVACY_CONSENT_SYNC`, `DISABLE_OUTBOUND_WORKER`, `DISABLE_POST_CALL_WORKER`, `DISABLE_KB_WORKER`, `DISABLE_CALENDAR_WORKER` et `DISABLE_TICKET_WORKER` en les mettant à `true`. Cela n'interdit pas les actions déclenchées par HTTP : aucun appel/paiement/provisioning pendant cette inspection. Réactiver uniquement les workers nécessaires et approuvés pour chaque scénario. Un `/health` vert avec des workers désactivés ne constitue pas une recette de ces workers.

## 2. Résultats locaux acquis et limites

### Précontrôle de l'environnement existant — 13 septembre 2026

Karim a confirmé de réutiliser les accès existants. Contrôles réalisés **en lecture seule**, via le connecteur Supabase et des GET HTTP publics, sans secrets affichés ni compte QA créé.

- Projet **Exevori Voice IA**, référence `yptsvqhcnksjxufziech`, région `ca-central-1`, état **ACTIVE_HEALTHY**.
- `ticket_messages.company_id` existe. Toutes les tables publiques présentes ont RLS activée. Sur contacts/calls/tickets/ticket_messages/phone_numbers/notifications : politiques `tenant_isolation` et `service_role_bypass` présentes, aucun GRANT direct à anon/authenticated remonté par la vue interrogée. Les deux helpers du schéma `private` existent. Ces observations sont compatibles avec la migration 009 ; elles ne remplacent pas les six tests cross-tenant sous de vrais comptes.
- Le registre renvoyé par `list_migrations` est vide, **ce qui ne prouve pas qu'aucun SQL n'a été exécuté manuellement**. L'état du schéma fait foi pour l'inventaire.
- Éléments requis absents : `audit_log` (010), `contacts.call_consent` (011), `outbound_call_queue` (012), `calendly_connections` (013), `knowledge_processing_jobs` (014), `ticket_email_outbox` (015), `provider_monitor_state` (016), `admin_impersonation_sessions` (017), `company_settings` et la fonction `account_session_active` (018), `onboarding_progress.setup_data` (019), `notifications.event_key` (020). Ces évolutions ne sont donc pas complètement appliquées ; ceci n'est pas une certification d'absence de toute application partielle.
- Les deux anciennes previews retrouvées (`720876eb-de73-4840-91bd-19cf23fab78e.preview.emergentagent.com` et `emergent-preview-113.preview.emergentagent.com`) renvoient du HTML avec HTTP 200 sur `/` et `/health`, mais **404 sur `/api/v1/billing/verify-session`**. La première page porte le titre **Not Found**. Un HTTP 200 de cette page d'hébergement n'est pas un backend sain. Aucune de ces URL ne permet de valider le parcours API attendu à ce stade.
- Advisors sécurité : 6 fonctions historiques à [search_path mutable](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable), l'extension vector dans [public](https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public), et [protection contre les mots de passe compromis désactivée](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection). Aucun réglage modifié ; pas de déplacement automatique de vector ni de réécriture de fonctions existantes.

**Conclusion : prérequis de recette bloqués, pas tests métier échoués.** Ne pas déployer le nouveau backend sur ce schéma incomplet. Les comptes, données Auth, profils, entreprises, abonnements, fournisseurs et secrets n'ont pas été modifiés. Aucun merge, déploiement ou changement de configuration de l'hébergeur effectué.

Avant de poursuivre : valider sauvegarde/restauration et SQL complet, contrôler les éventuels états partiels, appliquer uniquement les évolutions autorisées dans l'ordre, puis remettre à disposition l'application/API selon le processus de déploiement approuvé. La confirmation des accès n'est pas assimilée à une autorisation de migration ou de mise en production.

### Vérifications du code

Vérifications effectuées sur le code des Tâches 19–20, sans base ni fournisseur réel :

| Vérification | Résultat local au 13 septembre 2026 |
| --- | --- |
| Suite backend | **535/535 tests réussis** |
| Suite frontend JS | **41/41 tests réussis** |
| Tests ciblés notifications | 15 backend + 4 frontend réussis, inclus dans les suites |
| Syntaxe Tâche 20 | `node --check` réussi sur les 10 fichiers JS contrôlés ; JSX vérifié par compilation |
| Vite production | Réussi, 3706 modules ; avertissement de bundle > 500 ko conservé |
| Audit dépendances de la branche | **0 critique, 18 élevées, 10 modérées** ; pas une validation de sécurité complète |
| Exécution SQL, vraie isolation JWT, navigateur connecté, webhooks/appels/boîtes mail | **Non exécutés** |

La dépendance critique `shell-quote` est corrigée dans la branche (`1.9.0`). GitHub signalait encore une critique sur sa branche par défaut lors du push : le correctif n'est pas encore fusionné. Ne pas masquer l'alerte pour la faire disparaître. Les 18 alertes élevées et 10 modérées exigent analyse/correction ou acceptation de risque documentée avant décision de commercialisation ; voir [SECURITY_DEPENDENCIES.md](SECURITY_DEPENDENCIES.md).

Commandes locales, depuis `voicedesk_project/voicedesk/` avec les dépendances déjà installées et **sans secrets réels chargés** :

```powershell
Push-Location backend
node --test --test-reporter=dot
Pop-Location
Push-Location frontend
node --test --test-reporter=dot
npm run build
Pop-Location
npm audit --package-lock-only
git diff --check
```

Relever séparément chaque code de sortie. L'audit retourne un code non nul tant que des vulnérabilités restent présentes. Ne pas lancer `npm audit fix --force`. Le build ne remplace pas un essai visuel/clavier ; les tests utilisent des identités fictives et des transports simulés.

## 3. Tableau de recette à remplir

Pour chaque ligne : noter testeur, date UTC, SHA déployé, résultat **PASS / FAIL / BLOQUÉ**, preuve expurgée et ticket d'anomalie. Un prérequis manquant donne BLOQUÉ, jamais PASS. Arrêter les scénarios concernés en cas de fuite tenant, appel involontaire, facturation imprévue ou état fournisseur incertain.

| ID | Parcours | Résultat réel | Preuve / anomalie |
| --- | --- | --- | --- |
| E01 | Inscription → paiement → onboarding → premier appel | NON EXÉCUTÉ | À renseigner |
| E02 | CRM complet et actions Appeler/RDV | NON EXÉCUTÉ | À renseigner |
| E03 | Isolation Alpha/Bêta, RLS et rôles | NON EXÉCUTÉ | À renseigner |
| E04 | Appel entrant, historique, transcript, audio, RDV | NON EXÉCUTÉ | À renseigner |
| E05 | Outbound, DNC, concurrence, callbacks | NON EXÉCUTÉ | À renseigner |
| E06 | Calendly OAuth, réservation, webhook, confirmation | NON EXÉCUTÉ | À renseigner |
| E07 | Apprentissage → validation → RAG → réponse | NON EXÉCUTÉ | À renseigner |
| E08 | Support, notes internes, notifications, SLA | NON EXÉCUTÉ | À renseigner |
| E09 | Forfaits, facturation, paiement échoué, factures | NON EXÉCUTÉ | À renseigner |
| E10 | Admin, diagnostic/réparation, audit, vue client | NON EXÉCUTÉ | À renseigner |
| E11 | Six fournisseurs en panne + rollback provisioning | NON EXÉCUTÉ | À renseigner |
| E12 | Profil, sessions, équipe, propriétaire | NON EXÉCUTÉ | À renseigner |
| E13 | Notifications, isolation, rétention et retries | NON EXÉCUTÉ | À renseigner |
| E14 | Confidentialité, export, anonymisation, DNC | NON EXÉCUTÉ | À renseigner |
| E15 | Navigation, tableaux de bord, ergonomie, erreurs | NON EXÉCUTÉ | À renseigner |

## 4. Scénarios pas à pas

### E01 — Inscription, paiement, activation, test entrant

Prérequis : inscription QA et éventuels achats de numéro explicitement autorisés ; mode Stripe test ; agent maître dédié QA.

1. Ouvrir `/signup` déconnecté, saisir une identité QA neuve. Vérifier validation des champs, message exploitable en cas d'erreur, absence d'erreur « JSON » brute. Répéter avec un courriel déjà inscrit sans créer une seconde entreprise.
2. Terminer la connexion, ouvrir Checkout, payer en mode test ; revenir sur `/onboarding/success`. Sans `session_id`, `GET /api/v1/billing/verify-session` doit répondre **400 `session_id requis` sans JWT**, pas 401. Une session non active ne doit pas activer le service.
3. Ouvrir `/onboarding`. Enregistrer entreprise/assistante, voix, FAQ. Après chaque étape, fermer/recharger : valeurs et avancement exacts. Vérifier qu'un membre non administrateur ne peut pas muter les étapes.
4. Faire échouer un embedding en QA : FAQ sauvegardée, étape non terminée ; réessayer le même contenu, sans source/chunks dupliqués. Les étapes déjà enregistrées ne sont pas réécrites silencieusement.
5. Déclencher l'activation, puis essayer simultanément depuis un autre onglet : un seul provisioning. Un abonnement non admissible doit être refusé avant achat. Perte réseau : relire le statut, ne pas relancer un achat sur un résultat inconnu.
6. Vérifier numéro actif/agent cohérents. Après trois minutes, l'UI doit cesser d'attendre indéfiniment et proposer une reprise lisible ; cela ne signifie pas que le travail serveur est annulé.
7. Armer le test avec le téléphone E.164 du testeur, appeler manuellement dans les 20 minutes depuis ce téléphone, parler quelques phrases, raccrocher. Attendre le post-appel signé : onboarding terminé seulement après preuve serveur. Recharger : preuve conservée.
8. Sans appel, tenter de confirmer via `/step/4` avec un `call_id` inventé ou `/skip` : aucun contournement. Un appel sortant, ancien, masqué, d'un autre tenant ou hors fenêtre ne valide pas le test.

Preuves : progression avant/après, nombre de ressources QA achetées, statut du webhook, preuve d'appel liée ; aucun numéro complet ni transcript sensible dans le rapport. Détails : [ONBOARDING_RESUME.md](ONBOARDING_RESUME.md).

### E02 — Petit CRM complet et facile à suivre

1. Dans `/crm`, créer un contact Alpha avec données fictives, téléphone contrôlé, besoin, statut et consentement explicite. Rechercher/filtrer, modifier et recharger : valeurs persistantes.
2. Ouvrir la fiche : ajouter une note ; vérifier date/auteur/historique sans duplications. Tester champs invalides et doublon téléphone ; fusionner seulement deux contacts jetables Alpha après confirmation. L'historique doit rester attribué au bon tenant.
3. Cliquer **Appeler** : ouverture `/outbound?contact_id=...`, contact prérempli, pas d'appel avant confirmation. Un refus de consentement/DNC ou rôle insuffisant doit bloquer l'envoi réel.
4. Cliquer **RDV** : afficher les disponibilités de la connexion Alpha, réserver un créneau QA avec confirmation (E06). L'ID contact Beta forcé dans la demande doit être refusé.
5. Vérifier la chronologie après E04–E07 : appels, résumé, besoins, rendez-vous et suggestions reliés au bon contact. Donnée absente = état vide explicite, pas information inventée.
6. Export/suppression uniquement sur données QA selon E14 ; vérifier qu'un rafraîchissement ou un changement de tenant ne réaffiche pas une fiche précédente.

### E03 — Isolation réelle et permissions

1. Créer via les parcours normaux **un contact, un appel et un ticket dans chacun des deux tenants**. Relever les six UUID dans les preuves privées QA.
2. Vérifier d'abord que chaque compte obtient 200 sur ses propres trois ressources avec son vrai JWT actif ; cela évite un faux succès obtenu avec des tokens invalides.
3. Exécuter les six GET croisés du tableau ci-dessous : **403 attendu sur ces trois routes**. Un 401, 404 ou 500 n'est pas le 403 demandé pour ce test. Les autres endpoints peuvent choisir 404 pour cacher l'existence (notifications notamment) : consigner leur contrat séparément.
4. Répéter les tentatives en forçant `company_id` via query/body, ainsi que sur les mutations autorisées de ressources jetables. Contrôler aussi listes, exports, enregistrements, suggestions, campagnes, rendez-vous et pièces de support : aucune donnée de Bêta chez Alpha.
5. Avec `anon` puis les JWT `authenticated`, tenter la Data API et les RPC backend-only : refus attendu. Le backend service_role ne dispense jamais des filtres tenant et de ces tests directs.
6. Vérifier `company_user` vs `company_admin` et super-admin : les actions de gestion doivent être refusées quand le rôle ne les autorise pas. Une session révoquée donne 401 ; un profil désactivé ne garde pas son ancien accès.

| Compte | Ressource étrangère | Attendu | Réel |
| --- | --- | --- | --- |
| Alpha | `GET /api/v1/contacts/<contact-beta>` | 403 | NON EXÉCUTÉ |
| Alpha | `GET /api/v1/calls/<call-beta>` | 403 | NON EXÉCUTÉ |
| Alpha | `GET /api/v1/tickets/<ticket-beta>` | 403 | NON EXÉCUTÉ |
| Bêta | `GET /api/v1/contacts/<contact-alpha>` | 403 | NON EXÉCUTÉ |
| Bêta | `GET /api/v1/calls/<call-alpha>` | 403 | NON EXÉCUTÉ |
| Bêta | `GET /api/v1/tickets/<ticket-alpha>` | 403 | NON EXÉCUTÉ |

Exemple **manuel, non exécuté**, PowerShell/curl Windows. Le JWT est saisi masqué, transmis à curl par son entrée standard plutôt que dans ses arguments ; seul le code HTTP est affiché. Répéter avec chaque compte/route, sans `--verbose`, sans transcription de terminal :

```powershell
$api = (Read-Host 'URL HTTPS de l API QA autorisee').TrimEnd('/')
$path = Read-Host 'Chemin exact /api/v1/contacts/UUID, /calls/UUID ou /tickets/UUID'
if ($api -notmatch '^https://[a-zA-Z0-9.-]+(?::[0-9]+)?$') { throw 'Origine QA invalide' }
if ($path -notmatch '^/api/v1/(contacts|calls|tickets)/[0-9a-fA-F-]{36}$') { throw 'Chemin invalide' }
$secureToken = Read-Host 'JWT du compte testeur (ne pas partager)' -AsSecureString
$jwt = [System.Net.NetworkCredential]::new('', $secureToken).Password
try {
  if ($jwt -notmatch '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$') { throw 'JWT invalide' }
  ('header = "Authorization: Bearer ' + $jwt + '"') |
    curl.exe --config - --silent --show-error --max-time 20 --output NUL --write-out '%{http_code}' --url "$api$path"
  if ($LASTEXITCODE -ne 0) { throw 'Erreur transport curl : test non valide' }
} finally {
  $jwt = $null
  $secureToken.Dispose()
}
```

Un code seul ne suffit pas : vérifier séparément, dans le navigateur QA, que le corps de refus ne contient aucune donnée étrangère. Ne conserver que la preuve expurgée.

### E04 — Réception d'appel, CRM, transcript, audio, RDV

1. Appeler le numéro QA Alpha depuis un contact autorisé et contrôlé. Vérifier accueil, langue, nom de l'assistante et contexte CRM ; aucune donnée Bêta dans les réponses.
2. Exprimer un besoin puis demander un rendez-vous. L'assistante doit utiliser de vraies disponibilités et demander confirmation avant réservation ; ni créneau ni confirmation inventés.
3. Terminer l'appel ; attendre ingestion/worker. Dans `/calls`, vérifier durée, état, résumé, transcript, contact et rendez-vous ; rapprocher SID/conversation des ressources QA dans les preuves privées.
4. Écouter l'enregistrement après confirmation de confidentialité. Vérifier chargement, pause/reprise, absence/expiration d'audio et refus d'un ID Bêta. Ne pas afficher un faux lecteur prêt quand le fournisseur refuse l'accès.
5. Tester un appel sans réponse/échoué et, si configuré, un transfert vers un numéro QA autorisé. Vérifier notification de suivi, sans rappel automatique. Un callback tardif ne dégrade pas un appel déjà terminé/transféré.
6. Redélivrer le même post-appel signé en QA : pas de second appel/CRM/RDV/quota compté. Signature invalide ou altération du corps : refus, aucune mutation.

### E05 — Émission, campagnes, consentement, concurrence

1. Ouvrir `/outbound` (ou action Appeler du CRM), configurer le numéro émetteur QA assigné. Créer une campagne brouillon, avec deux téléphones de test et consentements explicites ; vérifier import/normalisation/doublons.
2. Ajouter un numéro à DNC : insertion/dispatch doivent être refusés. Révoquer le consentement CRM : vérifier propagation DNC et impossibilité de l'enlever pour contourner le refus. Une panne du contrôle DNC doit bloquer, pas autoriser.
3. Lancer après confirmation ; tester plage horaire, quota, abonnement et permission. Doubler le clic puis exécuter avec deux workers QA autorisés : chaque ligne ne doit produire qu'un seul appel effectif.
4. Mettre en pause : pas de nouveaux départs après prise en compte ; un appel déjà parti peut finir. Reprendre, annuler une campagne jetable, vérifier compteurs et interdiction de supprimer une campagne active.
5. Recevoir/redélivrer le callback Twilio signé ; tester SID inconnu, signature invalide, autre tenant et statut tardif. Aucune réattribution ni double consommation.
6. Simuler un timeout après envoi fournisseur : résultat incertain visible, pas de réémission aveugle. Le super-admin vérifie chez le fournisseur avant résolution manuelle documentée ; le client ne peut pas forcer cette résolution.

### E06 — Calendly complet

1. Depuis Paramètres/Calendrier, connecter le compte QA Alpha via OAuth. Vérifier retour sur le bon tenant, token non exposé, refresh fonctionnel. Annuler/refuser OAuth : état clair, aucune fausse connexion.
2. Rejouer le callback OAuth ou altérer son state : refus. Un state Alpha ne peut pas connecter Bêta. Sélectionner un type d'événement réellement accessible.
3. Consulter un intervalle raisonnable de disponibilités ; vérifier fuseau du client, passage minuit et changement d'heure. Créneau indisponible/non autorisé : refus, pas de réservation locale fictive.
4. Réserver avec confirmation depuis CRM puis via l'assistante. Vérifier l'événement **dans Calendly** et la fiche locale, même contact/tenant/heure. Répéter la même clé d'idempotence : un seul rendez-vous ; même clé avec contenu divergent : refus.
5. Recevoir `invitee.created` puis annuler/replanifier un RDV QA via le parcours prévu. Webhook signé + redélivrance : état local cohérent, sans doublon ni deuxième courriel.
6. Vérifier confirmation et rappel dans la boîte QA, From vérifié/Reply-To correct. Une acceptation Resend seule n'est pas une preuve de réception.
7. Signature manquante/fausse, connectionId inconnu, droits OAuth insuffisants ou refresh refusé : erreur visible, aucune écriture étrangère ni token divulgué. Déconnecter uniquement le compte QA ; vérifier absence de nouvelles réservations via l'ancienne connexion.

### E07 — Apprentissage réellement relié au RAG

1. Lors d'un appel QA, poser une question absente de la base ; vérifier la suggestion créée et reliée au bon contact/appel. Dans CRM → fiche → IA, retrouver les hésitations/suggestions en attente.
2. En administrateur Alpha, corriger et approuver une réponse fictive identifiable. Le membre non habilité et Bêta ne doivent pas pouvoir valider cet ID.
3. Dans `/knowledge`, vérifier source d'origine apprentissage, chunks et statut d'indexation réel. Attendre le worker ; aucune validation « prête » si Fireworks ou la persistance échoue.
4. Répéter l'approbation : pas de seconde source/chunk équivalent. Refuser une autre suggestion : elle ne doit pas devenir une connaissance utilisable.
5. Faire un nouvel appel et poser la question : réponse issue de la connaissance Alpha. Le même appel sur Bêta ne doit pas retrouver cette information.
6. Supprimer une source QA, réindexer/recharger puis réessayer : aucun chunk supprimé ne doit encore être récupéré. Tester le seuil RAG et une question sans réponse : ne pas confondre absence de source avec réponse prouvée.

### E08 — Support professionnel, échanges et SLA

1. Alpha ouvre `/support`, crée un ticket avec priorité et description QA ; recharge, suit son état. `/tickets` doit ouvrir le même produit. Beta ne voit ni le ticket ni ses messages.
2. Le super-admin consulte le ticket, l'assigne, répond publiquement ; Alpha reçoit la réponse in-app et le courriel transactionnel prévu. Un retry ne doit pas envoyer un doublon.
3. Ajouter une **note interne** comme agent : invisible au client dans fiche, API, aperçu, notification et courriel. Un client tentant de forcer auteur/rôle/note interne doit être refusé.
4. Vérifier transitions de statut, attente client, résolution/réouverture et satisfaction selon les gardes. Le client ne peut pas s'auto-attribuer un agent ou altérer les champs réservés.
5. Sur une fixture QA à SLA court préparée par l'opérateur, vérifier délais première réponse/résolution, alerte de dépassement et compteurs admin. Une note interne ne vaut pas réponse publique au client.
6. Couper Resend seulement en QA : message support sauvegardé durablement, livraison en attente/échec visible, reprise sans doublon. Erreur DB : aucune réussite affichée.

### E09 — Facturation et abonnement

1. Sur `/billing`, rapprocher forfait, période, minutes incluses/utilisées et factures avec le compte Stripe QA. Le membre ne peut pas gérer les paiements réservés à l'administrateur.
2. Ouvrir le portail, changer de forfait test puis revenir ; vérifier prix autorisé et synchronisation après webhook, pas après simple clic. Un `price_id`, customer ou company étrangers injectés doivent être refusés.
3. Simuler un paiement de facture échoué dans Stripe test : état `overdue`, notification, erreur/action compréhensible. Faire réussir le paiement suivant et vérifier récupération selon les règles du produit.
4. Redélivrer les événements signés, vérifier absence de double abonnement/facture/notification ; signature invalide refusée. Si la mise à jour SQL échoue, le webhook doit retourner une erreur permettant retry.
5. Atteindre le quota avec données/appels QA autorisés : pas de dépassement silencieux, politique explicite ; deux appels simultanés ne doivent pas contourner la limite ou dupliquer l'alerte.
6. Télécharger une facture du seul compte Alpha ; vérifier montant/devise/période. Export ou portail d'un autre client interdit. Aucun détail de carte ou secret dans les logs.

### E10 — Admin, audit et vue client

1. En super-admin réel, ouvrir `/admin`, chercher Alpha, ouvrir sa fiche : identité, abonnement, consommation, téléphonie, équipe, support et compteurs cohérents. Client/membre : API admin 403, pas seulement lien masqué.
2. Lancer le diagnostic téléphonie : états et horodatage réels ; timeout/403 fournisseur ne signifie pas « absent » ou « sain ». Tester uniquement une réparation QA supportée, avec confirmation entreprise/motif, puis relire le diagnostic.
3. Vérifier aucun achat/recréation d'agent/réactivation d'entreprise dans **Réparer**. Références contradictoires ou verrou actif : arrêt/intervention manuelle, pas correction destructive.
4. Ouvrir `/admin/audit` : acteur réel, entreprise, action, résultat ou résultat inconnu ; filtres/pagination stables. Indisponibilité de l'audit préalable : l'action sensible doit être bloquée.
5. Démarrer « Voir comme PME » avec motif : bannière visible, rôle effectif Alpha, pas de bypass super-admin. Tenter ID Beta, API admin, données personnelles de session et notifications : refus adapté.
6. Recharger, ouvrir un second onglet, terminer puis attendre expiration (30 minutes maximum) : session invalide après fin/expiration/remplacement. L'ancien état libre localStorage ne suffit pas à usurper une entreprise. Audit début/fin conservé.
7. Dans `/monitoring`, vérifier six sondes, état non configuré/refusé/périmé distinct, historique non inventé. Détails : [ADMIN_AUDIT.md](ADMIN_AUDIT.md), [PROVISIONING_HEALTH.md](PROVISIONING_HEALTH.md).

### E11 — Pannes fournisseurs et rollback du provisioning

**QA isolé uniquement.** Provoquer une erreur contrôlée dans l'environnement QA ou son transport de test ; ne pas rotater/révoquer de secret production ni provoquer de panne générale. Réinitialiser les fixtures entre les cas. Un test simulé reste étiqueté simulé.

| Fournisseur | Injection QA | Attendu à vérifier |
| --- | --- | --- |
| Twilio | Timeout/5xx, puis accès refusé | Appel/provisioning non déclaré réussi ; aucune réémission/commande en double sur résultat inconnu |
| ElevenLabs | Agent/import/assignation refusé ou timeout | Échec/reprise explicite, verrou libéré ou expirant correctement ; pas de modification de Léa/agent maître |
| Groq | 429/5xx ou timeout | Erreur/fallback prévu observable ; pas de faux résumé ou donnée métier présentée comme résultat IA confirmé |
| Supabase | Échec de lecture/écriture/RPC | Accès sensibles refusés, webhooks non acquittés à tort, aucune liste vide interprétée comme succès |
| Stripe | API indisponible ou webhook retardé | Pas d'activation/paiement fictif ; état en attente et reprise via événement vérifié |
| Resend | Refus/timeout, puis retour normal | Outbox/réessai visible, pas d'envoi dupliqué ; réception réelle confirmée après rétablissement |

1. Pour chaque sonde, vérifier échec continu > 5 minutes → une alerte par incident quand la persistance fonctionne ; reprise puis nouvel incident distinct. Une observation âgée de > 150 secondes est périmée.
2. Tester aussi Fireworks (indexation) et Calendly (OAuth/réservation), hors six sondes du monitoring : leurs parcours métier doivent échouer proprement, pas rester verts artificiellement.
3. Provoquer un échec à chaque phase du provisioning QA : avant achat, après numéro obtenu, après création/import agent, pendant persistance. Relever exactement ce qui existe chez chaque fournisseur et en base.
4. Vérifier rollback seulement des ressources nouvellement créées et dont la propriété est certaine, sans toucher une ressource préexistante. Si cleanup échoue ou réponse fournisseur inconnue : signalement support/diagnostic, pas succès fictif ni suppression aveugle.
5. Interrompre/reprendre un worker, tester deux processus et bail expiré : pas de second achat/dispatch par ancien propriétaire du bail. Refaire le diagnostic avant tout retry manuel.

Limites connues à conserver : secours courriel Supabase non durable et potentiellement multiple entre instances ; Supabase + Resend indisponibles = pas de courriel ; backend arrêté = incapable de se surveiller lui-même. Aucun moniteur externe ajouté. Voir [MONITORING_PROVIDERS.md](MONITORING_PROVIDERS.md).

### E12 — Profil, sécurité et équipe

1. Modifier nom/avatar QA, recharger ; tester fichier trop grand/invalide. Changer le courriel : nouveau courriel pris en compte seulement après confirmation Auth, pas sur simple saisie.
2. Tester `/forgot-password` puis lien `/reset-password` : mot de passe nouveau utilisable, ancien refusé ; lien expiré/invalide affiché sans boucle ni erreur JSON brute. Le formulaire ne doit pas confirmer l'existence d'un tiers.
3. Ouvrir deux sessions ; changer le mot de passe avec réauthentification si demandée, révoquer l'autre session puis toutes : anciennes sessions effectivement refusées côté API, pas seulement supprimées du navigateur.
4. Inviter un membre QA, accepter une seule fois, modifier le rôle autorisé, retirer puis rétablir son accès. Une invitation ne réactive pas une entreprise suspendue ; compte déjà existant traité sans rattachement silencieux à un autre tenant.
5. Tester protections propriétaire/dernier admin/soi-même, transfert explicite à un administrateur actif et audit. Deux mises à jour concurrentes ne doivent pas laisser l'entreprise sans responsable.
6. Paramètres assistante : voix/accueil réellement relus chez l'agent QA, nom/ton/seuil RAG utilisés. Panne de synchronisation = état à relancer ; aucun achat ni écrasement des outils/LLM de l'agent maître.
7. Expéditeur transactionnel : nom/Reply-To personnalisés, adresse From toujours vérifiée ; pas de destinataire arbitraire dans le test de courriel. Voir [ACCOUNT_SETTINGS.md](ACCOUNT_SETTINGS.md).

### E13 — Notifications et rétention

1. Générer les événements QA : nouveau ticket, réponse publique, activation réussie/échouée, paiement échoué, quota atteint, appel entrant non abouti. Vérifier destinataires exacts dans [NOTIFICATION_CENTER.md](NOTIFICATION_CENTER.md) ; aucune alerte client pour note interne.
2. Vérifier cloche/compteur, ouverture clavier, focus, Échap, lien interne ; super-admin voit uniquement ses notifications avec entreprise. En vue client, sa boîte personnelle est inaccessible.
3. Marquer une alerte lue puis recharger. Cliquer « tout lu » pendant qu'une nouvelle alerte arrive : la nouvelle doit rester non lue si créée après l'instantané affiché.
4. Panne API : erreur visible, pas compteur zéro ni faux succès ; changement de compte/tenant pendant chargement : pas de résultat ancien. Un ID appartenant à un autre destinataire retourne 404.
5. Rejouer chaque événement : pas de doublon. Deux appels franchissant le quota simultanément : une alerte par période. Appel manqué sans fiche post-appel : alerte autonome, numéro de rappel si disponible, pas de fiche/transcript inventé ni rappel automatique.
6. Fixture QA avec échéance dépassée : contenu absent de l'API immédiatement, puis nettoyé par maintenance ; redémarrage et backlog repris sans double traitement. Suppression utilisateur nettoie/masque, clé technique anti-rejeu conservée. Les anciennes notifications sans échéance ne sont pas automatiquement réécrites.
7. Préférences partielles conservées, test courriel vers le compte courant uniquement ; quatrième essai de l'heure refusé pour ce processus. Vérifier boîte de réception et non seulement réponse Resend.

### E14 — Confidentialité et suppression

Prérequis : fixtures jetables et autorisation explicite d'export/anonymisation. Aucun vrai dossier client.

1. Paramétrer une rétention QA ; vérifier application aux **nouvelles** données sans effacer rétroactivement l'historique existant. Préparer les échéances accélérées dans une fixture approuvée, jamais par changement d'horloge système en production.
2. Demander l'export d'un contact Alpha : contenu limité au bon tenant/contact, accès et audit conformes. Beta et membre non habilité refusés.
3. Déclencher l'anonymisation prévue : dès la demande en attente, audio inaccessible ; après traitement, vérifier CRM, transcriptions, résumés, enregistrements et données fournisseurs selon les capacités configurées. Un échec externe doit rester visible/en attente.
4. Refus de consentement : vérifier DNC et absence de nouveau dispatch, de rappel automatique et de réapparition du contenu via post-appel tardif/RAG/notifications.
5. Ne pas déclarer une suppression chez un fournisseur non équipé/configuré sur la seule base d'une suppression locale. Consigner les résidus techniques et leur politique de conservation, sans qualifier la conformité juridique comme validée par ces tests.

### E15 — Expérience client/admin et navigation

1. Vérifier tableau de bord client et admin : données du bon périmètre, filtres/périodes, chargement, zéro réel vs erreur. Recharger chaque page et changer de session/entreprise pendant une requête lente.
2. Vérifier accès simple aux appels entrants ET sortants, CRM, calendrier, connaissances/apprentissage, facturation, support et paramètres. Les courriels opérationnels IMAP doivent rester masqués dans la navigation/paramètres ; invitations, support et confirmations transactionnelles restent actifs. Masquer une rubrique ne signifie pas supprimer son ancienne API.
3. **Constat de lecture à recetter :** `/outbound` existe et l'action Appeler du CRM y conduit, mais il n'y a pas d'entrée sortant dédiée dans le menu principal actuel. `/monitoring` existe sans entrée dédiée dans ce menu admin. Vérifier si cette navigation indirecte satisfait Karim ; sinon consigner une correction d'ergonomie avant commercialisation. Le traitement des suggestions se trouve dans la fiche CRM, et leurs sources dans Connaissances, pas dans une route `/learning` frontend distincte.
4. Tester bureau 1440 px, portable 1280 px et petite largeur 390 px, zoom 200 %, clavier seul, focus des modales, libellés, fermeture/rechargement, FR/EN si proposés. Ne pas supposer le mobile validé : aucune recette visuelle n'a été faite dans cette tâche.
5. Provoquer timeout/API non JSON/session expirée dans l'environnement QA : message compréhensible et reprise possible, pas de spinner infini ni écran vide. Console sans erreur bloquante, réseau sans secret et aucun service tiers non approuvé.

## 5. Preuves, anomalies et sortie de recette

Une preuve minimale contient : ID du scénario, date UTC, SHA frontend/backend, environnement/projet QA, rôle/tenant pseudonymisés, étapes, attendu, observé, code HTTP, identifiants techniques expurgés et capture sans PII/secret. Pour un appel/RDV/paiement, joindre la vérification des deux côtés (application + fournisseur). **Les six résultats curl E03 sont obligatoires**, en plus des tests unitaires.

Une anomalie contient : gravité, reproduction, périmètre, preuve, propriétaire, correction SHA et résultat du retest. Fuite tenant, contournement Auth, double appel/achat/paiement, suppression erronée ou note interne exposée = blocage de sortie. Les tests de concurrence/rollback ne deviennent pas PASS par simple revue du code.

À la fin, arrêter uniquement les ressources/workers QA convenus et faire valider leur nettoyage. Aucune suppression automatique de comptes, résiliation de numéros ou déconnexion d'intégration de production.

### Décision Karim — condition de passage à la Tâche 22

- [ ] Environnement, projet, SHA et ressources QA identifiés ; aucune donnée réelle utilisée sans accord.
- [ ] Migrations manquantes validées/appliquées/testées, RLS/GRANT/RPC contrôlés et advisors examinés.
- [ ] E01–E15 exécutés, preuves attachées, six refus cross-tenant confirmés, aucune anomalie bloquante ouverte.
- [ ] Navigation client/admin et ergonomie validées ; réserves explicitement tranchées.
- [ ] Dépendances réauditées, alertes élevées/modérées traitées ou risques formellement acceptés par le responsable.
- [ ] Secrets/URLs de production vérifiés par l'opérateur, capacité Calendly/agent/outbound et coûts confirmés.
- [ ] Sauvegarde, ordre migrations/déploiement, arrêt/reprise workers, surveillance et plan de retour compatibles avec le schéma approuvés.
- [ ] **Karim valide la recette et autorise explicitement la Tâche 22.** Date/signature : **EN ATTENTE**.

Seulement ensuite : préparer la PR `feature/v1-professionnel` → `main`, suivre le merge approuvé **sans rebase** (historique conservé), déployer sur l'environnement retenu, refaire les smoke tests autorisés puis poser le tag `v1.0.0-professionnel` selon validation de release. Aucun de ces actes n'a été réalisé par cette tâche ; pas de merge direct ni de déploiement implicite.

En cas d'échec de recette : corriger dans la branche, retester les scénarios impactés et les suites locales, mettre à jour les preuves et soumettre à nouveau la décision. **Guide terminé ne signifie pas produit prêt à commercialiser.**
