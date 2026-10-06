# Premier test — ce que tu dois faire

Tout le code est écrit, relu et testé (232 tests automatiques au vert, installeur généré). Il reste ce qui **demande ton compte Discord** : je ne pouvais pas le faire à ta place.

## 1. Lancer l'app

Deux options :

- **Installeur** : `dist/Virtual AutoFisher Setup 1.0.0.exe`. Windows SmartScreen va avertir (« éditeur inconnu », l'exe n'est pas signé) → *Informations complémentaires* → *Exécuter quand même*.
- **Depuis le code** (recommandé pour le premier test, tu vois les logs) :
  ```bash
  npm run dev
  ```

## 2. Se connecter

1. Lis l'avertissement, coche « I understand the risks ».
2. Colle ton token (l'aide « How do I find my token? » est dans l'écran). Il est chiffré par Windows et reste sur ton PC.
3. Tu dois voir ton avatar + pseudo.

## 3. Choisir le serveur et le salon

- Les serveurs où Virtual Fisher est présent sont en haut avec un badge.
- **Conseil : utilise un salon où tu es seul** (ou presque) pour ce premier test.

## 4. Activer le mode capture (important)

Avant de démarrer : **Settings → Advanced → Capture mode : ON**.
Ça enregistre chaque réponse du bot dans `%APPDATA%\virtual-autofisher\captures\`. J'en ai besoin pour caler la lecture des messages (pour l'instant elle est basée sur des exemples reconstitués, pas sur de vrais messages).

## 5. Session de test (~10 min)

1. Clique **▶ Start** et observe le dashboard : prises qui défilent, cooldown, solde.
2. Utilise les boutons rapides au moins une fois chacun : `/sell all`, `/profile`, `/daily`, `/quests`, `/boosts`.
3. Clique une commande pendant le cooldown (pour capturer le message « wait »).
4. Si un **captcha** apparaît : la pêche se fige, une notification Windows s'affiche. Tape le code dans le panneau → *Submit*. Si c'est une fausse alerte : *Stop fishing*.
5. Teste aussi : ⏸ Pause / ▶ Resume, fermer la fenêtre (elle va dans la barre système, près de l'horloge), *Quit* depuis l'icône de la barre système.

## 6. Ce que tu me renvoies

- Le dossier `%APPDATA%\virtual-autofisher\captures\` (zippé), **après avoir vérifié qu'il ne contient rien de privé** (pseudos d'autres joueurs, etc.). Les captures ne contiennent pas ton token.
- Le fichier `%APPDATA%\virtual-autofisher\logs\app.log` (le token y est masqué automatiquement).
- Ce qui t'a paru faux ou bizarre dans l'interface, et 1–2 captures d'écran pour le README.

Avec ça je fais la **Task 13** : remplacer les exemples par tes vrais messages, et vérifier :
- les noms réels des options de `/sell`, `/buy`, `/verify`, `/coinflip` (aujourd'hui l'app prend « la 1ʳᵉ option », à confirmer) ;
- la réponse de VF à un `/daily` déjà réclamé ;
- si les réponses à `/fish` sont éditées après coup ;
- si l'image du captcha est un embed ou une pièce jointe (les deux sont gérés) ;
- les vrais noms des poissons rares.

## 7. Une question pour toi

La police de l'interface est **Inter** (comme prévu dans la spec). Elle n'est pas embarquée, donc Windows affiche sa police système à la place. Tu veux garder ça, ou que je choisisse une police plus distinctive et que je l'embarque ?

## Dépannage rapide

| Problème | Que faire |
|---|---|
| « Invalid or expired token » | Re-récupère le token (il change si tu te déconnectes de Discord). |
| Le serveur est grisé | Virtual Fisher n'y est pas détecté, choisis-en un autre. |
| « Command unavailable » | La commande VF n'existe pas dans ce serveur (ou a changé de nom), envoie-moi `app.log`. |
| État « Error » | La raison s'affiche à côté de la pastille d'état, envoie-la-moi. |
