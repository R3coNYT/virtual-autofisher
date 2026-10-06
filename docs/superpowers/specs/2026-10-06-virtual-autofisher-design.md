# Virtual AutoFisher — Spécification de conception

- **Date :** 2026-10-06
- **Statut :** brouillon, en attente de validation
- **Référence :** [yudhistiraindyka/virtualfisher-bot-experimental](https://github.com/yudhistiraindyka/virtualfisher-bot-experimental) (Python, CLI, commandes à préfixe `%`)
- **Bot cible :** Virtual Fisher (ID `574652751745777665`), [guide](https://virtualfisher.com/guide), [commandes](https://virtualfisher.com/commands)

---

## 1. Objectif

Une application de bureau Windows, jolie et simple, qui automatise la pêche sur Virtual Fisher avec le compte Discord de l'utilisateur. Elle affiche en direct tout ce qui est utile : prises, argent, niveau, cooldown, boosts, stats.

### Critères de réussite

1. On colle son token une fois. L'app retrouve seule les serveurs où Virtual Fisher est présent et leurs salons.
2. On choisit un serveur et un salon, on clique sur **Start** : la pêche tourne sans intervention.
3. Le dashboard reflète l'état réel du compte (solde, niveau, boosts, prises) en quelques secondes.
4. Quand un captcha apparaît, tout s'arrête immédiatement. L'utilisateur est notifié, le résout dans l'app, et la pêche reprend.
5. On peut changer de serveur ou de salon sans redémarrer l'app (un seul actif à la fois).

### Hors périmètre

- **Résolution automatique des captchas** (OCR ou autre) : volontairement exclue. Ce serait contourner la protection anti-bot de Virtual Fisher. Le captcha est toujours résolu par l'humain.
- Plusieurs comptes ou plusieurs serveurs en même temps.
- Coinflip ou jeux d'argent automatisés (disponibles seulement en commande manuelle).
- macOS / Linux : pas ciblés, même si rien n'est spécifiquement Windows à part le packaging.

### Risques acceptés par l'utilisateur

- Utiliser un token utilisateur (selfbot) est contraire aux conditions d'utilisation de Discord : risque de ban du compte.
- Virtual Fisher interdit les macros : risque de reset ou de ban dans le bot.
- L'app limite l'exposition (rythme humain, pause sur captcha, token chiffré en local) mais ne la supprime pas. Un avertissement s'affiche au premier lancement.

---

## 2. Stack technique

| Couche | Choix |
|---|---|
| Shell | Electron (dernière version stable) |
| Build | electron-vite |
| Langage | TypeScript (strict) partout |
| UI | React 18 + Tailwind CSS + lucide-react (icônes) |
| État UI | Zustand |
| Discord | `discord.js-selfbot-v13` encapsulé dans un adaptateur |
| Persistance | JSON dans `app.getPath('userData')` + `safeStorage` pour le token |
| Tests | Vitest (parser, scheduler, engine avec faux client) |
| Packaging | electron-builder → installeur NSIS `.exe` |

---

## 3. Fonctionnement de Discord (rappel technique)

Le bot de référence envoyait des messages texte (`POST /channels/{id}/messages` avec `%fish`). Virtual Fisher fonctionne aujourd'hui en **commandes slash**, qui s'envoient comme des **interactions** :

1. **Connexion Gateway** (WebSocket) avec le token. L'événement `READY` fournit le `session_id`, l'utilisateur et la liste des serveurs.
2. **Découverte des commandes :** récupération de l'index des commandes applicatives du serveur pour obtenir, pour Virtual Fisher, l'`id`, la `version` et les options de chaque commande (`fish`, `sell`, `buy`, `verify`…).
3. **Envoi :** `POST /interactions` (type 2) avec `application_id`, `guild_id`, `channel_id`, `session_id`, `data` (id, version, nom, options) et un `nonce`.
4. **Réponses :** le bot répond par un message (`MESSAGE_CREATE`), parfois modifié ensuite (`MESSAGE_UPDATE`), parfois éphémère (flag 64, visible seulement par nous mais reçu via le Gateway).

La librairie `discord.js-selfbot-v13` gère les étapes 1 à 3 (`channel.sendSlash(botId, 'commande', ...options)`). L'adaptateur `DiscordClient` (§5.2) isole le reste de l'app de cette librairie.

**Les noms et options exacts des commandes sont lus à l'exécution** depuis l'index des commandes, jamais codés en dur sans vérification. Si une commande attendue est absente, l'app l'indique dans les réglages et désactive la fonction correspondante.

---

## 4. Fonctionnalités

### 4.1 Automatisations

| Fonction | Commande | Déclencheur | Réglages |
|---|---|---|---|
| Auto-fish | `/fish` | En boucle, après le cooldown | Cooldown de base (s, défaut 3.5, min 2), aléatoire (± s, défaut 0.8) |
| Auto-sell | `/sell` (montant `all`) | Toutes les N prises **ou** N minutes | Mode, N (défaut : 25 prises) |
| Auto-buff | `/buy` boost fish + boost treasure | À l'expiration de chaque boost | On/off, durée (5 ou 20 min) |
| Auto-bait | `/buy` appât | Quand le stock estimé tombe sous un seuil, ou en même temps que les buffs | Appât, quantité (calcul auto : `(durée*60 / cooldown − 10) × 0.75`, comme la référence) |
| Profil | `/profile` (inventaire) + stats | Au démarrage, puis toutes les N minutes (défaut 5) et après chaque vente | Intervalle |
| Daily | `/daily` | Au démarrage puis toutes les 24 h (+ quelques minutes) | On/off |
| Quêtes | `/quests` | Au démarrage puis toutes les 30 min | On/off (lecture seule : affichage) |

### 4.2 Commandes manuelles

Une barre de commandes rapides dans le dashboard, chaque commande passant par la même file d'attente : `/sell all`, `/daily`, `/quests`, `/boosts`, `/coinflip` (côté + montant), `/top`, `/profile`, ainsi qu'un champ libre pour saisir une commande slash et ses options.

### 4.3 Humanisation

- Délai aléatoire sur chaque cooldown (distribution normale tronquée, jamais sous le minimum).
- Délai minimum global de **2,5 s** entre deux commandes, toutes sources confondues.
- **Pauses optionnelles** : après X minutes de pêche (défaut 45 ± 10), pause de Y minutes (défaut 5 ± 2). Désactivées par défaut, activables dans les réglages.
- Limite de session optionnelle : arrêt automatique après H heures.

### 4.4 Captcha (résolution manuelle)

1. Le parser détecte un message de vérification : texte ou embed contenant `captcha`, `/verify` ou `verify`, avec ou sans image.
2. L'Engine passe à l'état `captcha` : **la file est vidée et plus aucune commande automatique n'est envoyée.**
3. L'app envoie une notification Windows (cliquable : met la fenêtre au premier plan), joue un son si activé, et fait clignoter l'icône dans la barre des tâches.
4. Le panneau captcha affiche l'image en grand, un champ de saisie et deux boutons : **Valider** (`/verify` + réponse) et **Nouvelle image** (`/verify regen`, si l'option existe).
5. Si le bot répond que la vérification est réussie (`You may now continue.` ou équivalent), l'Engine reprend **après un délai aléatoire de 5 à 15 s**.
6. Si la réponse est fausse, le panneau reste ouvert avec le message du bot.
7. **Aucun envoi automatique de `/verify`.** Seul le clic de l'utilisateur en envoie un.

---

## 5. Architecture

```
┌──────────────── Processus principal (Node) ────────────────┐
│                                                            │
│  ConfigStore ── config.json + token chiffré (safeStorage)  │
│       │                                                    │
│  DiscordClient (adaptateur discord.js-selfbot-v13)         │
│       │                                                    │
│  Parser (fonctions pures) : message → GameEvent            │
│       │                                                    │
│  Engine                                                    │
│   ├─ StateMachine (idle/connecting/running/paused/…)       │
│   ├─ CommandQueue (file unique + délai minimal)            │
│   ├─ Scheduler (timers fish/sell/buff/bait/profil/daily)   │
│   └─ GameState (profil, boosts, stats de session, journal) │
│       │                                                    │
│  IPC (ipcMain / preload contextBridge, typé)               │
└───────────────────────┬────────────────────────────────────┘
                        │
┌──────────── Interface (React, sandboxée) ────────────────────┐
│  Onboarding → Sélection serveur/salon → Dashboard            │
│  Journal • Réglages • Panneau captcha                        │
└──────────────────────────────────────────────────────────────┘
```

### 5.1 Arborescence

```
src/
  main/
    index.ts                 # création fenêtre, tray, wiring
    config/ConfigStore.ts
    discord/DiscordClient.ts # interface
    discord/SelfbotClient.ts # implémentation discord.js-selfbot-v13
    parser/index.ts          # parseMessage(msg) → GameEvent
    parser/catch.ts | inventory.ts | stats.ts | boosts.ts | captcha.ts | misc.ts
    parser/text.ts           # nettoyage emojis, markdown, nombres
    engine/Engine.ts
    engine/CommandQueue.ts
    engine/Scheduler.ts
    engine/GameState.ts
    engine/humanize.ts       # délais aléatoires
    ipc/channels.ts          # noms + types partagés
    ipc/handlers.ts
    notify.ts                # notifications Windows, son, flash
  preload/index.ts           # expose window.api (typé)
  renderer/
    App.tsx
    store.ts                 # Zustand, alimenté par les events IPC
    screens/Onboarding.tsx | ServerPicker.tsx | Dashboard.tsx | Settings.tsx
    components/StatCard.tsx | CatchLog.tsx | BoostTimer.tsx | CaptchaPanel.tsx
               | CommandBar.tsx | StatusPill.tsx | RareFishGrid.tsx
  shared/types.ts            # GameEvent, Config, EngineState, DTO IPC
tests/
  fixtures/messages/*.json   # vrais messages du bot (anonymisés)
  parser/*.test.ts
  engine/*.test.ts
```

### 5.2 `DiscordClient` (interface)

```ts
interface DiscordClient {
  login(token: string): Promise<SelfUser>;       // rejette si token invalide
  logout(): Promise<void>;
  listGuilds(): Promise<GuildInfo[]>;            // { id, name, iconUrl, hasVirtualFisher }
  listChannels(guildId: string): Promise<ChannelInfo[]>; // salons texte où on peut écrire + utiliser les slash
  getBotCommands(guildId: string): Promise<SlashCommandInfo[]>; // commandes VF disponibles
  sendSlash(channelId: string, command: string, options?: SlashOptions): Promise<void>;
  on(event: 'botMessage', cb: (m: BotMessage) => void): void; // create + update, filtré sur l'auteur VF et le salon actif
  on(event: 'disconnected' | 'reconnected', cb: () => void): void;
}
```

`BotMessage` est une représentation neutre : `{ id, channelId, content, embeds[{title, description, fields, imageUrl, footer}], ephemeral, isEdit, interactionUserId }`. Seuls les messages qui répondent à **nos** interactions (`interactionUserId === moi`) ou qui nous mentionnent sont transmis. Cela évite de compter les prises des autres joueurs du salon.

### 5.3 Parser

`parseMessage(msg: BotMessage): GameEvent` est une fonction pure, testée avec des fixtures.

```ts
type GameEvent =
  | { kind: 'catch'; items: CatchItem[]; xp?: number; levelUp?: number; treasure?: string[]; raw: string }
  | { kind: 'sell'; earned: number; xp?: number }
  | { kind: 'inventory'; balance: number; level: number; xpToNext?: number; rod?: string; biome?: string;
      bait?: { name: string; count: number }; rare: { gold: number; emerald: number; lava: number; diamond: number } }
  | { kind: 'stats'; crates?: number; quests?: number; trips?: number; dailyStreak?: number; totals: Partial<RareCounts> }
  | { kind: 'boosts'; active: { name: string; endsAt: number }[] }
  | { kind: 'purchase'; item: string; amount: number; cost?: number }
  | { kind: 'daily'; reward: string }
  | { kind: 'quests'; quests: { label: string; progress: string; done: boolean }[] }
  | { kind: 'cooldown'; waitMs: number }        // "You must wait X seconds"
  | { kind: 'captcha'; imageUrl?: string; text: string }
  | { kind: 'captchaSolved' }
  | { kind: 'captchaFailed'; text: string }
  | { kind: 'error'; text: string }             // fonds insuffisants, commande inconnue…
  | { kind: 'unknown'; title?: string; text: string };
```

Règles :
- On identifie le type par le **titre de l'embed**, puis par des mots-clés : `You caught`, `Inventory of`, `Statistics for`, `Active boosts`, `You sold`, `You must wait`, `captcha`, `You may now continue`…
- Nettoyage avant analyse : on supprime les emojis custom `<:nom:id>` et `<a:nom:id>`, les `:emoji:`, le markdown `*_~\``, et on normalise les nombres (`1,234,567` et `1.2M`).
- La **détection du captcha est prioritaire** sur tout le reste, et volontairement large : mieux vaut une fausse alerte qu'un captcha ignoré.
- Un message non reconnu produit `unknown`, affiché dans le journal, sans jamais faire planter le moteur.

> Les textes exacts des embeds de la version slash ne sont pas documentés publiquement. **La première étape d'implémentation** consiste à capturer de vrais messages (mode « capture » qui enregistre les `BotMessage` bruts dans `userData/captures/`) pour construire les fixtures. Les mots-clés ci-dessus viennent du bot de référence et seront ajustés.

### 5.4 Engine

**États :**

```
idle ──start──▶ connecting ──ok──▶ running ◀──resume── paused
  ▲                 │                │ ▲                  ▲
  │               error              │ └─captchaSolved─┐  │
  └────stop─────────┴────────────────┤                 │  │
                                     ├──pause──────────┼──┘
                                     ├──captcha──▶ captcha
                                     └──break (humanisation)──▶ resting ──timer──▶ running
```

- `running` : le Scheduler alimente la file.
- `paused` / `resting` / `captcha` : les timers sont gelés et la file est bloquée. Le captcha vide aussi la file.
- `error` : déconnexion prolongée, token invalide, salon inaccessible. Un message clair s'affiche et un bouton permet de réessayer.

**`CommandQueue` :**
- File FIFO avec priorités : `manual` > `verify` > `maintenance` (sell, buy, profil, daily) > `fish`.
- Un seul envoi à la fois. Après un envoi, on attend la réponse du bot (timeout 8 s) **et** le délai minimal global, avant la commande suivante.
- Si le bot répond `cooldown`, on attend `waitMs` + un peu d'aléatoire, puis on renvoie une fois.
- Les doublons de maintenance sont ignorés (pas deux `/sell` dans la file).

**`Scheduler` :**
- `fish` : à chaque réponse `catch`, on replanifie après `cooldown()`.
- `sell` : compteur de prises ou timer, selon le mode choisi.
- `buff` : basé sur `boosts.endsAt`, connu grâce à `/boosts` ou au moment de l'achat. On rachète 5 à 30 s après l'expiration.
- `bait` : décrémente un compteur estimé à chaque prise, et corrige avec l'inventaire.
- `profile`, `daily`, `quests` : timers simples.

**`GameState`** est la source de vérité unique, poussée vers l'interface par diff à chaque changement :
- `account` : solde, niveau, XP, canne, biome, appât, poissons rares ;
- `boosts` ;
- `quests` ;
- `session` : début, prises, poissons par espèce, argent gagné, XP gagnée, ventes, captchas, commandes envoyées ;
- `log` : 500 dernières entrées.

### 5.5 Persistance

`userData/config.json` :

```json
{
  "version": 1,
  "tokenEncrypted": "<base64 safeStorage>",
  "target": { "guildId": "…", "channelId": "…" },
  "fishing": { "baseCooldownSec": 3.5, "jitterSec": 0.8, "minGapSec": 2.5 },
  "sell": { "enabled": true, "mode": "catches", "every": 25 },
  "buffs": { "enabled": false, "lengthMin": 5 },
  "bait": { "enabled": false, "name": "", "autoAmount": true, "amount": 0 },
  "profile": { "refreshMin": 5 },
  "daily": { "enabled": true },
  "quests": { "enabled": true },
  "breaks": { "enabled": false, "workMin": 45, "workJitterMin": 10, "restMin": 5, "restJitterMin": 2 },
  "sessionLimitH": 0,
  "notifications": { "captcha": true, "sound": true, "levelUp": true, "rareFish": true },
  "ui": { "compactLog": false },
  "capture": false
}
```

- Le token n'est **jamais** stocké en clair, jamais envoyé à l'interface, jamais écrit dans les logs. Les messages d'erreur masquent tout ce qui ressemble à un token.
- `userData/sessions/*.json` contient un résumé de chaque session terminée, pour l'historique.

### 5.6 IPC

Les canaux sont typés dans `shared/types.ts`, et `window.api` est exposé par le preload avec `contextIsolation: true`, `sandbox: true` et `nodeIntegration: false`.

- **Interface → main :** `auth.setToken`, `auth.logout`, `guilds.list`, `channels.list`, `target.set`, `engine.start|pause|resume|stop`, `command.send`, `captcha.submit`, `captcha.regen`, `config.get|update`.
- **Main → interface :** `engine.state`, `game.patch`, `log.append`, `captcha.show|hide`, `connection.status`, `toast`.

---

## 6. Interface

Thème sombre « océan » : fond bleu nuit, accents cyan et turquoise, cartes semi-transparentes, police Inter avec chiffres tabulaires. L'app est utilisable dès 1000×680, avec la sidebar repliable.

### 6.1 Écrans

1. **Onboarding** (premier lancement)
   - Avertissement sur les risques (CGU Discord, règles VF), avec une case « J'ai compris ».
   - Champ token (masqué, bouton afficher), lien « Comment trouver mon token ? » vers une aide intégrée.
   - Bouton « Connexion », qui affiche ensuite l'avatar et le pseudo pour confirmer.
2. **Sélection serveur et salon**
   - Grille de serveurs avec icône et nom. Ceux qui ont Virtual Fisher sont en premier avec un badge, les autres sont grisés.
   - Puis liste des salons texte autorisés, avec recherche.
   - « Utiliser ce salon » mémorise le choix. On y revient à tout moment via le sélecteur en haut du dashboard.
3. **Dashboard**
   - **Barre du haut :** serveur et salon actifs (cliquable pour changer), pastille d'état (Running / Paused / Captcha / Resting / Error), boutons ▶ Start, ⏸ Pause, ⏹ Stop, chrono de session.
   - **Rangée de cartes :** Solde (avec gain de session), Niveau (barre d'XP), Prises de session (avec rythme par heure), Prochain `/fish` (anneau de cooldown animé).
   - **Boosts actifs :** puces avec compte à rebours (fish, treasure, autres).
   - **Poissons rares :** gold, emerald, lava, diamond, avec compteur de session et total.
   - **Journal des prises** (colonne principale) : liste en direct, une ligne par prise (heure, poissons avec quantités, XP, trésors, level-up mis en valeur). Filtres : tout, prises, achats/ventes, système.
   - **Panneau latéral :** canne, biome, appât et stock, quêtes du jour avec progression, prochain daily.
   - **Barre de commandes rapides** en bas (§4.2).
4. **Réglages**
   - Sections : Pêche, Vente, Buffs et appât, Profil/Daily/Quêtes, Humanisation, Notifications, Compte (changer de token, déconnexion), Avancé (mode capture, ouvrir le dossier de données).
   - Chaque modification est appliquée à chaud.
5. **Panneau captcha** (modal non fermable tant que le captcha est actif)
   - Image, champ de réponse (focus automatique), Valider, Nouvelle image, dernier message du bot.

### 6.2 Barre système

- Icône dans la barre des tâches avec menu : Afficher, Start/Pause, Quitter.
- Fermer la fenêtre réduit l'app dans la barre (configurable).
- L'icône change pour un captcha.

---

## 7. Gestion des erreurs

| Situation | Comportement |
|---|---|
| Token invalide | Retour à l'onboarding avec le message « Token invalide ou expiré ». |
| Déconnexion du Gateway | La librairie se reconnecte ; l'Engine passe en `paused` (cause : réseau) et reprend seul à la reconnexion. Après 2 min sans reconnexion : `error`. |
| Salon supprimé ou plus accessible | `error`, avec retour au sélecteur. |
| Commande VF introuvable | Fonction désactivée + avertissement dans les réglages. Si c'est `/fish` : `error`. |
| Pas de réponse du bot (timeout 8 s) | Nouvel essai une fois. Après 3 timeouts d'affilée : `paused` + toast « Virtual Fisher ne répond pas ». |
| « You must wait » | Attente du délai indiqué + aléatoire. |
| Fonds insuffisants pour un achat | Log + désactivation temporaire de l'achat concerné (30 min). |
| Message non reconnu | Ligne `unknown` dans le journal ; jamais d'arrêt. |
| Rate limit Discord (429) | Respect du `retry_after` + augmentation temporaire du délai minimal. |
| Exception inattendue dans l'Engine | Capturée, loguée, Engine en `paused`, toast d'erreur. Aucun crash de l'app. |

Les logs techniques sont écrits dans `userData/logs/app.log` (rotation à 5 Mo), avec le token masqué.

---

## 8. Tests

- **Parser** : chaque type d'événement a au moins 2 fixtures réelles. Les messages inconnus doivent produire `unknown` sans exception. Les variantes de captcha doivent toutes produire `captcha`.
- **CommandQueue / Scheduler** : avec des timers simulés (`vi.useFakeTimers`), on vérifie l'ordre des priorités, le délai minimal, la déduplication, le gel en pause et le vidage sur captcha.
- **Engine** : avec un `FakeDiscordClient` qui rejoue des scénarios (pêche normale, vente déclenchée à N prises, captcha → résolution → reprise, déconnexion → reprise, cooldown).
- **Test critique** : en état `captcha`, **aucune** commande n'est envoyée sans action de l'utilisateur.
- **Manuel** : session réelle de 10 min sur un serveur de test, avec un captcha déclenché naturellement si possible.

---

## 9. Packaging et livraison

- `npm run dev` : développement avec rechargement à chaud.
- `npm run test` : Vitest.
- `npm run build:win` : installeur NSIS dans `dist/`.
- `README.md` : installation, récupération du token, avertissements, captures d'écran.

---

## 10. Étapes de réalisation (aperçu)

1. Squelette electron-vite + React + Tailwind + IPC typé.
2. `ConfigStore`, puis `SelfbotClient` (login, serveurs, salons, commandes, envoi slash, réception) avec un **mode capture**.
3. Capture de vrais messages, puis fixtures et Parser avec tests.
4. CommandQueue, Scheduler, GameState, Engine, avec tests.
5. Interface : onboarding, sélecteur, dashboard, réglages, panneau captcha.
6. Notifications, barre système, gestion des erreurs, packaging.

Le plan détaillé sera rédigé à part après validation de cette spec.
