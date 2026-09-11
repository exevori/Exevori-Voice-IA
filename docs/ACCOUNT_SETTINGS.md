# Paramètres V1 — Tâche 18

## Livré dans le code

- Profil personnel : nom, avatar JPEG réduit à 256 px (128 Kio maximum), changement de courriel confirmé par Supabase Auth. Seul le courriel confirmé est synchronisé dans le profil ; le contact de facturation reste indépendant.
- Sécurité : changement de mot de passe, réauthentification par code lorsque Supabase la demande, liste des sessions présentes dans Auth, déconnexion des autres appareils ou de tous les appareils.
- Chaque requête protégée vérifie désormais le JWT, l’existence de sa session Auth et le profil actuel sans cache de rôle. Une indisponibilité de vérification refuse l’accès.
- Équipe : invitations, rôles canoniques, révocation/rétablissement d’accès, propriétaire distinct du rôle SQL, transfert explicite et journalisé. Les transitions sont sérialisées par entreprise et protègent le propriétaire, soi-même et le dernier administrateur actif.
- L’acceptation d’invitation crée le profil et consomme l’invitation atomiquement ; elle ne réactive jamais une entreprise. Un compte déjà inscrit exige une vérification support (un seul tenant par compte).
- Assistant : nom/ton appliqués au Custom LLM ; seuil de pertinence réellement envoyé au RAG ; voix et accueil synchronisés sur l’agent ElevenLabs existant, avec relecture de confirmation. Aucun achat de numéro ni modification de l’agent maître.
- Une configuration est sauvegardée avant la synchronisation externe. En cas de panne ou résultat inconnu, l’interface montre « à relancer » : réenregistrer les mêmes valeurs réessaie. Un verrou de deux minutes évite les sauvegardes simultanées ; aucune suppression/rotation de ressource.
- Calendly OAuth accessible dans les paramètres, avec lien vers les types d’événements et disponibilités.
- Personnalisation du nom d’expéditeur et Reply-To des invitations d’équipe et confirmations/rappels Calendly. L’adresse From reste celle du domaine vérifié configuré par Exevori.
- Rétention par entreprise pour les NOUVEAUX appels, appels sortants, enregistrements et transcriptions. Les horloges existantes sont conservées ; aucun effacement rétroactif.
- Masquage d’écoute côté serveur et confirmation de confidentialité avant téléchargement. Une suppression de confidentialité en attente interdit déjà l’écoute. Chaque accès autorisé à l’audio est journalisé, sans nom de fichier contenant des données personnelles.
- Les onglets IMAP sont masqués, y compris via l’ancien paramètre d’URL. Les fonctions transactionnelles restent présentes.

## Rôles

| Fonction produit | Représentation |
| --- | --- |
| Propriétaire | company_admin + company_settings.owner_user_id |
| Administrateur | company_admin |
| Membre | company_user |

Une nouvelle inscription crée explicitement son propriétaire. Aucun propriétaire historique n’est deviné.
Pour une entreprise existante : Administration → fiche entreprise → **Équipe et propriétaire**.
Cette action conserve l’identité administrateur réelle ; un transfert de propriété est interdit en vue client.
Le propriétaire peut ensuite transférer à un administrateur actif. Une entreprise sans propriétaire doit être initialisée par le super-admin.

## Déploiement — approbation requise

La migration **018_account_settings.sql est préparée, pas exécutée**.
Elle dépend des migrations 009 à 017 et du schéma réel existant.
Ne pas déployer ce backend avant son application validée : sans les RPC de session, l’API refuse volontairement les connexions.

La migration :
- crée company_settings et account_preferences, RLS activée, sans GRANT à anon/authenticated ;
- ajoute le seuil RAG et l’état/verrou de synchronisation à assistant_configs ;
- expose à service_role seulement deux fonctions étroites de lecture de auth.sessions (aucune écriture dans le schéma Auth) ;
- prépare les fonctions de gestion d’équipe et d’acceptation d’invitation ; elles modifieront profiles uniquement lors d’actions futures explicites ;
- ajoute des triggers de rétention sur INSERT, sans réécriture des données existantes.

Le CLI Supabase et un PostgreSQL local ne sont pas disponibles dans cet environnement. Le nom suit donc la convention numérotée du dépôt. Les tests SQL locaux vérifient la structure et les contrats, **pas l’exécution PostgreSQL ni les politiques en base**.

Précontrôles à faire avant exécution autorisée :

~~~sql
SELECT to_regclass('auth.sessions'), to_regclass('public.company_settings');
SELECT column_name FROM information_schema.columns
WHERE table_schema='auth' AND table_name='sessions'
AND column_name IN ('id','user_id');
SELECT table_name, column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name IN ('calls','outbound_calls','call_recordings')
AND column_name IN ('company_id','retention_days','transcript_retention_days');
~~~

Après migration, vérifier les GRANT/RLS et l’accessibilité des RPC uniquement par service_role.
Tester en QA une session révoquée (401), un compte inactif (403), les trois profils owner/admin/member, deux entreprises différentes, la panne des RPC, les sauvegardes concurrentes et la reprise d’une synchronisation ElevenLabs.

Configurer dans Supabase Auth l’URL de retour publique /settings, les confirmations de courriel, SMTP transactionnel et les politiques de mot de passe souhaitées. Aucune nouvelle clé ni service n’est ajouté par cette tâche.

## Vérification locale

Les tests utilisent Express local et le vrai client supabase-js avec transport HTTP simulé, des comptes/identifiants fictifs et aucun appel à la base de production.
Ils couvrent l’isolation, les autorisations, les erreurs, les requêtes exactes, les invitations, la synchronisation d’agent, les limites des données, les contrôles d’écoute et la structure SQL.
La compilation Vite vérifie les JSX ; elle ne remplace pas la recette visuelle ni les essais de vrais courriels, sessions Supabase, appels téléphoniques et rendez-vous.

Références : [sessions Supabase](https://supabase.com/docs/guides/auth/sessions),
[modification du compte](https://supabase.com/docs/reference/javascript/auth-updateuser),
[déconnexion](https://supabase.com/docs/reference/javascript/auth-signout),
[mise à jour d’un agent ElevenLabs](https://elevenlabs.io/docs/api-reference/agents/update).
