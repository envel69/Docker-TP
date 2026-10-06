# TD1 – Réponses

## Partie A – Premiers conteneurs

### A1. `docker run hello-world` (deux exécutions)

**Commande :**
```bash
docker run hello-world
```

**Première exécution :**
```
Unable to find image 'hello-world:latest' locally
latest: Pulling from library/hello-world
4f55086f7dd0: Pull complete
Digest: sha256:5e23090353324d887c48ad5e5c56d294eab81588df9605b07d1afe895f9cc8f8
Status: Downloaded newer image for hello-world:latest

Hello from Docker!
```

**Deuxième exécution :**
```
Hello from Docker!
[message affiché directement, sans téléchargement]
```

**Différence :** lors du premier lancement, Docker ne trouve pas l'image localement et la télécharge depuis Docker Hub (`Pulling from library/hello-world`). Lors du second, l'image est déjà dans le cache local : Docker crée immédiatement un nouveau conteneur sans rien télécharger.

---

### A2. Deux conteneurs nginx sur des ports différents

**Commandes :**
```bash
docker run -d --name web1 -p 8080:80 nginx:1.29-alpine
docker run -d --name web2 -p 8081:80 nginx:1.29-alpine
```

**Pas de conflit :** les deux conteneurs écoutent tous les deux sur le port 80 **à l'intérieur** de leur propre espace réseau isolé (namespace réseau Linux). Ce port 80 interne n'est visible de l'extérieur que via la règle de publication `-p` : `web1` est joignable sur 8080, `web2` sur 8081. Chaque conteneur a sa propre interface réseau virtuelle, donc le port 80 dans l'un n'interfère pas avec le port 80 dans l'autre.

**Conflit sur 8080 :**
```bash
docker run -d --name web2_conflict -p 8080:80 nginx:1.29-alpine
# Error: Bind for 0.0.0.0:8080 failed: port is already allocated.
```
Le port 8080 de l'hôte ne peut être lié qu'à un seul processus à la fois. Docker refuse de démarrer le second conteneur et retourne une erreur.

---

### A3. Logs de web1

**Commande pour afficher les logs :**
```bash
docker logs web1
```

**Commande pour suivre en continu :**
```bash
docker logs -f web1
```

**Exemple de sortie :**
```
172.17.0.1 - - [06/Oct/2026:08:15:43 +0000] "GET / HTTP/1.1" 200 896 "-" "curl/7.74.0" "-"
```

Ces lignes viennent de la **sortie standard (stdout) et stderr** du processus nginx à l'intérieur du conteneur. Docker capture tout ce que le processus principal écrit sur stdout/stderr et le rend accessible via `docker logs`.

---

### A4. Modification via `docker exec` puis suppression

**Commandes :**
```bash
docker exec web1 sh -c 'echo "Envel" > /usr/share/nginx/html/index.html'
# → curl http://localhost:8080 retourne "Envel"

docker stop web1 && docker rm web1
docker run -d --name web1 -p 8080:80 nginx:1.29-alpine
# → curl http://localhost:8080 retourne le HTML nginx par défaut
```

**Observation :** après suppression et recréation, la modification a disparu. La page par défaut nginx est de retour.

**Conclusion :** la modification faite avec `docker exec` n'existe que dans la **couche d'écriture** du conteneur (layer CoW), qui est détruite avec lui. L'image originale n'est pas modifiée. Utiliser `docker exec` pour modifier une application est inutile en production : tout changement est perdu au redémarrage du conteneur. La bonne approche est de modifier le **Dockerfile** et de reconstruire l'image.

---

## Partie B – Variables d'environnement et mode interactif

### B1. Variable d'environnement avec `-e`

**Commandes :**
```bash
docker run --rm -e PRENOM=Envel alpine printenv PRENOM
# → Envel

docker run --rm alpine printenv PRENOM
# → (aucune sortie, la variable n'existe pas)

echo $PRENOM
# → (vide – la variable n'est pas définie sur la machine hôte)
```

**Avec `-e PRENOM=Envel` :** la variable existe dans le conteneur et vaut `Envel`.  
**Sans `-e` :** `printenv PRENOM` ne retourne rien car la variable n'a pas été injectée.  
**Sur l'hôte :** `PRENOM` n'est pas définie non plus — la variable passée avec `-e` « vit » uniquement dans l'environnement du conteneur, isolé de l'hôte.

---

### B2. Shell interactif et installation éphémère

