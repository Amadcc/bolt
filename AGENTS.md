# Repository Guidelines

## Project Structure & Module Organization
`src/index.ts` wires the Fastify API, Telegram bot, and chain services. `src/bot` handles command routing, `src/services` wraps Solana/Jupiter/Jito/honeypot logic, `src/utils` hosts logging, Prisma, and Redis helpers, while `src/config` and `src/types` contain env parsing and shared contracts. Generated files stay in `src/generated`. Database schema and migrations live in `prisma/`, docs and runbooks sit in `docs/` plus the root markdown references, tests mirror sources under `tests/`, and build output in `dist/` is disposable.

## Build, Test & Development Commands
- `bun install` — sync dependencies after pulling.
- `bun dev` — start the API and bot with watch mode.
- `bun run build && bun start` — emit `dist/` and run the production profile.
- `bun run prisma:generate` / `bun run prisma:migrate` — refresh the Prisma client and apply schema updates; commit the generated artifacts.
- `bun run docker:up` / `bun run docker:down` — bring up or stop Redis/Solana services; inspect with `bun run docker:logs`.

## Coding Style & Naming Conventions
Code is modern TypeScript with ESM imports, 2-space indentation, and `const` by default. Order imports from packages to local modules, keep side-effect imports (e.g., `dotenv/config`) first, and rely on `async/await` with centralized logging through `src/utils/logger`. Use `camelCase` for values, `PascalCase` for types/classes, and `SCREAMING_SNAKE_CASE` for env names; store shared schemas in `src/types` and shared helpers in `src/utils`.

## Testing Guidelines
Vitest runs the suite. Place unit specs in `tests/unit/<domain>/<feature>.test.ts`, integration flows in `tests/integration/`, and bootstrap helpers in `tests/setup.ts`. Run `bun test` before pushing, `bun run test:watch` for live feedback, and `bun run test:coverage` for wallet, trading, or security-sensitive changes. Provide scripts in `scripts/` when RPC or Prisma behavior needs reproduction.

## Commit & Pull Request Guidelines
Use Conventional Commits (`feat:`, `fix:`, `chore:`) with optional scope, as seen in history. Keep messages in present tense and describe user-facing outcomes. Each PR must link issues or docs, summarize behavior changes, list executed commands (build, tests, migrations), and attach screenshots or logs for Telegram-facing flows. Call out `.env` updates and any reviewer steps.

## Environment & Security Tips
Configure runtime secrets through `.env` and validate new keys inside `src/config`; never commit credentials. Limit `bun run prisma:studio` to disposable data and shut down services with `bun run docker:down` when idle. Before exposing new endpoints or trade paths, review `COMPREHENSIVE_SECURITY_AUDIT.md`, `SECURITY_AUDIT.md`, and `HONEYPOT.md` to ensure mitigations stay intact.
