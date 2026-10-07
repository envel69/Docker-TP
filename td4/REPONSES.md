# TD4 — Vers la production

Fichiers :

| Fichier | Rôle |
|---|---|
| `compose.yaml` | base commune : services, healthchecks, `depends_on: service_healthy`, volumes. **Aucun port, aucun mot de passe.** |
| `compose.override.yaml` | dev (chargé automatiquement) : cible `dev`, `develop.watch`, ports API + base, mot de passe lu dans `.env` |
| `compose.prod.yaml` | prod : image `${API_IMAGE:-td4-api}`, API sur `${API_PORT:-8000}`, `restart: unless-stopped`, base non publiée, mot de passe en **secret**, API durcie |
| `.env.example` | modèle de `.env` (le vrai `.env`, `secrets/` et `token.txt` sont dans `.gitignore`) |
| `../.github/workflows/td4.yml` | pipeline build → scan → test → publish (dépôt sur GitHub) |

Commandes :

```bash
cp .env.example .env                                   # puis remplir
mkdir -p secrets && printf 'motdepasse' > secrets/db_password.txt
docker compose up -d                                   # dev
docker compose -f compose.yaml -f compose.prod.yaml up -d --build   # prod
```

---

## Partie A

### A1. Démarrage fiable

Healthchecks ajoutés dans `compose.yaml` :

- `db` : `pg_isready -h 127.0.0.1 -U $${POSTGRES_USER} -d $${POSTGRES_DB}`
- `cache` : `redis-cli ping`
- `api` : `wget -q -O /dev/null http://127.0.0.1:3000/health`. L'image `node:24-alpine` n'a **pas** `curl`,
  mais elle a le `wget` de **busybox** (`docker run --rm node:24-alpine which wget curl` → `/usr/bin/wget` seulement).

L'API a `depends_on: {db: {condition: service_healthy}, cache: {condition: service_healthy}}`. J'ai retiré
`restart: on-failure` : il ne servait qu'à relancer l'API tant que Postgres n'était pas prêt.

`-h 127.0.0.1` : au premier démarrage, l'image Postgres lance un serveur **temporaire**, joignable seulement par le
socket Unix, pour exécuter l'init, puis le redémarre. Sans `-h`, `pg_isready` peut répondre « prêt » à ce serveur
temporaire. En TCP, il ne répond qu'au vrai serveur.

Preuve, en partant de zéro :

```
$ docker compose down -v && docker compose up -d --build
 Container td4-db-1  Started
 Container td4-cache-1  Started
 Container td4-cache-1  Waiting
 Container td4-db-1  Waiting
 Container td4-cache-1  Healthy
 Container td4-db-1  Healthy
 Container td4-api-1  Starting        ← l'API ne démarre qu'une fois db ET cache sains
 Container td4-api-1  Started

$ docker compose ps
NAME          IMAGE                SERVICE   STATUS                    PORTS
td4-api-1     td4-api              api       Up 11 seconds (healthy)   0.0.0.0:3000->3000/tcp
td4-cache-1   redis:8-alpine       cache     Up 17 seconds (healthy)   6379/tcp
td4-db-1      postgres:18-alpine   db        Up 17 seconds (healthy)   0.0.0.0:5432->5432/tcp

$ docker compose logs api
api-1  | > td3-visites@1.0.0 dev
api-1  | > node --watch src/server.js
api-1  | Connecting to Postgres at db:5432…
api-1  | Connecting to Redis at redis://cache:6379…
api-1  | Visites API listening on 3000

$ docker inspect td4-api-1 --format '{{.RestartCount}} {{.State.Health.Status}}'
0 healthy
```

Aucun `ECONNREFUSED`, aucun redémarrage (`RestartCount = 0`).

**À quoi sert `$$` ?** Compose interpole lui-même les `${VAR}` du fichier YAML avec les variables de l'hôte ou de
`.env`. `$$` est l'échappement : Compose le remplace par un simple `$` **sans interpoler**. La commande stockée
est donc `pg_isready -U ${POSTGRES_USER}`, et c'est le shell (`CMD-SHELL`) **à l'intérieur du conteneur** qui
lit la variable `POSTGRES_USER` du conteneur. Dans la sortie de `docker compose config`, on voit d'ailleurs
`pg_isready … $${POSTGRES_USER}` et non `app`.

