# Tâche 16 — Diagnostic et réparation du provisionnement

## Accès et contrôles

Dans **Admin → fiche entreprise → Téléphonie et assistante**, le diagnostic
effectue quatre contrôles et affiche une date de vérification :

1. Cohérence entre `phone_numbers`, `assistant_configs`, `twilio_configs` et
   présence de la progression d'inscription ; détection des références utilisées
   par d'autres entreprises, y compris les références historiques/orphelines.
2. Numéro Twilio : SID, téléphone, compte maître actif, état `in-use`, capacité voix.
3. Présence de l'agent ElevenLabs attendu.
4. Numéro ElevenLabs : identifiant, téléphone, fournisseur Twilio, agent assigné.

Une permission refusée, un timeout ou une réponse inconnue ne signifie jamais
« ressource absente » ni « tout fonctionne ». Les réponses externes sont limitées
à des projections explicites ; aucun token, prompt ou secret n'est renvoyé.

Routes exclusivement **super_admin** (authentification au montage + garde locale) :

- `GET /api/v1/admin/companies/:id/provisioning-health`
- `POST /api/v1/admin/companies/:id/provisioning-repair`

La seconde exige `confirm_company_id` égal à l'URL et un motif de 3 à 500
caractères. Le serveur déduit lui-même les ressources et les réparations ; les
identifiants Twilio/ElevenLabs ne proviennent jamais du corps de la requête.

## Réparations automatiques limitées

Le bouton **Réparer** n'est proposé que si les autres contrôles sont concluants :

- Restaurer `assistant_configs.twilio_number` / `elevenlabs_agent_id` quand ces
  champs sont NULL, à partir du numéro enregistré et vérifié chez les fournisseurs.
- Lier un numéro ElevenLabs existant **explicitement non assigné** à son agent attendu.
- Réconcilier un état d'inscription non terminé, ou un verrou daté expiré depuis
  plus de cinq minutes, uniquement après confirmation des ressources. Un verrou
  actif ou d'âge inconnu n'est pas repris par cette action.

Les champs non vides contradictoires, numéros multiples, ressources absentes,
identifiants incomplets, autres agents assignés et conflits de propriétaire
exigent une intervention manuelle. Aucun achat de numéro, création/suppression
d'agent, réimport, transfert de propriété ni réactivation de client n'est réalisé.
La relance historique du provisioning reste une action distincte ; ne pas
l'utiliser aveuglément pour résoudre une incohérence de ressources.

L'entreprise doit être active/en essai et son abonnement valide selon la garde
admin existante, revérifiée après acquisition du verrou. `auth.users`, `profiles`,
`companies` et `subscriptions` ne sont pas modifiés par cette nouvelle action.

## Concurrence, audit et résultats partiels

La réparation utilise le même protocole de verrou `onboarding_progress` que le
provisioning (lease atomique de 5 minutes, renouvellement et libération par token).
Le diagnostic est refait sous verrou, les références originales sont comparées,
et les champs de l'assistante sont restaurés par compare-and-set. Les erreurs DB
échouent explicitement. Les requêtes DB ont un timeout de 8 secondes et les
requêtes fournisseur de 5 secondes ; les redirections sont refusées.

Un audit est obligatoire **avant** les mutations. Les tentatives et leurs issues
sont journalisées sans secrets. Un contrôle indépendant après les écritures
détermine le succès ; un PATCH accepté mais non confirmé ne produit pas de succès.
Une interruption peut laisser une réparation partielle : refaire le diagnostic,
ne pas racheter un numéro. Les opérations supportées sont réexécutables.

Le verrou coordonne les processus VoiceDesk, pas les dashboards des fournisseurs.
L'API ElevenLabs ne fournit pas de compare-and-set pour l'assignation : une lecture
est faite juste avant le PATCH, mais il subsiste une fenêtre entre ces deux appels.
Ne pas modifier la même ressource manuellement pendant la réparation. Aucun
rollback destructif n'est tenté en cas d'incertitude.

## Validation et mise en production

Tests automatisés avec faux fournisseurs/base et tests HTTP locaux : accès 401/403,
confirmation, identité tenant, conflits de ressources, erreurs fournisseurs,
reprise idempotente, perte de verrou, changement concurrent et réparation partielle.
Un test utilise le vrai client Supabase avec transport simulé pour vérifier les
filtres PostgREST, sans se connecter à une base réelle.

Aucune nouvelle migration ni variable d'environnement. Utilise les clés serveur
Twilio/ElevenLabs/Supabase déjà prévues ; les droits ElevenLabs doivent autoriser
la lecture des agents/numéros et leur assignation pour réparer.

Les tests de cette tâche ne prouvent pas le fonctionnement d'un appel réel et
aucune réparation de production n'a été lancée. Après déploiement autorisé,
vérifier un tenant QA provisionné, puis un numéro QA non assigné (jamais Léa
production), confirmer l'audit, et terminer par un véritable appel entrant/sortant.

Validation locale du 9 septembre 2026 : **459/459 tests backend, 18/18 tests
frontend, 12 fichiers JavaScript contrôlés avec `node --check`, build Vite réussi**.
L'avertissement préexistant sur la taille du bundle reste présent.

## Fichiers de cette tâche (15)

Dans `voicedesk_project/voicedesk/backend/modules/admin/` :
`companies.js`, `companies.test.js`, `companyService.js`, `index.js`,
`provisioningHealth.js`, `provisioningHealth.test.js`, `provisioningProviders.js`,
`provisioningProviders.test.js`, `provisioningStore.js`.

Dans `voicedesk_project/voicedesk/frontend/src/` :
`components/admin/CompanyDetailSheet.jsx`, `components/admin/ProvisioningHealthPanel.jsx`,
`utils/admin-company.js`, `utils/provisioning-health.js`, `utils/provisioning-health.test.js`.

Documentation : `docs/PROVISIONING_HEALTH.md`.

Références API vérifiées :
[numéros Twilio](https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource),
[compte Twilio](https://www.twilio.com/docs/iam/api/account),
[numéro ElevenLabs](https://elevenlabs.io/docs/eleven-agents/api-reference/phone-numbers/get),
[assignation ElevenLabs](https://elevenlabs.io/docs/eleven-agents/api-reference/phone-numbers/update).
