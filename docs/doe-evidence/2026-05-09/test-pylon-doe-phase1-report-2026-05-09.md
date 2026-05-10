<!-- markdownlint-disable MD013 MD060 MD012 -->

# Test-Hank DOE phase 1 report - 2026-05-09

Sixteen sequential stratified-50 DOE screening cells completed against HyperMem `d51ee2f`. This was a screening round only; no code changes were made.

## 1. Run metadata

| Cell | Run id | HyperMem | EasyLoCoMo | Dataset SHA | Bridge data dir | JSON config override |
|---|---|---|---|---|---|---|
| `c01` | `test-hank-doe-phase1-c01-20260509-0858` | `d51ee2f0` | `f632f6e5` | `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4` | `/tmp/hypermem-bench-doe-phase1-c01` | `{"queryMessageRecall":{"multiHopMaxTokens":5200,"multiHopHitLimit":32,"multiHopNeighborWindow":4,"multiHopLineCharLimit":520,"multiHopFtsNaturalTermLimit":24,"multiHopFtsSpecificTermLimit":16,"multiHopRareFacetFanoutLimit":6,"multiHopSameConversationDirectFirst":false}}` |
| `c02` | `test-hank-doe-phase1-c02-20260509-0900` | `d51ee2f0` | `f632f6e5` | `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4` | `/tmp/hypermem-bench-doe-phase1-c02` | `{"queryMessageRecall":{"multiHopMaxTokens":5200,"multiHopHitLimit":32,"multiHopNeighborWindow":4,"multiHopLineCharLimit":920,"multiHopFtsNaturalTermLimit":24,"multiHopFtsSpecificTermLimit":36,"multiHopRareFacetFanoutLimit":18,"multiHopSameConversationDirectFirst":true}}` |
| `c03` | `test-hank-doe-phase1-c03-20260509-0902` | `d51ee2f0` | `f632f6e5` | `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4` | `/tmp/hypermem-bench-doe-phase1-c03` | `{"queryMessageRecall":{"multiHopMaxTokens":5200,"multiHopHitLimit":32,"multiHopNeighborWindow":8,"multiHopLineCharLimit":520,"multiHopFtsNaturalTermLimit":48,"multiHopFtsSpecificTermLimit":36,"multiHopRareFacetFanoutLimit":18,"multiHopSameConversationDirectFirst":false}}` |
| `c04` | `test-hank-doe-phase1-c04-20260509-0904` | `d51ee2f0` | `f632f6e5` | `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4` | `/tmp/hypermem-bench-doe-phase1-c04` | `{"queryMessageRecall":{"multiHopMaxTokens":5200,"multiHopHitLimit":32,"multiHopNeighborWindow":8,"multiHopLineCharLimit":920,"multiHopFtsNaturalTermLimit":48,"multiHopFtsSpecificTermLimit":16,"multiHopRareFacetFanoutLimit":6,"multiHopSameConversationDirectFirst":true}}` |
| `c05` | `test-hank-doe-phase1-c05-20260509-0907` | `d51ee2f0` | `f632f6e5` | `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4` | `/tmp/hypermem-bench-doe-phase1-c05` | `{"queryMessageRecall":{"multiHopMaxTokens":5200,"multiHopHitLimit":60,"multiHopNeighborWindow":4,"multiHopLineCharLimit":520,"multiHopFtsNaturalTermLimit":48,"multiHopFtsSpecificTermLimit":36,"multiHopRareFacetFanoutLimit":6,"multiHopSameConversationDirectFirst":true}}` |
| `c06` | `test-hank-doe-phase1-c06-20260509-0909` | `d51ee2f0` | `f632f6e5` | `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4` | `/tmp/hypermem-bench-doe-phase1-c06` | `{"queryMessageRecall":{"multiHopMaxTokens":5200,"multiHopHitLimit":60,"multiHopNeighborWindow":4,"multiHopLineCharLimit":920,"multiHopFtsNaturalTermLimit":48,"multiHopFtsSpecificTermLimit":16,"multiHopRareFacetFanoutLimit":18,"multiHopSameConversationDirectFirst":false}}` |
| `c07` | `test-hank-doe-phase1-c07-20260509-0911` | `d51ee2f0` | `f632f6e5` | `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4` | `/tmp/hypermem-bench-doe-phase1-c07` | `{"queryMessageRecall":{"multiHopMaxTokens":5200,"multiHopHitLimit":60,"multiHopNeighborWindow":8,"multiHopLineCharLimit":520,"multiHopFtsNaturalTermLimit":24,"multiHopFtsSpecificTermLimit":16,"multiHopRareFacetFanoutLimit":18,"multiHopSameConversationDirectFirst":true}}` |
| `c08` | `test-hank-doe-phase1-c08-20260509-0913` | `d51ee2f0` | `f632f6e5` | `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4` | `/tmp/hypermem-bench-doe-phase1-c08` | `{"queryMessageRecall":{"multiHopMaxTokens":5200,"multiHopHitLimit":60,"multiHopNeighborWindow":8,"multiHopLineCharLimit":920,"multiHopFtsNaturalTermLimit":24,"multiHopFtsSpecificTermLimit":36,"multiHopRareFacetFanoutLimit":6,"multiHopSameConversationDirectFirst":false}}` |
| `c09` | `test-hank-doe-phase1-c09-20260509-0915` | `d51ee2f0` | `f632f6e5` | `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4` | `/tmp/hypermem-bench-doe-phase1-c09` | `{"queryMessageRecall":{"multiHopMaxTokens":7800,"multiHopHitLimit":32,"multiHopNeighborWindow":4,"multiHopLineCharLimit":520,"multiHopFtsNaturalTermLimit":48,"multiHopFtsSpecificTermLimit":16,"multiHopRareFacetFanoutLimit":18,"multiHopSameConversationDirectFirst":true}}` |
| `c10` | `test-hank-doe-phase1-c10-20260509-0917` | `d51ee2f0` | `f632f6e5` | `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4` | `/tmp/hypermem-bench-doe-phase1-c10` | `{"queryMessageRecall":{"multiHopMaxTokens":7800,"multiHopHitLimit":32,"multiHopNeighborWindow":4,"multiHopLineCharLimit":920,"multiHopFtsNaturalTermLimit":48,"multiHopFtsSpecificTermLimit":36,"multiHopRareFacetFanoutLimit":6,"multiHopSameConversationDirectFirst":false}}` |
| `c11` | `test-hank-doe-phase1-c11-20260509-0919` | `d51ee2f0` | `f632f6e5` | `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4` | `/tmp/hypermem-bench-doe-phase1-c11` | `{"queryMessageRecall":{"multiHopMaxTokens":7800,"multiHopHitLimit":32,"multiHopNeighborWindow":8,"multiHopLineCharLimit":520,"multiHopFtsNaturalTermLimit":24,"multiHopFtsSpecificTermLimit":36,"multiHopRareFacetFanoutLimit":6,"multiHopSameConversationDirectFirst":true}}` |
| `c12` | `test-hank-doe-phase1-c12-20260509-0920` | `d51ee2f0` | `f632f6e5` | `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4` | `/tmp/hypermem-bench-doe-phase1-c12` | `{"queryMessageRecall":{"multiHopMaxTokens":7800,"multiHopHitLimit":32,"multiHopNeighborWindow":8,"multiHopLineCharLimit":920,"multiHopFtsNaturalTermLimit":24,"multiHopFtsSpecificTermLimit":16,"multiHopRareFacetFanoutLimit":18,"multiHopSameConversationDirectFirst":false}}` |
| `c13` | `test-hank-doe-phase1-c13-20260509-0922` | `d51ee2f0` | `f632f6e5` | `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4` | `/tmp/hypermem-bench-doe-phase1-c13` | `{"queryMessageRecall":{"multiHopMaxTokens":7800,"multiHopHitLimit":60,"multiHopNeighborWindow":4,"multiHopLineCharLimit":520,"multiHopFtsNaturalTermLimit":24,"multiHopFtsSpecificTermLimit":36,"multiHopRareFacetFanoutLimit":18,"multiHopSameConversationDirectFirst":false}}` |
| `c14` | `test-hank-doe-phase1-c14-20260509-0924` | `d51ee2f0` | `f632f6e5` | `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4` | `/tmp/hypermem-bench-doe-phase1-c14` | `{"queryMessageRecall":{"multiHopMaxTokens":7800,"multiHopHitLimit":60,"multiHopNeighborWindow":4,"multiHopLineCharLimit":920,"multiHopFtsNaturalTermLimit":24,"multiHopFtsSpecificTermLimit":16,"multiHopRareFacetFanoutLimit":6,"multiHopSameConversationDirectFirst":true}}` |
| `c15` | `test-hank-doe-phase1-c15-20260509-0926` | `d51ee2f0` | `f632f6e5` | `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4` | `/tmp/hypermem-bench-doe-phase1-c15` | `{"queryMessageRecall":{"multiHopMaxTokens":7800,"multiHopHitLimit":60,"multiHopNeighborWindow":8,"multiHopLineCharLimit":520,"multiHopFtsNaturalTermLimit":48,"multiHopFtsSpecificTermLimit":16,"multiHopRareFacetFanoutLimit":6,"multiHopSameConversationDirectFirst":false}}` |
| `c16` | `test-hank-doe-phase1-c16-20260509-0928` | `d51ee2f0` | `f632f6e5` | `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4` | `/tmp/hypermem-bench-doe-phase1-c16` | `{"queryMessageRecall":{"multiHopMaxTokens":7800,"multiHopHitLimit":60,"multiHopNeighborWindow":8,"multiHopLineCharLimit":920,"multiHopFtsNaturalTermLimit":48,"multiHopFtsSpecificTermLimit":36,"multiHopRareFacetFanoutLimit":18,"multiHopSameConversationDirectFirst":true}}` |

