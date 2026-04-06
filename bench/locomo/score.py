#!/usr/bin/env python3
"""
LoCoMo Benchmark — Score Phase

Two scoring methods:
  1. Token-overlap F1 (original LoCoMo paper metric, deterministic)
  2. LLM-as-Judge accuracy (Mem0/MemMachine-comparable, requires API call)

Default judge: gpt-5-mini via copilot-local (same model as eval for fairness).

Usage:
  python3 score.py [--predictions /tmp/predictions.jsonl]
  python3 score.py --judge --judge-model gpt-5-mini --judge-url http://127.0.0.1:4141/v1
  python3 score.py --no-judge   # token F1 only, no API calls
"""

import json
import sys
import re
import string
import argparse
import time
import os
import urllib.request
import urllib.error
from collections import Counter, defaultdict
from datetime import date


# ─── Porter Stemmer (minimal implementation to avoid NLTK dependency) ────────

class PorterStemmer:
    """Minimal Porter Stemmer for F1 scoring."""

    def __init__(self):
        self.cache = {}

    def stem(self, word):
        if word in self.cache:
            return self.cache[word]
        result = self._stem(word.lower())
        self.cache[word] = result
        return result

    def _stem(self, w):
        if len(w) <= 2:
            return w

        # Step 1a
        if w.endswith("sses"):
            w = w[:-2]
        elif w.endswith("ies"):
            w = w[:-2]
        elif not w.endswith("ss") and w.endswith("s"):
            w = w[:-1]

        # Step 1b
        if w.endswith("eed"):
            if self._measure(w[:-3]) > 0:
                w = w[:-1]
        elif w.endswith("ed"):
            stem = w[:-2]
            if self._has_vowel(stem):
                w = stem
                w = self._step1b_fix(w)
        elif w.endswith("ing"):
            stem = w[:-3]
            if self._has_vowel(stem):
                w = stem
                w = self._step1b_fix(w)

        # Step 1c
        if w.endswith("y") and self._has_vowel(w[:-1]):
            w = w[:-1] + "i"

        return w

    def _step1b_fix(self, w):
        if w.endswith(("at", "bl", "iz")):
            return w + "e"
        if len(w) >= 2 and w[-1] == w[-2] and w[-1] not in "lsz":
            return w[:-1]
        if self._measure(w) == 1 and self._cvc(w):
            return w + "e"
        return w

    def _is_consonant(self, w, i):
        c = w[i]
        if c in "aeiou":
            return False
        if c == "y":
            return i == 0 or not self._is_consonant(w, i - 1)
        return True

    def _measure(self, w):
        """Count VC sequences."""
        n = 0
        i = 0
        while i < len(w) and self._is_consonant(w, i):
            i += 1
        while i < len(w):
            while i < len(w) and not self._is_consonant(w, i):
                i += 1
            if i >= len(w):
                break
            n += 1
            while i < len(w) and self._is_consonant(w, i):
                i += 1
        return n

    def _has_vowel(self, w):
        return any(not self._is_consonant(w, i) for i in range(len(w)))

    def _cvc(self, w):
        if len(w) < 3:
            return False
        return (self._is_consonant(w, len(w) - 1) and
                not self._is_consonant(w, len(w) - 2) and
                self._is_consonant(w, len(w) - 3) and
                w[-1] not in "wxy")


ps = PorterStemmer()


# ─── Token F1 Scoring (matching LoCoMo evaluation.py exactly) ────────────────

def normalize_answer(s):
    """Lower, remove articles, remove punctuation, whitespace fix."""
    s = str(s).replace(",", "")

    def remove_articles(text):
        return re.sub(r'\b(a|an|the|and)\b', ' ', text)

    def white_space_fix(text):
        return ' '.join(text.split())

    def remove_punc(text):
        exclude = set(string.punctuation)
        return ''.join(ch for ch in text if ch not in exclude)

    def lower(text):
        return text.lower()

    return white_space_fix(remove_articles(remove_punc(lower(s))))


def f1_score_single(prediction, ground_truth):
    """Token-level F1 with Porter stemming."""
    prediction_tokens = [ps.stem(w) for w in normalize_answer(prediction).split()]
    ground_truth_tokens = [ps.stem(w) for w in normalize_answer(ground_truth).split()]

    common = Counter(prediction_tokens) & Counter(ground_truth_tokens)
    num_same = sum(common.values())

    if num_same == 0:
        return 0.0

    precision = num_same / len(prediction_tokens)
    recall = num_same / len(ground_truth_tokens)
    f1 = (2 * precision * recall) / (precision + recall)
    return f1


