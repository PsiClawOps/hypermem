<!-- markdownlint-disable MD013 MD060 MD012 -->

# Non-Temporal Evidence Coverage Gate - 2026-05-09

## Verdict

FAIL

Run: `test-hank-doe-phase1-c06-20260509-0909`
Raw failure threshold: `0.8`

## Gate checks

| check | target | actual | status |
|---|---:|---:|---|
| multi-hop complete evidence coverage on low-F1 rows | >=4 | 2 | FAIL |
| open-domain any evidence coverage on low-F1 rows | >=5 | 5 | PASS |
| temporal raw F1 floor on same stratified shape | >=0.6 | 0.6279 | PASS |

## Category summary

| category | rows | raw F1 | normalized F1 | failures < threshold | any evidence selected | all evidence selected | evidence retrieved not selected | triggered zero semantic/context |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| single-hop | 15 | 0.5034 | 0.532 | 9 | 6 | 6 | 2 | 0 |
| multi-hop | 10 | 0.6599 | 0.6599 | 7 | 7 | 2 | 1 | 0 |
| open-domain | 10 | 0.35 | 0.35 | 8 | 5 | 4 | 0 | 0 |

## Failure rows

| id | category | raw F1 | normalized F1 | selected/required | direct | semantic | retrieved not selected | retrieval mode | failure cause | triggered zero semantic/context |
|---|---|---:|---:|---:|---:|---:|---:|---|---|---|
| conv-30:3 | multi-hop | 0.6667 | 0.6667 | 4/4 | 0 | 0 | 0 | raw_message_fts | evidence-reached-reader | no |
| conv-42:1 | multi-hop | 0.5 | 0.5 | 6/7 | 1 | 1 | 0 | raw_message_fts | evidence-reached-reader | no |
| conv-43:0 | multi-hop | 0.7 | 0.7 | 2/3 | 2 | 2 | 0 | open_domain_raw | evidence-reached-reader | no |
| conv-44:2 | multi-hop | 0.5 | 0.5 | 3/4 | 1 | 1 | 0 | raw_message_fts | evidence-reached-reader | no |
| conv-47:2 | multi-hop | 0.5556 | 0.5556 | 3/4 | 0 | 0 | 0 | raw_message_fts | evidence-reached-reader | no |
| conv-48:1 | multi-hop | 0.3333 | 0.3333 | 1/3 | 2 | 2 | 1 | raw_message_fts | evidence-reached-reader | no |
| conv-50:1 | multi-hop | 0.3429 | 0.3429 | 2/2 | 2 | 2 | 0 | raw_message_fts | evidence-reached-reader | no |
| conv-26:2 | open-domain | 0.3333 | 0.3333 | 2/2 | 1 | 1 | 0 | open_domain_raw | evidence-reached-reader | no |
| conv-41:14 | open-domain | 0 | 0 | 0/2 | 0 | 0 | 0 | triggered_semantic_fallback | evidence-not-retrieved | no |
| conv-41:8 | open-domain | 0 | 0 | 0/1 | 0 | 0 | 0 | open_domain_raw | evidence-not-retrieved | no |
| conv-42:0 | open-domain | 0 | 0 | 1/1 | 0 | 0 | 0 | open_domain_raw | evidence-reached-reader | no |
| conv-43:3 | open-domain | 0 | 0 | 0/3 | 0 | 0 | 0 | triggered_semantic_fallback | evidence-not-retrieved | no |
| conv-44:19 | open-domain | 0.5 | 0.5 | 1/2 | 0 | 0 | 0 | open_domain_raw | evidence-reached-reader | no |
| conv-47:0 | open-domain | 0 | 0 | 1/1 | 0 | 0 | 0 | open_domain_raw | evidence-reached-reader | no |
| conv-48:5 | open-domain | 0.6667 | 0.6667 | 1/1 | 1 | 1 | 0 | open_domain_raw | evidence-reached-reader | no |
| conv-30:2 | single-hop | 0.6667 | 0.6667 | 2/2 | 0 | 0 | 0 | raw_message_fts | evidence-reached-reader | no |
| conv-30:4 | single-hop | 0 | 0 | 0/2 | 1 | 1 | 1 | none | evidence-retrieved-not-selected | no |
| conv-42:88 | single-hop | 0 | 0 | 2/2 | 1 | 1 | 0 | open_domain_raw | evidence-reached-reader | no |
| conv-42:89 | single-hop | 0 | 0 | 2/2 | 2 | 2 | 0 | raw_message_fts | evidence-reached-reader | no |
| conv-43:71 | single-hop | 0 | 0 | 0/1 | 0 | 0 | 0 | raw_message_fts | evidence-not-retrieved | no |
| conv-43:72 | single-hop | 0 | 0 | 0/1 | 1 | 1 | 1 | open_domain_raw | evidence-retrieved-not-selected | no |
| conv-44:62 | single-hop | 0.5714 | 1 | 1/1 | 1 | 1 | 0 | open_domain_raw | evidence-reached-reader | no |
| conv-48:15 | single-hop | 0 | 0 | 3/3 | 0 | 0 | 0 | raw_message_fts | evidence-reached-reader | no |
| conv-49:83 | single-hop | 0.6667 | 0.6667 | 1/1 | 1 | 1 | 0 | raw_message_fts | evidence-reached-reader | no |

## Recommendation

Do not run the full benchmark yet. Fix compose/retrieval evidence coverage first.

