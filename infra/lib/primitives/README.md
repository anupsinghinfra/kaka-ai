# infra/lib/primitives

Primitive stacks land here in wave 2 (events, tokens/secrets, filesystem, database, network, compute, identity — see PLAN.md §2 and EXECUTION.md §3 M0–M1). One stack per primitive; wire each into `lib/prod-stage.ts`; cross-stack references via SSM parameters only.
