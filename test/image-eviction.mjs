/**
 * Image eviction pre-pass tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evictStaleContent, DEFAULT_EVICTION_CONFIG } from '../dist/image-eviction.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal base64 string of approximately `tokens` tokens worth of data. */
function fakeBase64(tokens) {
  // 3 chars/token for base64
  return 'A'.repeat(tokens * 3);
}

/** Build a fake OpenAI-format image_url message. */
function imageMsg(role, base64, mediaType = 'image/png') {
  return {
    role,
    content: [
      { type: 'text', text: 'here is a screenshot' },
      {
        type: 'image_url',
        image_url: { url: `data:${mediaType};base64,${base64}` },
      },
    ],
  };
}

/** Build a fake Anthropic-format image message. */
function anthropicImageMsg(role, base64, mediaType = 'image/png') {
  return {
    role,
    content: [
      {
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: base64 },
      },
    ],
  };
}

/** Build a tool-role message. */
function toolMsg(content, name = 'read') {
  return { role: 'tool', name, content };
}

/** Build an assistant message (should never be touched). */
function assistantMsg(text) {
  return { role: 'assistant', content: text };
}

/** Build a user text message (should never be touched). */
function userTextMsg(text) {
  return { role: 'user', content: [{ type: 'text', text }] };
}

/**
 * Build a conversation with the structure:
 *   [old_image_msg, assistant, assistant, user_text, assistant]
 * The old_image_msg is 3 turns old (3 assistant messages after it).
 */
