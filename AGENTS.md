# WhiteOven contributor guidance

## Project state

WhiteOven has finished M0 (landing, lead capture, deployment preparation; no production environment provisioned) and is in M1 (API foundation). `apps/landing` is the Astro landing: prerendered commercial page, browser-only Pizza Builder demo, real interest form, Astro API endpoint, SQLite persistence and runtime privacy policy. Capture requires explicit valid environment configuration. `apps/api` is the NestJS API (M1.1: validated config, `/health`, JSON logs without PII, standard error body, OpenAPI; see ADR 0004). It has no database, tenant or authentication yet; those arrive in M1.2–M1.5 following `docs/architecture/mvp-roadmap.md`. Product capabilities in docs are plans unless explicitly implemented. Implement only the milestone being worked on; do not scaffold later apps (admin, mobile) or unapproved integrations.

## Working conventions

- Use pnpm workspaces, root scripts and strict TypeScript. Keep boundaries explicit; avoid premature abstractions.
- Preserve the approved responsive visual design and semantic accessible HTML.
- Preserve prerendering of the landing. The approved Node endpoint requires a server; do not claim a static file deployment supports lead capture.
- Validate untrusted input server-side. Never expose server configuration, credentials, personal data in logs or analytics, or public read/export endpoints.
- Maintain privacy text/version, retention and consent audit together. No vendor without approval. Do not commit database files, exports, `.env`, or real lead fixtures.
- Keep product, architecture and implementation documentation consistent; mark old milestone records as historical.
- Do not modify or deploy Orbia infrastructure. This milestone prepares Docker/Compose/GHCR and operations; actual deployment and provisioning are outside scope.
- Before adding a dependency, confirm existing capabilities are insufficient.
- Do not claim checks passed unless they completed successfully.

## Commands

- `pnpm dev`: start local Astro with app `.env`.
- `pnpm build` / `pnpm start`: build and serve through the guarded Node launcher (`pnpm start`), preserving trusted request identity and HTTP limits.
- `pnpm typecheck` / `pnpm test`: run in every workspace package that defines them (`pnpm -r --if-present`). `pnpm test` covers landing (pizza, lead contract, endpoint, persistence, backups), API (config, logging, errors, OpenAPI, startup) and `tests/deployment/ops.test.mjs` (ops and GHCR script decisions against a recording docker/gh/curl double).
- `pnpm test:e2e`: build and test desktop/mobile with synthetic local capture configuration.
- `pnpm check`: format, lint, typecheck.
- `pnpm api:dev`: build and start the API on `127.0.0.1:3000` with `apps/api/.env` if present. `docker compose -f compose.dev.yaml up --build api` runs it in a container.
- API conventions: configuration only through `loadConfig` (invalid values must stop the start); throw `ApiError` with a stable code; never log personal data, query strings, headers or bodies.
- `node --experimental-strip-types tests/deployment/containers.mjs`: build and test isolated Docker resources with synthetic data only.
- `bash ops/whiteoven.sh`: deployment operations; never execute against real environments without task authorization.
- `pnpm leads`: local operations; see README and capture runbook. Deletion/export of real leads requires task authorization.
