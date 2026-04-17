# AGENTS.md — HyperMem

## Build Execution Policy

HyperMem allows both normal repo work and HyperBuilder-managed workstreams.

When a spec, phase brief, or sprint contract marks a workstream as HyperBuilder-managed:
- implementation must run only through the declared HyperBuilder configuration
- the controlling artifact must name the required composition tier or pipeline profile, mandatory stage roles, required evaluation lanes, and any allowed override path
- do not substitute ad hoc single-agent execution, partial-role execution, or a simplified pipeline
- if the required HyperBuilder configuration is missing, stop and update the controlling artifact before writing code
- only ragesaq can approve a one-off deviation, and that approval must be explicit for the exact run

## Turn DAG Migration

Turn DAG Phase 4 and later are HyperBuilder-managed.

Do not start Phase 4+ implementation until a fresh phase brief or sprint contract names the required HyperBuilder configuration for that phase.
