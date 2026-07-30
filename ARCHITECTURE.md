# Autonomous Venture Platform — Architecture

**One-liner:** The user brings an idea. The platform builds the product, launches it, markets it, and iterates on it — autonomously. Humans steer; agents execute.

**Design stance (the Vercel lesson):** Vercel won not because it hosted websites, but because it turned infrastructure into *primitives with contracts* — immutable deployments, previews, framework-defined infra — and made the workflow the product. We apply the same discipline, with one twist: **our primary customer is an agent, not a human developer.** Every API below is designed agent-first.

---

## 1. Core principles

1. **Primitives, not platforms.** Compute, storage, database, filesystem, network, secrets, events — each is a standalone product with its own API, resource model, event stream, and usage meter. Nothing reaches around a primitive to touch a provider directly.

2. **Loose coupling via contracts.** Every primitive has:
   - a **resource model** (declarative CRUD, versioned schema)
   - a **provider interface** (pluggable backend: gVisor cells today, microVMs tomorrow if needed)
   - an **event stream** (all state changes emitted to the bus)
   - a **meter** (every unit of consumption measured, for billing and margin control)

   Providers are swappable under contract tests. Agents and the control plane speak only to primitive APIs.

3. **Everything is a branch.** The killer feature. A *venture* (code + database + filesystem + config) can be forked as a unit. Every agent change is a preview branch of the entire venture state — not just the code. Promotion to production is atomic; rollback is a pointer move.

4. **Agent-first APIs.** Idempotent operations with client-supplied idempotency keys, resumable long-running jobs, machine-readable errors with suggested remediations, and capability-scoped tokens. An agent should never need to "click around" — and never hold a raw third-party credential.

5. **Immutable builds, declarative desired state.** Agents emit a manifest; a reconciler makes reality match it. Agents never imperatively provision infra.

6. **Control plane / data plane separation.** The control plane orchestrates and bills. The data plane (user apps, agent cells) runs isolated per venture and keeps serving even if the control plane is down.

---

## 2. The unit: a Venture

Not a "project" — a **venture**: everything a one-person startup owns.

```
Venture
├── Spec            — living product spec (agent-maintained, human-editable)
├── Code            — repo on the FileSystem primitive
├── Data            — Database branches, Blob namespaces
├── Deployments     — immutable builds → environments (preview/prod)
├── Distribution    — domains, email, social handles, ad accounts, SEO content
├── Analytics       — first-party event stream from the deployed product
├── Treasury        — Stripe account, spend budgets for ads/tools
└── Team            — the agent roster + human owner, with roles
```

The venture manifest (`venture.yaml`) is the single declarative source of truth. The reconciler compiles it to primitive resources — framework-defined infrastructure, one level up.

---

## 3. The three planes

