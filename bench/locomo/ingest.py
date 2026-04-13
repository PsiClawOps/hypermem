#!/usr/bin/env python3
"""
LoCoMo Benchmark — Ingest Phase

Loads locomo10.json, creates a fresh HyperMem memory space per conversation,
feeds all dialogue turns chronologically via the bridge HTTP API, then triggers
indexing so facts/episodes/embeddings are ready for retrieval.

Usage: python3 ingest.py [--bridge http://localhost:9800] [--dataset /path/to/locomo10.json]
"""

import json
import sys
import time
import argparse
import urllib.request
import urllib.error

CATEGORY_MAP = {1: "multi-hop", 2: "temporal", 3: "open-domain", 4: "single-hop", 5: "adversarial"}

def api_call(bridge_url, endpoint, payload, retries=3):
    """POST to bridge and return parsed JSON response."""
    url = f"{bridge_url}{endpoint}"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode())
        except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            raise RuntimeError(f"API call failed after {retries} retries: {endpoint} — {e}")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bridge", default="http://localhost:9800")
    parser.add_argument("--dataset", default="/tmp/locomo-bench/data/locomo10.json")
    parser.add_argument("--manifest", default="/tmp/locomo-manifest.json")
    args = parser.parse_args()

    # Health check
    try:
        health = api_call(args.bridge, "/healthz", {})
        print(f"[ingest] Bridge healthy: {health}")
    except Exception as e:
        print(f"[ingest] ERROR: Bridge not reachable at {args.bridge}: {e}", file=sys.stderr)
        sys.exit(1)

    # Load dataset
    print(f"[ingest] Loading dataset: {args.dataset}")
    with open(args.dataset) as f:
        conversations = json.load(f)
    print(f"[ingest] Loaded {len(conversations)} conversations")

    manifest = {}
    total_messages = 0
    start_time = time.time()

    for conv_idx, conv in enumerate(conversations):
        sample_id = conv["sample_id"]
        agent_id = f"locomo-{sample_id}"
        conversation_data = conv["conversation"]

        speaker_a = conversation_data.get("speaker_a", "speaker_a")
        speaker_b = conversation_data.get("speaker_b", "speaker_b")

        # Get sorted session keys
        session_keys = sorted(
            [k for k in conversation_data.keys() if k.startswith("session_") and not k.endswith("_date_time")],
            key=lambda x: int(x.split("_")[1])
        )

        print(f"\n[ingest] Conv {conv_idx + 1}/{len(conversations)}: {sample_id} ({len(session_keys)} sessions)")

        conv_messages = 0
        for sess_key in session_keys:
            session_num = sess_key.split("_")[1]
            session_key = f"agent:{agent_id}:bench:{sample_id}-session-{session_num}"
            date_key = f"{sess_key}_date_time"
            session_date = conversation_data.get(date_key, "unknown date")

            turns = conversation_data[sess_key]
            if not turns:
                continue

            # Create conversation in HyperMem
            api_call(args.bridge, "/get-or-create-conversation", {
                "agentId": agent_id,
                "sessionKey": session_key,
                "channelType": "bench",
            })

            for turn in turns:
                speaker = turn["speaker"]
                text = turn["text"]
                dia_id = turn.get("dia_id", "")

                # Prefix with session context for temporal grounding
                context_prefix = f"[{session_date}] {speaker}: "
                full_text = f"{context_prefix}{text}"

                # Record as user message (both speakers are "users" from memory perspective)
                api_call(args.bridge, "/record-user", {
                    "agentId": agent_id,
                    "sessionKey": session_key,
                    "content": full_text,
                    "channelType": "bench",
                })
                conv_messages += 1
                total_messages += 1

            # Small delay between sessions to avoid hammering
            time.sleep(0.05)

        # Trigger indexing after all sessions are recorded
        print(f"  [{sample_id}] Recorded {conv_messages} messages, triggering indexing...")
        try:
            index_result = api_call(args.bridge, "/index", {"agentId": agent_id})
            print(f"  [{sample_id}] Indexed: {index_result}")
        except Exception as e:
            print(f"  [{sample_id}] WARNING: Indexing failed: {e}")

        manifest[sample_id] = {
            "agent_id": agent_id,
            "sessions": len(session_keys),
            "messages": conv_messages,
            "qa_count": len(conv["qa"]),
            "speaker_a": speaker_a,
            "speaker_b": speaker_b,
        }

    elapsed = time.time() - start_time

    # Save manifest
    with open(args.manifest, "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"\n[ingest] Complete!")
    print(f"  Conversations: {len(conversations)}")
    print(f"  Total messages: {total_messages}")
    print(f"  Time: {elapsed:.1f}s ({total_messages / elapsed:.1f} msg/s)")
    print(f"  Manifest: {args.manifest}")

if __name__ == "__main__":
    main()
