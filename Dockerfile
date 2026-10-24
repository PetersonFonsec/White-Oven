# syntax=docker/dockerfile:1
FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS toolchain
ENV ASTRO_TELEMETRY_DISABLED=1
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@11.25.0
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/landing/package.json apps/landing/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/design-tokens/package.json packages/design-tokens/package.json

FROM toolchain AS build
RUN pnpm install --frozen-lockfile
COPY apps/landing apps/landing
COPY packages packages
COPY tsconfig.json ./
RUN pnpm build

FROM toolchain AS production-dependencies
RUN pnpm install --prod --frozen-lockfile

FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS runtime
ARG VCS_REF=local
LABEL org.opencontainers.image.source="https://github.com/PetersonFonsec/White-Oven" \
      org.opencontainers.image.revision=$VCS_REF
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4321 LEADS_ENABLED=false LEADS_DB_PATH=/var/lib/whiteoven/leads.sqlite
WORKDIR /workspace/apps/landing
COPY --from=production-dependencies /workspace/node_modules /workspace/node_modules
COPY --from=production-dependencies /workspace/apps/landing/node_modules ./node_modules
COPY --from=build /workspace/apps/landing/dist ./dist
COPY apps/landing/package.json ./package.json
COPY apps/landing/scripts ./scripts
COPY apps/landing/src/server ./src/server
COPY packages/contracts /workspace/packages/contracts
COPY packages/design-tokens /workspace/packages/design-tokens
RUN mkdir -p /var/lib/whiteoven /var/backups/whiteoven && chown node:node /var/lib/whiteoven /var/backups/whiteoven && chmod 0700 /var/lib/whiteoven /var/backups/whiteoven
USER node
VOLUME ["/var/lib/whiteoven"]
EXPOSE 4321
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "scripts/healthcheck.mjs"]
CMD ["node", "--experimental-strip-types", "scripts/serve.mjs"]
