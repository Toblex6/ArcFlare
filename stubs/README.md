# stubs/

`dynamic-import-stub.mjs` is load-bearing: it is the Turbopack `resolveAlias`
(and webpack `IgnorePlugin`) target for `@x402/svm`, which is never installed
and only ever reached via a runtime-guarded dynamic `import()`. Do not delete
it without replacing the alias in `next.config.mjs`.

(`dead-code/` and `dead-scripts/` — compatibility artifacts / historical
reference copies — were removed in the 2026-10-04 production-hardening pass
after verifying no active imports. See git history for their contents.)