### A2. Trois fichiers

- `compose.yaml` : pas de `ports:`, pas de `POSTGRES_PASSWORD` ni de `DB_PASSWORD`.
- `compose.override.yaml` : `target: dev`, `develop.watch` (sync de `src/`, rebuild si `package.json` change),
  `${API_PORT:-3000}:3000`, `${DB_HOST_PORT:-5432}:5432`, `POSTGRES_PASSWORD` / `DB_PASSWORD` lus dans `.env`.
- `compose.prod.yaml` : `image: ${API_IMAGE:-td4-api}`, `${API_PORT:-8000}:3000`, `restart: unless-stopped` sur
  les 3 services, aucun port pour `db`. Le mot de passe vient d'un secret (A5). Avant A5, il était lu dans `.env`
  (`DB_PASSWORD: ${POSTGRES_PASSWORD}`).

**Pourquoi la base ne doit-elle publier aucun port ?** Seule l'API a besoin de la base, et elle la joint par le
réseau interne de Compose (`db:5432`, résolu par le DNS de Docker). Publier 5432 l'exposerait sur toutes les
interfaces de la machine (`0.0.0.0`), donc potentiellement sur Internet, aux attaques par force brute sur le mot de
passe et aux failles de Postgres. Docker écrit aussi ses propres règles iptables, qui passent **avant** le
pare-feu de l'hôte (ufw). Moins de ports ouverts, c'est moins de surface d'attaque. L'API est le seul point
d'entrée.

Vérification de la fusion (extrait) :

```
$ docker compose -f compose.yaml -f compose.prod.yaml config
services:
  api:
    build:
      context: /home/envel/Docker-TD/td4/app
      target: prod                       ← la cible dev de l'override n'est pas chargée
    depends_on:
      cache: {condition: service_healthy, required: true}
      db:    {condition: service_healthy, required: true}
    environment:
      DB_PASSWORD_FILE: /run/secrets/db_password
      ...
    image: td4-api
    ports:
      - target: 3000
        published: "8000"
    read_only: true
    cap_drop: [ALL]
    mem_limit: "268435456"
    restart: unless-stopped
    secrets: [{source: db_password}]
  cache:
    restart: unless-stopped              ← pas de ports
  db:
    environment:
      POSTGRES_DB: visites
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
      POSTGRES_USER: app
    restart: unless-stopped              ← pas de ports
```

### A3. La prod

```
$ docker compose -f compose.yaml -f compose.prod.yaml up -d --build --wait
$ docker compose -f compose.yaml -f compose.prod.yaml ps
NAME          SERVICE   STATUS                    PORTS
td4-api-1     api       Up 6 seconds (healthy)    0.0.0.0:8000->3000/tcp
td4-cache-1   cache     Up 11 seconds (healthy)   6379/tcp
td4-db-1      db        Up 11 seconds (healthy)   5432/tcp      ← non publié

$ curl -s localhost:8000/   (×3)
{"hitsInRedis":1,"visitsInPostgres":1,"servedBy":"62dd77d38f49"}
{"hitsInRedis":2,"visitsInPostgres":2,"servedBy":"62dd77d38f49"}
{"hitsInRedis":3,"visitsInPostgres":3,"servedBy":"62dd77d38f49"}

$ docker compose -f compose.yaml -f compose.prod.yaml down
 Network td4_default  Removed
$ docker compose -f compose.yaml -f compose.prod.yaml up -d --wait
$ curl -s localhost:8000/
{"hitsInRedis":4,"visitsInPostgres":4,"servedBy":"6bace486ef72"}

$ bash -c '</dev/tcp/127.0.0.1/5432'
bash: connect: Connection refused

$ docker volume ls | grep td4
local     td4_cache-data
local     td4_db-data
```

