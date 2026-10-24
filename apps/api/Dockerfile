# syntax=docker/dockerfile:1
# Build context: repository root (docker build -f apps/api/Dockerfile .).
FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS toolchain
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install --global pnpm@11.25.0
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json

FROM toolchain AS build
RUN pnpm install --frozen-lockfile --filter @whiteoven/api
COPY apps/api apps/api
RUN pnpm --filter @whiteoven/api build

FROM toolchain AS production-dependencies
RUN pnpm install --frozen-lockfile --filter @whiteoven/api --prod

FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS runtime
ARG VCS_REF=local
LABEL org.opencontainers.image.source="https://github.com/PetersonFonsec/White-Oven" \
      org.opencontainers.image.revision=$VCS_REF
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=3000
WORKDIR /workspace/apps/api
COPY --from=production-dependencies /workspace/node_modules /workspace/node_modules
COPY --from=production-dependencies /workspace/apps/api/node_modules ./node_modules
COPY --from=build /workspace/apps/api/dist ./dist
COPY apps/api/package.json ./package.json
COPY apps/api/scripts ./scripts
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "scripts/healthcheck.mjs"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
