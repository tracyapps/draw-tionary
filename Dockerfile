# Draw-tionary
#
# The app has zero runtime dependencies — everything it uses ships with Node —
# so this image is essentially "Node plus our source". No npm install at
# runtime, nothing to compile, nothing to go stale.
#
# Node 22 is pinned deliberately: node:sqlite is what bot/store.js is built on,
# and it is still an experimental API. Pinning the major means a base-image
# refresh can't change the database layer underneath us.

FROM node:22-alpine

# Tini reaps zombies and forwards signals properly. Without an init, a SIGTERM
# from the platform on redeploy goes to the shell rather than to Node, and the
# graceful shutdown in server.js never runs.
RUN apk add --no-cache tini

WORKDIR /srv

# package.json first so this layer caches independently of source changes.
COPY package.json ./

# Dev dependencies ARE needed here, briefly: the build vendors Discord's
# Embedded App SDK out of node_modules and into app/vendor/.
RUN npm install --no-audit --no-fund

COPY . .

# app/bundle.js and app/vendor/ are generated and gitignored, so a fresh clone
# doesn't have them. Without this the canvas loads and fails on a missing
# script, and the Activity page cannot find the SDK.
RUN npm run build

# The application has zero runtime dependencies — everything it uses ships
# with Node — so once the build has taken what it needs, the whole of
# node_modules can go. That is ~40 MB of jsdom and SDK source not shipped.
RUN rm -rf node_modules

# The database lives on a mounted volume. Created here so the directory exists
# and is owned correctly even on the very first boot, before any volume is
# attached — otherwise the first run crashes instead of creating its schema.
RUN mkdir -p /data && chown -R node:node /data /srv

# Don't run as root. Nothing here needs it.
USER node

ENV NODE_ENV=production \
    PORT=3000 \
    DB_FILE=/data/draw-tionary.db

EXPOSE 3000

# The platform's own healthcheck is the one that matters for routing; this is
# a backstop so a wedged container is visible in `docker ps` locally too.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npm", "start"]
