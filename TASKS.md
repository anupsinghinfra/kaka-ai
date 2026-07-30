# Task Breakdown — Autonomous Venture Platform

Companion to `PLAN.md`. Tasks are ordered by dependency; IDs are stable — reference them in commits (`feat: cells warm pool [P2.3]`). Every task includes its acceptance criteria; a task is done only when contract tests pass, CDK assertion tests pass, and usage metering is emitting.

Legend: ☐ not started · ◐ in progress · ☑ done

---

## Phase 0 — Foundations

- ☐ **P0.1 — AWS Organizations & account baseline**
  CDK (or org-formation) definition of the account tree from PLAN §2: shared-services, control-plane-{dev,staging,prod}, data-plane-{dev,staging,prod}, security. SSO permission sets; no IAM users.
  *Accepts:* accounts exist, SSO login works, SCPs deny manual mutation of CDK-managed resources in prod.

- ☐ **P0.2 — CDK monorepo + pipelines**
  pnpm workspace per PLAN §2 layout; CDK Pipelines (self-mutating) with waves dev → staging → prod, manual approval before prod; `cdk-nag` in synth; assertion-test harness.
  *Accepts:* push to `main` deploys a hello-world Lambda through all stages; a failing cdk-nag rule or assertion test blocks the pipeline.

- ☐ **P0.3 — Networking & DNS foundation**
  VPCs per data-plane account (private subnets, VPC endpoints for S3/DynamoDB/ECR/Secrets), parent hosted zone `platform.app` in shared-services with delegated per-stage subzones, ACM wildcard certs.
  *Accepts:* `dev.platform.app` resolves; cross-account zone delegation is CDK-managed.

- ☐ **P0.4 — Observability baseline**
  ADOT collector pattern (construct), CloudWatch log/metric conventions with `venture_id` + `agent_id` dimensions, one shared dashboard construct, alarm → SNS → Slack/email.
  *Accepts:* hello-world service emits traces/metrics tagged by stage; synthetic alarm fires end to end.

- ☐ **P0.5 — Security baseline**
  Org CloudTrail → security account (S3 Object Lock), GuardDuty + Config aggregation, break-glass role with alerting.
  *Accepts:* trail is immutable; Config flags a hand-made resource in <15 min.

## Phase 1 — Trust & communication core

- ☐ **P1.1 — Events primitive (platform bus)**
  Kinesis streams (per-key ordering, replay) + EventBridge bus for rules/fan-out; publisher/subscriber SDK (TypeScript) with schema-registry validation (JSON Schema in `contracts/events/`); replay API for crashed-consumer catch-up.
  *Accepts:* contract suite green — ordered per key, at-least-once, replay from timestamp; consumer lag alarms exist.

- ☐ **P1.2 — Secrets vault**
  Secrets Manager + per-venture KMS CMK; versioned config sets; injection contract for build-time and runtime (pod identity / task role); rotation hooks.
  *Accepts:* secret readable only via venture-scoped role; version pinning + rollback works; every read is audit-logged.

- ☐ **P1.3 — Capability token service + Cedar policy store**
  Short-lived JWT issuance scoped to verbs+resources (`fs:write on venture-42/branch-x`); Amazon Verified Permissions policy store; Cedar policies versioned in repo, deployed via CDK; authorizer middleware for all primitive APIs.
  *Accepts:* contract tests prove deny-by-default, expiry, scope narrowing (a token can mint only weaker tokens); p99 authz decision <20 ms with local policy cache.

- ☐ **P1.4 — Audit log**
  All control-plane mutations + agent actions from the bus → Firehose → S3 (Object Lock) with Athena table; query API.
  *Accepts:* "what did agent X do between t1–t2 in venture V" answerable via one Athena query; log is append-only.

- ☐ **P1.5 — Metering skeleton**
  Usage-event schema (`contracts/metering/`); emitter library used by every primitive; Firehose → S3 raw ledger; hourly aggregation to DynamoDB.
  *Accepts:* hello-world primitive emits usage; aggregate matches raw ledger exactly for a replayed day.

## Phase 2 — Build primitives

- ☐ **P2.1 — Cells: fleet & control**
  EC2 bare-metal ASG (warm pool) in data-plane accounts; Firecracker cell-manager (port/adapt OnCell): create from image, exec with timeout + idempotency key, snapshot/restore to S3, idle eviction, `fork()`.
  *Accepts:* cold-create p95 within SLO from warm pool; fork of a running cell <5 s; escaped-process test proves microVM isolation; per-second usage metered.

- ☐ **P2.2 — Cells: API surface**
  `POST /cells`, `/cells/{id}/exec|snapshot|fork` per ARCHITECTURE §4.1, behind capability tokens; long-running execs as resumable operations.
  *Accepts:* contract suite green; killing the API mid-exec loses nothing (operation resource resumes).