**Les compteurs ont-ils survécu ?** Oui, on passe à 4, alors que les conteneurs ont été recréés (`servedBy`
change). `down` supprime les conteneurs et le réseau, mais **pas les volumes nommés** (il faudrait `down -v`).
Postgres écrit dans le volume `td4_db-data`. Redis écrit dans `td4_cache-data` : il fait un snapshot RDB dans
`/data` à l'arrêt propre (SIGTERM) et le recharge au démarrage.

**La base est-elle joignable depuis la machine ?** Non (`Connection refused` sur 5432), parce que
`compose.prod.yaml` ne publie pas son port. C'est voulu : seule l'API, sur le même réseau Docker, a besoin de la
base (cf. A2). Pour administrer la base, on passe par `docker compose exec db psql …`.

### A4. Un arrêt propre

```
$ time docker compose -f compose.yaml -f compose.prod.yaml stop api
 Container td4-api-1  Stopped
real	0m0.386s

$ docker compose -f compose.yaml -f compose.prod.yaml ps -a
NAME          SERVICE   STATUS
td4-api-1     api       Exited (0) Less than a second ago
td4-cache-1   cache     Up 16 seconds (healthy)
td4-db-1      db        Up 16 seconds (healthy)

$ docker compose … logs api | tail -1
api-1  | SIGTERM received, shutting down
```

**Combien de temps, quel code ?** Environ **0,4 s**, et le code de sortie est **0**. `docker stop` envoie SIGTERM
au PID 1. Ici, le PID 1 est directement `node` (forme exec `CMD ["node", "src/server.js"]`, pas de `npm` ni de
`sh` intermédiaire), et l'app a un handler `SIGTERM` : elle ferme le serveur HTTP, `pool.end()`, `redis.quit()`,
puis `process.exit(0)`. Le code 0 signifie donc « arrêt normal, demandé ». Sans handler (ou derrière un `sh -c`
qui ne relaie pas le signal), Docker aurait attendu 10 s puis envoyé SIGKILL : code **137** (128 + 9) et
connexions coupées net. Un code 143 (128 + 15) aurait voulu dire « tué par SIGTERM sans handler ».

**`restart: unless-stopped` après un `docker stop` ?** Le conteneur **reste arrêté**. Un arrêt manuel est
respecté, y compris après un redémarrage du démon ou de la machine. C'est la différence avec `always`, qui le
relancerait au redémarrage du démon.

**Et s'il plante ?** Docker le **redémarre** automatiquement, avec un délai croissant. Démonstration avec un
SIGKILL envoyé depuis l'hôte (simule un crash ou un OOM) :

```
$ docker run --rm --privileged --pid=host alpine kill -9 <pid de node>
$ docker inspect td4-api-1 --format 'Status={{.State.Status}} RestartCount={{.RestartCount}}'
Status=running RestartCount=1
$ docker events --since 30s --filter container=td4-api-1 --format '{{.Status}} {{.Actor.Attributes.exitCode}}'
kill
stop
die 0          ← le docker stop manuel : pas de redémarrage
start          ← le docker compose start manuel
die 137        ← le crash…
start          ← …redémarré automatiquement par la politique unless-stopped
```

### A5 (bonus). Le mot de passe en secret