## 2. Matrix table

| Cell | A | B | C | D | E | F | G | H | Concrete values |
|---|---|---|---|---|---|---|---|---|---|
| `c01` | - | - | - | - | - | - | - | - | `multiHopMaxTokens=5200, multiHopHitLimit=32, multiHopNeighborWindow=4, multiHopLineCharLimit=520, multiHopFtsNaturalTermLimit=24, multiHopFtsSpecificTermLimit=16, multiHopRareFacetFanoutLimit=6, multiHopSameConversationDirectFirst=false` |
| `c02` | - | - | - | + | - | + | + | + | `multiHopMaxTokens=5200, multiHopHitLimit=32, multiHopNeighborWindow=4, multiHopLineCharLimit=920, multiHopFtsNaturalTermLimit=24, multiHopFtsSpecificTermLimit=36, multiHopRareFacetFanoutLimit=18, multiHopSameConversationDirectFirst=true` |
| `c03` | - | - | + | - | + | + | + | - | `multiHopMaxTokens=5200, multiHopHitLimit=32, multiHopNeighborWindow=8, multiHopLineCharLimit=520, multiHopFtsNaturalTermLimit=48, multiHopFtsSpecificTermLimit=36, multiHopRareFacetFanoutLimit=18, multiHopSameConversationDirectFirst=false` |
| `c04` | - | - | + | + | + | - | - | + | `multiHopMaxTokens=5200, multiHopHitLimit=32, multiHopNeighborWindow=8, multiHopLineCharLimit=920, multiHopFtsNaturalTermLimit=48, multiHopFtsSpecificTermLimit=16, multiHopRareFacetFanoutLimit=6, multiHopSameConversationDirectFirst=true` |
| `c05` | - | + | - | - | + | + | - | + | `multiHopMaxTokens=5200, multiHopHitLimit=60, multiHopNeighborWindow=4, multiHopLineCharLimit=520, multiHopFtsNaturalTermLimit=48, multiHopFtsSpecificTermLimit=36, multiHopRareFacetFanoutLimit=6, multiHopSameConversationDirectFirst=true` |
| `c06` | - | + | - | + | + | - | + | - | `multiHopMaxTokens=5200, multiHopHitLimit=60, multiHopNeighborWindow=4, multiHopLineCharLimit=920, multiHopFtsNaturalTermLimit=48, multiHopFtsSpecificTermLimit=16, multiHopRareFacetFanoutLimit=18, multiHopSameConversationDirectFirst=false` |
| `c07` | - | + | + | - | - | - | + | + | `multiHopMaxTokens=5200, multiHopHitLimit=60, multiHopNeighborWindow=8, multiHopLineCharLimit=520, multiHopFtsNaturalTermLimit=24, multiHopFtsSpecificTermLimit=16, multiHopRareFacetFanoutLimit=18, multiHopSameConversationDirectFirst=true` |
| `c08` | - | + | + | + | - | + | - | - | `multiHopMaxTokens=5200, multiHopHitLimit=60, multiHopNeighborWindow=8, multiHopLineCharLimit=920, multiHopFtsNaturalTermLimit=24, multiHopFtsSpecificTermLimit=36, multiHopRareFacetFanoutLimit=6, multiHopSameConversationDirectFirst=false` |
| `c09` | + | - | - | - | + | - | + | + | `multiHopMaxTokens=7800, multiHopHitLimit=32, multiHopNeighborWindow=4, multiHopLineCharLimit=520, multiHopFtsNaturalTermLimit=48, multiHopFtsSpecificTermLimit=16, multiHopRareFacetFanoutLimit=18, multiHopSameConversationDirectFirst=true` |
| `c10` | + | - | - | + | + | + | - | - | `multiHopMaxTokens=7800, multiHopHitLimit=32, multiHopNeighborWindow=4, multiHopLineCharLimit=920, multiHopFtsNaturalTermLimit=48, multiHopFtsSpecificTermLimit=36, multiHopRareFacetFanoutLimit=6, multiHopSameConversationDirectFirst=false` |
| `c11` | + | - | + | - | - | + | - | + | `multiHopMaxTokens=7800, multiHopHitLimit=32, multiHopNeighborWindow=8, multiHopLineCharLimit=520, multiHopFtsNaturalTermLimit=24, multiHopFtsSpecificTermLimit=36, multiHopRareFacetFanoutLimit=6, multiHopSameConversationDirectFirst=true` |
| `c12` | + | - | + | + | - | - | + | - | `multiHopMaxTokens=7800, multiHopHitLimit=32, multiHopNeighborWindow=8, multiHopLineCharLimit=920, multiHopFtsNaturalTermLimit=24, multiHopFtsSpecificTermLimit=16, multiHopRareFacetFanoutLimit=18, multiHopSameConversationDirectFirst=false` |
| `c13` | + | + | - | - | - | + | + | - | `multiHopMaxTokens=7800, multiHopHitLimit=60, multiHopNeighborWindow=4, multiHopLineCharLimit=520, multiHopFtsNaturalTermLimit=24, multiHopFtsSpecificTermLimit=36, multiHopRareFacetFanoutLimit=18, multiHopSameConversationDirectFirst=false` |
| `c14` | + | + | - | + | - | - | - | + | `multiHopMaxTokens=7800, multiHopHitLimit=60, multiHopNeighborWindow=4, multiHopLineCharLimit=920, multiHopFtsNaturalTermLimit=24, multiHopFtsSpecificTermLimit=16, multiHopRareFacetFanoutLimit=6, multiHopSameConversationDirectFirst=true` |
| `c15` | + | + | + | - | + | - | - | - | `multiHopMaxTokens=7800, multiHopHitLimit=60, multiHopNeighborWindow=8, multiHopLineCharLimit=520, multiHopFtsNaturalTermLimit=48, multiHopFtsSpecificTermLimit=16, multiHopRareFacetFanoutLimit=6, multiHopSameConversationDirectFirst=false` |
| `c16` | + | + | + | + | + | + | + | + | `multiHopMaxTokens=7800, multiHopHitLimit=60, multiHopNeighborWindow=8, multiHopLineCharLimit=920, multiHopFtsNaturalTermLimit=48, multiHopFtsSpecificTermLimit=36, multiHopRareFacetFanoutLimit=18, multiHopSameConversationDirectFirst=true` |

