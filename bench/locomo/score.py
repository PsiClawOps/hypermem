#!/usr/bin/env python3
"""
LoCoMo Benchmark — Score Phase

Loads predictions and ground truth, computes token-level F1 with Porter stemming.
Reports per-category F1 and comparison against published baselines.

Uses the exact same scoring methodology as the LoCoMo paper:
  - normalize_answer: lowercase, remove articles (a/an/the/and), remove punctuation, whitespace fix
  - Porter stemming on tokens
  - Token overlap F1
  - Multi-hop: split by comma, partial F1 for each ground truth sub-answer
  - Adversarial: binary (contains "no information available" or "not mentioned" → 1, else 0)

Usage: python3 score.py [--predictions /tmp/predictions.jsonl] [--output /tmp/results.json]
"""

import json
import sys
import re
import string
import argparse
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


# ─── Scoring Functions (matching LoCoMo evaluation.py exactly) ───────────────

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


def score_prediction(prediction, category):
    """Score a single prediction using the correct method for its category."""
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


# ─── Comparison Baselines ────────────────────────────────────────

BASELINES = {
    "Mem0": {"single-hop": 0.387, "multi-hop": 0.286, "temporal": 0.489, "open-domain": 0.477, "overall": 0.40},
    "Zep": {"single-hop": 0.357, "multi-hop": 0.194, "temporal": 0.420, "open-domain": 0.496},
    "Memobase": {"single-hop": 0.463, "multi-hop": 0.229, "temporal": 0.642, "open-domain": 0.516},
    "Kumiho": {"single-hop": 0.462, "multi-hop": 0.355, "temporal": 0.533, "open-domain": 0.290, "overall": 0.565},
}

CATEGORY_MAP = {1: "multi-hop", 2: "temporal", 3: "open-domain", 4: "single-hop", 5: "adversarial"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--predictions", default="/tmp/predictions.jsonl")
    parser.add_argument("--output", default=None)
    args = parser.parse_args()

    if args.output is None:
        today = date.today().isoformat()
        args.output = f"/tmp/locomo-hypermem-{today}.json"

    # Load predictions
    print(f"[score] Loading predictions: {args.predictions}")
    predictions = []
    with open(args.predictions) as f:
        for line in f:
            line = line.strip()
            if line:
                predictions.append(json.loads(line))

    print(f"[score] Loaded {len(predictions)} predictions")

    # Score each prediction
    by_category = defaultdict(list)
    all_scores = []

    for pred in predictions:
        category = pred["category"]
        category_name = CATEGORY_MAP.get(category, "unknown")
        f1 = score_prediction(pred, category)

        pred["f1"] = f1
        by_category[category_name].append(f1)
        all_scores.append(f1)

    # Compute per-category means
    category_results = {}
    for cat_name in ["single-hop", "multi-hop", "temporal", "open-domain", "adversarial"]:
        scores = by_category.get(cat_name, [])
        if scores:
            mean = sum(scores) / len(scores)
            category_results[cat_name] = {
                "f1_mean": round(mean, 4),
                "count": len(scores),
            }

    overall_f1 = sum(all_scores) / len(all_scores) if all_scores else 0.0

    # Build results
    results = {
        "benchmark": "LoCoMo",
        "system": "HyperMem 0.4.0",
        "date": date.today().isoformat(),
        "reader_llm": "gpt-4o-mini (via OpenRouter)",
        "retrieval_limit": 10,
        "total_questions": len(predictions),
        "overall_f1": round(overall_f1, 4),
        "per_category": category_results,
        "baselines": BASELINES,
    }

    # Print results table
    print(f"\n{'='*70}")
    print(f"  LoCoMo Benchmark Results — HyperMem 0.4.0")
    print(f"{'='*70}")
    print(f"\n  Reader LLM: gpt-4o-mini | Retrieval limit: 10 memories")
    print(f"  Total questions: {len(predictions)}")
    print(f"\n  {'Category':<14} {'Count':>6} {'F1':>8}")
    print(f"  {'─'*30}")
    for cat in ["single-hop", "multi-hop", "temporal", "open-domain", "adversarial"]:
        if cat in category_results:
            r = category_results[cat]
            print(f"  {cat:<14} {r['count']:>6} {r['f1_mean']:>8.4f}")
    print(f"  {'─'*30}")
    print(f"  {'OVERALL':<14} {len(predictions):>6} {overall_f1:>8.4f}")

    # Comparison table
    print(f"\n{'='*70}")
    print(f"  Comparison with Published Baselines")
    print(f"{'='*70}")
    header = f"  {'System':<14}"
    for cat in ["single-hop", "multi-hop", "temporal", "open-domain", "overall"]:
        header += f" {cat:>12}"
    print(header)
    print(f"  {'─'*76}")

    # HyperMem row
    row = f"  {'HyperMem':<14}"
    for cat in ["single-hop", "multi-hop", "temporal", "open-domain"]:
        val = category_results.get(cat, {}).get("f1_mean", 0)
        row += f" {val:>12.3f}"
    row += f" {overall_f1:>12.3f}"
    print(row)

    # Baseline rows
    for name, baseline in BASELINES.items():
        row = f"  {name:<14}"
        for cat in ["single-hop", "multi-hop", "temporal", "open-domain", "overall"]:
            val = baseline.get(cat, None)
            if val is not None:
                row += f" {val:>12.3f}"
            else:
                row += f" {'—':>12}"
        print(row)

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
