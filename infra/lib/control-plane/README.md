# infra/lib/control-plane

Control-plane stacks land here in wave 2 (venture registry, reconciler, orchestrator, metering, audit — see PLAN.md §2). One stack per component; wire each into `lib/prod-stage.ts`; cross-stack references via SSM parameters only.
