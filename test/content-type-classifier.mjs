/**
 * Content Type Classifier tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyContentType,
  signalWeight,
  isSignalBearing,
  SIGNAL_WEIGHT,
} from '../dist/content-type-classifier.js';

describe('ContentTypeClassifier', () => {
  // ─── Decision detection ───────────────────────────────────────

  describe('decisions', () => {
    const decisions = [
      'We decided to use nomic-embed-text for all embedding.',
      'The approach is to keep the LRU cache at 128 entries.',
      "We'll go with SQLite for cursor durability.",
      'The plan is to ship Phase 1 before starting Phase 2.',
      'Approved: contextEngine slot flipped to hypermem.',
      'Confirmed: Redis auth not needed for single-user.',
      'Shipped TUNE-013 to production.',
      'Merged PR #42 — vector store wiring.',
      'Deployed the background indexer fix.',
      'Decision: stay with nomic-embed-text.',
      '🟢 GREEN — proceed with implementation.',
      '🔴 RED — stop, this needs human review.',
    ];

    for (const text of decisions) {
      it(`classifies "${text.slice(0, 50)}..." as decision`, () => {
        const result = classifyContentType(text);
        assert.equal(result.type, 'decision');
        assert.ok(result.confidence >= 0.8);
        assert.equal(result.halfLifeDays, Infinity);
      });
    }
  });

  // ─── Spec detection ───────────────────────────────────────────

  describe('specs', () => {
    it('classifies code blocks as spec', () => {
      const result = classifyContentType('Here is the schema:\n```sql\nCREATE TABLE facts...\n```');
      assert.equal(result.type, 'spec');
    });

    it('classifies type definitions as spec', () => {
      const result = classifyContentType('type ContentType = "decision" | "spec"');
      assert.equal(result.type, 'spec');
    });

    it('classifies interface as spec', () => {
      const result = classifyContentType('interface VectorStoreConfig { model: string; }');
      assert.equal(result.type, 'spec');
    });

    it('classifies architecture discussion as spec', () => {
      const result = classifyContentType('The architecture uses a 4-layer compositor with Redis as L1.');
      assert.equal(result.type, 'spec');
    });
  });

  // ─── Preference detection ────────────────────────────────────

  describe('preferences', () => {
    it('classifies preference statements', () => {
      assert.equal(classifyContentType('I prefer tabs over spaces.').type, 'preference');
      assert.equal(classifyContentType('My preferred model is claude-sonnet.').type, 'preference');
      assert.equal(classifyContentType("I'd rather use SSH than HTTPS.").type, 'preference');
      assert.equal(classifyContentType('Always use conventional commits.').type, 'preference');
    });
  });

  // ─── Noise detection ─────────────────────────────────────────

  describe('noise', () => {
    it('classifies heartbeats as noise', () => {
      assert.equal(classifyContentType('heartbeat check ok').type, 'noise');
    });

    it('classifies NO_REPLY as noise', () => {
      assert.equal(classifyContentType('NO_REPLY').type, 'noise');
    });

    it('classifies HEARTBEAT_OK as noise', () => {
      assert.equal(classifyContentType('HEARTBEAT_OK').type, 'noise');
    });

    it('classifies empty as noise', () => {
      assert.equal(classifyContentType('').type, 'noise');
      assert.equal(classifyContentType('  ').type, 'noise');
    });

    it('classifies system messages as noise', () => {
      assert.equal(classifyContentType('[SYSTEM_EVENT] gateway restarted').type, 'noise');
    });
  });

  // ─── Ack detection ───────────────────────────────────────────

  describe('acks', () => {
    const acks = ['ok', 'sounds good', 'lgtm', 'done', 'thanks', '👍', 'perfect'];
    for (const ack of acks) {
      it(`classifies "${ack}" as ack`, () => {
        assert.equal(classifyContentType(ack).type, 'ack');
      });
    }

    it('does not classify long messages as ack even with ack words', () => {
      const result = classifyContentType('Ok so the plan is to restructure the entire compositor pipeline and add a new keystone slot.');
      assert.notEqual(result.type, 'ack');
    });
  });

  // ─── Discussion detection ────────────────────────────────────

  describe('discussion', () => {
    it('classifies questions as discussion', () => {
      assert.equal(classifyContentType('What benchmark was used?').type, 'discussion');
    });

    it('classifies exploratory text as discussion', () => {
      assert.equal(classifyContentType('Maybe we should explore a different approach.').type, 'discussion');
    });

    it('classifies generic text as discussion', () => {
      const result = classifyContentType('The fleet has 18 agents running across 5 provider families.');
      assert.equal(result.type, 'discussion');
    });
  });

  // ─── Signal weight ───────────────────────────────────────────

  describe('signalWeight()', () => {
    it('decisions have weight 1.0', () => {
      assert.equal(signalWeight('We decided to keep nomic-embed-text.'), 1.0);
    });

    it('noise has weight 0.0', () => {
      assert.equal(signalWeight('NO_REPLY'), 0.0);
    });

    it('acks have weight 0.0', () => {
      assert.equal(signalWeight('ok'), 0.0);
    });

    it('discussion has weight 0.4', () => {
      assert.equal(signalWeight('The fleet has 18 agents.'), 0.4);
    });
  });

  // ─── isSignalBearing ─────────────────────────────────────────

  describe('isSignalBearing()', () => {
    it('returns true for decisions', () => {
      assert.ok(isSignalBearing('We decided to ship.'));
    });

    it('returns false for acks', () => {
      assert.ok(!isSignalBearing('ok'));
    });

    it('returns false for noise', () => {
      assert.ok(!isSignalBearing('NO_REPLY'));
    });

    it('returns true for discussion', () => {
      assert.ok(isSignalBearing('Let me check the logs.'));
    });
  });

  // ─── SIGNAL_WEIGHT ordering ──────────────────────────────────

  describe('signal weight ordering', () => {
    it('decision > spec > preference > skill > attribute > discussion > ack = noise', () => {
      assert.ok(SIGNAL_WEIGHT.decision > SIGNAL_WEIGHT.spec);
      assert.ok(SIGNAL_WEIGHT.spec > SIGNAL_WEIGHT.preference);
      assert.ok(SIGNAL_WEIGHT.preference > SIGNAL_WEIGHT.skill);
      assert.ok(SIGNAL_WEIGHT.skill > SIGNAL_WEIGHT.attribute);
      assert.ok(SIGNAL_WEIGHT.attribute > SIGNAL_WEIGHT.discussion);
      assert.ok(SIGNAL_WEIGHT.discussion > SIGNAL_WEIGHT.ack);
      assert.equal(SIGNAL_WEIGHT.ack, SIGNAL_WEIGHT.noise);
    });
  });
});