```
┌─────────────────────────────────────────────────────────────┐
│  CONTROL PLANE                                              │
│  Venture registry · Manifest reconciler · Orchestrator      │
│  Scheduler · Metering/Billing · Audit log · Policy engine   │
└──────────────────────┬──────────────────────────────────────┘
                       │ (declarative manifests, capability tokens)
┌──────────────────────▼──────────────────────────────────────┐
│  AGENT PLANE                                                │
│  Orchestrator-per-venture (state machine)                   │
│  Specialist agents in isolated Cells:                       │
│    Builder · Designer · Marketer · Analyst · Support        │
│  Shared venture memory (context graph)                      │
└──────────────────────┬──────────────────────────────────────┘
                       │ (primitive APIs only)
┌──────────────────────▼──────────────────────────────────────┐
│  PRIMITIVE PLANE                                            │
│  Build primitives:  Compute · FileSystem · Database ·       │
│                     Storage · Network · Secrets · Events ·  │
│                     Identity                                │
│  Distribution primitives:  Domains · Email · Social ·       │
│                     Analytics · Payments · Content          │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Build primitives

### 4.1 Compute
Two flavors, one API family:

- **Cells** — interactive dev sandboxes for agents. gVisor-isolated sandboxes on NVMe hosts today (OnCell), with idle eviction via snapshot-to-S3/restore, and `fork()` to clone a running cell; microVMs (Firecracker) remain the upgrade path if kernel-level isolation is ever required. This is where builder agents live. (Per-customer isolation is non-negotiable — agent-generated code is untrusted by definition.)
- **Runtime** — production serving. Serverless containers, scale-to-zero, concurrency-based autoscaling, per-request metering.

```
POST /cells                 {image, resources, snapshot?}
POST /cells/{id}/exec       {cmd, timeout, idempotency_key}
POST /cells/{id}/snapshot
POST /cells/{id}/fork
POST /runtimes              {build_id, env_ref, scale: {min:0, max}}
```

### 4.2 FileSystem
Versioned, copy-on-write workspace. Git-compatible surface, content-addressed blobs underneath (overlayfs + CAS).

- `fork()` a workspace in O(1) — agents experiment on branches, never on main
- Snapshots are the input to builds (build = f(snapshot, config), fully reproducible)
- Merge with structured conflict reporting an agent can resolve

### 4.3 Database
Per-venture Postgres with **branching** (Neon-style copy-on-write). Every preview deployment gets a DB branch matching its code branch. Schema migrations are validated on the branch before promotion. Point-in-time restore is table stakes — agents will make mistakes; recovery must be a primitive, not an incident.

### 4.4 Storage
Blob store, per-venture namespace, signed URLs, CDN-fronted. S3-backed today; contract says nothing about S3.

### 4.5 Network
Ingress, TLS, and routing. Every deployment gets `{deploy-id}.{venture}.platform.app` instantly; production maps custom domains. Routing table is a pure function of the deployment registry — promotion and rollback are edge config flips, zero data movement.

### 4.6 Secrets & Capabilities
Two distinct things:
- **Secrets vault** — venture-scoped env/config, versioned, injected at build/runtime.
- **Capability tokens** — how agents act. An agent gets a short-lived token scoped to *specific verbs on specific resources* (`fs:write on venture-42/branch-x`, `email:send up to 100/day`). Third-party credentials (Stripe keys, social OAuth) live behind **proxy primitives** — the agent calls `email.send()`, never sees the SendGrid key. This is the blast-radius control that makes autonomy safe.

### 4.7 Events
The platform bus. Every primitive emits state changes; agents subscribe rather than poll. Also the substrate for venture-internal queues (the deployed product can use it too). At-least-once, ordered per key, replayable — an agent that crashed can catch up.

### 4.8 Identity
Auth-as-a-primitive for the *venture's* end users (sessions, OAuth, magic links), so every generated product ships with production-grade auth on day one instead of agent-written auth code.

---

## 5. Distribution primitives

Marketing gets the same discipline as infra. These are not "integrations" — they are metered, contract-bound primitives:

| Primitive | What it wraps | Agent-facing verbs |
|-----------|---------------|--------------------|
| **Domains** | Registrar + DNS + TLS | `search`, `register`, `route` |
| **Email** | Transactional + campaigns | `send`, `sequence.start`, `list.manage` |
| **Social** | X, LinkedIn, Reddit, Product Hunt | `post`, `schedule`, `monitor` |
| **Analytics** | First-party event pipeline | `track` (SDK auto-injected), `query`, `funnel` |
| **Payments** | Stripe Connect per venture | `products.create`, `checkout`, `revenue.query` |
| **Content** | Blog/SEO publishing surface | `publish`, `sitemap`, `keywords.rank` |
| **Signals** | Ops telemetry distillation + external sensing (SEO rank, social mentions, market/competitor watch) | `observe.query`, `watch.create`, `rank.track` |

Every distribution primitive enforces **budgets and rate policies** from the policy engine (an agent cannot spend $5k on ads or spam 1,000 posts — limits are infrastructural, not prompt-based).

The flywheel runs on three signal classes, all distilled into structured observation events on the bus and into venture memory:

1. **Product signals** — first-party analytics, support, revenue → *self-optimizing* (funnel/conversion iterations).
2. **Operational signals** — logs, metrics, traces, cost anomalies, per-venture → *self-healing* (error spike → observation → fix on a branch → verified promote, no human).
3. **External signals** — SEO rank, social mentions, market/competitor watch → *self-repositioning* (pivot-class proposals that re-enter the loop at `idea`, re-triggering human spec approval).

Distillation discipline: anomaly detection decides *when* something is signal; LLM triage decides *what it means*; agents consume observations, never raw log streams. External content is untrusted by definition — provenance-tagged, treated strictly as data about the world, never as instructions; anything it motivates still flows through proposal → verify → gate.

Analyst agent queries observations → proposes changes → Builder ships a preview → metrics decide promotion. Growth becomes a closed control loop.

---

## 6. Agent plane

- **Orchestrator (one per venture):** a durable state machine — `idea → spec → build → verify → launch → grow ⟲`. It owns the venture manifest, decomposes work, spawns specialists, and gates irreversible actions (spend, domain purchase, production promote) on policy or human approval.
- **Specialists** (Builder, Designer, Marketer, Analyst, Support) each run in their own Cell with capability tokens scoped to their job. Marketer can `email.send`; it cannot `fs:write`.
- **Venture memory:** a shared context graph — spec, decisions, customer feedback, experiment results — with hierarchical summaries so any agent can be spun up cold and be productive. Agents are stateless and disposable; the venture's memory is not.
- **Verification is structural:** every Builder change lands as a preview (code branch + DB branch + URL). A separate verifier agent tests it via browser before promotion. The agent that writes code never grades its own work.

---

## 7. The lifecycle (end to end)

```
Idea (human, one paragraph)
 → Orchestrator drafts Spec, human approves scope + budget
 → Builder: fork FS → write code → immutable build → preview URL + DB branch
 → Verifier: browser-tests the preview, checks against Spec
 → Promote: atomic edge flip to production
 → Marketer: domain, landing copy, launch posts, email sequences
 → Signals flow (product analytics · ops telemetry · external watch) → Analyst finds drop-offs / regressions / opportunities
 → Orchestrator queues next iteration → Builder … ⟲
