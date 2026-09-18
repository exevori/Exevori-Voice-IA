# Démonstration locale du client VoiceDesk

Depuis le dossier frontend : `npm run demo`, puis ouvrir http://127.0.0.1:3000/login.

- Identifiant fictif : `client@demo.exevori.test`
- Mot de passe public de démonstration : `DemoVoice2026!`
- Aucun compte Supabase, abonnement réel ou clé d'API requis.

Le vrai frontend utilise, dans cette configuration explicite seulement, un contexte d'authentification de démonstration et une API simulée. Les configurations standard de développement et de production restent inchangées. Ce mode refuse une compilation déployable, écoute uniquement sur 127.0.0.1 et ne relaie aucune requête au backend.

Parcours disponibles : connexion/déconnexion, tableau de bord, historique et transcripts fictifs d'appels entrants, CRM et modification des notes, consultation de campagne sortante, rendez-vous fictifs, base de connaissances manuelle, tickets et réponses locales, notifications. Les actions non simulées affichent un refus explicite. Le bouton Appels sortants dans le bandeau ouvre le parcours d'émission ; aucun lancement réel n'est permis.

Les données fictives et modifications sont enregistrées uniquement dans le stockage local du navigateur (`voicedesk.local-demo.v1`). La session de test est dans sessionStorage. Le bouton Réinitialiser efface seulement ces données de démonstration. N'y saisir aucune vraie information client, aucun mot de passe personnel ni clé fournisseur.

Appels, paiements, emails, provisioning, invitations réelles, Calendly OAuth, upload et calculs d'embeddings sont désactivés. La politique navigateur bloque aussi les connexions vers les services externes. Ce mode permet de découvrir l'interface : il ne remplace pas la recette de l'API, de Supabase, des appels ou des fournisseurs.

Tests : `npm run test:demo`.

## Vérifications de l’interface

- `node --test demo/ui-contract.test.js demo/api.test.js` : vérifie l’isolation et l’absence de changement des appels réseau lors du polish UI.
- Avec Playwright déjà installé et accessible dans `NODE_PATH` : `node demo/ui-smoke.cjs` puis `node demo/ui-flows.cjs`.
- `node demo/ui-flows.cjs --admin` utilise des fixtures éphémères dans le navigateur de test. Il ne crée aucun compte admin et ne donne pas accès à l’administration réelle.
- Captures locales dans `.demo-vite-cache/screenshots/`, exclues de Git.
- La première étape d’onboarding est consultable ; les mutations d’activation restent bloquées.