**Commandes :**
```bash
docker run -it --rm alpine sh
# dans le conteneur :
apk add curl    # installation réussie
curl --version  # fonctionne

# après exit et relance :
docker run -it --rm alpine sh
curl --version  # → "sh: curl: not found"
```

`curl` n'est plus là après relance. L'installation a été effectuée dans la **couche d'écriture du conteneur** (qui est éphémère avec `--rm`). L'**image** `alpine` n'a pas été modifiée. Pour rendre l'installation durable, il faut l'écrire dans un `Dockerfile` avec `RUN apk add curl`.

---

## Partie C – Images et couches

### C1. Comparaison des images node

**Commandes :**
```bash
docker pull node:24 && docker pull node:24-slim && docker pull node:24-alpine
docker image ls node
docker run --rm node:24 sh -c 'ls /usr/bin | wc -l'
docker run --rm node:24 which gcc git curl
```

| Image | Taille | Nb de commandes dans `/usr/bin` | gcc | git | curl |
|---|---|---|---|---|---|
| `node:24` | 1.14 GB | 666 | ✓ | ✓ | ✓ |
| `node:24-slim` | 230 MB | 275 | ✗ | ✗ | ✗ |
| `node:24-alpine` | 171 MB | 143 | ✗ | ✗ | ✗ |

Les trois images font tourner le même Node 24. `node:24` (basée sur Debian Bookworm) embarque en plus gcc, git, curl, ainsi que des centaines d'outils de développement et de librairies système. Ces outils sont utiles pour **compiler** des modules natifs npm (ex. `node-gyp`), mais sont totalement inutiles pour **faire tourner** une API : ils alourdissent l'image et augmentent la surface d'attaque.

---

### C2. Historique des couches de `node:24-alpine`

**Commande :**
```bash
docker image history node:24-alpine
```

**Résultat (extrait) :**
```
IMAGE          CREATED       CREATED BY                                      SIZE
c10884952bb8   2 weeks ago   CMD ["node"]                                    0B
<missing>      2 weeks ago   ENTRYPOINT ["docker-entrypoint.sh"]             0B
<missing>      2 weeks ago   COPY docker-entrypoint.sh /usr/local/bin/       388B
<missing>      2 weeks ago   RUN apk add --no-cache --virtual .build-deps…   5.36MB
<missing>      2 weeks ago   ENV YARN_VERSION=1.22.22                        0B
<missing>      2 weeks ago   RUN addgroup -g 1000 node && adduser…           157MB
<missing>      2 weeks ago   ENV NODE_VERSION=24.21.0                        0B
<missing>      2 weeks ago   CMD ["/bin/sh"]                                 0B
<missing>      2 weeks ago   ADD alpine-minirootfs-3.24.2-x86_64.tar.gz /   8.42MB
```

**9 couches.** La plus lourde est le `RUN` qui installe Node.js lui-même (157 MB) : compilation et ajout de l'exécutable node, npm, et des librairies associées.

---

### C3. Métadonnées de nginx

**Commande :**
```bash
docker image inspect nginx:1.29-alpine | grep -A4 '"Cmd"'
docker image inspect nginx:1.29-alpine | grep -A4 '"ExposedPorts"'
```

**Résultat :**
```json
"Cmd": ["nginx", "-g", "daemon off;"]
"ExposedPorts": { "80/tcp": {} }
```

La commande lancée au démarrage est `nginx -g "daemon off;"` (nginx en mode foreground pour que le processus reste au premier plan — requis par Docker). Le port indiqué est `80/tcp`, ce qui est cohérent avec le `-p 8080:80` utilisé en A2 : on publie le port interne 80 sur le port hôte 8080.

---

## Partie D – Énigmes

### D1. `docker run -d alpine` rend la main mais `docker ps` n'affiche rien

**Observation :**
```bash
docker run -d alpine
# → affiche un ID de conteneur, mais...
docker ps
# → conteneur absent de la liste

docker ps -a
# → CONTAINER ID  ...  STATUS: Exited (0) Less than a second ago
```

**Explication :** la commande par défaut de l'image `alpine` est `/bin/sh` (visible via `docker image inspect alpine`). Sans terminal interactif (`-it`), `/bin/sh` n'a rien à lire sur stdin et se termine immédiatement avec le code 0. Docker retire les conteneurs terminés de `docker ps` (qui n'affiche que les conteneurs *en cours d'exécution*).

