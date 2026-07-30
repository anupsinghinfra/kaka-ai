# Implementation Plan — Autonomous Venture Platform on AWS

All infrastructure is AWS, defined exclusively with **AWS CDK (TypeScript)**. No manual console changes, ever. Every primitive keeps its contract from `ARCHITECTURE.md`; AWS services are *providers* behind those contracts and must remain swappable.

---

## 1. AWS service mapping (provider choices per primitive)

| Primitive / Component | AWS Provider (v1) | Notes on the choice |
|---|---|---|
| **Cells** (agent sandboxes) | EC2 bare-metal (`c6i.metal` / `m6i.metal`) + Firecracker, warm pools, snapshots to S3/EBS | Reuse the OnCell cell-manager design: warm-pool provisioning, idle eviction, snapshot/restore, `fork()`. Per-customer microVM isolation is non-negotiable. |
| **Runtime** (prod serving) | EKS + Knative Serving | Exact contract match: scale-to-zero, concurrency-based autoscaling (KPA), per-request metering via queue-proxy. Provider interface keeps ECS/Fargate or Lambda as future alternates. |
| **FileSystem** | S3 (content-addressed blob store) + DynamoDB (tree/ref metadata); overlayfs on cell-local NVMe | Git-compatible surface implemented by our service (CodeCommit is closed to new accounts). CoW fork = new ref pointing at same CAS objects → O(1). |
| **Database** | Aurora PostgreSQL Serverless v2 + fast clones (copy-on-write) | Resolves the build-vs-buy open question for v1: stays in-account, CDK-managed, IAM-integrated. Neon becomes a second provider under the same contract if clone economics disappoint. |
| **Storage** | S3 per-venture prefix + bucket policies, CloudFront, S3 presigned URLs | Contract says nothing about S3 — keep it that way. |
| **Network** | Route 53, ACM wildcard certs, CloudFront + CloudFront KeyValueStore for `{deploy-id}.{venture}` routing | Routing table = pure function of deployment registry → KVS write on promote/rollback. Edge flip, zero data movement. |
| **Secrets vault** | Secrets Manager + KMS (per-venture CMK) | Versioned, injected at build/runtime via task/pod identity. |
| **Capability tokens** | Own token service (short-lived JWTs) + **Amazon Verified Permissions (Cedar)** as the policy engine | Cedar policies express `fs:write on venture-42/branch-x`, `email:send ≤100/day`. Budgets/rate limits enforced in the proxy primitives, decisions from AVP. |
| **Events** (platform bus) | Kinesis Data Streams (ordered per key, replayable) + EventBridge for fan-out/rules | Kinesis gives per-key ordering + replay; EventBridge gives routing and SaaS targets. MSK is the escape hatch if throughput/retention outgrows Kinesis. |
| **Identity** (venture end-users) | Cognito user pool per venture behind our Identity API | Sessions, OAuth, magic links exposed via our contract; Cognito never leaks into generated app code. |
| **Domains** | Route 53 Domains (registrar) + Route 53 DNS + ACM | `search`, `register`, `route` verbs. |
| **Email** | SES v2 (configuration sets, dedicated IP pools per reputation tier) | Deliverability blast radius: shared pool for new ventures, graduation to dedicated pools. Suppression + bounce handling built in from day one. |
| **Social** | Proxy services (ECS) wrapping X/LinkedIn/Reddit/PH APIs; OAuth tokens in Secrets Manager | Agents call `social.post()`; never see provider tokens. |
| **Analytics** | Kinesis → Firehose → S3 (Parquet) + Athena; hot aggregates in DynamoDB | First-party SDK auto-injected at build time. `track`, `query`, `funnel`. |
| **Payments** | Stripe Connect (per-venture connected account); webhook ingestion via API GW → Lambda → Events bus | Also the platform's own billing rail. |
| **Signals** | Ops: CloudWatch/ADOT anomaly detection per venture. External: monitoring workers (SEO rank, social mentions, market/competitor watch) on ECS, budget- and rate-policed | Distills raw telemetry and external observations into structured "observation" events on the bus (anomaly detection decides *when*, LLM triage decides *what it means*). External content is untrusted: provenance-tagged, treated as data — never as instructions. |
| **Content** | Publishing service writing to venture FS + Runtime; sitemap/keywords workers | Rides on FileSystem + Network primitives. |
| **Control plane API** | API Gateway (HTTP) + Lambda for CRUD; ECS Fargate for the reconciler loop | Reconciler is a long-running controller, not request/response — Fargate service. |
| **Orchestrator** (per venture) | Step Functions (Standard) as the durable state machine, invoking agent runs in Cells | Durable, auditable, resumable; `idea → spec → build → verify → launch → grow ⟲`. |
| **Venture memory** | Aurora pgvector + DynamoDB (graph edges) | Context graph with hierarchical summaries; LLM-generated summaries, not keyword heuristics. |
| **Metering** | Per-primitive meters → Kinesis → Firehose → S3; aggregation to DynamoDB; Stripe usage records | Every primitive emits usage events on the same bus it emits state changes. |
| **Audit log** | EventBridge → Firehose → S3 (Object Lock, immutable) + Athena | Every control-plane mutation and agent action, queryable. |
| **Observability** | CloudWatch + ADOT (OpenTelemetry) traces, per-venture dimensions | Cost and latency attributable to a single venture/agent from day one. |

