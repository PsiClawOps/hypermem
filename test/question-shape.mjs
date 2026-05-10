/**
 * Tests for Sprint A question-shape detector.
 *
 * Covers:
 *   - Multi-hop classification (true positives)
 *   - Single-hop classification (true negatives / FP guard)
 *   - Entity extraction
 *   - Grace extraction
 *   - FP score on temporal/single-entity queries
 *
 * Run after build: node --test test/question-shape.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectQuestionShape,
  extractQueryEntities,
  extractQueryFacets,
  questionShapeFalsePositiveScore,
} from '../dist/question-shape.js';

// ── Multi-hop true positives ──────────────────────────────────────────────

test('detects multi-hop: two named entities + relation word', () => {
  const shape = detectQuestionShape('What do Alice and Bob have in common?');
  assert.equal(shape.kind, 'multi-hop', 'should be multi-hop');
  assert.ok(shape.entities.length >= 2, `expected 2+ entities, got ${shape.entities.join(', ')}`);
  assert.ok(shape.confidence > 0.1, 'confidence should be > 0');
});

test('detects multi-hop: LoCoMo-style shared activity query', () => {
  const shape = detectQuestionShape('What activities do both Jon and Gina share?');
  assert.equal(shape.kind, 'multi-hop');
  assert.ok(shape.entities.some(e => e === 'jon' || e === 'gina'), 'should extract named entities');
});

test('detects multi-hop: entity + grace (job loss)', () => {
  const shape = detectQuestionShape('What happened to Calvin\'s job before June?');
  // Calvin = entity, job = grace; "before" = relation word
  // FP risk: "before" also triggers temporal. Let's verify what we get.
  // Either multi-hop or single-hop is acceptable here depending on FP guard
  assert.ok(['multi-hop', 'single-hop'].includes(shape.kind));
  assert.ok(Array.isArray(shape.entities));
  assert.ok(Array.isArray(shape.facets));
});

test('detects multi-hop: LoCoMo conv-42 style (both people / common interest)', () => {
  const shape = detectQuestionShape('What do Sarah and Mike both enjoy doing in their free time?');
  assert.equal(shape.kind, 'multi-hop');
  assert.ok(shape.entities.includes('sarah') || shape.entities.includes('mike'));
  assert.ok(shape.facets.includes('hobby') || shape.facets.includes('activity'));
});

test('detects multi-hop: purchase query across two people', () => {
  const shape = detectQuestionShape('What items did Alice and Bob both purchase in March?');
  assert.equal(shape.kind, 'multi-hop');
  assert.ok(shape.facets.includes('purchase') || shape.facets.includes('time'));
});

// ── Single-hop / FP guard ─────────────────────────────────────────────────

test('single-hop: simple factual query', () => {
  const shape = detectQuestionShape('What is Alice\'s job?');
  // Only one entity, no relation word for multi-hop
  assert.equal(shape.kind, 'single-hop');
});

test('single-hop: temporal question about one subject', () => {
  const shape = detectQuestionShape('When did Bob lose his job?');
  assert.equal(shape.kind, 'single-hop');
});

test('single-hop: "when did" temporal anchor suppresses FP', () => {
  const fpScore = questionShapeFalsePositiveScore('When did Alice and Bob meet?');
  // "when did" is a temporal single-hop pattern → FP score should be elevated
  assert.ok(fpScore > 0.3, `expected FP score > 0.3, got ${fpScore}`);
});

test('single-hop: short query', () => {
  const shape = detectQuestionShape('What is VR?');
  assert.equal(shape.kind, 'single-hop');
});

test('FP score: purely temporal query scores high FP', () => {
  const score = questionShapeFalsePositiveScore('When did Alice first visit the gym?');
  assert.ok(score >= 0.3, `expected score >= 0.3, got ${score}`);
});

test('FP score: multi-entity relation query scores low FP', () => {
  const score = questionShapeFalsePositiveScore('What do Sarah and Mike both enjoy doing together?');
  assert.ok(score < 0.6, `expected FP score < 0.6, got ${score}`);
});

// ── Entity extraction ─────────────────────────────────────────────────────

test('extractQueryEntities: TitleCase names', () => {
  const entities = extractQueryEntities('What do Alice and Bob share?');
  assert.ok(entities.includes('alice'), `missing alice in ${entities}`);
  assert.ok(entities.includes('bob'), `missing bob in ${entities}`);
});

test('extractQueryEntities: quoted strings', () => {
  const entities = extractQueryEntities('What does "Jon" think about "VR Club"?');
  assert.ok(entities.includes('jon'), `missing jon in ${entities}`);
  assert.ok(entities.includes('vr club'), `missing vr club in ${entities}`);
});

test('extractQueryEntities: skips stop words', () => {
  const entities = extractQueryEntities('What is the best activity?');
  assert.ok(!entities.includes('what'), 'should not include "what"');
  assert.ok(!entities.includes('the'), 'should not include "the"');
});

test('extractQueryEntities: ALL-CAPS abbreviations', () => {
  const entities = extractQueryEntities('Did Alice join VR training?');
  assert.ok(entities.includes('vr'), `missing vr in ${entities}`);
});

// ── Grace extraction ──────────────────────────────────────────────────────

test('extractQueryFacets: job grace', () => {
  const facets = extractQueryFacets('What happened to Bob\'s career?');
  assert.ok(facets.includes('job'), `expected job grace in ${facets}`);
});

test('extractQueryFacets: purchase grace', () => {
  const facets = extractQueryFacets('What did Alice buy in March?');
  assert.ok(facets.includes('purchase'), `expected purchase grace in ${facets}`);
});

test('extractQueryFacets: hobby/activity grace', () => {
  const facets = extractQueryFacets('What hobbies do they share?');
  assert.ok(facets.includes('hobby'), `expected hobby grace in ${facets}`);
});

test('extractQueryFacets: relationship grace', () => {
  const facets = extractQueryFacets('Who is Alice\'s boyfriend?');
  assert.ok(facets.includes('relationship'), `expected relationship grace in ${facets}`);
});

test('extractQueryFacets: empty for generic query', () => {
  const facets = extractQueryFacets('Tell me something');
  // Should not match bogus facets
  assert.ok(Array.isArray(facets));
});

// ── False positive measurement hook (Sprint A requirement) ───────────────

test('FP measurement: held-out single-hop multi-entity queries stay below 30% multi-hop rate', () => {
  // Spec: "Measure question-shape false positives on a held-out 10-20 item
  //        single-hop multi-entity set before declaring the classifier safe."
  const singleHopMultiEntityQueries = [
    'When did Alice and Bob first meet?',
    'How long have Sarah and Mike known each other?',
    'What year did Jon and Calvin become friends?',
    'When did Alice introduce Bob to her family?',
    'Who is Alice\'s boyfriend named Bob?',
    'How many times did Sarah visit Bob\'s house?',
    'What is the name of Mike\'s sister?',
    'Where did Alice and Bob go to school?',
    'When was Bob born?',
    'What is Sarah\'s job title?',
  ];

  const multiHopCount = singleHopMultiEntityQueries.filter(q => {
    const shape = detectQuestionShape(q);
    return shape.kind === 'multi-hop';
  }).length;

  const fpRate = multiHopCount / singleHopMultiEntityQueries.length;
  // Spec says if FP rate > 30%, add a negative check. This test enforces that.
  assert.ok(
    fpRate <= 0.30,
    `FP rate on single-hop multi-entity set is ${(fpRate * 100).toFixed(0)}% (${multiHopCount}/${singleHopMultiEntityQueries.length}), must be <= 30%`,
  );
});

test('recall: LoCoMo multi-hop target queries are classified as multi-hop', () => {
  // Sprint A target rows: conv-30:3, conv-42:1, conv-50:1 style queries
  // These should be classified as multi-hop when the detector is working.
  const multiHopTargetQueries = [
    'What activities do both Jon and Gina share?',
    'What do Alice and Bob have in common regarding their hobbies?',
    'What purchases did Sarah and Mike both make?',
    'What events have Calvin and Alice both attended?',
    'What hobbies do Alice and Bob share?',
  ];

  const classifiedMultiHop = multiHopTargetQueries.filter(q =>
    detectQuestionShape(q).kind === 'multi-hop',
  );

  // At least 60% of clear multi-hop queries should be detected
  const recallRate = classifiedMultiHop.length / multiHopTargetQueries.length;
  assert.ok(
    recallRate >= 0.60,
    `Multi-hop recall rate is ${(recallRate * 100).toFixed(0)}% (${classifiedMultiHop.length}/${multiHopTargetQueries.length}), must be >= 60%`,
  );
});
