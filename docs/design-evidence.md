# Product Design Evidence

This register captures failures observed while using Continuity. Architecture
requirements should point to concrete evidence here instead of being inferred
again from chat history.

## E-CANON-001: Reconciliation Hid Durable Active Scope

Observed on 2026-07-24 while recovering an existing task:

- The Phase 2 design that unified `JsonCodec` and fixed streaming remained
  present in durable Continuity blocks 451-458.
- A scope-regressing reconciliation replaced the focused canon without carrying
  that still-active workstream forward.
- A later checkpoint marked the task `completed`, burying the workstream again.
- Recovery required inspecting older blocks and restoring Phase 2 as the active
  `in_progress` canon.

Observed recurrence on 2026-08-21:

- Post-merge follow-ups remained present in append-only daemon block history.
- A reconciliation written at `2026-08-21T20:58Z` flattened the canon and
  omitted the follow-up section.
- A normal `resume` therefore presented an incomplete current state even though
  recovery from history was still possible.
- The immediate repair was to re-pin the follow-ups through another daemon
  checkpoint.

This recurrence happened after the failure mode was already known. It proves
that agent instructions and manual re-pinning are mitigations, not correctness
mechanisms. Follow-ups must be structured entities with stable identities and
lifecycle status; their visibility cannot depend on an agent remembering to
copy prose into every replacement canon.

Observed recurrence on 2026-09-08 during merge assessment:

- The canon undercounted multiple confirmed issues.
- Verification of Repo `#22652` was never completed, but the missing check was
  not reliably represented as an active blocker in the current model.
- The canon remained useful for initial orientation but was not reliable enough
  to authorize a final merge or completion decision.
- Recovery concluded that Continuity needs versioned feature synthesis instead
  of another rewrite of historical prose.

This occurrence expands the failure from state recovery into delivery safety. A
lossy canon can cause an agent to implement against an incomplete scope, merge
without evaluating every confirmed issue, or declare completion while required
verification is still open.

### Finding

Block durability prevented data loss, but durability alone did not preserve
correct current truth. The canon is a derived read model and an unchecked
agent-authored replacement can be internally valid while semantically
regressing task scope.

`completed` is also not a harmless label. It is a closure assertion over the
known task inventory and must not be accepted merely because the latest focused
checkpoint says so.

### Required Product Invariants

1. Accepted signed blocks remain authoritative history. Canon publication never
   deletes or invalidates them.
2. Canon updates are proposals based on an explicit previous canon/head and a
   declared workstream coverage set.
3. An unresolved workstream cannot disappear from current truth without an
   explicit `resolved`, `superseded`, `rejected`, or `out_of_scope` transition
   that references evidence.
4. A task cannot become `completed` while its validated inventory contains an
   unresolved workstream, unless an explicit scoped-completion policy names what
   is excluded.
5. A scope-regressing proposal is rejected or held as
   `needs_reconciliation`; it does not replace the last accepted canon.
6. Recovery can rebuild a candidate canon and workstream inventory from accepted
   blocks without relying on chat history or vendor memory.
7. Unresolved follow-ups have stable identities and remain projected across
   reconciliation until an explicit lifecycle transition closes or excludes
   them.
8. Current feature synthesis is versioned and accounts for environments,
   consumers, sources of truth, invariants, decisions, rejected paths, delivery
   state, confirmed issues, required verification, and unresolved risks.
9. Before implementation, the agent produces an impact matrix that references
   the exact feature-model version and declares which items the proposed work
   affects, preserves, supersedes, or leaves unresolved.
10. Major reviews and merges trigger lineage validation and a new feature-model
    synthesis. Canon text alone cannot authorize merge or completion.

### Design Consequences

- Separate the focused canon from a structured workstream inventory.
- Give canon publications lineage, coverage, and validation results.
- Validate state transitions structurally first, then use an evaluator agent for
  semantic comparison when text meaning is involved.
- Preserve explicit supersession evidence instead of treating text omission as
  resolution.
- Model follow-ups as inventory items or linked workstreams, not as an
  unstructured canon section that must be manually re-pinned.
- Separate orientation (`canon`) from delivery decisions (`merge_ready` and
  `completed`), and require the latter to reference a validated feature-model
  version plus verification evidence.
- Keep append-only evidence immutable. Regenerate versioned current models from
  that evidence rather than rewriting history into one lossy summary.
- Keep the canon concise; protection comes from inventory and validation
  metadata, not by copying the full journal into every canon.

### Required Acceptance Cases

| Case | Expected result |
|---|---|
| New canon omits an unresolved workstream | Publication is rejected or held for reconciliation |
| Checkpoint marks task completed with open inventory | Completion is rejected |
| Canon explicitly supersedes a workstream with evidence | Publication is accepted and lineage remains inspectable |
| Two agents propose divergent current truth | Both proposals remain durable; validated projection does not silently choose one |
| Focused canon lacks older context | Recovery rebuilds inventory from accepted blocks and proposes a non-regressing canon |
| Reconciliation flattens canon after merge | Every unresolved post-merge follow-up remains in the validated projection |
| Agent re-pins a previously omitted follow-up | Repair is idempotent and restores the same item identity instead of creating a duplicate |
| Feature synthesis undercounts confirmed issues | Validation reports the missing issue identities and rejects publication |
| Required Repo `#22652` verification is incomplete | Merge-ready and completed transitions are rejected with the open verification named |
| Agent begins implementation | An impact matrix references the current feature-model version and accounts for every affected item |
| Major review or merge lands | A new feature-model version preserves lineage and revalidates active scope, delivery state, and risks |

Implementation and executable tests for these cases are required before the
personal product can claim canon reconciliation safety.
