# Exécution migrations V1 — arrêt sur 011

Contrôle du **14 septembre 2026 à 00:30 UTC** (13 septembre, heure locale de Karim).
Projet : `yptsvqhcnksjxufziech` — Exevori Voice IA — `ACTIVE_HEALTHY`.
Branche source : `feature/v1-professionnel`, commit SQL `e189e48874b94b38c1deaf16a80b49440342b633`.

## Autorisation et limites

Karim a explicitement autorisé l'exécution **sans sauvegarde** après comptage, en déclarant les données exclusivement de test Exevori. Ce comptage n'est ni un export logique ni une sauvegarde restaurable. Aucune sauvegarde de base n'a été créée ou validée.

Les conversions CRM et la rétention normale de 90 jours sont approuvées. Aucun worker, poller, cron, job de purge ou backend n'a été démarré par Codex pendant cette séquence. Les contrôles locaux n'ont identifié que les processus Node du runtime Codex ; les connexions SQL observées ne constituent pas une preuve exhaustive de l'arrêt de tous les services externes.

Aucun mot de passe réinitialisé, aucun secret ajouté à un fichier, aucun forfait activé, aucun déploiement, aucun appel fournisseur et aucune migration 009 rejouée. La valeur ressemblant à un secret communiquée dans le chat n'a été ni testée ni recopiée.

L'archive des outils PostgreSQL a fini de se télécharger sous `G:\VoiceDesk\tools\postgresql-17.11\` après reprise, mais n'a pas été extraite/exécutée. Ce fichier n'est pas un backup. Le parcours pg_dump a été abandonné à la demande de Karim.

## Résultat de la séquence

```yaml
Migration 010: OK — appliquée et contrôlée
Migration 011: ÉCHEC — garde de schéma, email_drafts.contact_id absent
Migration 012: NON EXÉCUTÉE — arrêt après 011
Migration 013: NON EXÉCUTÉE — arrêt après 011
Migration 014: NON EXÉCUTÉE — arrêt après 011
Migration 015: NON EXÉCUTÉE — arrêt après 011
Migration 016: NON EXÉCUTÉE — arrêt après 011
Migration 017: NON EXÉCUTÉE — arrêt après 011
Migration 018: NON EXÉCUTÉE — arrêt après 011
Migration 019: NON EXÉCUTÉE — arrêt après 011
Migration 020: NON EXÉCUTÉE — arrêt après 011
Purge des 51 appels anciens: NON DÉCLENCHÉE
```

Les scripts ont été soumis séparément par l'outil Supabase de migration, sans modification du SQL approuvé. L'application de 010 est enregistrée sous `20260914002807 / v1_010_privacy_audit_log`. 011 n'apparaît pas dans le registre après échec. Le registre ne retrace pas les anciennes applications manuelles de 009 : **ne pas la rejouer**.

## Comptage avant migration — traçabilité

24 tables non vides, 488 lignes au total dans ces tables. Aucun contenu de ligne ni donnée personnelle exportés.

| Table public | Lignes |
| --- | ---: |
| call_events | 278 |
| calls | 77 |
| knowledge_chunks | 24 |
| knowledge_sources | 14 |
| contacts | 13 |
| appointments | 12 |
| learning_suggestions | 10 |
| emails | 7 |
| invitations | 6 |
| voice_library | 6 |
| outbound_contacts | 5 |
| plan_pricing | 5 |
| plan_limits | 5 |
| activity_logs | 4 |
| email_drafts | 4 |
| knowledge_base | 4 |
| outbound_campaigns | 3 |
| companies | 2 |
| profiles | 2 |
| assistant_configs | 2 |
| subscriptions | 2 |
| notification_preferences | 1 |
| outbound_calls | 1 |
| twilio_configs | 1 |

Requête exécutée :

```sql
SELECT table_name,
       (xpath('/row/cnt/text()', xml_count))[1]::text::int AS row_count
FROM (
  SELECT table_name,
         query_to_xml(
           format('SELECT COUNT(*) AS cnt FROM public.%I', table_name),
           false, true, ''
         ) AS xml_count
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
) t
WHERE (xpath('/row/cnt/text()', xml_count))[1]::text::int > 0
ORDER BY row_count DESC;
```

## Contrôles 010 réussis

