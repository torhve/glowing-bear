# Build stage: install deps, run SvelteKit production build
FROM node:20-alpine AS builder

ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=${GIT_COMMIT}

# Bake commit hash into image metadata for inspection via `docker image inspect`
LABEL org.opencontainers.image.revision=$GIT_COMMIT

WORKDIR /app

# Copy server config (small, changes rarely)
COPY sws.toml ./

# Copy only package manifests first — cached unless lockfile changes
COPY package*.json .
RUN npm ci

# Copy full source tree — cached unless source or static files change
COPY src-svelte/ ./src-svelte/
# Static assets (icons, manifest) live at repo root
COPY static/ ./static/

# Build: uses build:docker to skip prebuild (icon generation requires ImageMagick + macOS nicutil)
# Pre-generated icons in static/ are copied above, so nothing is lost
RUN GIT_COMMIT=$GIT_COMMIT npm run build:docker

# Production stage: lightweight static web server
FROM ghcr.io/static-web-server/static-web-server:2-alpine

# Default host (all interfaces), port, root, and config path — all overridable via -e or docker-compose env
ENV SERVER_HOST="::"
ENV SERVER_PORT=8080
ENV SERVER_ROOT=/var/public
ENV SERVER_CONFIG_FILE=/etc/sws.toml

COPY --from=builder /app/sws.toml /etc/sws.toml
COPY --from=builder /app/build/ /var/public/

EXPOSE 8080

# Shell-form HEALTHCHECK (CMD /bin/sh -c) expands $SERVER_PORT at runtime
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD /bin/sh -c 'wget -q --spider http://127.0.0.1:$SERVER_PORT/'

USER 1000:1000

ENTRYPOINT ["static-web-server"]
CMD ["--config-file", "/etc/sws.toml"]
