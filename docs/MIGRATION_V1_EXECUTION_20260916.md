# Exécution migrations V1 — 011 à 017 validées, arrêt avant 018

Contrôle du **16 septembre 2026, vers 22:36 UTC**.
Projet : `yptsvqhcnksjxufziech` — Exevori Voice IA — `ACTIVE_HEALTHY`.
Branche exclusive : `feature/v1-professionnel`.

## État consolidé

```yaml
Migration 010: OK — appliquée le 14 septembre, non rejouée
Migration 011 (corrigée): OK — appliquée le 14 septembre, contrôlée
Migration 012: OK
Migration 013: OK
Migration 014 (corrigée): OK — deux erreurs résolues, chaque correction committée avant reprise
Migration 015: OK
Migration 016: OK
Migration 017: OK
Migration 018: NON EXÉCUTÉE — refus du contrôle de sécurité avant envoi SQL
Migration 019: NON EXÉCUTÉE — ordre conservé
Migration 020: NON EXÉCUTÉE — ordre conservé
Sauvegarde: aucune — prérequis explicitement levé par Karim
Workers, pollers, cron, purge: aucun démarré par Codex
Merge main / déploiement: aucun
```

Le rapport du [14 septembre](MIGRATION_V1_EXECUTION_20260914.md) reste la trace de l'échec initial de 011 et du comptage préalable. Le présent rapport le remplace pour l'état courant. Ne pas rejouer 009 ni les migrations 010–017 déjà appliquées.

## Registre Supabase vérifié

| Migration | Version distante | Nom |
| --- | --- | --- |
| 010 | 20260914002807 | v1_010_privacy_audit_log |
| 011 | 20260914004035 | v1_011_crm_enrichment |
| 012 | 20260916221756 | v1_012_outbound_rebuild |
| 013 | 20260916222303 | v1_013_calendly_oauth |
| 014 | 20260916223051 | v1_014_kb_learning_unification |
| 015 | 20260916223143 | v1_015_ticket_support_hardening |
| 016 | 20260916223214 | v1_016_provider_monitoring |
| 017 | 20260916223258 | v1_017_admin_audit_impersonation |

018 est absente du registre. `company_settings`, `account_preferences` et `account_session_active(uuid,uuid)` sont absents : aucun début d'application constaté. L'ancien 009, appliqué manuellement, n'est pas déduit du registre.

## Corrections SQL committées et poussées avant application

### 011 — relation des brouillons via leur email parent

Commit : `3cdbeafdb32b00eac5fc07c5389fe5533b1972b9`.
Fichiers : `migrations/011_crm_enrichment.sql` et `backend/modules/crm/index.test.js`, sous `voicedesk_project/voicedesk/`.

- Prérequis réel : `email_drafts.email_id`, pas `email_drafts.contact_id`.
- Contrôle des brouillons par jointure avec `emails`, avec contrôle du tenant des deux tables.
- Aucun UPDATE direct d'une colonne contact inexistante sur les brouillons.
- Comptage avant réaffectation via brouillons → emails → contacts, filtré par entreprise.
- Tests CRM : 17/17 ; syntaxe JS et suite backend réussies lors de cette correction.
- Vérifications base : 7 index valides, fonctions et triggers présents, RPC publiques réservées à `service_role`, 13 contacts conservés.

SHA-256 SQL : `bdf5f2fb78ede26f170b30a5d6f9d878bde126d5e5cd3860a81ae1fa593aa3fa`.

### 014 — opérateur vectoriel et date réelle de détection

Première tentative : erreur PostgreSQL `42883`, opérateur `public.vector <=> public.vector` introuvable sous `search_path = ''`. Diagnostic : pgvector 0.8.0 et l'opérateur sont dans `public`. La transaction a été annulée : nouvelle table/colonne absentes et ancienne fonction conservée.