## 3. Gate metrics per cell

| Cell | Overall raw F1 | Multi-hop raw F1 | Temporal raw F1 | Open-domain raw F1 | mh_complete | od_any | Multi-hop allSelectedRate |
|---|---:|---:|---:|---:|---:|---:|---:|
| `c01` | 0.55 | 0.5932 | 0.7013 | 0.35 | 2 | 5 | 0.2857 |
| `c02` | 0.5554 | 0.5798 | 0.7013 | 0.35 | 2 | 5 | 0.2857 |
| `c03` | 0.5647 | 0.6265 | 0.7013 | 0.35 | 2 | 5 | 0.2857 |
| `c04` | 0.5561 | 0.5837 | 0.7013 | 0.35 | 2 | 5 | 0.2857 |
| `c05` | 0.5486 | 0.556 | 0.6946 | 0.35 | 2 | 5 | 0.2857 |
| `c06` | 0.5414 | 0.6599 | 0.6279 | 0.35 | 2 | 5 | 0.2857 |
| `c07` | 0.5394 | 0.5398 | 0.7013 | 0.35 | 2 | 5 | 0.2857 |
| `c08` | 0.5544 | 0.6349 | 0.7013 | 0.35 | 2 | 5 | 0.2857 |
| `c09` | 0.5526 | 0.5725 | 0.6902 | 0.35 | 2 | 5 | 0.2857 |
| `c10` | 0.5626 | 0.6059 | 0.7013 | 0.35 | 2 | 5 | 0.2857 |
| `c11` | 0.5583 | 0.5798 | 0.7044 | 0.35 | 3 | 5 | 0.4286 |
| `c12` | 0.5579 | 0.5827 | 0.7013 | 0.35 | 3 | 5 | 0.4286 |
| `c13` | 0.5619 | 0.6027 | 0.7013 | 0.35 | 2 | 5 | 0.2857 |
| `c14` | 0.5522 | 0.5494 | 0.7044 | 0.35 | 2 | 5 | 0.2857 |
| `c15` | 0.5453 | 0.5694 | 0.7013 | 0.35 | 3 | 5 | 0.4286 |
| `c16` | 0.5557 | 0.5465 | 0.6844 | 0.35 | 3 | 5 | 0.4286 |

