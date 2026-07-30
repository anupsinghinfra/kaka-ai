# services/

Primitive API implementations land here in wave 2 (one deployable package per primitive, e.g. `services/token-service`). Each service is a pnpm workspace package (covered by `services/*` in `pnpm-workspace.yaml`) with `build` (tsc) and `test` (jest) scripts, extending the root `tsconfig.base.json`.
