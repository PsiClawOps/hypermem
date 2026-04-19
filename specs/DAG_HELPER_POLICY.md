# DAG Helper Policy

HyperMem Phase 4 Sprint 3 canonical helper-boundary policy.

## Classification

| Helper | Classification | Rule |
|---|---|---|
| `MessageStore.getHistoryByDAGWalk` | `SHARED DAG PRIMITIVE` | Use only inside composition and archived-mining surfaces. Do not call it directly from operator-facing code except exceptional diagnostics. |
| `getContextById` | `INSPECTION ONLY` | Metadata lookup only. Not a message retrieval path. |
| `getContextLineage` | `STATUS-CROSSING BY DESIGN` | May traverse active, archived, and forked contexts. Filter at the call site if archived-only output is needed. |
| `getForkChildren` | `STATUS-CROSSING BY DESIGN` | May return active, archived, and forked children. Filter at the call site if archived-only output is needed. |
| `getArchivedContexts` | `OPERATOR-SAFE ENUMERATION` | Approved listing surface for archived and forked contexts. |
| `getArchivedContext` | `OPERATOR-SAFE LOOKUP` | Approved single-context lookup surface for archived and forked contexts. |
| `MessageStore.mineArchivedContext` | `OPERATOR-SAFE MINING` | Primary archived mining entry point for a single context. |
| `MessageStore.mineArchivedContexts` | `CAPPED OPERATOR-SAFE MINING` | Primary archived mining entry point for multiple contexts. Must enforce the hard `maxContexts` gate before any DB fan-out. |
| `HyperMem.listArchivedContexts` | `OPERATOR FACADE` | Approved top-level archived context listing surface. |
| `HyperMem.mineArchivedContext` | `OPERATOR FACADE` | Approved top-level single-context archived mining surface. |
| `HyperMem.mineArchivedContexts` | `OPERATOR FACADE` | Approved top-level multi-context archived mining surface. |

## Sprint 3 decisions

### 1. Archived-only wrapper decision

Decision: documented policy plus call-site review is sufficient for Sprint 3.

Archived-only wrappers for `getContextLineage` and `getForkChildren` are deferred to Phase 5 unless a concrete operator surface proves they are needed.

### 2. `ftsQuery` scope decision

Decision: `ftsQuery` remains a client-side substring filter at the operator boundary for Sprint 3.

Constraints:
- bounded by per-context `limit`
- bounded by `mineArchivedContexts.maxContexts`
- not a correctness substitute for SQL FTS

SQL FTS promotion is deferred to Phase 5.

### 3. Background indexer scope

Decision: `BackgroundIndexer` remains active-scope and cursor-driven.

Sprint 3 does not wire archived mining into the indexer. If historical re-indexing is needed later, it must go through the capped archived-mining surface with explicit operational controls.

## Operating rule

If a call site is operator-facing and needs archived data, route through the archived-mining surface or the archived lookup/listing helpers. Do not reach through to shared DAG primitives directly.
