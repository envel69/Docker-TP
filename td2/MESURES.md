# TD2 – Mesures et réponses

## Tableau de mesures

| Version | Taille de l'image | Build à froid | Rebuild après modif d'une ligne de code | `.env` dans l'image ? | Utilisateur |
|---|---|---|---|---|---|
| v1 | 1.21 GB | ~5 s | ~5 s (tout est recalculé) | **Oui** (`COPY . .` copie tout) | root |
| v2 | 1.18 GB | ~5 s | ~1.5 s (npm ci mis en cache) | Non (`.dockerignore` actif) | root |
| v3 | 1.18 GB | ~5 s | ~1.5 s | **Non** (`.dockerignore` filtre `.env`, `node_modules`) | root |
| v4 | **175 MB** | ~6 s | ~0.5 s | Non | `node` (non-root) |

> Commandes utilisées :
> ```bash
> docker build --no-cache -t td2:v1 -f Dockerfile.v1 .   # build à froid
> # modifier src/server.ts puis :
> docker build -t td2:v1 -f Dockerfile.v1 .              # rebuild
> docker image ls td2                                     # tailles
> docker run --rm td2:v1 ls -la                           # contenu du dossier de travail
> docker run --rm td2:v1 id                               # utilisateur
> ```

---

## Q1 — Le `.env` est-il dans l'image v1 ? Pourquoi est-ce grave ?

Oui. `COPY . .` copie **tout** le répertoire courant dans l'image, y compris le fichier `.env` qui contient `API_KEY=super-secret-key-12345`.

C'est grave même si l'image reste sur la machine locale, pour plusieurs raisons :

1. **Les images Docker ne sont pas chiffrées.** N'importe qui ayant accès au daemon Docker (ou au fichier `.tar` exporté) peut extraire le `.env` avec `docker run --rm td2:v1 cat .env` ou `docker save td2:v1 | tar xO` et lire les secrets en clair.
2. **La surface d'attaque s'élargit au fil du temps.** Si l'image est un jour poussée sur un registry (Docker Hub, AWS ECR…), même privé, le secret voyage avec elle. Un mauvais paramétrage de visibilité suffit à l'exposer.
3. **Les couches Docker sont immuables.** Même si on supprime `.env` dans un `RUN rm .env` ultérieur, la couche qui le contient reste dans l'image et reste accessible. On ne peut pas « effacer » un secret d'une image sans la reconstruire entièrement.

---

## Q2 — Pourquoi le rebuild v2 est-il plus rapide ?

En v1, la seule instruction `COPY . .` copie tout le projet d'un coup. La moindre modification d'un fichier source invalide cette couche, ce qui force Docker à ré-exécuter le `RUN npm ci && npm run build` intégralement (téléchargement des dépendances + compilation).

En v2, on décompose en deux étapes :
1. `COPY package*.json ./` + `RUN npm ci` — copie seulement les fichiers de dépendances
2. `COPY . .` + `RUN npm run build` — copie le code source

Le cache Docker est invalide **à partir de la première instruction modifiée**. Si on modifie uniquement un fichier `.ts`, seules les étapes 2 et suivantes sont rejouées. Les étapes 1 (dont `npm ci`, qui prend 2-3 secondes) restent en cache. D'où un rebuild ~3× plus rapide.

**Si on modifie `package.json` :** la couche `COPY package*.json` est invalidée, ce qui force une réinstallation complète des dépendances (`npm ci`) — exactement comme en v1. C'est le comportement attendu : les dépendances ont changé.

---

## Q3 — Le `.dockerignore` : contenu et effet

**Fichier `.dockerignore` :**
```
.env
node_modules
dist
.git
*.md
```

| Ligne | Raison |
|---|---|
| `.env` | Contient des secrets (clés API) — ne doit **jamais** entrer dans une image Docker. |
| `node_modules` | Dossier potentiellement très lourd (des centaines de Mo) installé localement. Docker les réinstalle avec `npm ci` depuis zéro dans le conteneur ; copier ceux de l'hôte risque d'introduire des modules compilés pour la mauvaise architecture. |
| `dist` | Artefacts de build locaux. On recompile dans Docker pour garantir la reproductibilité. |
| `.git` | Historique Git volumineux, inutile à l'exécution, augmente le contexte inutilement. |
| `*.md` | Fichiers de documentation, inutiles dans l'image finale. |

**Effet sur la ligne `transferring context` :**

- **Avant** `.dockerignore` (v1) : `transferring context: 38.4 MB` (node_modules + tout le projet transféré au daemon)
- **Après** `.dockerignore` (v3) : `transferring context: 825 B` (uniquement les fichiers sources utiles)

Le contexte de build passe de plusieurs dizaines de Mo à quelques octets, ce qui accélère le transfert et évite d'exposer des fichiers sensibles.

---

## Q4 — Qu'est-ce qui est dans l'image de build et plus dans l'image finale ?

L'étape `build` utilise `node:24` (1.14 GB), l'étape `runtime` utilise `node:24-alpine` (171 MB). Ce qui disparaît de l'image finale :

1. **Le compilateur TypeScript** (`tsc`, installé dans `node_modules/.bin/tsc` par les devDependencies)
2. **Les devDependencies** (`typescript`, `@types/express`, `@types/node`) — absentes car on installe avec `npm ci --omit=dev`
3. **Le code source TypeScript** (`src/`) — seul le `dist/` compilé est copié avec `COPY --from=build /app/dist`
4. **Le JDK complet / outils de compilation** — dans le cas général, tous les outils de build (gcc, make, git, curl…) présents dans `node:24` mais absents d'`alpine`
5. **Les fichiers intermédiaires de build** (cache npm, fichiers `.tsbuildinfo`, etc.)

L'image finale passe de 1.18 GB à **175 MB**, soit une réduction de 85 %.

---

## Q5 — Pourquoi ne pas reconstruire l'image pour changer le message ?

```bash
# Deux conteneurs, une seule image, deux configurations différentes :
docker run -d --name api1 -p 3001:3000 -e MESSAGE="Bonjour !" -e APP_VERSION=1.0.0 td2:v4
docker run -d --name api2 -p 3002:3000 -e MESSAGE="Hello!"    -e APP_VERSION=1.0.0 td2:v4
```

Il est important de **ne pas** reconstruire l'image pour plusieurs raisons :

1. **Séparation du code et de la configuration** : le principe des [12-Factor Apps](https://12factor.net/config) stipule que la configuration (messages, URLs, clés API) varie selon l'environnement (dev, staging, prod) mais que le **code** est identique. Reconstruire l'image pour changer un message brise cette séparation.

2. **Reproductibilité garantie** : si on reconstruit avec un message différent, on produit une nouvelle image — on ne peut plus être sûr que dev et prod tournent exactement le même binaire. Avec les variables d'environnement, c'est la même image bit-à-bit dans tous les environnements.

3. **Efficacité** : reconstruire une image prend du temps (compilation, téléchargement…). Passer une variable d'environnement à `docker run` est instantané.

4. **Sécurité** : intégrer des secrets ou des configurations dans l'image les rend difficiles à changer et les expose dans les couches immuables (cf. Q1).
