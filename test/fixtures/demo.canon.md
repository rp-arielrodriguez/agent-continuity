# Canon: cli-reconcile-smoke-validated

last-reconciled: 2026-06-14T00:00:00.000Z
<!-- STALENESS GUARD: if last-reconciled != the journal's newest entry timestamp,
     this canon is STALE. Run `continuity reconcile --task-id cli-reconcile-smoke-validated --canon-file <file>` before acting. -->

## SOURCE-OF-TRUTH
- PostgreSQL continuity tables via `continuity resume --task-id cli-reconcile-smoke-validated`.

## CURRENT-TRUTH / INVARIANTS
- Reconcile smoke uses a user-provided canon file.

## DECISIONS
- D1: Canon content is agent-authored; Absurd owns durable persistence.

## REJECTED (do not re-derive)
- Making hooks infer semantic canon content automatically.

## NEXT-ACTION
- Continue validating CLI integration.
