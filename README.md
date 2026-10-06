# Virtual AutoFisher

Application de bureau Windows (Electron + React) qui automatise le bot Discord **Virtual Fisher** avec votre propre compte : pêche en boucle, vente, buffs, appât, `/daily`, suivi des quêtes, avec un tableau de bord en direct (solde, niveau, prises, boosts, poissons rares, journal).

## Avertissements

- **Utiliser le token de votre compte (self-bot) est contraire aux conditions d'utilisation de Discord.** Votre compte s'expose à une suspension ou à un bannissement.
- **Virtual Fisher interdit les macros** : votre progression peut être remise à zéro ou bannie.
- L'application imite un rythme humain (délais aléatoires, pauses optionnelles), ce qui **réduit le risque sans l'annuler**.
- Vous utilisez cet outil à vos propres risques. Il n'est pas affilié à Discord ni à Virtual Fisher.
- Votre token est stocké **chiffré** (stockage sécurisé de Windows via Electron `safeStorage`), n'est jamais affiché ni écrit dans les journaux, et n'est envoyé qu'à Discord.

## Installation

### Depuis l'installeur

1. Téléchargez `VirtualAutoFisher-Setup-x.y.z.exe` depuis l'onglet **Releases** du dépôt GitHub (ou construisez-le avec `npm run build:win`, il arrive dans `dist/`).
2. Exécutez l'installeur : vous pouvez choisir le dossier d'installation.
3. Windows SmartScreen peut afficher un avertissement car l'installeur n'est pas signé : « Informations complémentaires » puis « Exécuter quand même ».

### Depuis les sources

Prérequis : Node.js 20 ou plus récent.

```bash
npm install
npm run dev
```

## Récupérer son token Discord

1. Ouvrez Discord dans votre navigateur (`discord.com/app`) et connectez-vous.
2. Appuyez sur **F12** pour ouvrir les outils de développement.
3. Allez dans l'onglet **Réseau** (Network).
4. Tapez `api` dans le filtre, puis cliquez sur une requête.
5. Dans les en-têtes de requête, copiez la valeur de **authorization**.

Ne partagez jamais ce token : il donne un accès complet à votre compte. Ces mêmes étapes sont rappelées dans l'application (« Comment trouver mon token ? »).

## Premier lancement

1. Lisez l'avertissement, cochez « J'ai compris les risques », collez votre token puis cliquez sur **Connexion**. Votre avatar et votre pseudo s'affichent pour confirmer.
2. Choisissez un **serveur** (ceux qui ont Virtual Fisher sont en premier, avec un badge) puis un **salon** texte, et validez avec « Utiliser ce salon ». Vous pouvez en changer à tout moment depuis la barre du haut du tableau de bord.
3. Cliquez sur **Démarrer**. L'application lit les commandes slash du bot sur ce serveur, puis lance la pêche.

## Captcha : résolution manuelle uniquement

Virtual Fisher envoie parfois un captcha (`/verify`). Quand cela arrive :

- toute la file de commandes est vidée et **plus aucune commande automatique n'est envoyée** ;
- une notification Windows cliquable apparaît (avec un son si activé), l'icône de la barre des tâches clignote et l'icône de la zone de notification devient rouge ;
- un panneau non fermable affiche l'image et le dernier message du bot. Vous tapez la réponse puis cliquez sur **Valider** (ou appuyez sur Entrée) : c'est ce clic qui envoie `/verify`. **Nouvelle image** demande une autre image quand le bot le permet ;
- si la réponse est fausse, le panneau reste ouvert avec le message du bot ; si elle est bonne, la pêche reprend après un délai aléatoire de 5 à 15 secondes.

**Pourquoi manuel ?** Le captcha est là pour vérifier qu'un humain joue. Contourner cela (OCR, service tiers) rendrait l'automatisation bien plus facile à détecter et irait directement contre les règles du bot. L'application **n'envoie jamais `/verify` sans votre action** et ne résout jamais un captcha à votre place. Si vous ne répondez pas, elle attend.

## Réglages (appliqués immédiatement)

