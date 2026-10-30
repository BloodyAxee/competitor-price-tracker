# AGENTS.md

## Objective

Build a three-day prototype that monitors exact competitor prices for centr-to.ru. The source of truth is `docs/DEVELOPMENT_PLAN.md`, the supplied task, and the research data committed under `data/research`.

## Non-negotiable business invariants

- Compare only an exact model and material configuration. Voltage, generation, ranges and package composition matter.
- Normalize to one unit only when a homogeneous package size is known.
- Prefer a manufacturer or independently confirmed official dealer, while keeping RRP, retail, sale and quote prices distinct.
- Exclude unreliable observations from the comparison but retain them with a reason.
- Mark manual observations as manual.
- Price history is append-only. Never update or delete `price_observations`.
- One source failure must not stop the rest of a collection job.
- The 4641N + VT-64 product is a bundle of two distinct components. A missing own bundle URL is valid. Use `same_seller_only` until cross-seller comparison is explicitly approved.
- Unknown VAT, delivery, installation, stock, region and other conditions remain null.
- Default collection is once daily in Europe/Moscow and must be configurable.

## Required stack

- Python 3.13 and Playwright for collection.
- PostgreSQL 18 with forward-only SQL migrations.
- React 18.3, TypeScript 5.9 and Vite.
- If an API is needed: NestJS 12, Prisma 7 and zod 4.
- Docker Compose; do not add Redis, RabbitMQ, Celery or another language/service.

## Security and repository rules

- Real secrets belong only in local `.env`; commit only `.env.example`.
- Never print secrets or DSNs to logs, fixtures, screenshots or test output.
- OpenAI models are development tools, not a runtime dependency.
- Inspect staged diff for secrets before every commit.
- Do not push unless the user explicitly asks for that action.
- Keep milestone commits small and descriptive; do not squash the development history.
- Do not implement Telegram alerts until all mandatory acceptance checks pass.

## Quality gates

- Run the tests named by the active stage in `docs/DEVELOPMENT_PLAN.md`.
- Use fixtures for parsers; live sites are smoke tests and must not make CI flaky.
- Verify migrations from an empty PostgreSQL volume.
- Verify two observations with the same price are still two history rows.
- Verify a failed source produces partial success and does not abort other sources.
- Verify exact CSV headers and round-trip parsing.
- Verify production frontend build and desktop/mobile states.
- Report commands run, results and remaining limitations before proposing a commit.