**Correction :** pour garder le conteneur actif, il faut soit une commande longue (`sleep infinity`), soit un mode interactif avec TTY :
```bash
docker run -d alpine sleep infinity
# ou, pour un shell interactif :
docker run -it --rm alpine sh
```

---

### D2. nginx sur `-p 9082:8080` ne répond pas

**Observation :**
```bash
docker run -d --name nginx_wrong -p 9082:8080 nginx:1.29-alpine
docker ps   # conteneur Up, PORTS: 0.0.0.0:9082->8080/tcp
curl http://localhost:9082   # (pas de réponse)
```

**Explication :** la règle `-p 9082:8080` publie le port **8080 du conteneur** sur le port 9082 de l'hôte. Mais nginx écoute sur le port **80** à l'intérieur du conteneur, pas sur 8080. Le port 8080 du conteneur n'est ouvert par aucun processus — les requêtes arrivant sur 9082 sont bien transférées vers le port 8080 interne, mais personne n'écoute là.

**Correction :**
```bash
docker run -d -p 9082:80 nginx:1.29-alpine
```

---

### D3. Arrêt lent et code de sortie 137

**Commandes :**
```bash
docker run -d --name dormeur alpine sleep 1000
time docker stop dormeur
# real 0m10.237s
docker ps -a --filter name=dormeur
# STATUS: Exited (137) Less than a second ago
```

**Durée :** ~10 secondes. **Code de sortie :** 137 (= 128 + 9, signal SIGKILL).

**Explication (cycle de vie) :** `docker stop` envoie d'abord `SIGTERM` au processus principal (PID 1 dans le conteneur, ici `sleep`). Docker attend ensuite un délai de grâce de **10 secondes**. `sleep` ne gère pas les signaux Unix — il ignore SIGTERM. Au bout de 10 secondes, Docker envoie `SIGKILL` (signal 9, non ignorable) qui tue immédiatement le processus. Le code 137 confirme l'arrêt forcé.

**Bonus — avec `--init` :**
```bash
docker run -d --init --name dormeur2 alpine sleep 1000
time docker stop dormeur2
# real 0m0.207s   EXIT CODE: 143 (= 128 + 15, SIGTERM reçu)
```
Avec `--init`, Docker injecte un processus `tini` comme PID 1. `tini` propage correctement les signaux à ses enfants et se termine proprement à réception de SIGTERM, sans attendre le délai de grâce.

---

### D4. OOM Kill — conteneur limité en mémoire

**Commande :**
```bash
docker run --name gourmand --memory 50m node:24-alpine \
  node -e "const a=[]; while(true) a.push(new Array(1e6).fill(1))"
# → exit code 137
```

**Observation :** le conteneur alloue de la mémoire en boucle jusqu'à dépasser la limite de 50 Mo, puis est tué avec le code 137.

**Confirmation via `docker inspect` :**
```bash
docker inspect gourmand --format '{{.State.OOMKilled}}'
# → true
```

Le champ `OOMKilled: true` confirme que c'est le noyau Linux qui a tué le processus, pas Docker. Le mécanisme en jeu est le **OOM Killer** (Out Of Memory Killer) du noyau, activé par les **cgroups** (Control Groups). Docker utilise les cgroups pour imposer des limites de ressources aux conteneurs ; quand un processus dépasse sa limite mémoire, le noyau invoque l'OOM Killer qui le termine avec SIGKILL (code 137).

---

## Partie E – Ménage

### E1. Espace Docker et nettoyage

**Commande avant nettoyage :**
```bash
docker system df
```
```
TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE
Images          6         3         1.606GB   1.544GB (96%)
Containers      5         2         2.19kB    0B (0%)
Local Volumes   0         0         0B        0B
Build Cache     402       0         20.59GB   20.59GB
```

**Suppression des conteneurs arrêtés :**
```bash
docker container prune -f
# Deleted Containers: 3 conteneurs supprimés (cd6c70..., 765b7e..., 736eb5...)
```

**Commande après nettoyage :**
```bash
docker system df
```
```
TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE
Images          6         1         1.606GB   1.544GB (96%)
Containers      2         2         2.19kB    0B (0%)
```

Les 3 conteneurs arrêtés (issues de ce TD : `alpine`, `hello-world`) ont été supprimés. L'espace récupéré est négligeable (les conteneurs eux-mêmes ne stockent que les différences par rapport à leur image de base — ici des données de quelques octets).