- SQL SHA-256 : `1e5e5d89673b169de95c9ebdf294ad4248d7b2d6591f48fcaeab15751f65fb22`.
- `audit_log` et `privacy_external_deletions` créées, RLS active sur les deux.
- Neuf nouvelles colonnes de rétention/anonymisation/identifiant ElevenLabs présentes.
- Six colonnes de rétention : NOT NULL et valeur par défaut 90.
- Dix-huit index attendus présents et valides.
- Cinq fonctions présentes : `purge_expired_audit_log`, `enqueue_consent_refusal_cleanup`, `anonymize_contact_data`, `purge_expired_privacy_data`, `claim_privacy_external_deletions`.
- EXECUTE autorisé à `service_role`, refusé à `anon` et `authenticated` sur ces cinq fonctions.
- `audit_log` : `service_role` reçoit SELECT/INSERT uniquement.
- `privacy_external_deletions` : `service_role` reçoit SELECT/INSERT/UPDATE/DELETE.
- Aucun GRANT direct à `anon`/`authenticated` sur ces deux tables.
- Quatre identifiants historiques ElevenLabs repris ; zéro appel avec rétention différente de 90.
- Après 010 : 77 appels, 1 appel sortant, 13 contacts, 2 companies, 2 profiles, 2 subscriptions.
- Audit et file de suppression externe : **0 ligne** chacun ; aucune fonction de purge/anonymisation appelée.

## Échec 011 et diagnostic

SQL SHA-256 : `073f64404f9981637ce44a084d08f3d61246e6508d6423ca059d36dfe68a7e69`.

Erreur exacte :

```text
ERROR: P0001: Migration 011 aborted — missing required columns: email_drafts.contact_id
CONTEXT: PL/pgSQL function inline_code_block line 73 at RAISE
```

La garde correspond à la ligne 157 du fichier [011_crm_enrichment.sql](../voicedesk_project/voicedesk/migrations/011_crm_enrichment.sql). La même colonne inexistante est utilisée dans la vérification cross-tenant de `merge_crm_contacts` (lignes 709–710) et dans son UPDATE (lignes 745–749). **Retirer uniquement le prérequis ne corrigerait pas la fonction.**

Schéma réel de `email_drafts` : `id uuid`, `company_id uuid`, `email_id uuid`, `to_email text`, `subject text`, `body text`, `status text`, `ai_confidence integer`, `ai_reasoning text`, `sent_at timestamptz`, `approved_by text`, `created_at timestamptz`.

Clés étrangères : `company_id → companies(id)` et `email_id → emails(id)`. Le contact se retrouve **via emails.contact_id**, pas par une colonne de brouillon.

Contrôle des 4 brouillons : 4 emails parents présents, 4 contacts accessibles via l'email, 0 incohérence tenant entre brouillon et email.

### Annulation transactionnelle confirmée

Après échec de 011 :

- schéma `crm_private` absent ;
- extension `pg_trgm` absente ;
- les 11 colonnes CRM ajoutées par 011 absentes ;
- `dnc_list.source` absente ;
- statuts inchangés : 8 new, 2 warm, 1 hot, 1 customer, 1 cold ;
- 010 reste en place, RLS conservée ; tables audit/file externe toujours vides ;
- registre de migrations : uniquement l'entrée 010 créée pendant cette séquence.

Ces contrôles confirment l'annulation de 011 ; aucune conversion CRM de cette migration n'a été conservée.

### Proposition à valider par Claude — non appliquée

Adapter 011 à la relation réelle `email_drafts.email_id → emails.id → contacts.id` :

- remplacer le prérequis inexistant par `email_drafts.email_id` et conserver les vérifications de tenant ;
- vérifier les brouillons via leur email parent, en contrôlant les company_id des deux tables ;
- conserver la réaffectation de `emails.contact_id` lors de la fusion, qui rattache déjà ses brouillons au bon contact ;
- retirer l'UPDATE direct de `email_drafts.contact_id` et adapter le comptage des brouillons liés ;
- ajouter les tests correspondant au schéma réel avant toute nouvelle tentative.

Aucun SQL corrigé, aucun nouvel essai 011 et aucune migration suivante pendant ce tour.

## Advisors après 010

Les avertissements déjà observés avant migration restent présents ; aucun nouveau constat nommé par l'advisor dans les objets de 010 :