- **Pêche** : délai de base (min 2 s), variation aléatoire (0 à 5 s), écart minimum entre deux commandes (min 2 s).
- **Vente** : activation, déclencheur (toutes les N prises ou N minutes).
- **Buffs et appât** : buffs fish et treasure (5 ou 20 min), achat d'appât avec quantité automatique ou fixe.
- **Profil, daily et quêtes** : intervalle d'actualisation du profil, `/daily`, `/quests`.
- **Humanisation** : pauses régulières (durée de pêche et de pause avec variation), arrêt automatique après N heures.
- **Notifications** : captcha, son, niveau supérieur, poisson rare.
- **Compte** : changer de token, se déconnecter.
- **Avancé** : réduire dans la barre système à la fermeture, mode capture, ouverture du dossier de données.

Une option dont la commande n'existe pas sur le serveur choisi affiche « Commande indisponible » et est ignorée par l'automatisation.

Fermer la fenêtre **réduit l'application dans la barre système** (option réglable). Pour quitter vraiment : clic droit sur l'icône de la zone de notification puis **Quitter**. Le menu permet aussi d'afficher la fenêtre et de démarrer ou mettre en pause.

## Mode capture et emplacement des fichiers

Les données sont dans `%APPDATA%\virtual-autofisher\` :

| Élément | Emplacement |
|---|---|
| Configuration (token chiffré) | `config.json` (sauvegarde : `config.bak.json`) |
| Journaux | `logs\app.log` (rotation à 5 Mo) |
| Résumés de session | `sessions\` |
| Captures de messages du bot | `captures\` (mode capture) |

Le **mode capture** (Réglages > Avancé) enregistre les messages bruts du bot dans `captures\`. Il sert à diagnostiquer ou améliorer la reconnaissance des réponses quand le bot change son format. Les captures peuvent contenir votre pseudo : relisez-les avant de les partager. Le bouton « Ouvrir le dossier de données » ouvre ce répertoire.

## Scripts npm

| Commande | Rôle |
|---|---|
| `npm run dev` | Développement avec rechargement à chaud |
| `npm test` | Tests (Vitest) |
| `npm run typecheck` | Vérification TypeScript (processus principal et interface) |
| `npm run build` | Compilation (`out/`) |
| `npm run build:win` | Installeur NSIS dans `dist/` |
| `node scripts/make-icons.mjs` | Régénère les icônes (`resources/`, `build/icon.ico`) |

## Dépannage

- **Token invalide** : le token est refusé ou a expiré (changer de mot de passe Discord le révoque). Récupérez-en un nouveau (voir plus haut) puis utilisez Réglages > Compte > « Changer de token », ou déconnectez-vous et recommencez l'onboarding.
- **Virtual Fisher absent du serveur** : le bot n'est pas présent (ou pas visible) sur ce serveur, ou la commande `/fish` est introuvable. Choisissez un serveur marqué du badge Virtual Fisher, ou invitez le bot, puis relancez.
- **« Commande indisponible »** : la commande correspondante (`/sell`, `/buy`, `/daily`, `/quests`, `/profile`) n'est pas exposée par le bot sur ce serveur ; l'option est ignorée. Les commandes sont relevées au démarrage : démarrez la pêche une fois pour les découvrir.
- **Le bot ne répond plus** : après 3 absences de réponse (8 s chacune), l'application se met en pause. Vérifiez le salon, puis cliquez sur Reprendre.
- **Un message n'est pas reconnu** : activez le mode capture, reproduisez le cas et consultez `captures\` et `logs\app.log`.

## Captures d'écran

<!-- TODO (utilisateur) : ajouter des captures d'écran : onboarding, tableau de bord, réglages, panneau captcha. -->

*À venir.*

## Publier une nouvelle version

Chaque push sur `main` lance la GitHub Action [release.yml](.github/workflows/release.yml) : si la version de `package.json` n'a pas encore de release `v<version>`, elle lance les tests, construit l'installeur Windows et crée la release avec le `.exe`. Sinon elle ne fait rien.

```bash
npm version 1.0.1
git push
```
