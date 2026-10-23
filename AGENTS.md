# WhiteOven contributor guidance

## Project state

WhiteOven is at M0.1-B. The only app is the Astro landing in `apps/landing`: prerendered commercial page, browser-only Pizza Builder demo, real interest form, Astro API endpoint, SQLite persistence and runtime privacy policy. Capture requires explicit valid environment configuration. Product capabilities in docs are plans unless explicitly implemented. Do not advance to M1, scaffold future apps, add the main SaaS API, authentication, logistics or unapproved integrations.

## Working conventions

- Use pnpm workspaces, root scripts and strict TypeScript. Keep boundaries explicit; avoid premature abstractions.
- Preserve the approved responsive visual design and semantic accessible HTML.
- Preserve prerendering of the landing. The approved Node endpoint requires a server; do not claim a static file deployment supports lead capture.
- Validate untrusted input server-side. Never expose server configuration, credentials, personal data in logs or analytics, or public read/export endpoints.
- Maintain privacy text/version, retention and consent audit together. No vendor without approval. Do not commit database files, exports, `.env`, or real lead fixtures.
- Keep product, architecture and implementation documentation consistent; mark old milestone records as historical.
- Do not modify or deploy Orbia infrastructure. Production deployment is outside this milestone.
- Before adding a dependency, confirm existing capabilities are insufficient.
- Do not claim checks passed unless they completed successfully.

## Commands

- `pnpm dev`: start local Astro with app `.env`.
- `pnpm build` / `pnpm start`: build and serve through the guarded Node launcher (`pnpm start`), preserving trusted request identity and HTTP limits.
- `pnpm test`: Node tests for pizza, lead contract, endpoint and persistence.
- `pnpm test:e2e`: build and test desktop/mobile with synthetic local capture configuration.
- `pnpm check`: format, lint, typecheck.
- `pnpm leads`: local operations; see README and capture runbook. Deletion/export of real leads requires task authorization.