Correction 1 : qualifier les trois expressions en `OPERATOR(public.<=>)`, sans élargir le search_path ou les droits. Commit : `fa223c73c0cc71cce8427b2b56c06204f3bfba70`.
La syntaxe de qualification est documentée par [PostgreSQL](https://www.postgresql.org/docs/current/ddl-schemas.html#DDL-SCHEMAS-PATH).

Deuxième tentative : erreur `42703`, `created_at` absent de `learning_suggestions`. L'inventaire confirme `detected_at` existant.

Correction 2 : index RAG sur `(company_id, rag_status, detected_at DESC)`, sans ajout de date artificielle ni réécriture de l'historique. Commit : `583e53ff07e001809597343907d93ebc60b17394`.

Fichiers pour chaque correction : `migrations/014_kb_learning_unification.sql` et `backend/modules/kb/migration.test.js`. Les tests vérifient les trois opérateurs qualifiés, le search_path vide, la colonne réelle et les restrictions d'accès. Tests ciblés : **12/12**, `node --check` et `git diff --check` réussis. Le test de l'opérateur échoue bien sur l'ancien SQL avant correction. Suite backend complète `node --test --test-reporter=dot` relancée après les deux corrections : **exit 0**, sans démarrage du serveur applicatif.

SHA-256 du SQL finalement appliqué : `2585eb0e259829d6aac04ec6635e9d6d7ee5d056db67674aacb5b09ec3920c65`.

## Contrôles après chaque migration réussie

| Migration | Nouvelles tables vérifiées avec RLS | Fonctions présentes | Index valides | Colonnes attendues manquantes | GRANT anon/authenticated sur nouvelles tables |
| --- | ---: | ---: | ---: | ---: | ---: |
| 012 | 5 | 26 | 33 | 0 | 0 |
| 013 | 5 | 11 | 18 | 0 | 0 |
| 014 | 1 | 4 | 6 | 0 | 0 |
| 015 | 1 | 8 | 6 | 0 | 0 |
| 016 | 3 | 6 | 2 | 0 | 0 |
| 017 | 1 | 3 | 7 | 0 | 0 |

Pour toutes les RPC publiques de ces migrations : EXECUTE refusé à `anon`/`authenticated`, accordé à `service_role`. Les fonctions privées de triggers sont comptées dans la présence, pas assimilées aux RPC publiques. Ces contrôles ne sont pas des tests fonctionnels exhaustifs de chaque fonction.

- 013 : `appointments.source_direction` est `text`, nullable, sans défaut.
- 014 : 4 anciennes fiches conservées dans `knowledge_base`, 4 sources et 4 chunks RAG ajoutés. 4 jobs pending, attempts=0 ; aucun embedding lancé. Recherche vectorielle en lecture seule sur un tenant inexistant : 0 résultat, sans erreur SQL.
- 017 : `audit_log` reste append-only pour `service_role` : SELECT/INSERT oui, UPDATE/DELETE non. Aucune session d'impersonation créée.
- Global : aucune table publique sans RLS.

## Données et absence d'exécution de jobs

| Compteur final | Valeur |
| --- | ---: |
| calls | 77 |
| outbound_calls | 1 |
| contacts | 13 |
| companies / profiles / subscriptions | 2 / 2 / 2 |
| knowledge_base | 4 |
| knowledge_sources / knowledge_chunks | 18 / 28 |
| jobs RAG pending sans tentative | 4 |
| jobs RAG démarrés | 0 |

CRM : 8 new, 3 qualified, 1 client, 1 lost, conformément à la conversion approuvée. Les consentements restent inconnus ; aucun consentement inventé.

Comptage à zéro : `outbound_call_queue`, `outbound_call_attempts`, `post_call_processing_jobs`, `calendly_webhook_events`, `calendar_booking_requests`, `calendar_email_outbox`, `ticket_email_outbox`, `provider_monitor_checks`, `provider_monitor_alerts`, `admin_impersonation_sessions`.

Ces agrégats ne prouvent pas l'immutabilité de chaque champ ni l'arrêt de tous les services externes. Codex n'a démarré aucun backend/worker ni invoqué de fonction de purge, appel, envoi, fusion CRM ou gestion des comptes. Aucun secret utilisé ou exporté, aucun service ajouté, aucune action Vercel.

## Sécurité restante — non modifiée hors périmètre

Les nouvelles tables/RPC vérifiées n'ont pas de GRANT API direct. Les trois catalogues historiques `voice_library`, `plan_limits`, `plan_pricing` conservent en revanche des GRANT larges à anon/authenticated, dont TRUNCATE. Ils sont hors de la liste de durcissement 009 et n'ont pas été modifiés par 010–017. Leurs politiques SELECT/super-admin ne constituent pas une justification suffisante pour conserver tous ces privilèges : audit ciblé recommandé avant commercialisation, sans correction opportuniste dans cette séquence.

Advisor sécurité : aucune erreur retournée, mais 7 avertissements persistants :

- 5 anciennes fonctions à [search_path mutable](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable) : current_company_id, is_super_admin, currency_for_country, installation_fee_for_country, trg_set_updated_at. L'avertissement de match_kb_chunks a disparu après 014.
- Extension vector dans [public](https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public), non déplacée.
- [Protection des mots de passe compromis](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection) désactivée, non modifiée.

Le push GitHub continue de signaler 119 alertes sur la branche par défaut, dont 1 critique ; ce n'est pas un nouvel audit de la branche feature et aucun merge n'a été effectué pour les masquer.

## Blocage 018 — autorisation explicite à renouveler

Le contrôle automatique de sécurité a refusé **avant exécution** l'appel de migration 018, en raison de la règle de Karim exigeant une alerte préalable avant de toucher aux profils/comptes. Il s'agit d'un refus d'autorisation, pas d'une erreur SQL. Aucun contournement ni nouvelle tentative n'a été effectué.

La lecture du SQL complet précise les capacités créées :

- `manage_company_member` pourra modifier le rôle/statut des profils et transférer la propriété après contrôles tenant/rôle.
- `accept_team_invitation` pourra créer un profil et consommer une invitation.
- `account_session_active` / `account_sessions` liront `auth.sessions` via des fonctions SECURITY DEFINER réservées au backend.
- Ajout de paramètres de compte/assistant et de triggers de rétention sur les futures insertions d'appels/enregistrements.

La migration définit ces fonctions sans les appeler ; elle ne contient pas de backfill des propriétaires ni de mutation immédiate des profils, entreprises, abonnements ou auth.users. Il faut néanmoins confirmer explicitement l'autorisation de **créer ces fonctions sensibles**, sans les tester par mutation de comptes existants.

Après ce GO : reprendre à **018**, vérifier, puis 019 et 020 une par une. Les workers restent arrêtés. Le nouveau backend ne doit pas être lancé avant 018 et la validation complète : ses contrôles de session en dépendent. La recette réelle, les fournisseurs et le déploiement restent des étapes distinctes.

## Requêtes de contrôle reproductibles (lecture seule)

```sql
-- Résultat observé : aucune ligne, toutes les tables publiques ont RLS.
SELECT c.relname
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
  AND NOT c.relrowsecurity;

-- Exceptions observées : les 3 catalogues historiques détaillés plus haut.
SELECT table_name, grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND grantee IN ('anon','authenticated')
ORDER BY table_name, grantee, privilege_type;

-- Résultat observé : 77, 1, 13, 2, 2, 2 ; aucun contenu personnel extrait.
SELECT (SELECT count(*) FROM public.calls) AS calls,
       (SELECT count(*) FROM public.outbound_calls) AS outbound_calls,
       (SELECT count(*) FROM public.contacts) AS contacts,
       (SELECT count(*) FROM public.companies) AS companies,
       (SELECT count(*) FROM public.profiles) AS profiles,
       (SELECT count(*) FROM public.subscriptions) AS subscriptions;

-- Résultat observé : pending / attempts 0 / 4 lignes.
SELECT status, attempts, count(*)
FROM public.knowledge_processing_jobs GROUP BY status, attempts;

-- Résultat observé : tous NULL (018 n'a pas été exécutée).
SELECT to_regclass('public.company_settings') AS company_settings,
       to_regclass('public.account_preferences') AS account_preferences,
       to_regprocedure('public.account_session_active(uuid,uuid)') AS session_rpc;

-- Résultat observé : SELECT/INSERT true ; UPDATE/DELETE false.
SELECT has_table_privilege('service_role','public.audit_log','SELECT') AS can_select,
       has_table_privilege('service_role','public.audit_log','INSERT') AS can_insert,
       has_table_privilege('service_role','public.audit_log','UPDATE') AS can_update,
       has_table_privilege('service_role','public.audit_log','DELETE') AS can_delete;
```
