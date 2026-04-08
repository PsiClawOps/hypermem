# hypermem Memory Viewer

## Goal

Restore operator visibility that `.md` memory systems gave us, without giving up SQLite/Redis runtime quality.

Operators should be able to inspect what hypermem knows, why it knows it, what is hot in Redis right now, and why a given item showed up in retrieval.

## Problem

Flat markdown memory had two operator advantages:
1. direct inspectability
2. easy grep/debug loops

hypermem improved runtime behavior by moving memory into structured stores:
- `messages.db`
- `vectors.db`
- `library.db`
- Redis hot cache

That improved composition quality and speed, but it removed the operator visibility layer. Today, an operator mostly has to trust the system or ask an agent to explain it.

That is not enough.

## Product Position

The Memory Viewer is an **operator surface**, not an agent surface.

It should answer:
- what data exists?
- where does it live?
- what is hot vs durable?
- what was retrieved and why?
- what changed over time?
- what looks wrong?

## Scope

Two surfaces:
1. **CLI first**
2. **Web page second**

CLI ships first because it is faster, lower risk, easier to audit, and immediately useful for debugging.

## Users

- operator (`ragesaq`)
- council/director agents when debugging with operator approval
- infrastructure/devex maintainers

## Core Objects to View

### 1. Messages
Source: per-agent `messages.db`

Need to inspect:
- recent messages by agent/session/conversation
- raw stored text
- normalized/rendered text
- topic assignment
- duplicate/suspicious rows
- source timestamps
- message ids and ordering gaps

### 2. Facts
Source: `library.db`

Need to inspect:
- active facts
- superseded facts
- confidence/decay/scope/visibility
- contradiction links
- vector indexed status

### 3. Knowledge
Source: `library.db`

Need to inspect:
- key/domain/content
- version chain
- superseded history
- source refs
- whether indexed in vectors

### 4. Topics
Source:
- session topics in `messages.db`
- cross-session topics in `library.db`

Need to inspect:
- active topic per session
- topic confidence/stability
- topic synthesis page
- pending confirmation / optimistic switch state
- message counts and last active time

### 5. Episodes
Source: `library.db`

Need to inspect:
- significance
- participants
- visibility
- source message id
- vector indexed status

### 6. Redis hot cache
Source: Redis

Need to inspect:
- hot history window
- cursor
- topic-scoped slots
- topic return state
- query embedding presence
- TTL remaining

### 7. Retrieval traces
Source:
- compose diagnostics
- vector map tables
- graph links
- Redis/session state

Need to inspect:
- what was recalled
- why it ranked
- trigger vs semantic vs keyword path
- graph neighbors used
- chunks/facts/knowledge included or filtered

## CLI Specification

Command namespace:

```bash
openclaw memory ...
```

### A. Overview

```bash
openclaw memory status [--agent forge]
```

Shows:
- message db size
- vector db size
- library counts
- hot Redis session count
- stale topic count
- duplicate/suspicious row count summary

### B. Sessions

```bash
openclaw memory sessions [--agent forge]
openclaw memory sessions show <sessionKey>
```

Shows:
- active/recent sessions
- message counts
- last active
- active topic
- cursor state
- hot/cold cache status

### C. Messages

```bash
openclaw memory messages [--agent forge] [--session <key>] [--limit 50]
openclaw memory messages show <messageId> [--agent forge]
openclaw memory messages grep "redis hot cache" [--agent forge]
openclaw memory messages suspicious [--agent forge]
```

`messages show` should include:
- raw row
- rendered/normalized content preview
- topic id
- previous/next message ids
- possible duplicate diagnosis

`suspicious` should flag:
- envelope-shaped rows
- duplicate user rows
- large tool payloads
- malformed JSON fields
- missing topic references

### D. Facts

```bash
openclaw memory facts [--agent forge] [--active]
openclaw memory facts show <factId>
openclaw memory facts conflicts [--agent forge]
```

### E. Knowledge

```bash
openclaw memory knowledge [--agent forge] [--domain topic-synthesis]
openclaw memory knowledge show <knowledgeId>
openclaw memory knowledge history <key> [--agent forge]
```

### F. Topics

```bash
openclaw memory topics [--agent forge]
openclaw memory topics show <topicId> [--agent forge]
openclaw memory topics search "redis recovery"
```

Should expose:
- session topic state
- pending confirmation metadata
- topic synthesis
- linked graph neighbors

### G. Redis

