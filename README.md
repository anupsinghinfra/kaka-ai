# Autonomous Venture Platform (kaka)

The user brings an idea. The platform builds the product, launches it, markets
it, and iterates on it — autonomously. Humans steer; agents execute.

Start with the docs:

- [ARCHITECTURE.md](./ARCHITECTURE.md) — primitives and contracts
- [PLAN.md](./PLAN.md) — target-state AWS implementation plan
- [EXECUTION.md](./EXECUTION.md) — lean path to market
- [TASKS.md](./TASKS.md) — task breakdown
- [docs/ONCELL_AUDIT.md](./docs/ONCELL_AUDIT.md) — OnCell primitive audit

## Built on OnCell

kaka is a **customer of [OnCell](https://oncell.ai)** — it consumes OnCell's
public API with a customer API key, exactly like any outside platform builder.
No shared internals, even where the repos share an author.

The core mapping: **a venture is a cell.** An OnCell cell is a persistent,
isolated workspace+state unit — files, a SQLite database, a journal — that can
be exec'd into, snapshotted, and forked atomically. That is precisely the
venture platform's "everything is a branch" primitive:

| Venture operation | OnCell API call |
|---|---|
| create venture | `POST /api/v1/cells {customer_id}` |
| write/read code & files | `POST /cells/{id}/request` (`write_file`, `read_file`, `list_files`) |
| build / test / run | `POST /cells/{id}/exec {cmd, idempotency_key}` |
| venture state (DB) | `request` (`db_get` / `db_set`) + SQLite files in the workspace |
| checkpoint | `POST /cells/{id}/snapshot` (pinned, never GC'd) |
| **branch the venture** | `POST /cells/{id}/fork` — code + files + database, atomically |
| idle economics | automatic — idle cells pause to ~$0, resume on demand |
| preview URL | `preview_url` on the cell record (host-side app serving pending) |

What kaka therefore does **not** build: compute isolation, a filesystem
primitive, database branching, snapshot/restore, idle eviction. Those were all
on the original build list (see PLAN.md) and are now one API key.

What kaka keeps (venture semantics, on top): the venture registry and
manifest, the orchestrator, the agent team (Builder/Verifier/Marketer/
Analyst — themselves OnCell agents, eventually), distribution primitives
(domains, email, payments, analytics), budgets/policy, and edge routing.

Config: `ONCELL_API_KEY` + `ONCELL_API_URL` in `.env` (gitignored).

## Layout

| Path | Purpose |
|---|---|
| `infra/` | AWS CDK v2 app (TypeScript). All infrastructure, IaC-only. |
| `contracts/` | JSON Schemas + hand-written TypeScript types per primitive. |
| `libs/` | Shared libraries: `authorizer`, `events`, `routing`, `oncell` (the OnCell client). |
| `services/` | Platform services (`token-service`, `registry`). |
| `scripts/venture/` | The golden path: create → build → snapshot → fork → verify, against production OnCell. |

## Prerequisites

Node 20+ (`.nvmrc`), pnpm 8+.

## Commands

```sh
pnpm install        # install all workspace packages
pnpm -r build       # typecheck + compile every package
pnpm -r test        # run every package's tests
pnpm --dir infra cdk synth \
  --context prodAccount=<account-id> \
  --context prodRegion=<region> \
  --context platformDomain=<domain>
```

Account, region, and platform domain come from CDK context (`infra/cdk.json` or `--context`); they are never hardcoded in stack code.
