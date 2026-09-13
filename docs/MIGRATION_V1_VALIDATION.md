# Mise à niveau V1 — dossier de validation préalable

Préparé le **13 septembre 2026**, après accord de Karim pour engager la mise à niveau de la base existante, **avec sauvegarde et validation du SQL avant exécution**.

Projet ciblé : **Exevori Voice IA**, `yptsvqhcnksjxufziech`, région `ca-central-1`.
Branche uniquement : `feature/v1-professionnel`.

**Aucune migration exécutée. Aucune sauvegarde créée ni restauration effectuée. Aucun déploiement, changement de secret, appel ou paiement.** Le présent document ne constitue pas un GO SQL.

## 1. Sauvegarde — prérequis non vérifié

Le connecteur confirme `ACTIVE_HEALTHY`, mais n'expose pas la liste des sauvegardes. L'ouverture du Dashboard par le navigateur intégré n'a pas abouti ; ce résultat ne permet pas de conclure qu'une sauvegarde existe ou qu'elle manque.

Karim/opérateur doit ouvrir la [page des sauvegardes de ce projet](https://supabase.com/dashboard/project/yptsvqhcnksjxufziech/database/backups/scheduled) et relever, sans secrets :

- type de sauvegarde et état terminé/disponible ;
- date/heure UTC du dernier point restaurable, et éventuellement fenêtre PITR ;
- confirmation de l'accès au mécanisme de restauration et de l'impact acceptable d'un retour à cette date ;
- protection distincte des objets Storage et ressources externes concernés, si présents.

**Ne pas cliquer sur Restore pour ce contrôle.** Ne pas activer un forfait, PITR ou autre option payante sans accord sur son coût. Si aucune sauvegarde utilisable n'est disponible, préparer un export logique complet par l'outillage PostgreSQL/Supabase approuvé, hors dépôt, dans un stockage protégé, puis vérifier sa restauration dans un environnement isolé autorisé. Un inventaire de schéma, des compteurs ou une copie des migrations ne sont pas une sauvegarde des données.

La [documentation officielle Supabase](https://supabase.com/docs/guides/platform/backups) précise que les sauvegardes de base ne contiennent pas les fichiers Storage, et qu'une restauration rend temporairement le projet indisponible. Une sauvegarde quotidienne peut perdre les écritures postérieures à son point de reprise. Aucune promesse de restauration sans perte n'est faite ici.

## 2. Constats en lecture seule

Toutes les requêtes de cette préparation ont porté sur les métadonnées ou des agrégats ; aucun nom, courriel, transcript, téléphone ou secret de client n'a été exporté.

| Contrôle | Observation |
| --- | --- |
| Schéma public | 46 tables, 621 colonnes inventoriées |
| Taille de base observée | 17 927 315 octets ; ce n'est pas une taille d'export ni une preuve de sauvegarde |
| Appels entrants enregistrés | 77, dont **50 de plus de 90 jours** |
| Appels sortants enregistrés | 1, de **plus de 90 jours** |
| Enregistrements dans `call_recordings` | 0 ; cela ne prouve pas l'absence d'audio chez les fournisseurs |
| Horodatages `created_at` NULL | 0 dans calls/outbound_calls/call_recordings |
| Identifiants historiques `conv_` dans calls | 4 ; aucun groupe dupliqué détecté parmi eux |
| Statuts des 13 contacts | 8 new, 2 warm, 1 hot, 1 customer, 1 cold |
| Contacts sortants | 5 pending |
| Messages ticket avec parent absent/tenant divergent | 0 |
| Pièces jointes dont message référencé absent/ou autre ticket | 0 |
| Chunks RAG avec source absente/tenant divergent | 0 |
| Embeddings | `vector(1536)` ; extension vector 0.8.0 dans public |
| Colonnes Auth requises par 018 | `auth.sessions.id` et `user_id` présentes ; aucune session lue ou modifiée |
| pg_trgm | Non présent dans l'inventaire des extensions ; 011 prévoit son installation dans extensions |

Les protections RLS et l'absence des éléments V1 ont déjà été relevées dans [TEST_E2E.md](TEST_E2E.md). Les contrôles ci-dessus sont ciblés : ils ne certifient pas toutes les contraintes, tous les types ou tous les chemins des fonctions SQL. Les migrations n'ont pas été exécutées dans un PostgreSQL de test pendant cette préparation.

## 3. Effets sur l'historique à valider

### Migration 010 : rétention et audit

Le SQL attribue **90 jours de rétention aux appels existants** dont les nouveaux champs sont NULL. Il prépare les fonctions de purge ; l'application de 010 seule ne lance pas ces fonctions. Toutefois, au démarrage ultérieur des workers, les **50 appels entrants et 1 appel sortant anciens** risquent d'être nettoyés selon leur état et leur contenu.

**Recommandation pour la mise à niveau : préserver cet historique, et ne pas démarrer les nettoyages tant qu'une politique explicite n'a pas été validée.** Aucun ancien horodatage n'est modifié artificiellement pour contourner une échéance. Si Karim veut exclure les anciens appels de la nouvelle politique ou choisir une autre durée, le SQL devra être adapté, retesté et soumis à nouveau ; ce document n'a pas modifié la politique actuelle.

La migration renseigne aussi le champ ElevenLabs à partir des 4 identifiants historiques `conv_`. L'absence de doublons sur ce sous-ensemble est constatée, sans conclure à la réussite de tous les futurs index. Elle crée audit et file de suppressions externes ; aucune suppression fournisseur ne doit être déclenchée pendant la préparation.

### Migration 011 : conversion CRM

La conversion prévue modifierait les statuts métier de **5 contacts** : 2 warm + 1 hot vers qualified, 1 customer vers client, 1 cold vers lost. Les 8 new restent new. Le script exécute un UPDATE du statut sur l'ensemble des contacts et copie les anciennes prochaines actions non vides dans le nouveau champ de note. Les consentements inconnus restent inconnus : aucun accord de rappel ne doit être inventé.

### Migrations suivantes

- 012 introduit les files et états des appels/post-appels ; aucun worker ne doit démarrer au milieu de la séquence.
- 013 ajoute le stockage OAuth/Calendly et peut reprendre les URI historiques reconnues. Les autres identifiants existants restent inchangés.
- 014 prépare le RAG unifié ; la table de connaissances historique est conservée. Les contraintes `NOT VALID` protègent les nouvelles écritures mais ne valent pas validation de tout l'historique.
- 015 prépare le support transactionnel, ses contraintes et sa séquence de numéros ; aucune campagne de courriels de test sans autorisation.
- 016–020 ajoutent monitoring, audit administrateur, paramètres/sessions, onboarding et notifications. En particulier, 018 est un prérequis au démarrage du nouveau backend.
- Les fonctions de gestion d'équipe/onboarding pourront écrire profils/entreprises lors de futures actions explicites. Les triggers de notification lisent les profils/abonnements. Aucun compte ni abonnement existant ne doit être modifié par un test implicite de ces fonctions.

## 4. Incompatibilité corrigée dans le dépôt seulement

La garde initiale de 013 exigeait `appointments.source_direction`, absent de la base et non créé par 010–012. Le service Calendly écrit pourtant ce champ. La migration se serait arrêtée avant application.

Correction locale : retirer ce champ des prérequis historiques et l'ajouter avec les autres nouveaux champs Calendly :

```sql
ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS source_direction text,
  -- autres colonnes Calendly inchangées dans le fichier complet
```

Cet extrait est explicatif, **pas un script à exécuter**. Le SQL complet figure dans le lien 013 ci-dessous. Le champ est nullable, sans valeur par défaut ni réécriture de l'historique : une direction inconnue n'est pas transformée en appel entrant fictif.

Le nouveau test de contrat échoue sur l'ancienne migration, puis passe après correction. **31/31 tests Calendly réussis** avec base/fournisseurs simulés, `node --check` réussi sur le test modifié. Cela ne remplace pas une validation PostgreSQL réelle.

## 5. SQL complets soumis à revue

Lire les fichiers complets dans l'ordre. Ne pas copier seulement les extraits du présent document. Ne pas rejouer 009 sur la seule base du registre de migrations vide : son état doit être comparé au schéma existant. 017 n'est notamment pas un script à rejouer aveuglément.

Les empreintes ci-dessous portent sur les octets des fichiers locaux préparés ; une conversion CRLF/LF peut les changer sans changement SQL. Toute modification de contenu invalide la validation correspondante.

| Ordre / SQL complet | SHA-256 du fichier préparé |
| --- | --- |
| [010 — confidentialité/audit](../voicedesk_project/voicedesk/migrations/010_privacy_audit_log.sql) | `1e5e5d89673b169de95c9ebdf294ad4248d7b2d6591f48fcaeab15751f65fb22` |
| [011 — CRM](../voicedesk_project/voicedesk/migrations/011_crm_enrichment.sql) | `073f64404f9981637ce44a084d08f3d61246e6508d6423ca059d36dfe68a7e69` |
| [012 — émission/post-appel](../voicedesk_project/voicedesk/migrations/012_outbound_rebuild.sql) | `600aea28505c45f397f378db835ed7acfa800eb8e198d89ef8a0b823c5c905a7` |
| [013 — Calendly corrigé](../voicedesk_project/voicedesk/migrations/013_calendly_oauth.sql) | `8847dedd9757b7b61f45864181367b18a79e3bfde84e74ab7b85b3b567096152` |
| [014 — RAG/apprentissage](../voicedesk_project/voicedesk/migrations/014_kb_learning_unification.sql) | `24193180a3d05bc28f6c7b274f0f7b9c8a564a298803d5211cc0e8d4e48721df` |
| [015 — support](../voicedesk_project/voicedesk/migrations/015_ticket_support_hardening.sql) | `70b2fa357eb4838fe336444644ef539cfa75769fee9066d7cf37297bc840d2a7` |
| [016 — monitoring](../voicedesk_project/voicedesk/migrations/016_provider_monitoring.sql) | `a15a624bb298a516058d071587aad60acabd4158a31f930a62e509f5235bdbbb` |
| [017 — audit/vue client](../voicedesk_project/voicedesk/migrations/017_admin_audit_impersonation.sql) | `5d98f72268723b6a3783aef968a412d93b67786a29e2f5cdcdb7a9d26360b720` |
| [018 — paramètres/sessions](../voicedesk_project/voicedesk/migrations/018_account_settings.sql) | `8d51a99656c8068bbd4c25a7287641f43c3961aee4ae1f0fa900fd53ef13d85d` |
| [019 — onboarding](../voicedesk_project/voicedesk/migrations/019_onboarding_resume.sql) | `c591328bf3593475bf0f0b76593db02b90037dd65fd2cc2d3d7030571c7e32f5` |
| [020 — notifications](../voicedesk_project/voicedesk/migrations/020_notification_center.sql) | `4c6e4a9cea52a2d91c310ddc9b180605dfb62fb4ab18d87668071c0058f24b1b` |

## 6. Ordre opératoire après validation

1. Confirmer la sauvegarde restaurable, l'historique à conserver et le SQL exact. Tant que l'un manque : **STOP**.
2. Identifier les processus existants et leurs webhooks. Définir une fenêtre de maintenance pour éviter les écritures pendant la mise à niveau ; ne pas interrompre Léa ou un autre service sans accord spécifique.
3. Tester les SQL validés sur un environnement isolé autorisé avant la base existante ; aucune nouvelle branche/projet Supabase payant créé implicitement.
4. Après autorisation d'exécution, appliquer **une migration à la fois**, dans l'ordre, avec contrôles après chacune. Au premier échec : arrêt et diagnostic ; pas d'assouplissement RLS/GRANT pour forcer le passage.
5. Contrôler colonnes, fonctions, contraintes/index et privilèges, puis advisors. Vérifier que les anciens comptes et abonnements n'ont pas subi de modification inattendue. Conserver la preuve du script exact et du résultat de chaque étape.
6. Aucun worker actif avant compatibilité complète et décision de conservation. `DISABLE_BACKGROUND_JOBS=true` seul ne suffit pas : voir les drapeaux distincts dans [TEST_E2E.md](TEST_E2E.md).
7. Déploiement, merge/tag et vrais parcours QA selon leur autorisation propre ; aucune réussite commerciale déduite des migrations seules.

Si retour arrière nécessaire : arrêter les écritures selon le plan approuvé, choisir le point de restauration validé, faire confirmer l'opération puis restaurer et vérifier. **Ne pas fabriquer un rollback en supprimant les nouvelles tables/colonnes** : certaines conversions et ressources externes ne sont pas annulées ainsi. Une restauration de la base ne remet pas automatiquement Twilio, ElevenLabs, Calendly ou Stripe dans leur état précédent.

## Décisions encore attendues

- Preuve de sauvegarde restaurable : **NON VÉRIFIÉE**.
- Conservation des 51 appels anciens / politique de rétention historique : **À VALIDER**.
- Validation du SQL complet et des conversions de données : **EN ATTENTE**.
- Exécution des migrations / modifications production : **NON EFFECTUÉES**.