- `secrets/db_password.txt` (hors git, `secrets/` est dans `.gitignore`)
- `compose.prod.yaml` : `secrets: db_password: file: ./secrets/db_password.txt`, monté dans `api` et `db`
- `db` : `POSTGRES_PASSWORD_FILE: /run/secrets/db_password` (supporté par l'image officielle)
- `api` : `DB_PASSWORD_FILE: /run/secrets/db_password` (`server.js` lit déjà ce fichier si la variable est définie)

**Avant**, avec le mot de passe en variable d'environnement :

```
$ docker inspect td4-api-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep DB_
DB_USER=app
DB_PASSWORD=Td4-Pg-s3cret          ← en clair
DB_HOST=db
DB_NAME=visites
DB_PORT=5432
$ docker inspect td4-db-1 … | grep POSTGRES
POSTGRES_PASSWORD=Td4-Pg-s3cret    ← en clair
```

**Après** :

```
$ docker inspect td4-api-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep DB_
DB_USER=app
DB_PASSWORD_FILE=/run/secrets/db_password
DB_HOST=db
DB_NAME=visites
DB_PORT=5432
$ docker inspect td4-db-1 … | grep POSTGRES
POSTGRES_USER=app
POSTGRES_PASSWORD_FILE=/run/secrets/db_password
POSTGRES_DB=visites
$ docker inspect td4-api-1 --format '{{range .Mounts}}{{.Source}} -> {{.Destination}} (rw={{.RW}}){{end}}'
/home/envel/Docker-TD/td4/secrets/db_password.txt -> /run/secrets/db_password (rw=false)
```

Le mot de passe n'apparaît plus dans `docker inspect`. Il n'apparaît plus non plus dans l'environnement
(`/proc/*/environ`, visible dans les dumps et les logs de crash, et hérité par les processus enfants), ni dans
`docker compose config`. C'est un fichier monté en lecture seule. Après `down -v`, la prod se réinitialise et
fonctionne avec ce seul secret : `{"hitsInRedis":1,"visitsInPostgres":1,…}`.

---

## Partie B

```bash
alias trivy='docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v trivy-cache:/root/.cache aquasec/trivy:0.74.0'
```

### B1. Un secret de build qui ne fuit pas

`token.txt` contient `ghp_JETON-PRIVE-1234` (fichier hors git).

**1. Avec `ARG`** (au début de la cible `prod`) :

```dockerfile
FROM base AS prod
ARG TOKEN
RUN echo "téléchargement avec le jeton $TOKEN"
```

```
$ docker build --target prod --build-arg TOKEN="$(cat token.txt)" -t td4-api:arg app
#6 [prod 1/3] RUN echo "téléchargement avec le jeton ghp_JETON-PRIVE-1234"

$ docker history --no-trunc td4-api:arg --format '{{.CreatedBy}}' | grep -i jeton
RUN |1 TOKEN=ghp_JETON-PRIVE-1234 /bin/sh -c npm ci --omit=dev # buildkit
RUN |1 TOKEN=ghp_JETON-PRIVE-1234 /bin/sh -c echo "téléchargement avec le jeton $TOKEN" # buildkit
ARG TOKEN=ghp_JETON-PRIVE-1234
```

C'est **`docker history --no-trunc`** qui donne le jeton : les valeurs des `ARG` sont enregistrées dans les
métadonnées de l'image (l'historique de chaque instruction `RUN` qui suit l'`ARG`). Quiconque peut `docker pull`
l'image peut donc lire le jeton (`docker image inspect` ou `docker save` donnent le même résultat).

**2. Avec un secret de build** :

```dockerfile
FROM base AS prod
RUN --mount=type=secret,id=token \
    echo "téléchargement avec le jeton $(cat /run/secrets/token 2>/dev/null || echo '<aucun>')"
```

```
$ docker build --target prod --secret id=token,src=token.txt -t td4-api:secret app
#6 0.221 téléchargement avec le jeton ghp_JETON-PRIVE-1234      ← le RUN a bien eu le jeton

$ docker history --no-trunc td4-api:secret --format '{{.CreatedBy}}' | grep -iE 'jeton|TOKEN'
RUN /bin/sh -c echo "téléchargement avec le jeton $(cat /run/secrets/token 2>/dev/null || echo '<aucun>')" # buildkit
                                                          ← la commande, mais pas la valeur

$ docker image save td4-api:secret | tar -xO | grep -a -c 'JETON-PRIVE'     # tout le contenu de l'image
0
$ docker image save td4-api:arg    | tar -xO | grep -a -c 'JETON-PRIVE'     # pour comparaison
1
$ docker run --rm td4-api:secret ls /run/secrets
ls: /run/secrets: No such file or directory
```

**Pourquoi aucune trace ?** BuildKit monte le secret dans un **tmpfs**, `/run/secrets/token`, **uniquement
pendant ce `RUN`**. Ce montage ne fait pas partie du système de fichiers de la couche, il est démonté avant le
snapshot. La valeur ne figure pas non plus dans les métadonnées : l'historique contient le texte de la commande,
pas le contenu du fichier, et le cache de build est calculé sans le secret. L'image finale ne contient donc ni le
fichier ni la valeur. (L'`echo` affiche quand même le jeton dans le **log de build** : c'est la simulation
demandée, pas une chose à faire en vrai.)

Le `|| echo '<aucun>'` permet de construire sans `--secret`, par exemple dans la CI ou avec `docker compose build`.

### B2. Durcir l'API

Dans `compose.prod.yaml`, service `api` :

```yaml
read_only: true
tmpfs:
  - /tmp
cap_drop:
  - ALL
mem_limit: 256m
```

```
$ curl -s localhost:8000/                                   ← l'app fonctionne toujours
{"hitsInRedis":6,"visitsInPostgres":6,"servedBy":"4934dc2d8189"}
$ docker compose -f compose.yaml -f compose.prod.yaml ps api
td4-api-1   Up (healthy)

$ docker compose … exec api touch /app/test.txt             ← écriture refusée
touch: /app/test.txt: Read-only file system
$ docker compose … exec api sh -c 'touch /tmp/ok && ls -l /tmp/ok'
-rw-r--r--    1 node     node    0 Oct  7 07:53 /tmp/ok      ← /tmp reste inscriptible

$ docker compose … exec api grep Cap /proc/1/status          ← aucune capability
CapInh:	0000000000000000
CapPrm:	0000000000000000
CapEff:	0000000000000000
CapBnd:	0000000000000000
CapAmb:	0000000000000000

$ docker inspect td4-api-1 --format 'ReadonlyRootfs={{.HostConfig.ReadonlyRootfs}} CapDrop={{.HostConfig.CapDrop}} Memory={{.HostConfig.Memory}} Tmpfs={{.HostConfig.Tmpfs}}'
ReadonlyRootfs=true CapDrop=[ALL] Memory=268435456 Tmpfs=map[/tmp:]
$ docker stats --no-stream td4-api-1 --format '{{.Name}} {{.MemUsage}}'
td4-api-1 38.93MiB / 256MiB                                  ← 268435456 o = 256 Mio
```

À comparer avec la même image lancée sans `cap_drop` (`docker run --rm td4-api grep -E 'CapEff|CapBnd' /proc/1/status`) :
`CapEff: 0000000000000000` mais **`CapBnd: 00000000a80425fb`** (CHOWN, SETUID, NET_RAW, etc.). Comme l'API tourne
déjà en utilisateur non root (`USER node`), son ensemble *effectif* est vide dans les deux cas. `cap_drop: [ALL]`
vide en plus l'ensemble **limite** (`CapBnd`) : même un binaire setuid ou une élévation vers root ne pourrait
plus récupérer aucune capability. En root, sans `cap_drop`, on aurait `CapEff: 00000000a80425fb`.

**Pourquoi laisser `/tmp` inscriptible ?** Beaucoup de programmes et de bibliothèques ont besoin d'un répertoire
temporaire : `os.tmpdir()` de Node, fichiers temporaires des uploads, sockets, caches de compilation. Sans `/tmp`
inscriptible, ils plantent. Avec un `tmpfs`, `/tmp` est en mémoire et vidé à chaque redémarrage. Un attaquant ne
peut donc pas y installer durablement de binaire ni modifier le code de l'app, qui reste en lecture seule. Le
`tmpfs` compte aussi dans la limite mémoire.

**Et les fichiers à garder ?** Dans un **volume** (nommé ou bind mount) monté sur un répertoire dédié, par exemple
`uploads:/app/uploads`, comme `db-data` pour Postgres. Le volume reste inscriptible malgré `read_only` et survit
aux recréations du conteneur. Pour une API sans état, le mieux est d'externaliser : base de données, stockage
objet (S3).

### B3. Un scan qui bloque

```
$ trivy image --severity CRITICAL --exit-code 1 td4-api ; echo "code de sortie : $?"
Report Summary
│ td4-api (alpine 3.24.2)                       │  alpine  │ 0 │
│ app/node_modules/express/package.json         │ node-pkg │ 0 │
│ …                                             │ node-pkg │ 0 │
code de sortie : 0
```

Code **0** : aucune faille CRITICAL, le scan passe.

Avec une dépendance vulnérable ajoutée (`npm install lodash@4.17.4`), après reconstruction :

```
$ trivy image --severity CRITICAL --exit-code 1 td4-api:vuln ; echo "code de sortie : $?"
Node.js (node-pkg)
Total: 1 (CRITICAL: 1)
┌───────────────────────┬────────────────┬──────────┬────────┬───────────────────┬───────────────┬──────────────────────────────────────────────┐
│        Library        │ Vulnerability  │ Severity │ Status │ Installed Version │ Fixed Version │ Title                                        │
│ lodash (package.json) │ CVE-2019-10744 │ CRITICAL │ fixed  │ 4.17.4            │ 4.17.12       │ nodejs-lodash: prototype pollution in        │
│                       │                │          │        │                   │               │ defaultsDeep function …                      │
└───────────────────────┴────────────────┴──────────┴────────┴───────────────────┴───────────────┴──────────────────────────────────────────────┘
code de sortie : 1
```

Code **1** : Trivy trouve CVE-2019-10744 (prototype pollution dans lodash, corrigée en 4.17.12) et `--exit-code 1`
le transforme en **échec**. Dans une pipeline, l'étape échoue et les suivantes (test, publish) ne s'exécutent pas :
l'image vulnérable n'est pas publiée. Sans `--exit-code`, Trivy affiche les failles mais renvoie 0, et le scan ne
bloque rien. La dépendance a ensuite été retirée (`package.json` et `package-lock.json` restaurés, scan de nouveau
à 0).

### B4. La pipeline

Le dépôt est sur **GitHub**, la pipeline est donc dans `.github/workflows/td4.yml`. Un seul job sur
`ubuntu-latest`, où Docker est déjà installé :

| Étape | Ce qu'elle fait | Quand |
|---|---|---|
| build | `docker build --target prod -t ghcr.io/<owner>/visites-api:<sha7> td4/app` | toujours |
| scan | Trivy en conteneur, `--severity CRITICAL --exit-code 1` | toujours |
| test | réseau `ci`, `postgres:18-alpine` + `redis:8-alpine` + l'image (durcie : `--read-only --tmpfs /tmp --cap-drop ALL --memory 256m`), attend `pg_isready`, puis boucle sur `curl -f localhost:8000/` (60 s max) | toujours |
| publish | `docker login ghcr.io` avec `GITHUB_TOKEN` (`permissions: packages: write`), `docker push` | `push` sur la branche par défaut |

Les étapes s'enchaînent : si une étape échoue, les suivantes sont sautées. Une faille ou un test raté empêche
donc la publication. Le tag est `${GITHUB_SHA::7}`, le commit court.

L'étape `test` a été rejouée en local avant le push :

```
{"hitsInRedis":1,"visitsInPostgres":1,"servedBy":"80434e8d661b"}
API OK
exit=0
```

<!-- B4-RUNS -->

### B5. « Déployer »

<!-- B5-DEPLOY -->

**Pourquoi `--no-build` ?** Sans cette option, Compose, voyant une section `build:` (héritée de `compose.yaml`),
pourrait **reconstruire** l'image localement à partir des sources de la machine et la taguer avec le nom du
registry. On ne déploierait alors plus l'artefact **construit, scanné et testé par la pipeline**, mais un build
local, potentiellement différent (sources modifiées, dépendances résolues autrement, image de base plus récente).
Avec `--no-build`, Compose se contente de `pull` / `run` l'image publiée. Un serveur de prod n'a d'ailleurs ni les
sources ni la chaîne de build.

**Pourquoi un tag lié au commit plutôt que `latest` ?** `latest` est un tag **mobile** : il désigne l'image
poussée en dernier, qui change à chaque publication. Avec lui, on ne sait pas quelle version tourne, deux
serveurs peuvent exécuter deux versions différentes selon la date de leur `pull`, et un retour arrière est
impossible. Le tag `visites-api:<sha>` est **immuable et traçable** : il dit exactement quel code tourne (on
retrouve le commit, la pipeline, le rapport Trivy), le déploiement est reproductible, et revenir en arrière
consiste à relancer avec le tag précédent.