---

## 2. Account & CDK topology

### AWS Organizations layout

```
management (org root, SSO, billing)
├── shared-services        — CDK pipelines, ECR, artifact buckets, Route 53 parent zone
├── control-plane-{stage}  — registry, reconciler, orchestrator, metering, policy   (dev, staging, prod)
├── data-plane-{stage}     — Cells fleet, Runtime EKS, per-venture data stores      (dev, staging, prod)
└── security               — audit log archive, GuardDuty/Config aggregation, break-glass
```

Control/data plane separation is enforced at the **account boundary**, matching the architecture's requirement that the data plane keeps serving if the control plane is down. Per-venture isolation inside data-plane accounts: microVMs for compute, IAM session policies + per-venture KMS keys for data. If a venture ever needs hard isolation (compliance), the provider contract allows moving it to a dedicated account without touching agents.

### CDK repo layout (this repo)

```
kaka/
├── infra/                        # CDK app (TypeScript, pnpm workspace)
│   ├── bin/platform.ts           # single app, stages via cdk-pipelines
│   ├── lib/
│   │   ├── foundation/           # org, networking, DNS, observability, security baseline
│   │   ├── primitives/
│   │   │   ├── compute/          # cells fleet stack, runtime (EKS+Knative) stack
│   │   │   ├── filesystem/
│   │   │   ├── database/
│   │   │   ├── storage/
│   │   │   ├── network/
│   │   │   ├── secrets/          # vault + token service + AVP policy store
│   │   │   ├── events/
│   │   │   └── identity/
│   │   ├── distribution/         # domains, email, social, analytics, payments, content
│   │   ├── control-plane/        # registry, reconciler, orchestrator, metering, audit
│   │   └── pipelines/            # CDK Pipelines (self-mutating, per-stage waves)
│   └── test/                     # fine-grained assertions + snapshot tests per stack
├── services/                     # primitive API implementations (one deployable per primitive)
├── agents/                       # orchestrator defs, specialist agent runtimes
├── contracts/                    # OpenAPI + JSON Schema per primitive, versioned; contract test suites
└── docs/                         # ARCHITECTURE.md, PLAN.md, TASKS.md, ADRs
```

CDK conventions (hard rules):
- One stack per primitive per stage; cross-stack references via SSM parameters, not `Fn.importValue` (avoids deploy deadlocks).
- `cdk-nag` (AwsSolutions pack) runs in CI; suppressions require an inline justification.
- Every stack has fine-grained assertion tests; ≥80% coverage on constructs with logic.
- No hardcoded ARNs/regions/account IDs — everything from stage context.
- Deletion protection + backup on every stateful resource in prod stages.

---

## 3. Phases

Each phase ends with production-grade, contract-tested primitives — no throwaway scaffolding (per standing engineering standards: no MVP shortcuts). Sequencing is driven by the dependency graph: Events, Secrets/Capabilities, and FileSystem underpin everything; the end-to-end build loop is the first integration milestone; distribution and the growth loop come last because they consume everything else.