## 4. Guardrail verdict per cell

Guardrail order: `mh_complete >= 3`, `multi-hop rawF1 >= 0.6193`, `temporalRawF1 >= 0.6804`, `open-domain rawF1 >= 0.2752`, `od_any >= 5`.

| Cell | Pass count | Verdicts |
|---|---:|---|
| `c01` | 3/5 | `FAIL/FAIL/PASS/PASS/PASS` |
| `c02` | 3/5 | `FAIL/FAIL/PASS/PASS/PASS` |
| `c03` | 4/5 | `FAIL/PASS/PASS/PASS/PASS` |
| `c04` | 3/5 | `FAIL/FAIL/PASS/PASS/PASS` |
| `c05` | 3/5 | `FAIL/FAIL/PASS/PASS/PASS` |
| `c06` | 3/5 | `FAIL/PASS/FAIL/PASS/PASS` |
| `c07` | 3/5 | `FAIL/FAIL/PASS/PASS/PASS` |
| `c08` | 4/5 | `FAIL/PASS/PASS/PASS/PASS` |
| `c09` | 3/5 | `FAIL/FAIL/PASS/PASS/PASS` |
| `c10` | 3/5 | `FAIL/FAIL/PASS/PASS/PASS` |
| `c11` | 4/5 | `PASS/FAIL/PASS/PASS/PASS` |
| `c12` | 4/5 | `PASS/FAIL/PASS/PASS/PASS` |
| `c13` | 3/5 | `FAIL/FAIL/PASS/PASS/PASS` |
| `c14` | 3/5 | `FAIL/FAIL/PASS/PASS/PASS` |
| `c15` | 4/5 | `PASS/FAIL/PASS/PASS/PASS` |
| `c16` | 4/5 | `PASS/FAIL/PASS/PASS/PASS` |

