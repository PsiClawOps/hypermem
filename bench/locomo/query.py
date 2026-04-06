#!/usr/bin/env python3
"""
LoCoMo Benchmark — Query Phase

For each QA pair:
1. Retrieve context from HyperMem via message FTS search
2. Call gpt-4o-mini via OpenRouter with retrieved context + question
3. Save predictions as JSONL

Usage: python3 query.py [--bridge http://localhost:9800] [--output /tmp/predictions.jsonl]
"""

import json
import sys
import time
import argparse
import urllib.request
import urllib.error
import os

CATEGORY_MAP = {1: "multi-hop", 2: "temporal", 3: "open-domain", 4: "single-hop", 5: "adversarial"}

GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY", "")
READER_MODEL = "gemini-2.0-flash"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"

SYSTEM_PROMPT = """You are a precise question-answering assistant. You will be given retrieved conversation excerpts between two people, and a question about that conversation.

Answer the question based ONLY on the provided conversation excerpts. Be concise and specific.

Rules:
- If the answer is a date or time, give the specific date/time mentioned.
- If the answer is a name, give the full name.
- If the answer requires multiple items, list them separated by commas.
- If the information is not available in the provided excerpts, say "No information available".
- Do NOT make up information. Only use what is in the provided excerpts.
- Keep answers short and factual, usually a few words or a short sentence.
- Pay attention to temporal context (dates in brackets) when answering time-related questions."""


def api_call(url, payload, headers=None, retries=3, timeout=60):
    """POST and return parsed JSON."""
    data = json.dumps(payload).encode()
    hdrs = {"Content-Type": "application/json"}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, data=data, headers=hdrs)
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            body = e.read().decode() if e.fp else ""
            if e.code == 429:
                retry_after = int(e.headers.get("Retry-After", 5))
                print(f"  [rate-limit] 429, waiting {retry_after}s...")
                time.sleep(retry_after)
                continue
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            raise RuntimeError(f"HTTP {e.code}: {body[:200]}")
        except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            raise


def sanitize_fts_query(query):
    """Remove FTS5 special characters and stop words from the query."""
    import re
    # Remove ALL non-alphanumeric characters except spaces
    cleaned = re.sub(r'[^a-zA-Z0-9\s]', ' ', query)
    # Remove stop words to improve FTS5 recall (FTS5 uses implicit AND)
    stop_words = {'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
                  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
                  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
                  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
                  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
                  'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
                  'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more',
                  'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
                  'same', 'so', 'than', 'too', 'very', 'just', 'because', 'but', 'and',
                  'or', 'if', 'while', 'about', 'up', 'what', 'which', 'who', 'whom',
                  'this', 'that', 'these', 'those', 'am', 'it', 'its', 'he', 'she',
                  'they', 'them', 'their', 'we', 'our', 'you', 'your', 'my', 'his', 'her'}
    words = cleaned.lower().split()
    keywords = [w for w in words if w not in stop_words and len(w) > 1]
    # Use OR between keywords for better recall
    if not keywords:
        # Fallback: use all non-stop words even short ones
        keywords = [w for w in words if w not in stop_words]
    if not keywords:
        return cleaned.strip()
    return ' OR '.join(keywords)


def retrieve_context(bridge_url, agent_id, question, limit=10):
    """Get memories from HyperMem for a question using message FTS search."""
    # Sanitize query for FTS5
    clean_query = sanitize_fts_query(question)
    if not clean_query.strip():
        return "No relevant conversation excerpts found."

    # Primary: message FTS search (returns matching conversation turns)
    msg_result = api_call(f"{bridge_url}/search-messages", {
        "agentId": agent_id,
        "query": clean_query,
        "limit": limit,
    })
    msg_hits = msg_result.get("results", [])

    parts = []
    if msg_hits:
        seen = set()
        for msg in msg_hits:
            content = msg.get("textContent", msg.get("content", ""))
            if content and content not in seen:
                seen.add(content)
                parts.append(content)

    return "\n".join(parts) if parts else "No relevant conversation excerpts found."


