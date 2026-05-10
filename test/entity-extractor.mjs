/**
 * Tests for Sprint A entity-extractor (compose-time annotation).
 *
 * Covers:
 *   - extractEntitiesFromText: TitleCase, quoted strings, ALLCAPS
 *   - annotateRecallGroups: entity/grace matching within recall content
 *   - formatStructuredHandoffBlock: group header annotation
 *   - buildStructuredHandoffInstruction: preamble format
 *
 * Run after build: node --test test/entity-extractor.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractEntitiesFromText,
  annotateRecallGroups,
  formatStructuredHandoffBlock,
  buildStructuredHandoffInstruction,
} from '../dist/entity-extractor.js';

// ── extractEntitiesFromText ───────────────────────────────────────────────

test('extractEntitiesFromText: finds TitleCase entities', () => {
  const result = extractEntitiesFromText('Alice and Bob went to the VR Club together.');
  assert.ok(result.entities.includes('alice'), `missing alice in ${result.entities}`);
  assert.ok(result.entities.includes('bob'), `missing bob in ${result.entities}`);
});

test('extractEntitiesFromText: finds job grace', () => {
  const result = extractEntitiesFromText('Alice lost her job at the company.');
  assert.ok(result.facets.includes('job'), `expected job grace in ${result.facets}`);
});

test('extractEntitiesFromText: finds purchase grace', () => {
  const result = extractEntitiesFromText('Bob bought a new car last month.');
  assert.ok(result.facets.includes('purchase'), `expected purchase grace in ${result.facets}`);
});

test('extractEntitiesFromText: knownEntities fast path', () => {
  const text = 'alice mentioned that she was planning a trip with bob';
  const result = extractEntitiesFromText(text, ['alice', 'bob']);
  assert.ok(result.entities.includes('alice'), `missing alice`);
  assert.ok(result.entities.includes('bob'), `missing bob`);
});

test('extractEntitiesFromText: does not include stop words', () => {
  const result = extractEntitiesFromText('The quick brown fox jumped over the lazy dog.');
  assert.ok(!result.entities.includes('the'), 'should not include "the"');
  assert.ok(!result.entities.includes('user'), 'should not include role labels');
});

// ── annotateRecallGroups ──────────────────────────────────────────────────

const SAMPLE_RECALL_CONTENT = `### Raw transcript group 42
- [2024-01-15] user: What activities does Alice do?
- [2024-01-15] assistant: Alice enjoys hiking and cooking with her friends.
### Raw transcript group 43
- [2024-02-10] user: What about Bob's hobbies?
- [2024-02-10] assistant: Bob likes gaming and was interested in martial arts.`;

test('annotateRecallGroups: parses two groups', () => {
  const groups = annotateRecallGroups(SAMPLE_RECALL_CONTENT, ['alice', 'bob'], ['hobby']);
  assert.equal(groups.length, 2, `expected 2 groups, got ${groups.length}`);
});

test('annotateRecallGroups: group 42 matches Alice entity', () => {
  const groups = annotateRecallGroups(SAMPLE_RECALL_CONTENT, ['alice', 'bob'], ['hobby']);
  const g42 = groups.find(g => g.groupId === '42');
  assert.ok(g42, 'group 42 should exist');
  assert.ok(g42.matchedEntities.includes('alice'), `expected alice in group 42: ${g42.matchedEntities}`);
  assert.ok(g42.isRelevant, 'group 42 should be relevant');
});

test('annotateRecallGroups: group 43 matches Bob entity', () => {
  const groups = annotateRecallGroups(SAMPLE_RECALL_CONTENT, ['alice', 'bob'], ['hobby']);
  const g43 = groups.find(g => g.groupId === '43');
  assert.ok(g43, 'group 43 should exist');
  assert.ok(g43.matchedEntities.includes('bob'), `expected bob in group 43: ${g43.matchedEntities}`);
});

test('annotateRecallGroups: hobby grace matched across groups', () => {
  const groups = annotateRecallGroups(SAMPLE_RECALL_CONTENT, ['alice', 'bob'], ['hobby']);
  const relevant = groups.filter(g => g.matchedFacets.includes('hobby'));
  assert.ok(relevant.length >= 1, 'at least one group should match hobby grace');
});

test('annotateRecallGroups: empty content returns empty array', () => {
  const groups = annotateRecallGroups('', ['alice'], ['job']);
  assert.equal(groups.length, 0);
});

test('annotateRecallGroups: no entity match = not relevant', () => {
  const isolatedContent = `### Raw transcript group 99
- [2024-03-01] user: Tell me about the weather.
- [2024-03-01] assistant: It was sunny today.`;
  const groups = annotateRecallGroups(isolatedContent, ['alice', 'bob'], ['job']);
  const g99 = groups.find(g => g.groupId === '99');
  assert.ok(g99, 'group 99 should exist');
  assert.equal(g99.matchedEntities.length, 0, 'no entity match expected');
});

// ── formatStructuredHandoffBlock ──────────────────────────────────────────

test('formatStructuredHandoffBlock: emits annotated headers for relevant groups', () => {
  const groups = annotateRecallGroups(SAMPLE_RECALL_CONTENT, ['alice', 'bob'], ['hobby']);
  const result = formatStructuredHandoffBlock(groups, ['alice', 'bob'], ['hobby']);

  assert.ok(result.content.includes('Evidence group'), 'should include annotated Evidence group header');
  assert.ok(result.entityGroupCount > 0, 'should have at least one entity group');
});

test('formatStructuredHandoffBlock: includes entity annotation in header', () => {
  const groups = annotateRecallGroups(SAMPLE_RECALL_CONTENT, ['alice', 'bob'], ['hobby']);
  const result = formatStructuredHandoffBlock(groups, ['alice', 'bob'], ['hobby']);

  assert.ok(
    result.content.includes('entities:'),
    'header should contain "entities:" annotation',
  );
});

test('formatStructuredHandoffBlock: preserves content lines', () => {
  const groups = annotateRecallGroups(SAMPLE_RECALL_CONTENT, ['alice', 'bob'], ['hobby']);
  const result = formatStructuredHandoffBlock(groups, ['alice', 'bob'], ['hobby']);

  assert.ok(result.content.includes('Alice enjoys hiking'), 'content should preserve original lines');
  assert.ok(result.content.includes('Bob likes gaming'), 'content should preserve original lines');
});

test('formatStructuredHandoffBlock: non-relevant group uses raw header', () => {
  const isolatedContent = `### Raw transcript group 99
- [2024-03-01] user: Tell me about weather.
- [2024-03-01] assistant: It was sunny.`;
  const groups = annotateRecallGroups(isolatedContent, ['alice', 'bob'], ['job']);
  const result = formatStructuredHandoffBlock(groups, ['alice', 'bob'], ['job']);

  // Non-relevant groups should still be emitted with raw header
  assert.ok(result.content.includes('Raw transcript group 99'), 'non-relevant group should use raw header');
});

test('formatStructuredHandoffBlock: entityGroupCount and facetGroupCount correct', () => {
  const groups = annotateRecallGroups(SAMPLE_RECALL_CONTENT, ['alice', 'bob'], ['hobby']);
  const result = formatStructuredHandoffBlock(groups, ['alice', 'bob'], ['hobby']);

  // Both groups should have entity matches
  assert.ok(result.entityGroupCount >= 1, `expected entityGroupCount >= 1, got ${result.entityGroupCount}`);
  assert.ok(result.facetGroupCount >= 0, 'facetGroupCount should be >= 0');
});

// ── buildStructuredHandoffInstruction ────────────────────────────────────

test('buildStructuredHandoffInstruction: contains section header', () => {
  const instruction = buildStructuredHandoffInstruction(['alice', 'bob'], ['hobby']);
  assert.ok(instruction.includes('## Query-Matched Conversation Memory'), 'should have section header');
});

test('buildStructuredHandoffInstruction: contains entity names', () => {
  const instruction = buildStructuredHandoffInstruction(['alice', 'bob'], ['hobby']);
  assert.ok(instruction.includes('alice') || instruction.includes('bob'), 'should mention query entities');
});

test('buildStructuredHandoffInstruction: contains grace names', () => {
  const instruction = buildStructuredHandoffInstruction(['alice'], ['job', 'purchase']);
  assert.ok(instruction.includes('job') || instruction.includes('purchase'), 'should mention facets');
});

test('buildStructuredHandoffInstruction: contains multi-hop scan instruction', () => {
  const instruction = buildStructuredHandoffInstruction(['alice', 'bob'], []);
  assert.ok(
    instruction.includes('scan all groups') || instruction.includes('multi-part'),
    'should include multi-hop scan instruction',
  );
});

test('buildStructuredHandoffInstruction: empty entities/facets still produces valid instruction', () => {
  const instruction = buildStructuredHandoffInstruction([], []);
  assert.ok(instruction.includes('## Query-Matched Conversation Memory'));
  assert.ok(typeof instruction === 'string' && instruction.length > 0);
});
