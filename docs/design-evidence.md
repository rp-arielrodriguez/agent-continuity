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

### Design Consequences

- Separate the focused canon from a structured workstream inventory.
- Give canon publications lineage, coverage, and validation results.
- Validate state transitions structurally first, then use an evaluator agent for
  semantic comparison when text meaning is involved.
- Preserve explicit supersession evidence instead of treating text omission as
  resolution.
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

Implementation and executable tests for these cases are required before the
personal product can claim canon reconciliation safety.