def call_reader_llm(question, context, api_key):
    """Call Gemini 2.0 Flash via Google Generative Language API."""
    url = f"{GEMINI_URL}?key={api_key}"
    payload = {
        "contents": [{
            "parts": [{
                "text": f"{SYSTEM_PROMPT}\n\nRetrieved conversation excerpts:\n{context}\n\nQuestion: {question}\n\nAnswer:"
            }]
        }],
        "generationConfig": {
            "temperature": 0.0,
            "maxOutputTokens": 200,
        }
    }
    result = api_call(url, payload, timeout=30)
    candidates = result.get("candidates", [])
    if candidates:
        parts = candidates[0].get("content", {}).get("parts", [])
        if parts:
            return parts[0].get("text", "").strip()
    return ""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bridge", default="http://localhost:9800")
    parser.add_argument("--dataset", default="/tmp/locomo10.json")
    parser.add_argument("--manifest", default="/tmp/locomo-manifest.json")
    parser.add_argument("--output", default="/tmp/predictions.jsonl")
    parser.add_argument("--api-key", default=GOOGLE_API_KEY)
    parser.add_argument("--start-from", type=int, default=0, help="Resume from this QA index")
    parser.add_argument("--batch-delay", type=float, default=0.3, help="Delay between LLM calls (seconds)")
    args = parser.parse_args()

    if not args.api_key:
        print("[query] ERROR: No Google API key. Set GOOGLE_API_KEY or use --api-key", file=sys.stderr)
        sys.exit(1)

    # Load dataset
    print(f"[query] Loading dataset: {args.dataset}")
    with open(args.dataset) as f:
        conversations = json.load(f)

    # Load manifest
    print(f"[query] Loading manifest: {args.manifest}")
    with open(args.manifest) as f:
        manifest = json.load(f)

    # Build flat QA list with agent_id references
    qa_pairs = []
    for conv in conversations:
        sample_id = conv["sample_id"]
        agent_id = manifest[sample_id]["agent_id"]
        for qi, qa in enumerate(conv["qa"]):
            # Adversarial questions (cat 5) have adversarial_answer instead of answer
            if qa["category"] == 5:
                answer = qa.get("adversarial_answer", "")
            else:
                answer = str(qa.get("answer", ""))
            qa_pairs.append({
                "conv_id": sample_id,
                "agent_id": agent_id,
                "qa_index": qi,
                "question": qa["question"],
                "answer": answer,
                "category": qa["category"],
                "category_name": CATEGORY_MAP.get(qa["category"], "unknown"),
                "evidence": qa.get("evidence", []),
            })

    print(f"[query] Total QA pairs: {len(qa_pairs)}")
    print(f"[query] Starting from index: {args.start_from}")

    # Open output file (append mode for resume)
    mode = "a" if args.start_from > 0 else "w"
    out_f = open(args.output, mode)

    completed = args.start_from
    errors = 0
    start_time = time.time()

    for idx, qa in enumerate(qa_pairs):
        if idx < args.start_from:
            continue

        try:
            # Retrieve context from HyperMem
            context = retrieve_context(args.bridge, qa["agent_id"], qa["question"])

            # Call reader LLM
            hypothesis = call_reader_llm(qa["question"], context, args.api_key)

            # Write prediction
            prediction = {
                "qa_index": idx,
                "conv_id": qa["conv_id"],
                "question": qa["question"],
                "answer": qa["answer"],
                "hypothesis": hypothesis,
                "category": qa["category"],
                "category_name": qa["category_name"],
                "context_length": len(context),
            }
            out_f.write(json.dumps(prediction) + "\n")
            out_f.flush()

            completed += 1

            # Progress logging
            if completed % 25 == 0 or completed == len(qa_pairs):
                elapsed = time.time() - start_time
                rate = (completed - args.start_from) / elapsed if elapsed > 0 else 0
                eta = (len(qa_pairs) - completed) / rate if rate > 0 else 0
                print(f"[query] {completed}/{len(qa_pairs)} ({qa['category_name']}) -- "
                      f"{rate:.1f} q/s, ETA: {eta / 60:.0f}min")

            # Rate limiting
            time.sleep(args.batch_delay)

        except Exception as e:
            errors += 1
            print(f"[query] ERROR at index {idx}: {e}", file=sys.stderr)
            # Write error prediction
            prediction = {
                "qa_index": idx,
                "conv_id": qa["conv_id"],
                "question": qa["question"],
                "answer": qa["answer"],
                "hypothesis": "",
                "category": qa["category"],
                "category_name": qa["category_name"],
                "error": str(e),
            }
            out_f.write(json.dumps(prediction) + "\n")
            out_f.flush()
            completed += 1
            time.sleep(1)  # Extra delay on error

    out_f.close()
    elapsed = time.time() - start_time

    print(f"\n[query] Complete!")
    print(f"  Predictions: {completed}")
    print(f"  Errors: {errors}")
    print(f"  Time: {elapsed:.1f}s ({(completed - args.start_from) / elapsed:.1f} q/s)")
    print(f"  Output: {args.output}")

if __name__ == "__main__":
    main()
