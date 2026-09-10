# Tâche 17 — journal d’audit et vues client

Implémentation sur `feature/v1-professionnel`. Aucune migration ni donnée de production modifiée. Aucun service, secret ou paquet ajouté.

## Périmètre livré

- Page `/admin/audit`, réservée au super-admin : journal et historique des vues client, filtres entreprise/date/action, pagination serveur par curseur stable `(date, id)`.
- Acteur identifié par son ID utilisateur immuable ; entreprise nommée lorsque présente dans l’annuaire existant. Pas de copie de profil ni de courriel dans le nouveau journal.
- Accès API authentifiés du super-admin journalisés avant le handler, puis résultat HTTP journalisé séparément. Aucun corps de requête, paramètre de recherche, token, transcription, IP ou user-agent enregistré par ce middleware.
- Les événements métier existants restent visibles : consultation/suspension/réactivation d’entreprise, export/anonymisation et diagnostic/réparation du provisioning. Le même request ID permet de rapprocher accès HTTP et événement métier.
- Une demande de changement de forfait a ses événements `admin_plan_change_requested` et `admin_plan_change_response`. Cela trace l’accès au flux Stripe, **pas la confirmation du changement dans Stripe**. Les actions effectuées directement dans les dashboards fournisseurs sont hors de ce journal applicatif.
- Les deux entrées « Voir comme PME » et « Impersonate » de la fiche client passent par la même session serveur, avec motif et confirmation.

## Sessions et isolation

- Durée maximale : 30 minutes, sans prolongation implicite. Une nouvelle session remplace atomiquement celle déjà ouverte par le même administrateur, y compris dans un autre onglet.
- Début/fin et événements de cycle de vie écrits dans la même transaction. Verrou consultatif par acteur, index unique sur la session ouverte ; un même request ID ne crée ni ne prolonge une seconde session.
- Chaque requête de vue client présente `X-Impersonation-Session`. Le backend valide l’acteur, l’expiration et la fermeture, sans utiliser le cache de profil pour cette validation de rôle.
- Le rôle effectif de la requête et de l’interface devient `company_admin` pour l’entreprise cible. Le bypass global super-admin n’est donc plus disponible dans la vue client ; l’identité réelle reste disponible pour l’audit.
- Une réauthentification répétée dans une même chaîne Express ne peut pas restaurer ce bypass.
- Les sessions sont conservées dans `sessionStorage`, liées au compte, puis revérifiées au serveur au rechargement. L’ancien objet libre dans `localStorage` n’active plus aucune vue.
- L’adaptateur fetch est limité aux API du projet (URL configurée et proxy même origine), avec Bearer correspondant. Aucun header d’impersonation vers Supabase Auth, Stripe ou un fournisseur externe ; pas de suivi de redirection pour les appels de vue client.
- Les sorties explicites et déconnexions ferment la session. Une fermeture d’onglet ou perte de réseau n’est pas une fin confirmée : l’historique indique une expiration déduite, plafonnée à 30 minutes.
- Une indisponibilité de l’audit initial bloque l’accès avant son handler. Si seul l’enregistrement du résultat échoue, le début reste durable et le résultat doit être considéré inconnu, pas réussi.

## API

| Route | Usage |
| --- | --- |
| `GET /api/v1/admin/audit` | Journal filtré, 50 résultats par défaut, maximum 100 |
| `GET /api/v1/admin/impersonations` | Historique filtré des sessions |
| `GET /api/v1/admin/impersonations/:id` | Vérifier sa propre session active |
| `POST /api/v1/admin/companies/:id/impersonate` | Ouvrir une session ; confirmation entreprise + motif |
| `POST /api/v1/admin/impersonations/:id/end` | Fermer sa session ; motif `user_exit` ou `sign_out` |

Filtres : `company_id`, `actor_user_id`, `session_id`, `action` (journal), `from` inclus, `to` exclus, `cursor`, `limit`. Dates complètes UTC ; l’interface convertit le jour de fin inclus vers le lendemain UTC. Les fractions PostgreSQL sont conservées dans le curseur.

## Migration 017 — à faire valider avant production

Fichier : `voicedesk_project/voicedesk/migrations/017_admin_audit_impersonation.sql`.

- Nécessite la migration 010 et sa table `audit_log`. À exécuter **avant le déploiement** de ce backend, après validation du SQL complet.
- Nouvelle table `admin_impersonation_sessions`, backend-only : RLS, aucun GRANT pour `anon/authenticated`, SELECT uniquement pour `service_role`. Écritures via RPC de cycle de vie uniquement.
- Ajout de `audit_log.impersonation_session_id` et des index de pagination. Audit toujours SELECT/INSERT uniquement pour `service_role`, pas UPDATE/DELETE direct.
- Fonctions à `search_path` vide, EXECUTE révoqué à PUBLIC/anon/authenticated, accordé exclusivement au backend.
- Aucun FK ni écriture visant `auth.users`, `profiles`, `companies`, `subscriptions`.
- Purge bornée des sessions expirées depuis 730 jours, raccordée au job de rétention existant. Pas de suppression en cascade du journal.
- La migration n’est pas un script à rejouer aveuglément : une seule application, transactionnelle, selon le registre des migrations.

Contrôles à effectuer dans l’environnement validé : RLS/GRANT sur les deux tables, refus de RPC avec anon/authenticated, ouverture/fermeture concurrente, retry du même request ID, rollback complet si insertion audit refusée, isolation entre deux administrateurs et deux entreprises.

## Vérification locale

- Backend : 474 tests réussis, dont 15 nouveaux tests d’audit. Tests HTTP locaux avec identités de test injectées, **pas des comptes QA de production**.
- Client Supabase réel avec transport simulé : filtres actor/tenant, projection, pagination avec microsecondes, RPC et timeout. Aucune requête à une base réelle.
- Frontend : 26 tests réussis, dont 8 nouveaux tests de transport, validation/restauration de session, rôle effectif et contrat UI.
- `node --check` : 14 fichiers JS modifiés/créés validés ; JSX vérifié par Vite.
- Build Vite réussi ; avertissement préexistant sur la taille du bundle conservé.
- SQL : contrôles structurels automatisés et revue du script, **pas d’exécution PostgreSQL locale ou distante**. Les tests transactionnels SQL et le parcours navigateur authentifié restent à réaliser dans l’environnement QA avant commercialisation.

## Fichiers concernés (22)

Backend :

- `middleware/auth.js`, `middleware/adminAudit.js`
- `modules/admin/index.js`, `companyService.js`, `companies.test.js`, `audit.js`, `audit.test.js`
- `modules/privacy/index.js`, `retention_job.js`, `retention_job.test.js`

Frontend :

- `src/App.jsx`, `src/contexts/AuthContext.jsx`
- `src/pages/AdminAudit.jsx`
- `src/components/admin/CompanyDetailSheet.jsx`
- `src/components/common/ImpersonationSwitcher.jsx`
- `src/components/layout/Layout.jsx`
- `src/utils/admin-company.js`, `admin-audit.js`, `impersonation.js`, `impersonation.test.js`

Migration 017 et ce rapport complètent la liste.

Les changements de profil d’authentification sont purement applicatifs : conservation du retour `signIn().session.access_token`, du flux récupération de mot de passe et de la déconnexion. Aucun utilisateur, profil, entreprise ou abonnement réel n’a été créé/modifié pour ces tests.