### Phase 0 — Foundations (infra you never rebuild)
Org + accounts, CDK pipelines, VPCs, DNS parent zone, observability baseline, security baseline (GuardDuty, Config, CloudTrail → security account), audit log skeleton. Exit: `git push` → pipeline deploys a hello-world service to dev/staging/prod through waves with approvals.

### Phase 1 — Trust & communication core
Events bus, Secrets vault, Capability token service + Cedar policy store, Audit log wired to the bus. Exit: a workload can present a scoped token, be authorized by Cedar, emit metered events, and every action lands in the immutable audit trail. This is the safety substrate — nothing agent-facing ships before it.

### Phase 2 — Build primitives
Cells (port/adapt OnCell), FileSystem (CAS + git surface + O(1) fork), Database (Aurora + clone-per-branch), Storage, Network (wildcard ingress + KVS routing), Runtime (EKS + Knative). Exit: **the golden path demo** — fork FS → write code in a Cell → immutable build → preview URL with its own DB branch → atomic promote → rollback. All driven by API calls only.

### Phase 3 — Control plane
Venture registry, `venture.yaml` schema + validation, manifest reconciler, metering aggregation + Stripe billing, policy engine integration (budgets, approval gates). Exit: declaring a venture manifest converges the full primitive set; drift is detected and corrected; usage appears on a Stripe invoice.

### Phase 4 — Agent plane
Orchestrator state machine (Step Functions), venture memory (context graph + hierarchical summaries), Builder agent, Verifier agent (browser-tests previews), human approval surface (spec, budget, irreversible actions). Exit: one-paragraph idea → spec → built preview → verified → human-approved promote to prod, autonomously.

### Phase 5 — Distribution primitives
Domains, Email, Identity (end-user auth in generated apps), Analytics pipeline + auto-injected SDK, Payments (Stripe Connect). Then Social + Content. Every one metered and budget-capped from the first deploy. Exit: a venture can register a domain, send capped email, take a real payment, and see its own funnel.

### Phase 6 — The closed loop
Marketer + Analyst agents, experiment framework (preview branch + metric gate = promotion decision), budget-bounded growth loop, Support agent, and the full signal fabric: operational signals (logs/metrics/traces/cost → anomaly detection → LLM triage → observations) for self-healing, and the external Signals primitive (SEO/social/market) for self-repositioning. The Analyst consumes all three signal classes — product, operational, external — and may propose venture-level pivots (re-entering at `idea`, which re-triggers human spec approval), not just optimizations. Exit: build → measure → iterate cycles run with humans only at the three defined touchpoints; a seeded error spike heals itself end to end.

---

## 4. Cross-cutting standards

- **Contract tests are the spec.** Each primitive ships `contracts/<primitive>/` (OpenAPI + JSON Schema) and a provider-agnostic contract test suite. A provider swap is legal iff the suite passes. TDD: contract tests are written before the provider implementation.
- **Agent-first API checklist** (enforced in review for every endpoint): idempotency key support, resumable long-running jobs (operation resources, not blocking calls), machine-readable errors with remediation hints, capability-token auth only.
- **Metering is not optional.** A primitive PR without usage events does not merge.
- **LLM-first internally.** Anywhere the platform needs judgment (conflict resolution hints, spec drift detection, summarization for venture memory), use model calls — no regex/keyword heuristics.
- **Security reviews** on every phase exit: token service, proxy primitives, and cell isolation get dedicated adversarial review (agent-generated code is untrusted by definition).

---

## 5. Key decisions made in this plan (revisit triggers noted)

1. **Runtime = EKS + Knative**, not Fargate/Lambda — contract fit (scale-to-zero + concurrency autoscaling + per-request metering). Revisit if EKS operational load crowds out primitive work.
2. **DB branching = Aurora fast clones**, not Neon — in-account, CDK-native. Revisit if clone creation latency or cost breaks the preview-per-change model (clones are storage-shared but instance-billed; idle-pause per branch is mandatory).
3. **Bus = Kinesis + EventBridge**, not MSK — managed ops now, Kafka later only if retention/throughput demands it.
4. **Policy = Cedar/AVP**, not homegrown — capability language is the safety core; use the verified engine and keep policies in the repo, deployed via CDK.
5. **Git surface built on CAS**, not CodeCommit (unavailable to new accounts) and not GitHub-as-storage (the FS primitive must own forks/snapshots for O(1) venture branching).
