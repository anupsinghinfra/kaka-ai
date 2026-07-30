# Capability Scope Grammar (v0)

Every platform API call is authorized by a short-lived capability JWT carrying a set of
**scopes**. Deny-by-default: a call is allowed only if a scope in the token matches it.

## Grammar

```
scope     = primitive ":" verb [ ":" resource ]
primitive = 1*( lowercase / digit / "_" )        ; e.g. fs, db, runtime, email, registry
verb      = 1*( lowercase / digit / "_" )        ; e.g. read, write, branch, promote, send
resource  = segment *( "/" segment )             ; optional resource qualifier
segment   = 1*( lowercase / digit / "_" / "-" / "." / "*" )
```

- A scope **without** a resource part grants the verb on the whole primitive
  (rare; usually platform-internal).
- A scope **with** a resource part grants the verb only on resources matching the
  qualifier. `*` is a single-segment wildcard.
- Matching is exact per segment; there is no implicit prefix matching.

## Examples

| Scope | Meaning |
|---|---|
| `fs:write:venture-42/branch-x` | Write to branch `branch-x` of venture-42's repo |
| `fs:fork:venture-42/*` | Fork any branch of venture-42's repo |
| `db:branch:venture-42` | Create a DB branch for venture-42 |
| `runtime:preview:venture-42` | Deploy previews for venture-42 (never prod) |
| `runtime:promote:venture-42` | Flip a preview to prod for venture-42 |
| `email:send:venture-42` | Send email on behalf of venture-42 (rate/budget caps come from policy, not the scope) |
| `registry:create` | Create venture records (platform-internal) |

## Semantics (normative)

1. **Deny by default.** No matching scope → machine-readable 403 with a remediation hint.
2. **Scopes authorize; policy constrains.** Quantitative limits (rate, budget, caps) live
   in policy JSON (DynamoDB, evaluated by `libs/authorizer`), not in the scope string.
3. **Short-lived.** Tokens are KMS-signed JWTs with minutes-scale TTLs; agents re-request
   rather than cache long-lived credentials.
4. **Least privilege per agent role.** e.g. the Builder gets `fs:*` on its venture,
   `db:branch`, `runtime:preview` — never `runtime:promote` (EXECUTION.md M2).
