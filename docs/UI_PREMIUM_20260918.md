# Polish UI premium — 18 septembre 2026

Branche : `feature/v1-professionnel`. Aucun déploiement public, migration, compte Supabase ou service ajouté.

## Écrans retouchés

| Groupe / commit | Pages | Évolution visuelle |
| --- | --- | --- |
| `f25ced2` | Dashboard, Calls, Contacts, Calendar | KPI réutilisables, timeline des interactions, actions rapides, avatars, filtres de statut, transcript mieux délimité, pipeline CRM, fiche deux colonnes sur grand écran, agenda chronologique et repères Aujourd’hui/Demain. Navigation compacte sur mobile sans changement de routes. |
| `85e4dfd` | Billing, Tickets, Settings, OnboardingPage | Forfait mis en avant, jauge verte/orange/rouge, messages client à gauche et support à droite, SLA visible, chargements skeleton, paramètres latéraux, aperçu de l’assistante avant enregistrement, stepper numéroté et animation de succès conditionnée à la confirmation réelle du test. |
| `aac892c` | Admin, Monitoring, AdminAudit + CompanyDetailSheet | KPI agrandis, avatars entreprise, sections de fiche repliables, états/latence lisibles, historique 24h respectant les tokens, vue chronologique d’audit et filtre local d’acteur explicitement limité à la page chargée. |
| `7af57a0` | Landing, Signup, ForgotPassword, ResetPassword | Hero animé avec mouvement réduit respecté, CTA et cartes soignés, forfait recommandé, formulaires cohérents, stepper d’inscription et indication de format de courriel. Les noms d’entreprises illustratifs ne sont plus présentés comme des références clients. |

Les finitions de confirmation d’archivage et de notifications CRM sont livrées avec ce rapport. Annuler n’effectue aucune mutation ; les mêmes requêtes d’archivage sont conservées après confirmation.

## Contraintes respectées

- `src/App.jsx`, les routes, les contextes de production, `components/ui/` et `tailwind.config.js` restent inchangés.
- Aucun appel réseau ou argument de requête modifié dans les 15 pages : comparaison AST avec le commit de référence `8de8785`.
- Pas de nouvelle couleur hexadécimale dans les pages. Les nouveaux composants de composition réutilisent les primitives existantes et les tokens Exevori.
- Garde d’affichage corrigée dans Dashboard : l’état initial `stats = null` ne doit pas accéder à `stats.calls`. C’était la cause de l’écran blanc lors de la connexion de test.
- Pas de données de production touchées. Les seules données modifiées par les tests sont fictives et locales.

## Vérifications

- `node --test demo/ui-contract.test.js demo/api.test.js` : **25 tests réussis**.
- `vite build` réussi après chacun des quatre commits de pages. Avertissement existant : bundle JS supérieur à 500 kB ; aucun changement de découpage de bundle dans ce périmètre visuel.
- Navigateur Edge local : Dashboard, Calls, CRM, Calendar, Billing, Support, Settings, Landing, Signup, ForgotPassword, ResetPassword affichés sans erreur JavaScript ; pas de débordement horizontal du dashboard à 390 px.
- Interactions : mauvais mot de passe refusé, connexion démo réussie, détail d’appel et transcript, fiche CRM, annulation d’archivage, aperçu de l’assistante et première étape d’onboarding vérifiés.
- Admin, Monitoring et AdminAudit vérifiés avec des fixtures éphémères dans le navigateur de test, sans créer de compte administrateur réel. Aucune action sensible admin exécutée.
- Captures locales non versionnées : `voicedesk_project/voicedesk/frontend/.demo-vite-cache/screenshots/`.
- Les marqueurs et identifiants de démo sont absents du JavaScript de production compilé.

## Limites explicites du brief

1. Le dashboard ne reçoit pas de série quotidienne ni de période de comparaison. Aucune courbe, sparkline ou hausse en pourcentage artificielle ajoutée. Leur livraison demande un contrat de données complémentaire, hors polish visuel.
2. La page Calls existante suit les appels entrants. Les campagnes sortantes gardent leur parcours existant : pas de filtre « Sortants » qui ferait croire à une liste fusionnée inexistante.
3. Aucun churn calculé sans historique adapté. Les indicateurs admin existants sont conservés ; aucun faux KPI commercial ajouté.
4. Pas de témoignage client inventé. Les offres, conditions d’essai et promesses commerciales héritées doivent toujours être validées avant publication ; le polish n’est pas une validation de ces conditions.
5. L’audit par acteur filtre les événements de la page chargée, pas l’ensemble de la base. Les filtres serveur existants sont inchangés.
6. Les tests locaux ne remplacent pas la recette Supabase, Stripe, téléphonie, Calendly ou emails. Les états publics de paiement, d’activation et de récupération de compte ne sont pas validés en production ici.

## Démo client locale

- Lancement depuis `voicedesk_project/voicedesk/frontend` : `npm run demo`.
- Adresse : `http://127.0.0.1:3000/login`.
- Identifiant fictif : `client@demo.exevori.test`.
- Mot de passe public de démo : `DemoVoice2026!`.
- Données locales réinitialisables ; aucun paiement, appel, envoi, achat de numéro ou provisioning réel.
- Le mode démo est sélectionné par une configuration Vite distincte et n’entre pas dans le build de production.

Les scripts de navigateur nécessitent Playwright déjà disponible (`NODE_PATH`) : `node demo/ui-smoke.cjs`, `node demo/ui-flows.cjs`, `node demo/ui-flows.cjs --admin`.