def f1_score_multi(prediction, ground_truth):
    """Multi-hop: split answers by comma, compute mean of per-sub-answer max F1."""
    predictions = [p.strip() for p in prediction.split(",")]
    ground_truths = [g.strip() for g in ground_truth.split(",")]

    scores = []
    for gt in ground_truths:
        best = max(f1_score_single(pred, gt) for pred in predictions)
        scores.append(best)

    return sum(scores) / len(scores) if scores else 0.0


def score_f1(prediction, category):
    """Score a single prediction using token F1 for its category."""
    hypothesis = prediction.get("hypothesis", "")
    answer = str(prediction.get("answer", ""))

    if category == 5:  # adversarial
        hyp_lower = hypothesis.lower()
        if "no information available" in hyp_lower or "not mentioned" in hyp_lower:
            return 1.0
        return 0.0

    if category == 1:  # multi-hop
        return f1_score_multi(hypothesis, answer)

    # categories 2, 3, 4: temporal, open-domain, single-hop
    return f1_score_single(hypothesis, answer)


# ─── LLM-as-Judge Scoring ────────────────────────────────────────────────────

JUDGE_PROMPT = """You are a strict answer judge. Compare the model's prediction to the ground truth answer for the given question.

Question: {question}
Ground Truth Answer: {answer}
Model Prediction: {hypothesis}

Judge whether the prediction is correct. The prediction is correct if:
- It conveys the same essential information as the ground truth
- Minor wording differences are acceptable
- It must not be factually wrong or contain made-up information
- For dates/times, the specific value must match
- For names, the name must be correct
- "No information available" is only correct if the ground truth also indicates the information is unavailable

Respond with ONLY a JSON object: {{"verdict": "correct"}} or {{"verdict": "wrong"}}"""

JUDGE_PROMPT_ADVERSARIAL = """You are a strict answer judge for adversarial questions. These questions ask about events or facts that do NOT exist in the conversation.

Question: {question}
Ground Truth: The correct response should indicate this information is not available or the event didn't happen.
Model Prediction: {hypothesis}

The prediction is correct if the model correctly identifies that the information is not available, the event didn't happen, or refuses to answer. It is wrong if the model hallucinates an answer.

Respond with ONLY a JSON object: {{"verdict": "correct"}} or {{"verdict": "wrong"}}"""


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
                print(f"  [judge rate-limit] 429, waiting {retry_after}s...")
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


