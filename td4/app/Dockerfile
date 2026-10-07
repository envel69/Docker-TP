FROM node:24-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./

FROM base AS dev
RUN npm ci
COPY src ./src
CMD ["npm", "run", "dev"]

FROM base AS prod
# Jeton privé : monté uniquement pendant ce RUN (tmpfs), jamais écrit dans une couche.
# docker build --secret id=token,src=token.txt …  (sans --secret : on continue sans jeton)
RUN --mount=type=secret,id=token \
    echo "téléchargement avec le jeton $(cat /run/secrets/token 2>/dev/null || echo '<aucun>')"
RUN npm ci --omit=dev
COPY src ./src
USER node
CMD ["node", "src/server.js"]