- ☐ **P2.3 — FileSystem: CAS + refs**
  Content-addressed blob store on S3, tree/commit/ref metadata in DynamoDB; O(1) `fork()` (new ref, shared objects); snapshot ID as reproducible build input.
  *Accepts:* 10 GB workspace forks in O(1) metadata time; identical snapshot → identical build hash.

- ☐ **P2.4 — FileSystem: git surface + merge**
  Git wire-protocol read/write against CAS (clone/push from a Cell); merge with structured, machine-readable conflict reports (agent-consumable JSON, LLM-assisted resolution hints).
  *Accepts:* `git clone/push` from inside a Cell works; conflicting merge returns structured conflicts, not a dump.

- ☐ **P2.5 — Database primitive**
  Aurora PG Serverless v2 per venture; branch = fast clone with auto-pause; migration validation on branch before promotion; PITR exposed as `restore(point_in_time)`.
  *Accepts:* branch-per-preview created/destroyed with preview lifecycle; clone of 50 GB DB usable in minutes; restore drill passes; idle branches cost ~storage only.

- ☐ **P2.6 — Storage primitive**
  Per-venture namespace on S3, capability-scoped presigned URLs, CloudFront-fronted reads, lifecycle policies.
  *Accepts:* cross-venture access structurally impossible (bucket policy + token tests); egress metered.

- ☐ **P2.7 — Network primitive**
  Wildcard ingress `{deploy-id}.{venture}.platform.app` via CloudFront + KeyValueStore routing (routing table = pure function of deployment registry); custom-domain mapping; promote/rollback = KVS flip.
  *Accepts:* new deployment routable <30 s; rollback is a single pointer write; zero data movement verified.

- ☐ **P2.8 — Runtime primitive**
  EKS + Knative Serving in data-plane accounts (CDK: cluster, node groups, Knative via manifests/blueprints); image build from FS snapshot (BuildKit in a Cell → ECR); scale-to-zero, concurrency autoscaling; per-request metering from queue-proxy metrics.
  *Accepts:* build → deploy → scale 0→N→0 verified; per-request usage events reconcile against ALB/CloudFront request counts ±1%.

- ☐ **P2.9 — Golden path integration test**
  Scripted end-to-end: fork FS → edit in Cell → build → preview (URL + DB branch) → verify → promote → rollback, all via primitive APIs with capability tokens.
  *Accepts:* runs nightly in staging; total wall-clock and per-step SLOs recorded; this test gates every later phase.

## Phase 3 — Control plane

- ☐ **P3.1 — Venture registry + manifest schema**
  DynamoDB registry; `venture.yaml` JSON Schema (versioned in `contracts/venture/`); CRUD API; registry changes emitted to bus.
  *Accepts:* invalid manifests rejected with machine-readable, remediation-bearing errors.

- ☐ **P3.2 — Manifest reconciler**
  Fargate controller: watch desired (manifest) vs. actual (primitive state), converge via primitive APIs only, exponential backoff, drift detection loop.
  *Accepts:* deleting a primitive resource out-of-band is detected and repaired; reconciliation is idempotent and audit-logged.

- ☐ **P3.3 — Metering aggregation → billing**
  Per-venture rollups; Stripe subscription + usage records; margin dashboard (cost allocation tags vs. metered revenue per primitive).
  *Accepts:* staged usage produces a correct Stripe invoice; per-venture COGS visible.

- ☐ **P3.4 — Policy engine: budgets & gates**
  Cedar policies for spend budgets, rate policies, approval gates (spend > $X, domain purchase, first prod promote, outbound email > N); enforcement hooks in proxy primitives; human approval queue (API + notification).
  *Accepts:* over-budget action is blocked infrastructurally with a remediation error; approval flow round-trips.

## Phase 4 — Agent plane

- ☐ **P4.1 — Orchestrator state machine**
  Step Functions (Standard) per venture: `idea → spec → build → verify → launch → grow ⟲`; task decomposition; agent runs dispatched to Cells; irreversible actions routed through P3.4 gates.
  *Accepts:* orchestrator survives kill/redeploy mid-phase and resumes; every transition audit-logged.

- ☐ **P4.2 — Venture memory (context graph)**
  Aurora pgvector + DynamoDB edges; spec, decisions, feedback, experiment results as nodes; LLM-generated hierarchical summaries with token-budgeted retrieval API.
  *Accepts:* cold-started agent answers "current state + why" for a venture within its context budget; write path is append + re-summarize.

- ☐ **P4.3 — Builder agent**
  Runs in a Cell with `fs:*` + `db:branch` + `runtime:preview` capabilities only; consumes spec from memory; every change lands as full preview (code branch + DB branch + URL).
  *Accepts:* spec delta → working preview with zero human input on the golden-path app.