## 5. Ranked cells

| Rank | Cell | Pass count | mh_complete | Multi-hop raw F1 | Temporal raw F1 | Open-domain raw F1 | od_any |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | `c12` | 4/5 | 3 | 0.5827 | 0.7013 | 0.35 | 5 |
| 2 | `c11` | 4/5 | 3 | 0.5798 | 0.7044 | 0.35 | 5 |
| 3 | `c15` | 4/5 | 3 | 0.5694 | 0.7013 | 0.35 | 5 |
| 4 | `c16` | 4/5 | 3 | 0.5465 | 0.6844 | 0.35 | 5 |
| 5 | `c08` | 4/5 | 2 | 0.6349 | 0.7013 | 0.35 | 5 |
| 6 | `c03` | 4/5 | 2 | 0.6265 | 0.7013 | 0.35 | 5 |
| 7 | `c06` | 3/5 | 2 | 0.6599 | 0.6279 | 0.35 | 5 |
| 8 | `c10` | 3/5 | 2 | 0.6059 | 0.7013 | 0.35 | 5 |
| 9 | `c13` | 3/5 | 2 | 0.6027 | 0.7013 | 0.35 | 5 |
| 10 | `c01` | 3/5 | 2 | 0.5932 | 0.7013 | 0.35 | 5 |
| 11 | `c04` | 3/5 | 2 | 0.5837 | 0.7013 | 0.35 | 5 |
| 12 | `c02` | 3/5 | 2 | 0.5798 | 0.7013 | 0.35 | 5 |
| 13 | `c09` | 3/5 | 2 | 0.5725 | 0.6902 | 0.35 | 5 |
| 14 | `c05` | 3/5 | 2 | 0.556 | 0.6946 | 0.35 | 5 |
| 15 | `c14` | 3/5 | 2 | 0.5494 | 0.7044 | 0.35 | 5 |
| 16 | `c07` | 3/5 | 2 | 0.5398 | 0.7013 | 0.35 | 5 |