```

Human touchpoints are exactly three: approve the spec, set the budget, and (optionally) approve irreversible actions. Everything else is a notification, not a request.

---

## 8. Why this shape wins

1. **Primitives are independently monetizable.** Like Vercel's KV/Blob/Postgres, each primitive can be sold à la carte later (the Cells product already has a market of its own).
2. **Provider-swappable margins.** Contracts + meters mean we can move any primitive to cheaper infra without touching a single agent.
3. **Venture-level branching is a moat.** Nobody previews *code + data + config* as one atomic branch. For autonomous agents this isn't a nicety — it's the only safe way to let them ship.
4. **Safety is infrastructure, not prompting.** Capability tokens, proxy credentials, and budget policies bound the blast radius of any single agent, no matter what the model does.
5. **The feedback loop is the product.** Build → measure → iterate with no human in the inner loop is what "autonomous" actually means; everything above exists to make that loop safe and fast.

---

## 9. Open questions

- **Cell economics:** warm-pool sizing vs. cold-start SLO per pricing tier (reuse OnCell's idle-eviction model?)
- **DB branching build-vs-buy:** Neon under contract vs. own CoW Postgres layer.
- **Human approval surface:** which actions are hard-gated by default (spend > $X, domain purchase, first prod deploy, outbound email > N)?
- **Multi-tenancy of distribution:** shared social/email reputation pools vs. per-venture isolation (deliverability blast radius).
- **Venture portability:** can a user eject (export code, data, domain)? Answer should be yes — it's the trust wedge, and lock-in should come from the loop, not the walls.