- six fonctions historiques avec [search_path mutable](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable) ;
- extension vector dans [public](https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public) ;
- [protection des mots de passe compromis désactivée](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

Aucun assouplissement RLS/GRANT ni correction opportuniste de ces avertissements.

## Requêtes de contrôle utilisées

### Vérification 010

```sql
SELECT jsonb_build_object(
'tables',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'rls',c.relrowsecurity)) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('audit_log','privacy_external_deletions')),
'columns',(SELECT jsonb_agg(jsonb_build_object('table',table_name,'column',column_name,'nullable',is_nullable,'default',column_default)) FROM information_schema.columns WHERE table_schema='public' AND ((table_name IN ('calls','call_recordings','outbound_calls') AND column_name IN ('retention_days','transcript_retention_days')) OR (table_name='calls' AND column_name='elevenlabs_conversation_id') OR (table_name IN ('contacts','outbound_contacts') AND column_name='anonymized_at'))),
'indexes',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'valid',i.indisvalid)) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname=ANY(ARRAY['idx_calls_privacy_transcript_purge','idx_calls_privacy_retention_purge','uq_calls_elevenlabs_conversation','idx_call_recordings_privacy_purge','idx_call_recordings_privacy_transcript_purge','idx_outbound_calls_privacy_transcript_purge','idx_outbound_calls_privacy_retention_purge','idx_contacts_anonymized','idx_outbound_contacts_anonymized','idx_audit_log_company_created','idx_audit_log_actor_created','idx_audit_log_entity_created','idx_audit_log_request','idx_audit_log_retention','uq_privacy_external_deletions_resource','idx_privacy_external_deletions_claim','idx_privacy_external_deletions_company_contact','idx_privacy_external_deletions_terminal_purge'])),
'functions',(SELECT jsonb_agg(jsonb_build_object('name',n.nspname||'.'||p.proname,'service_execute',has_function_privilege('service_role',p.oid,'EXECUTE'),'anon_execute',has_function_privilege('anon',p.oid,'EXECUTE'),'authenticated_execute',has_function_privilege('authenticated',p.oid,'EXECUTE'))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname||'.'||p.proname=ANY(ARRAY['privacy_private.purge_expired_audit_log','public.enqueue_consent_refusal_cleanup','public.anonymize_contact_data','public.purge_expired_privacy_data','public.claim_privacy_external_deletions'])),
'grants',(SELECT jsonb_agg(jsonb_build_object('table',table_name,'role',grantee,'privilege',privilege_type)) FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name IN ('audit_log','privacy_external_deletions') AND grantee IN ('anon','authenticated','service_role')),
'counts',jsonb_build_object('calls',(SELECT count(*) FROM public.calls),'outbound_calls',(SELECT count(*) FROM public.outbound_calls),'contacts',(SELECT count(*) FROM public.contacts),'companies',(SELECT count(*) FROM public.companies),'profiles',(SELECT count(*) FROM public.profiles),'subscriptions',(SELECT count(*) FROM public.subscriptions),'audit_log',(SELECT count(*) FROM public.audit_log),'deletion_queue',(SELECT count(*) FROM public.privacy_external_deletions)),
'retention_invalid',(SELECT count(*) FROM public.calls WHERE retention_days<>90 OR transcript_retention_days<>90),
'elevenlabs_backfilled',(SELECT count(*) FROM public.calls WHERE elevenlabs_conversation_id IS NOT NULL)
) AS verification;
```

### Vérification après échec 011

```sql
SELECT jsonb_build_object(
'email_drafts_columns',(SELECT jsonb_agg(jsonb_build_object('column',column_name,'type',data_type) ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='email_drafts'),
'email_drafts_foreign_keys',(SELECT jsonb_agg(jsonb_build_object('name',conname,'definition',pg_get_constraintdef(oid))) FROM pg_constraint WHERE conrelid='public.email_drafts'::regclass AND contype='f'),
'migration_011_markers',jsonb_build_object('crm_private',to_regnamespace('crm_private'),'pg_trgm_installed',EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_trgm'),'new_contact_columns',(SELECT jsonb_agg(column_name) FROM information_schema.columns WHERE table_schema='public' AND table_name='contacts' AND column_name IN ('next_action_date','next_action_note','email_consent','email_consent_at','sms_consent','sms_consent_at','call_consent','call_consent_at','archived_at','archived_by','merged_into_contact_id')),'dnc_source_exists',EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='dnc_list' AND column_name='source')),
'contact_statuses',(SELECT jsonb_object_agg(status,n) FROM (SELECT status,count(*) AS n FROM public.contacts GROUP BY status) s),
'counts',jsonb_build_object('calls',(SELECT count(*) FROM public.calls),'contacts',(SELECT count(*) FROM public.contacts),'companies',(SELECT count(*) FROM public.companies),'profiles',(SELECT count(*) FROM public.profiles),'subscriptions',(SELECT count(*) FROM public.subscriptions),'audit_log',(SELECT count(*) FROM public.audit_log),'deletion_queue',(SELECT count(*) FROM public.privacy_external_deletions)),
'migration_010_rls',(SELECT jsonb_object_agg(relname,relrowsecurity) FROM pg_class WHERE oid IN ('public.audit_log'::regclass,'public.privacy_external_deletions'::regclass))
) AS diagnostic;
```

### Relation brouillons/email/contact

```sql
SELECT jsonb_build_object(
  'drafts_total', count(*),
  'drafts_with_email', count(e.id),
  'drafts_with_contact_via_email', count(*) FILTER (WHERE e.contact_id IS NOT NULL),
  'drafts_with_tenant_mismatch', count(*) FILTER (
    WHERE e.id IS NOT NULL AND d.company_id IS DISTINCT FROM e.company_id
  )
) AS linkage
FROM public.email_drafts d
LEFT JOIN public.emails e ON e.id = d.email_id;
```

**Reprise bloquée en attente de validation du correctif 011. Ne pas rejouer 010 ni 009.**