- ☐ **P4.4 — Verifier agent**
  Separate cell, browser-based (Playwright) verification of previews against spec acceptance criteria; structured pass/fail report to orchestrator. Writer never grades its own work.
  *Accepts:* seeded broken preview is rejected with an actionable failure report; passing preview promotes only via orchestrator.

- ☐ **P4.5 — Spec pipeline + human approval surface**
  Idea → drafted spec (living doc in FS primitive); human approves scope + budget; spec-drift detection (LLM) flags divergence between spec and shipped behavior.
  *Accepts:* the three human touchpoints (spec, budget, irreversible actions) are the *only* blocking interactions on the golden path.

## Phase 5 — Distribution primitives

- ☐ **P5.1 — Domains** — Route 53 Domains `search/register/route` behind approval gate + budget.
  *Accepts:* agent registers and routes a domain end-to-end with one approval.
- ☐ **P5.2 — Email** — SES v2 proxy: `send`, `sequence.start`, `list.manage`; shared→dedicated IP pool graduation; suppression/bounce/complaint handling; hard caps from policy engine.
  *Accepts:* cap breach is blocked; bounce storm auto-pauses sending; reputation isolated per pool.
- ☐ **P5.3 — Identity** — Cognito-backed auth primitive auto-wired into generated apps (sessions, OAuth, magic links).
  *Accepts:* generated app ships working auth with zero agent-written auth code.
- ☐ **P5.4 — Analytics** — auto-injected SDK at build; Kinesis→S3 pipeline; `track/query/funnel` API; hot aggregates.
  *Accepts:* deploy → real user events queryable by Analyst-shaped queries in <2 min.
- ☐ **P5.5 — Payments** — Stripe Connect per venture: `products.create`, `checkout`, `revenue.query`; webhooks → bus.
  *Accepts:* test-mode purchase lands revenue in venture treasury and events on the bus.
- ☐ **P5.6 — Social + Content** — proxy services (`post/schedule/monitor`), publishing surface (`publish/sitemap/keywords.rank`); all rate-policed.
  *Accepts:* agent posts within policy; over-rate is blocked infrastructurally.

## Phase 6 — Closed loop

- ☐ **P6.1 — Analyst agent** — consumes all three signal classes (product analytics, operational observations from P6.6, external observations from P6.7); writes proposals to venture memory. Charter explicitly includes venture-level pivots: a pivot proposal re-enters the loop at `idea`, re-triggering human spec approval — without this mandate the loop only hill-climbs.
- ☐ **P6.2 — Marketer agent** — launch copy, sequences, posts; spends only within Treasury budgets.
- ☐ **P6.3 — Experiment framework** — proposal → preview branch → metric gate decides promotion; results recorded to memory.
  *Accepts:* an A/B iteration completes with no human in the inner loop.
- ☐ **P6.4 — Support agent** — inbound email/chat triage → memory + orchestrator queue.
- ☐ **P6.5 — Full-loop rehearsal** — one venture from paragraph-idea to deployed, marketed, iterating product; humans only at the three touchpoints; margin report per PLAN §1 metering.

- ☐ **P6.6 — Operational signal pipeline (self-healing loop)**
  Per-venture anomaly detection on the P0.4 telemetry (error-rate spikes, latency regressions, crash loops, cost anomalies from the metering ledger) → LLM triage clusters and summarizes into structured observation events on the bus → observation nodes in venture memory. Agents consume observations, never raw log streams.
  *Accepts:* a seeded 5xx spike in a venture's runtime produces an observation, an Analyst proposal, a Builder fix on a branch, and a verified promote — no human input; a seeded cost anomaly is attributed to its cause in the observation.

- ☐ **P6.7 — External Signals primitive (self-repositioning input)**
  Monitoring workers behind a metered API: `keywords.rank`, `social.monitor` (relocated here), competitor/market watch, review-site sentiment. Budget- and rate-policed via P3.4. Ingestion provenance-tags all external content and enforces the injection boundary: external observations are data about the world, never instructions — anything they motivate still flows through proposal → verify → gate.
  *Accepts:* injection-attempt corpus (adversarial content in scraped pages/mentions) produces observations but zero direct agent actions; a competitor-launch fixture surfaces as a pivot-class proposal in venture memory.

---

## Standing rules (apply to every task)

1. Contract tests (in `contracts/`) written **before** provider implementation — TDD at the primitive level; ≥80% coverage.
2. CDK only. A resource that exists but isn't in a stack is a bug (P0.5 catches it).
3. Every API behind capability tokens (P1.3) from its first deploy — no "add auth later".
4. Every primitive emits usage (P1.5) and state-change events (P1.1) from its first deploy.
5. Security review at each phase exit; adversarial review for P1.3, P2.1, and all proxy primitives.
