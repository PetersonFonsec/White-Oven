# WhiteOven contributor guidance

## Project state

WhiteOven is at milestone M0.1-A. The only application implemented so far is the statically built Astro landing page in `apps/landing`, including a browser-only Pizza Builder demonstration and a disabled interest form prototype. Product capabilities described in `docs/` are plans unless the documentation explicitly says they are implemented. Do not scaffold future applications or implement backend, lead capture, logistics, or other unapproved milestone work. Do not advance to M0.1-B without approval.

## Working conventions

- Use pnpm workspaces and run project scripts from the repository root when possible.
- Use TypeScript strict mode. Keep package boundaries explicit and avoid abstractions until a real consumer needs them.
- Keep the landing page statically buildable; do not add server dependencies or credentials.
- Keep product, architecture, and implementation documentation consistent.
- Do not modify or deploy Orbia infrastructure. Production deployment is out of scope for M0.
- Prefer small, accessible, responsive UI changes and semantic HTML.
- Before adding a dependency, confirm that the current stack does not already provide the needed capability.
- Do not claim checks have passed unless they were run and completed successfully.

## Commands

- `pnpm dev`: start the landing page.
- `pnpm test`: run browser-independent pizza selection and pricing tests with the Node test runner.
- `pnpm test:e2e`: build and run versioned Playwright integration tests (install Chromium first).
- `pnpm check`: format, lint, and type-check the workspace.
- `pnpm build`: generate the static landing site in `apps/landing/dist`.
