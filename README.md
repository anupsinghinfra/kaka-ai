# Autonomous Venture Platform

Monorepo for the venture platform. Start with the docs:

- [ARCHITECTURE.md](./ARCHITECTURE.md) — primitives and contracts
- [PLAN.md](./PLAN.md) — target-state AWS implementation plan
- [EXECUTION.md](./EXECUTION.md) — lean path to market (single prod, OnCell account)
- [TASKS.md](./TASKS.md) — task breakdown

## Layout

| Path | Purpose |
|---|---|
| `infra/` | AWS CDK v2 app (TypeScript). All infrastructure, IaC-only. |
| `contracts/` | JSON Schemas + hand-written TypeScript types per primitive. |
| `libs/` | Shared libraries (e.g. `libs/authorizer`). |
| `services/` | Primitive API implementations (land in wave 2). |

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
