# Known Limitations — HyperMem 0.2.0

## Global-scope fact write authorization

Facts written with `scope='global'` are readable fleet-wide at L4 priority. The write path has no authorization gate — any agent with access to the HyperMem API can write a global-scope fact.

**Impact:** In a trusted single-operator deployment (the intended alpha target), this is acceptable. All agents are operator-controlled and share the same trust boundary.

**Planned fix (V2):** Introduce a write-authority model that gates global-scope writes to designated agents (e.g., council seats or explicitly allowlisted agent IDs).

**Workaround:** Restrict HyperMem API access to trusted agents only. Do not expose the API to untrusted external agents.