function buildConversationWithOldImage(imageTurnAge = 3) {
  const base64 = fakeBase64(5000); // ~5000 tokens
  const msgs = [imageMsg('user', base64)];
  for (let i = 0; i < imageTurnAge; i++) {
    msgs.push(assistantMsg(`response ${i}`));
  }
  msgs.push(userTextMsg('what did you see?'));
  msgs.push(assistantMsg('final response'));
  return { msgs, base64 };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('evictStaleContent', () => {

  describe('images — OpenAI format', () => {
    it('evicts base64 image older than imageAgeTurns', () => {
      const { msgs } = buildConversationWithOldImage(3);
      const { messages, stats } = evictStaleContent(msgs, { imageAgeTurns: 2 });

      assert.equal(stats.imagesEvicted, 1);
      assert.ok(stats.tokensFreed > 0, 'should report freed tokens');

      const evictedMsg = messages[0];
      const content = evictedMsg.content;
      assert.ok(Array.isArray(content));
      // text block should be preserved
      assert.equal(content[0].text, 'here is a screenshot');
      // image block should be replaced with descriptor
      assert.equal(content[1].type, 'text');
      assert.ok(content[1].text.includes('evicted'));
      assert.ok(content[1].text.includes('tokens'));
    });

    it('does NOT evict image younger than imageAgeTurns', () => {
      const { msgs } = buildConversationWithOldImage(1); // only 1 turn old
      const { messages, stats } = evictStaleContent(msgs, { imageAgeTurns: 2 });

      assert.equal(stats.imagesEvicted, 0);
      // original image block preserved
      const content = messages[0].content;
      assert.equal(content[1].type, 'image_url');
    });

    it('does NOT evict plain URL images (not base64)', () => {
      const msgs = [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }],
        },
        assistantMsg('r1'),
        assistantMsg('r2'),
        assistantMsg('r3'),
      ];
      const { messages, stats } = evictStaleContent(msgs, { imageAgeTurns: 2 });
      assert.equal(stats.imagesEvicted, 0);
      assert.equal(messages[0].content[0].type, 'image_url');
    });

    it('does NOT evict small base64 images below minTokensToEvict', () => {
      const smallBase64 = fakeBase64(50); // only ~50 tokens
      const msgs = [
        imageMsg('user', smallBase64),
        assistantMsg('r1'), assistantMsg('r2'), assistantMsg('r3'),
      ];
      const { stats } = evictStaleContent(msgs, { imageAgeTurns: 2, minTokensToEvict: 200 });
      assert.equal(stats.imagesEvicted, 0);
    });
  });

  describe('images — Anthropic format', () => {
    it('evicts Anthropic base64 image older than imageAgeTurns', () => {
      const base64 = fakeBase64(5000);
      const msgs = [
        anthropicImageMsg('user', base64),
        assistantMsg('r1'), assistantMsg('r2'), assistantMsg('r3'),
      ];
      const { messages, stats } = evictStaleContent(msgs, { imageAgeTurns: 2 });
      assert.equal(stats.imagesEvicted, 1);
      const block = messages[0].content[0];
      assert.equal(block.type, 'text');
      assert.ok(block.text.includes('image/png'));
      assert.ok(block.text.includes('evicted'));
    });
  });

  describe('tool results', () => {
    it('evicts large tool result older than toolResultAgeTurns', () => {
      const largeResult = 'x'.repeat(5000); // ~1250 tokens
      const msgs = [
        toolMsg(largeResult, 'read'),
        assistantMsg('r1'), assistantMsg('r2'), assistantMsg('r3'), assistantMsg('r4'), assistantMsg('r5'),
        userTextMsg('ok'),
      ];
      const { messages, stats } = evictStaleContent(msgs, { toolResultAgeTurns: 4, minTokensToEvict: 200 });
      assert.equal(stats.toolResultsEvicted, 1);
      assert.ok(messages[0].content.includes('evicted'));
      assert.ok(messages[0].content.includes('read'));
      // preview present
      assert.ok(messages[0].content.includes('Preview:'));
    });

    it('does NOT evict tool result younger than toolResultAgeTurns', () => {
      const largeResult = 'x'.repeat(5000);
      const msgs = [
        toolMsg(largeResult),
        assistantMsg('r1'), assistantMsg('r2'),
      ];
      const { messages, stats } = evictStaleContent(msgs, { toolResultAgeTurns: 4 });
      assert.equal(stats.toolResultsEvicted, 0);
      assert.equal(messages[0].content, largeResult);
    });

    it('does NOT evict small tool results', () => {
      const small = 'hello world response';
      const msgs = [
        toolMsg(small),
        assistantMsg('r1'), assistantMsg('r2'), assistantMsg('r3'), assistantMsg('r4'), assistantMsg('r5'),
      ];
      const { stats } = evictStaleContent(msgs, { toolResultAgeTurns: 4, minTokensToEvict: 200 });
      assert.equal(stats.toolResultsEvicted, 0);
    });
  });

  describe('safety — never touch', () => {
    it('never modifies assistant messages', () => {
      const msgs = [
        assistantMsg('big response ' + 'x'.repeat(5000)),
        assistantMsg('r2'), assistantMsg('r3'), assistantMsg('r4'),
      ];
      const { messages, stats } = evictStaleContent(msgs, { imageAgeTurns: 2, toolResultAgeTurns: 4 });
      assert.equal(stats.imagesEvicted, 0);
      assert.equal(stats.toolResultsEvicted, 0);
      assert.equal(messages[0].content, msgs[0].content);
    });

    it('never modifies user text messages', () => {
      const msgs = [
        userTextMsg('x'.repeat(5000)),
        assistantMsg('r1'), assistantMsg('r2'), assistantMsg('r3'),
      ];
      const { messages, stats } = evictStaleContent(msgs);
      assert.equal(stats.imagesEvicted, 0);
      assert.equal(stats.toolResultsEvicted, 0);
      assert.equal(messages[0].content[0].text, msgs[0].content[0].text);
    });

    it('does not mutate original messages array', () => {
      const base64 = fakeBase64(5000);
      const original = [
        imageMsg('user', base64),
        assistantMsg('r1'), assistantMsg('r2'), assistantMsg('r3'),
      ];
      const originalJson = JSON.stringify(original);
      evictStaleContent(original, { imageAgeTurns: 2 });
      assert.equal(JSON.stringify(original), originalJson, 'original should not be mutated');
    });
  });

  describe('empty / edge cases', () => {
    it('handles empty messages array', () => {
      const { messages, stats } = evictStaleContent([]);
      assert.deepEqual(messages, []);
      assert.equal(stats.imagesEvicted, 0);
      assert.equal(stats.tokensFreed, 0);
    });

    it('handles messages with no images or tool results', () => {
      const msgs = [
        userTextMsg('hello'),
        assistantMsg('world'),
      ];
      const { messages, stats } = evictStaleContent(msgs);
      assert.equal(stats.tokensFreed, 0);
      assert.deepEqual(messages, msgs);
    });
  });

  describe('stats accuracy', () => {
    it('reports non-zero tokensFreed when image evicted', () => {
      const base64 = fakeBase64(3000);
      const msgs = [
        imageMsg('user', base64),
        assistantMsg('r1'), assistantMsg('r2'), assistantMsg('r3'),
      ];
      const { stats } = evictStaleContent(msgs, { imageAgeTurns: 2 });
      assert.ok(stats.tokensFreed > 1000, `expected > 1000 tokens freed, got ${stats.tokensFreed}`);
    });
  });

  describe('DEFAULT_EVICTION_CONFIG', () => {
    it('has expected defaults', () => {
      assert.equal(DEFAULT_EVICTION_CONFIG.imageAgeTurns, 2);
      assert.equal(DEFAULT_EVICTION_CONFIG.toolResultAgeTurns, 4);
      assert.equal(DEFAULT_EVICTION_CONFIG.minTokensToEvict, 200);
      assert.equal(DEFAULT_EVICTION_CONFIG.keepPreviewChars, 120);
    });
  });
});