```bash
openclaw memory redis [--agent forge] [--session <key>]
openclaw memory redis show-slot <sessionKey> <slot> [--agent forge]
openclaw memory redis show-topic <sessionKey> <topicId> [--agent forge]
```

Should show:
- keys present
- TTLs
- slot sizes
- hot history length
- active topic cache separation

### H. Retrieval

```bash
openclaw memory trace compose --agent forge --session <key> --prompt "how do we recover redis after restart"
openclaw memory trace item <messageId|factId|knowledgeId>
```

Should show:
- triggered collections
- semantic hits
- keyword hits
- scope-filtered rows
- graph neighbors
- final included blocks and token counts

### I. Maintenance

```bash
openclaw memory audit duplicates [--agent forge]
openclaw memory audit envelopes [--agent forge]
openclaw memory cleanup envelopes --dry-run [--agent forge]
openclaw memory cleanup envelopes --apply [--agent forge]
```

Maintenance commands must:
- default to dry-run
- require explicit `--apply`
- print backup path before mutation
- print deleted row ids and counts

## Web Page Specification

Location:
- ClawDash operator page
- route suggestion: `/memory` and `/memory/:agentId`

### Main layout

Tabs:
1. Overview
2. Sessions
3. Messages
4. Facts
5. Knowledge
6. Topics
7. Episodes
8. Redis
9. Retrieval Trace
10. Maintenance

### Overview cards

- agents with memory
- hot Redis sessions
- total facts/knowledge/topics/episodes
- suspicious rows
- duplicate envelope candidates
- vector index health

### Messages view

Columns:
- id
- created_at
- role
- session_key
- topic_id
- raw preview
- normalized preview
- suspicion flags

Expandable panel:
- raw stored text
- normalized text
- nearby rows
- duplicate analysis

### Topics view

Should make virtual-session state visible:
- active topic per session
- last composed topic
- pending topic
- confidence
- synthesis page
- related messages

### Retrieval Trace view

Operator enters:
- agent
- session
- prompt

UI returns:
- trigger hits
- semantic hits
- keyword hits
- graph neighbors
- included blocks in final compose
- token budget breakdown

This is critical. It answers: **why did the model see this?**

### Maintenance view

Read-only by default.

Supports:
- duplicate envelope audit
- orphan graph links audit
- stale Redis topic slot audit
- superseded vector tombstone audit

Mutation actions require:
- explicit confirmation
- backup path shown
- dry-run preview shown first

## API Endpoints

Suggested endpoints:

```http
GET /api/memory/overview?agent=forge
GET /api/memory/sessions?agent=forge
GET /api/memory/messages?agent=forge&sessionKey=...&limit=50
GET /api/memory/messages/:id?agent=forge
GET /api/memory/facts?agent=forge
GET /api/memory/knowledge?agent=forge&domain=topic-synthesis
GET /api/memory/topics?agent=forge
GET /api/memory/topics/search?q=redis&agent=forge
GET /api/memory/redis?agent=forge&sessionKey=...
POST /api/memory/trace/compose
POST /api/memory/audit/envelopes
POST /api/memory/cleanup/envelopes/dry-run
POST /api/memory/cleanup/envelopes/apply
```

## Security / Safety

This surface is operator-only.

Rules:
- no secret file reads
- redact token-like values in raw payloads
- mutation endpoints require explicit operator confirmation
- maintenance actions log audit rows to `library.db` system events

## Non-Goals

- not a public user-facing memory browser
- not full transcript export for compliance
- not arbitrary raw SQL in the UI
- not agent self-service mutation without operator visibility

## Implementation Order

### Phase 1: CLI
- `status`
- `sessions`
- `messages`
- `topics`
- `redis`
- `audit envelopes`

### Phase 2: Retrieval trace
- compose trace command
- why-this-was-recalled drilldown

### Phase 3: Web page
- overview
- messages
- topics
- redis
- trace

### Phase 4: maintenance actions
- duplicate cleanup dry-run
- guarded apply path

## Success Criteria

Operator can answer these without asking an agent:
- what does Forge currently know about X?
- why did X appear in retrieval?
- what topic is active in this session?
- what is sitting hot in Redis right now?
- which rows are suspicious duplicates?
- what would a cleanup pass delete before it runs?

## Strategic Fit

This restores the strongest property markdown memory had: inspectability.

hypermem should keep the runtime advantages of structured memory, but operators must be able to see inside the box.