def judge_prediction(prediction, judge_url, judge_model, api_key=None):
    """Call LLM judge to score a single prediction. Returns 1.0 (correct) or 0.0 (wrong)."""
    category = prediction.get("category", 0)
    hypothesis = prediction.get("hypothesis", "")
    answer = str(prediction.get("answer", ""))
    question = prediction.get("question", "")

    if not hypothesis.strip():
        return 0.0

    if category == 5:
        prompt = JUDGE_PROMPT_ADVERSARIAL.format(
            question=question, hypothesis=hypothesis
        )
    else:
        prompt = JUDGE_PROMPT.format(
            question=question, answer=answer, hypothesis=hypothesis
        )

    url = f"{judge_url}/chat/completions"
    payload = {
        "model": judge_model,
        "messages": [
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.0,
        "max_tokens": 50,
    }
    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    try:
        result = api_call(url, payload, headers=headers, timeout=30)
        choices = result.get("choices", [])
        if choices:
            content = choices[0].get("message", {}).get("content", "").strip().lower()
            # Parse JSON verdict
            try:
                verdict_obj = json.loads(content)
                return 1.0 if verdict_obj.get("verdict") == "correct" else 0.0
            except json.JSONDecodeError:
                # Fallback: check for keywords
                if "correct" in content and "wrong" not in content.split("correct")[0]:
                    return 1.0
                return 0.0
    except Exception as e:
        print(f"  [judge] Error: {e}", file=sys.stderr)
        return 0.0


# ─── Comparison Baselines ────────────────────────────────────────

BASELINES_F1 = {
    "Mem0": {"single-hop": 0.387, "multi-hop": 0.286, "temporal": 0.489, "open-domain": 0.477, "overall": 0.40},
    "Zep": {"single-hop": 0.357, "multi-hop": 0.194, "temporal": 0.420, "open-domain": 0.496},
    "Memobase": {"single-hop": 0.463, "multi-hop": 0.229, "temporal": 0.642, "open-domain": 0.516},
    "Kumiho": {"single-hop": 0.462, "multi-hop": 0.355, "temporal": 0.533, "open-domain": 0.290, "overall": 0.565},
}

BASELINES_JUDGE = {
    "Mem0": {"overall": 0.669, "note": "gpt-4o-mini eval+judge (ECAI 2025 paper)"},
    "MemMachine v0.2": {"overall": 0.881, "note": "gpt-4o-mini eval+judge"},
    "MemMachine v0.2 (4.1)": {"overall": 0.912, "note": "gpt-4.1-mini eval+judge"},
    "Full-context": {"overall": 0.729, "note": "gpt-4o-mini (Mem0 ECAI 2025)"},
}

CATEGORY_MAP = {1: "multi-hop", 2: "temporal", 3: "open-domain", 4: "single-hop", 5: "adversarial"}


def main():
    parser = argparse.ArgumentParser(description="LoCoMo Benchmark - Score Phase")
    parser.add_argument("--predictions", default="/tmp/predictions.jsonl",
                        help="Path to predictions JSONL")
    parser.add_argument("--output", default=None,
                        help="Output results JSON path")
    parser.add_argument("--judge", action="store_true", default=True,
                        help="Run LLM-as-judge scoring (default: yes)")
    parser.add_argument("--no-judge", action="store_true",
                        help="Skip LLM-as-judge, token F1 only")
    parser.add_argument("--judge-model", default="gpt-5-mini",
                        help="Judge LLM model ID (default: gpt-5-mini)")
    parser.add_argument("--judge-url", default="http://127.0.0.1:4141/v1",
                        help="Judge LLM API base URL (default: copilot-local)")
    parser.add_argument("--judge-api-key", default=os.environ.get("OPENAI_API_KEY", ""),
                        help="Judge API key (optional for copilot-local)")
    parser.add_argument("--judge-delay", type=float, default=0.5,
                        help="Delay between judge calls in seconds (default: 0.5)")
    args = parser.parse_args()

    if args.no_judge:
        args.judge = False

    if args.output is None:
        today = date.today().isoformat()
        args.output = f"/tmp/locomo-hypermem-{today}.json"

    # Load predictions
    print(f"[score] Loading predictions: {args.predictions}")
    predictions = []
    run_meta = {}
    with open(args.predictions) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            if obj.get("_meta"):
                run_meta = obj
                continue
            predictions.append(obj)

    print(f"[score] Loaded {len(predictions)} predictions")
    if run_meta:
        print(f"[score] Eval-LLM: {run_meta.get('eval_model', 'unknown')}")
        print(f"[score] Provider: {run_meta.get('provider_url', 'unknown')}")

    eval_model = run_meta.get("eval_model", "unknown")

    # ── Token F1 Scoring ──
    print(f"\n[score] Computing token-overlap F1...")
    by_category_f1 = defaultdict(list)
    all_f1 = []

    for pred in predictions:
        category = pred["category"]
        category_name = CATEGORY_MAP.get(category, "unknown")
        f1 = score_f1(pred, category)

        pred["f1"] = f1
        by_category_f1[category_name].append(f1)
        all_f1.append(f1)

    category_f1_results = {}
    for cat_name in ["single-hop", "multi-hop", "temporal", "open-domain", "adversarial"]:
        scores = by_category_f1.get(cat_name, [])
        if scores:
            mean = sum(scores) / len(scores)
            category_f1_results[cat_name] = {
                "f1_mean": round(mean, 4),
                "count": len(scores),
            }

    overall_f1 = sum(all_f1) / len(all_f1) if all_f1 else 0.0

    # ── LLM Judge Scoring ──
    category_judge_results = {}
    overall_judge = None

    if args.judge:
        print(f"\n[score] Running LLM-as-judge scoring...")
        print(f"[score] Judge: {args.judge_model} via {args.judge_url}")
        print(f"[score] Pacing: {args.judge_delay}s between calls")

        by_category_judge = defaultdict(list)
        all_judge = []

        for i, pred in enumerate(predictions):
            category = pred["category"]
            category_name = CATEGORY_MAP.get(category, "unknown")

            verdict = judge_prediction(
                pred, args.judge_url, args.judge_model, args.judge_api_key
            )

            pred["judge_score"] = verdict
            by_category_judge[category_name].append(verdict)
            all_judge.append(verdict)

            # Progress
            if (i + 1) % 50 == 0 or (i + 1) == len(predictions):
                running_acc = sum(all_judge) / len(all_judge)
                print(f"[score] Judge: {i+1}/{len(predictions)} -- "
                      f"running accuracy: {running_acc:.4f}")

            time.sleep(args.judge_delay)

        for cat_name in ["single-hop", "multi-hop", "temporal", "open-domain", "adversarial"]:
            scores = by_category_judge.get(cat_name, [])
            if scores:
                mean = sum(scores) / len(scores)
                category_judge_results[cat_name] = {
                    "judge_accuracy": round(mean, 4),
                    "count": len(scores),
                }

        overall_judge = sum(all_judge) / len(all_judge) if all_judge else 0.0

    # ── Build Results ──
    results = {
        "benchmark": "LoCoMo",
        "system": "HyperMem",
        "date": date.today().isoformat(),
        "eval_model": eval_model,
        "judge_model": args.judge_model if args.judge else None,
        "retrieval_limit": run_meta.get("retrieval_limit", 10),
        "total_questions": len(predictions),
        "overall_f1": round(overall_f1, 4),
        "overall_judge_accuracy": round(overall_judge, 4) if overall_judge is not None else None,
        "per_category_f1": category_f1_results,
        "per_category_judge": category_judge_results if args.judge else None,
        "baselines_f1": BASELINES_F1,
        "baselines_judge": BASELINES_JUDGE if args.judge else None,
    }

    # ── Print Results ──
    print(f"\n{'='*70}")
    print(f"  LoCoMo Benchmark Results - HyperMem")
    print(f"{'='*70}")
    print(f"\n  Eval-LLM: {eval_model}")
    if args.judge:
        print(f"  Judge-LLM: {args.judge_model}")
    print(f"  Total questions: {len(predictions)}")

    # Token F1 table
    print(f"\n  Token-Overlap F1 (original LoCoMo paper metric)")
    print(f"  {'Category':<14} {'Count':>6} {'F1':>8}")
    print(f"  {'─'*30}")
    for cat in ["single-hop", "multi-hop", "temporal", "open-domain", "adversarial"]:
        if cat in category_f1_results:
            r = category_f1_results[cat]
            print(f"  {cat:<14} {r['count']:>6} {r['f1_mean']:>8.4f}")
    print(f"  {'─'*30}")
    print(f"  {'OVERALL':<14} {len(predictions):>6} {overall_f1:>8.4f}")

    # Judge table
    if args.judge and overall_judge is not None:
        print(f"\n  LLM-as-Judge Accuracy (Mem0/MemMachine-comparable)")
        print(f"  {'Category':<14} {'Count':>6} {'Acc':>8}")
        print(f"  {'─'*30}")
        for cat in ["single-hop", "multi-hop", "temporal", "open-domain", "adversarial"]:
            if cat in category_judge_results:
                r = category_judge_results[cat]
                print(f"  {cat:<14} {r['count']:>6} {r['judge_accuracy']:>8.4f}")
        print(f"  {'─'*30}")
        print(f"  {'OVERALL':<14} {len(predictions):>6} {overall_judge:>8.4f}")

    # Comparison: F1 baselines
    print(f"\n{'='*70}")
    print(f"  F1 Comparison with Published Baselines")
    print(f"{'='*70}")
    header = f"  {'System':<16}"
    for cat in ["single-hop", "multi-hop", "temporal", "open-domain", "overall"]:
        header += f" {cat:>12}"
    print(header)
    print(f"  {'─'*80}")

    # HyperMem row
    row = f"  {'HyperMem':<16}"
    for cat in ["single-hop", "multi-hop", "temporal", "open-domain"]:
        val = category_f1_results.get(cat, {}).get("f1_mean", 0)
        row += f" {val:>12.3f}"
    row += f" {overall_f1:>12.3f}"
    print(row)

    for name, baseline in BASELINES_F1.items():
        row = f"  {name:<16}"
        for cat in ["single-hop", "multi-hop", "temporal", "open-domain", "overall"]:
            val = baseline.get(cat, None)
            if val is not None:
                row += f" {val:>12.3f}"
            else:
                row += f" {'-':>12}"
        print(row)

    # Comparison: Judge baselines
    if args.judge and overall_judge is not None:
        print(f"\n{'='*70}")
        print(f"  LLM-Judge Comparison (published use gpt-4o-mini)")
        print(f"{'='*70}")
        print(f"  {'System':<30} {'Score':>8}  {'Note'}")
        print(f"  {'─'*70}")
        print(f"  {'HyperMem':<30} {overall_judge:>8.4f}  {eval_model} eval, {args.judge_model} judge")
        for name, bl in BASELINES_JUDGE.items():
            print(f"  {name:<30} {bl['overall']:>8.4f}  {bl.get('note', '')}")
        print(f"\n  NOTE: Direct comparison requires same eval-LLM and judge-LLM.")
        print(f"  Published baselines use gpt-4o-mini. Our results use {eval_model}/{args.judge_model}.")

    # Save results
    with open(args.output, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\n[score] Results saved to: {args.output}")

    # Also save scored predictions
    scored_path = args.predictions.replace(".jsonl", "-scored.jsonl")
    with open(scored_path, "w") as f:
        for pred in predictions:
            f.write(json.dumps(pred) + "\n")
    print(f"[score] Scored predictions saved to: {scored_path}")

if __name__ == "__main__":
    main()
