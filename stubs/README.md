# stubs/

These files are intentionally **not imported** into production and are **not bundled**.

- `dead-code/` and `dead-scripts/` are compatibility artifacts / historical reference copies kept for audit diffing. No active import references them (verified via grep across `src/`).
- Do not rewrite production implementations to make a stub look current.
- One TODO in `dead-code/payrollExecution.ts` is a historical note, not unfinished production work.
