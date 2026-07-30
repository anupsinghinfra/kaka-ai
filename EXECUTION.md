# Execution Plan — Lean Path (Single Prod, OnCell Account)

`PLAN.md` is the target-state architecture. This document is how we actually get to market: one environment (**prod**), one AWS account (**OnCell**), everything CDK, sequenced like a startup — every milestone ends in something you can demo, sell, or learn from. Contracts from `ARCHITECTURE.md` are kept; deployment topology is collapsed. We cut **scope**, never quality: fewer primitives at launch, each one production-grade, because prod is the only environment there is.

---

## 0. Entrepreneur's operating principles

1. **The demo is the strategy.** "Paragraph in → live, verified product at a URL" is the moment that sells. Everything before that moment is overhead; get there first, then deepen.
2. **The differentiator is the loop, not codegen.** Codegen is a crowded market (we know — we're in it with JustCopy). Nobody else has *launch → measure → iterate autonomously*. So the loop must appear by M4, not "later."
3. **Reuse ruthlessly.** OnCell = the Cells primitive, already built (idle eviction, snapshot/restore-from-S3, per-customer gVisor isolation on NVMe hosts). JustCopy V3 contract executor = a head start on the Builder. We are not starting at zero; we're starting at ~Phase 2. (See `docs/ONCELL_AUDIT.md` for the verified state of OnCell — notably: snapshot exists but isn't API-exposed, fork doesn't exist yet, and there are no lifecycle events or scoped tokens. Those are the OnCell-side work items.)
4. **Dogfood as GTM.** The platform's own landing page, launch posts, and email sequences are produced by a venture *running on the platform*. The product is its own proof.
5. **Charge from the first external user.** Stripe is in M3, not a post-launch add-on. Willingness to pay is the only validation that counts.
6. **Buy the undifferentiated — or delete it.** Per-venture database = SQLite in the venture workspace (zero marginal cost, and it makes venture forking atomic); Postgres is a graduation tier, not a launch dependency. Policy via simple scoped JWTs first. Own the moat (venture branching, the loop); rent or embed the rest under swappable contracts.

## 1. Single-prod safety model (no staging, on purpose)

With one environment, "staging" is replaced by the architecture's own killer feature:

- **Previews are staging.** Every change — venture *or platform* — is a branch triple (code + DB branch + URL). Nothing lands on a live route except via pointer flip; rollback is the same flip in reverse.
- **Continuous golden-path canary.** The scripted `fork → build → preview → verify → promote → rollback` run executes hourly against a synthetic venture. Platform deploy completes only if the canary passes; auto-rollback otherwise.
- **IaC-only, enforced.** CDK is the sole mutation path. AWS Config flags out-of-band resources; drift is a pageable event.
- **Backups are a primitive.** PITR on every datastore, restore drilled monthly (agents will make mistakes; recovery is a feature, not an incident).
- **Blast-radius via tokens from day one.** Capability JWTs (deny-by-default, short-lived, verb+resource scoped) in front of every API from its first deploy. This is the one thing we refuse to simplify — it's what makes autonomy safe in prod.

## 2. Deltas vs PLAN.md (decisions for the lean path)

| Concern | PLAN.md target | Lean path (now) | Upgrade trigger |
|---|---|---|---|
| Accounts | Multi-account org | OnCell account, strict IAM boundaries + per-venture KMS | First compliance-sensitive customer or platform revenue > infra pain |
| Runtime | EKS + Knative | **Serve from cells**: each venture's app runs in a long-lived OnCell cell behind CloudFront; snapshot/restore ≈ scale-to-zero | A venture exceeds single-cell throughput, or >100 active ventures |
| Database | Aurora fast clones | **SQLite in the venture workspace** ("embedded" provider): the DB is a file, so workspace fork = atomic code+data branch. Litestream streams the WAL to S3 continuously (seconds RPO, PITR from WAL segments). Same contract verbs: `branch / promote / restore` | Venture outgrows single-writer: sustained write concurrency, multi-cell serving, or >~10 GB → `db.migrate_provider` to Postgres (Neon/Aurora) under the same contract |
| FileSystem | S3 CAS + git surface | **Bare git repos on cell-local NVMe** (OnCell hosts use instance-store NVMe with S3 as durable truth — there is no EFS), snapshots to S3; fork = `git clone --shared` / `cp --reflink` on XFS (seconds at venture scale) | Repo sizes make fork latency user-visible, or cache-affinity rescheduling causes fork misses → build CAS |
| Events | Kinesis + EventBridge | **EventBridge + archive/replay** only | Per-key strict ordering or consumer-lag needs → add Kinesis |
| Policy | Cedar / AVP | Scoped JWTs + policy JSON in DynamoDB, evaluated in an authorizer library | Policy count/complexity makes JSON audit painful → AVP, same token surface |
| Identity | Cognito per venture | Same (it's already lean) | — |
| Observability | Full ADOT | CloudWatch + structured logs with `venture_id`, X-Ray on the APIs | First perf mystery we can't solve in an hour |

Every row keeps the **contract** from ARCHITECTURE.md — providers swap later without touching agents. That's the whole point of the primitive discipline, and it's what lets us be lean now without a rewrite later.

### OnCell-side dependencies (built in OnCell, consumed here via its public API)

Per the two-product boundary — OnCell owns tenant-scoped agent infrastructure; kaka owns venture semantics — these land on the **OnCell roadmap**, not kaka's. Audited state and exact insertion points: `docs/ONCELL_AUDIT.md` (gaps G1–G11). In build order for M1:

1. **G1 — WAL checkpoint pre-snapshot hook** (required for M1; also fixes a live data-loss bug — WAL-mode DBs are synced to S3 without checkpoint or sidecars today).
2. **G2/G3/G10 — snapshot as an API verb, fork, create-from-snapshot** (snapshot logic exists internally but has no route; fork does not exist yet — it is new work, not reuse).
3. **G8 — scoped-token auth layer** (today: tenant isolation only, no scoping/TTL/JWT).
4. **G7 — cell lifecycle events** (today: poll-only; cheapest first emit is the `/internal/cell-status` chokepoint).
5. **G9 — exec verb with caller timeout + idempotency key** (no idempotency support exists anywhere in OnCell today).
6. **G4/G5/G6 — workspaces, blob API + presigned URLs, per-tenant observability.**

kaka consumes all of it through OnCell's public API only; no shared internals, even in the same account. Also resolve before M1: OnCell's gen-1 Rust host-agent (which owns cell snapshot/restore) currently has no CDK deployment path — the data plane deploys the gen-2 supervisor instead (audit §"Corrections", item 3).

---

## 3. Step by step

### M0 — Rails (Week 1)
*Nothing user-visible. Everything here is required by every later step.*

1. CDK app in this repo, deploying to the OnCell account; single pipeline `main → prod` with the canary gate (stub until M1 makes it real).
2. Platform domain: hosted zone + ACM wildcard + CloudFront distribution + KeyValueStore (empty routing table).
3. Event bus: EventBridge custom bus + archive (replay) + Firehose → S3 audit trail (Object Lock).
4. Capability token service: JWT issuance (KMS-signed), scope grammar (`verb:resource`), authorizer library; policy JSON in DynamoDB.
5. Venture registry table + `venture.yaml` schema v0 (spec, repo ref, db ref, deployments, budgets).
6. Kick off the slow external clocks **now**: SES production access request, Stripe platform account review, social API app approvals.

**Exit:** an API call with a scoped token creates a venture record; the event lands in the audit trail; an unscoped call gets a machine-readable 403.

### M1 — The build spine (Weeks 2–3)
*Assemble the branch triple out of parts we mostly have.*

1. FileSystem API over bare git repos on EFS: `create / fork / snapshot / merge(structured conflicts)`.
2. Database API, embedded provider: SQLite file in the workspace, Litestream baked into the runtime image (WAL → S3). `branch` = the workspace fork itself (preview gets a full data copy at fork time); `restore(pitr)` from WAL segments; `promote` = apply the branch-validated migration to prod's DB, then flip the code pointer (prod data is never replaced by the preview's copy — the copy exists to validate migrations and give the Verifier realistic data). `db.migrate_provider` defined in the contract now, implemented at first graduation.
3. Build: BuildKit inside an OnCell cell; snapshot-in → image/artifact-out, content-hash reproducible.
4. Serve-from-cell runtime: `deploy(build, env)` boots the app in a dedicated cell; Network API writes `{deploy-id}.{venture}.<domain>` → cell ingress into CloudFront KVS. `promote` / `rollback` = KVS pointer flips.
5. Wire the golden-path canary for real; it becomes the deploy gate from here on.

**Exit (the platform heartbeat):** scripted run — fork FS (code + SQLite data, atomically) → change → build → preview URL with its own data copy → promote → rollback — under 5 minutes end to end, hourly, in prod. Plus a restore drill: kill a cell, restore its DB from WAL to within seconds of the kill.

### M2 — The magic demo (Week 4)
*First time the product exists. Start showing it the day this lands.*

1. Orchestrator: Step Functions state machine per venture (`idea → spec → build → verify → launch`), resumable, every transition on the bus.
2. Spec agent: paragraph → living spec doc (in the venture's repo); minimal founder console (approve spec + set budget — human touchpoints #1 and #2).
3. Builder agent in a cell (adapt JustCopy V3 contract executor) with `fs:*`, `db:branch`, `runtime:preview` scopes only.
4. Verifier agent in a separate cell: Playwright against the preview, spec acceptance criteria, structured pass/fail. Writer never grades its own work.
5. Approval gate for first prod promote (touchpoint #3), then pointer-flip launch.

**Exit:** *live demo:* one paragraph → spec approved → built → browser-verified → promoted to a real URL, hands off in between. Record it. Open the waitlist. Start 10 design-partner conversations.

### M3 — Ventures that do business (Weeks 5–6)
*A URL isn't a venture. Revenue and reach are.*

1. Payments: Stripe Connect per venture — `products.create / checkout / revenue.query`; webhooks → bus. **Platform billing on the same rail** (subscription + metered usage from the M0 audit/usage events).
2. Domains: Route 53 Domains `search / register / route` behind budget + approval gate.
3. Email: SES proxy `send / sequence.start` — shared IP pool, hard caps from policy, suppression/bounce handling. (Access requested in M0.)
4. Analytics: auto-injected SDK at build time → API GW → Firehose → S3 + Athena; `track / query / funnel`; hot aggregates in DynamoDB.
5. Identity primitive: Cognito-backed auth wired into generated apps — no agent-written auth code.
6. **Dogfood:** launch 2–3 internal ventures (including the platform's own marketing site) built and run by the platform. Onboard the first 5 design partners at a real price.

**Exit:** a venture registers a domain, ships with working auth, sends capped email, takes a test-mode → live payment, and its funnel is queryable. First external dollar in.

### M4 — Close the loop (Weeks 7–8)
*The differentiator. Everything before this, competitors have some version of.*

1. Analyst agent: consumes product analytics + operational observations; writes proposals to venture memory (v0 memory: one small platform Postgres with pgvector + the venture repo — hierarchical summaries, LLM-generated. Platform stores stay Postgres; SQLite is per-venture only).
2. Ops signal pipeline v0: CloudWatch alarms per venture (5xx, latency, cost anomaly from usage ledger) → LLM triage → observation events → memory. Seeded error spike must heal itself: observation → proposal → Builder fix → verified promote.
3. Experiment framework: proposal → preview branch → traffic split at the CloudFront layer → metric gate decides promotion; result written to memory.
4. Marketer agent v0: launch copy + email sequence + scheduled posts, spending only within Treasury budgets.
5. **Public launch** (Product Hunt / X / HN) — run *by a venture on the platform*, and say so. The launch is the demo.

**Exit:** at least one venture completes an autonomous improvement cycle (signal → proposal → preview → metric gate → promote) with zero humans in the inner loop — and we can show the audit trail proving it.

### M5+ — Earn the right to scale (after launch, demand-driven)
Pull from PLAN.md phases as triggers fire (§2 table): Knative when a venture outgrows its cell; CAS filesystem when forks get slow; Kinesis when replay semantics bind; AVP when policies sprawl; multi-account when a customer or auditor asks. External Signals primitive (SEO/social/market watch, injection-hardened per TASKS P6.7) is the first post-launch feature — it's the self-repositioning input and a great retention story.

---

## 4. The numbers that matter (from day one)

- **Time-to-live-product** (paragraph → verified URL): the demo metric. Target < 1 hour at M2, < 15 min by M4.
- **Loop cycles per venture per week**: the differentiation metric. If ventures aren't iterating autonomously, we're a codegen tool with extra steps.
- **Venture 4-week retention**: do founders keep their ventures alive and paying?
- **Gross margin per venture**: metered usage revenue vs. cell + Neon + egress cost (the M0 usage ledger makes this a query, not a project).
- **Human interventions per venture per week**: should trend toward the three touchpoints and nothing else.
