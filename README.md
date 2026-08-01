# kaka

**Type your startup idea. An AI agent builds it into a working product, serves
it at a URL, and keeps improving it — version after version — on its own.**

You write one sentence. kaka deploys a Builder agent whose whole job is that
idea: it writes real code (no templates), proves every version runs before
shipping it, starts the app, and hands you a link. Turn on auto-improve and it
schedules its own next revision — grounded in the app's runtime logs, with
observed errors outranking new features. You can steer any revision by telling
it what to ship next. Every change is snapshotted first, and any idea can be
**forked** — code, files, and database, atomically — to try a different
direction without risking the original.

```
you:    "A habit tracker where you check off daily habits and watch
         your streaks grow — with a satisfying visual streak calendar"

agent:  ⚙ cells_write_file src/server.js
        ⚙ cells_write_file public/index.html
        ⚙ cells_exec node src/check.js   → CHECK_OK
        live → https://…cells.oncell.ai

        v1  Launched HabitStreak: add/delete habits, one-tap daily
            check-in, live streak counter, and a 70-day visual streak
            calendar you can click to backfill any day.   ✓ check passed
```

## Quickstart

Requirements: Node 20+, pnpm 8+, and an [OnCell](https://oncell.ai) API key
(the agent runtime kaka runs on — sign up, create a key in the dashboard).

```sh
git clone https://github.com/anupsinghinfra/kaka-ai && cd kaka-ai
pnpm install
cp .env.example .env          # paste your ONCELL_API_KEY
pnpm web                      # → http://localhost:3000
```

Type an idea, hit **Start building**, and watch the activity feed — every file
the agent writes, every check it runs, the running cost — until the gold
"Open your product ↗" button appears.

## How it works

Each idea gets two things:

- **An isolated world** — filesystem, SQLite database, and journal — where the
  product lives and runs. Snapshot it, fork it, exec in it. Idle worlds cost
  ~nothing and wake on demand; the product's URL stays live.
- **A Builder agent** — deployed per idea with an identity (your idea text
  embedded, a daily spend budget), tools scoped to its world, and one skill:
  ship the single most user-felt improvement per revision. It records every
  version's changelog, verifies with a self-test, and can schedule its own
  future work — durably, surviving crashes and restarts.

kaka's web app is the founder's cockpit: the idea, the live URL, the version
timeline, a steering input ("tell it what to ship next"), the auto-improve
toggle, and an "under the hood" view (console, files, journal, snapshots).

Both the worlds and the agents run on OnCell; kaka talks to it purely through
its public API with your key. Builds are metered through OnCell's LLM gateway,
so kaka itself needs no model API key (a local builder mode exists behind
`KAKA_BUILDER_MODE=local` if you'd rather bring your own `ANTHROPIC_API_KEY`).

## Repo layout

| Path | Purpose |
|---|---|
| `apps/web/` | The product: Next.js app — dashboard, idea pages, build/improve orchestration, activity feed. |
| `libs/oncell/` | Typed client for the OnCell API (cells, exec, snapshots, fork, agents, run feed). |
| `libs/` (rest) | Platform libraries: `authorizer`, `events`, `routing`. |
| `services/` | Platform services (capability token service, venture registry). |
| `infra/` | AWS CDK app (optional): Cognito auth stack, event bus, edge routing, deploy pipeline. |
| `scripts/venture/` | The golden path: create → build → snapshot → fork → verify, end to end. |
| `ARCHITECTURE.md` | The long-range design: the autonomous venture platform this grows into. |

## Optional pieces

- **Auth**: without Cognito env vars the app runs in local single-user mode
  (no sign-in). Deploy `infra/`'s AuthStack and set the three
  `NEXT_PUBLIC_COGNITO_*` vars for real sign-up/sign-in.
- **Golden path**: `pnpm golden-path` exercises the whole loop against
  production — creates a world, builds and runs an app in it, snapshots,
  forks, proves code + files + database survived the fork, and cleans up.

## Commands

```sh
pnpm -r build       # typecheck + compile every package
pnpm -r test        # every package's tests
pnpm web            # run the app
pnpm golden-path    # end-to-end proof against production
```

## License

MIT — see [LICENSE](./LICENSE).