## 6. Main-effects estimate table

Effects are high-level mean minus low-level mean. Positive means the high setting increased the metric in this 16-cell screen.

| Factor | Field | mh_complete | Multi-hop raw F1 | Temporal raw F1 | Open-domain raw F1 | od_any |
|---|---|---:|---:|---:|---:|---:|
| A | `multiHopMaxTokens` | 0.5 | -0.0206 | 0.0073 | 0 | 0 |
| B | `multiHopHitLimit` | 0 | -0.0082 | -0.0107 | 0 | 0 |
| C | `multiHopNeighborWindow` | 0.5 | -0.007 | 0.0093 | 0 | 0 |
| D | `multiHopLineCharLimit` | 0 | 0.0129 | -0.0091 | 0 | 0 |
| E | `multiHopFtsNaturalTermLimit` | 0 | 0.0073 | -0.0143 | 0 | 0 |
| F | `multiHopFtsSpecificTermLimit` | 0 | 0.0102 | 0.0076 | 0 | 0 |
| G | `multiHopRareFacetFanoutLimit` | 0 | 0.0048 | -0.0126 | 0 | 0 |
| H | `multiHopSameConversationDirectFirst` | 0 | -0.046 | 0.0056 | 0 | 0 |

## 7. Recommendation

No cell cleared all five guardrails. Best replicate candidates by screening rank are `c12`, `c11`, `c15`; use them only for confirmation, not release.

Most harmful-looking factor directions by combined mh_complete plus multi-hop rawF1 effect: H high (multiHopSameConversationDirectFirst), B high (multiHopHitLimit), G high (multiHopRareFacetFanoutLimit).

Top recommendation details:

- `c12`: pass 4/5, mh_complete 3, multi-hop rawF1 0.5827, temporal rawF1 0.7013, open-domain rawF1 0.35, od_any 5.
- `c11`: pass 4/5, mh_complete 3, multi-hop rawF1 0.5798, temporal rawF1 0.7044, open-domain rawF1 0.35, od_any 5.
- `c15`: pass 4/5, mh_complete 3, multi-hop rawF1 0.5694, temporal rawF1 0.7013, open-domain rawF1 0.35, od_any 5.

## Artifact list

- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c01-20260509-0858.json`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c01-20260509-0858.md`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c02-20260509-0900.json`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c02-20260509-0900.md`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c03-20260509-0902.json`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c03-20260509-0902.md`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c04-20260509-0904.json`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c04-20260509-0904.md`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c05-20260509-0907.json`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c05-20260509-0907.md`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c06-20260509-0909.json`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c06-20260509-0909.md`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c07-20260509-0911.json`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c07-20260509-0911.md`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c08-20260509-0913.json`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c08-20260509-0913.md`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c09-20260509-0915.json`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c09-20260509-0915.md`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c10-20260509-0917.json`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c10-20260509-0917.md`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c11-20260509-0919.json`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c11-20260509-0919.md`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c12-20260509-0920.json`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c12-20260509-0920.md`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c13-20260509-0922.json`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c13-20260509-0922.md`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c14-20260509-0924.json`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c14-20260509-0924.md`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c15-20260509-0926.json`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c15-20260509-0926.md`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c16-20260509-0928.json`
- `docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-c16-20260509-0928.md`
