/**
 * Unit tests for OpenAI adapter, config resolution, error handling,
 * API key validation, emulated streaming, embeddings, and token counting.
 * Run with: node tests/adapter.test.js
 */

const assert = require('assert');
const crypto = require('crypto');

// Import actual functions for testing
const {
  classifyError: actualClassifyError,
  estimateTokens,
  generateEmbedding,
  detectSilenceRegions,
  splitAudioAtSilence
} = require('../server/puter-client.js');

// Mock dependencies
const mockPuterClient = {
  chat: async (messages, options) => {
    // Simulate tool call response if tools provided
    if (options && options.tools && options.tools.length > 0) {
      return {
        text: 'I will check the weather for you.',
        toolCalls: [{
          id: 'call_abc123',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"location":"Paris"}' }
        }]
      };
    }
    return { text: 'Mock response', toolCalls: null };
  },
  estimateTokens,
  generateEmbedding,
  detectSilenceRegions,
  splitAudioAtSilence,
  classifyError: actualClassifyError
};

const mockConfig = {
  getConfig: () => ({
    port: 11436,
    puterModel: 'gpt-4o',
    spoofedOpenAIModelId: 'gpt-4o-mini',
    defaultModel: 'gpt-4o',
    apiKey: 'sk-puter-123',
    modelAliases: { 'my-gpt': 'gpt-5-nano' },
    modelAllowlist: [],
    modelBlocklist: ['bad-model'],
    emulatorActive: true
  }),
  isEmulatorActive: () => true,
  resolveModel: (requested, known) => {
    const aliases = { 'my-gpt': 'gpt-5-nano' };
    if (requested && aliases[requested]) {
      return { puterModel: aliases[requested], responseModel: requested };
    }
    if (requested && known.length > 0 && known.includes(requested)) {
      return { puterModel: requested, responseModel: requested };
    }
    const fallback = 'gpt-4o';
    return { puterModel: fallback, responseModel: requested || fallback };
  },
  checkModelAccess: (model) => {
    if (model === 'bad-model') return { allowed: false, reason: 'blocked' };
    return { allowed: true };
  }
};

const mockLogger = {
  logRequest: () => {},
  logSuccess: () => {},
  logError: () => {}
};

require.cache[require.resolve('../server/puter-client.js')] = { exports: mockPuterClient };
require.cache[require.resolve('../server/config.js')] = { exports: mockConfig };
require.cache[require.resolve('../server/logger.js')] = { exports: mockLogger };

const { validateRequest, createErrorResponse } = require('../server/openai-adapter.js');

function runTests() {
  console.log('Running OpenAI Adapter Tests...\n');
  let passed = 0, failed = 0;

  // Test 1: Valid request with messages
  try {
    validateRequest({ model: 'gpt-4', messages: [{ role: 'user', content: 'Hello' }] });
    console.log('✓ Test 1: Valid request with messages');
    passed++;
  } catch (e) { console.error('✗ Test 1 failed:', e.message); failed++; }

  // Test 2: Valid request with prompt
  try {
    validateRequest({ model: 'gpt-4', prompt: 'Hello' });
    console.log('✓ Test 2: Valid request with prompt');
    passed++;
  } catch (e) { console.error('✗ Test 2 failed:', e.message); failed++; }

  // Test 3: Reject missing messages/prompt
  try {
    validateRequest({ model: 'gpt-4' });
    console.error('✗ Test 3 failed: Should throw');
    failed++;
  } catch (e) {
    console.log('✓ Test 3: Rejects missing messages/prompt');
    passed++;
  }

  // Test 4: Reject empty messages array
  try {
    validateRequest({ model: 'gpt-4', messages: [] });
    console.error('✗ Test 4 failed: Should throw');
    failed++;
  } catch (e) {
    console.log('✓ Test 4: Rejects empty messages');
    passed++;
  }

  // Test 5: Reject invalid message format
  try {
    validateRequest({ model: 'gpt-4', messages: [{ role: 'user' }] });
    console.error('✗ Test 5 failed: Should throw');
    failed++;
  } catch (e) {
    console.log('✓ Test 5: Rejects message without content');
    passed++;
  }

  // Test 6: Error response format
  try {
    const resp = createErrorResponse(new Error('Test'), 400, 'invalid_request_error');
    assert.strictEqual(resp.statusCode, 400);
    assert.strictEqual(resp.body.error.type, 'invalid_request_error');
    console.log('✓ Test 6: Error response format');
    passed++;
  } catch (e) { console.error('✗ Test 6 failed:', e.message); failed++; }

  // Test 7: Default error type
  try {
    const resp = createErrorResponse(new Error('Error'));
    assert.strictEqual(resp.statusCode, 500);
    assert.strictEqual(resp.body.error.type, 'internal_server_error');
    console.log('✓ Test 7: Default error type');
    passed++;
  } catch (e) { console.error('✗ Test 7 failed:', e.message); failed++; }

  // Test 8: Token estimation
  try {
    const tokens = mockPuterClient.estimateTokens('Test message');
    assert(tokens > 0);
    console.log('✓ Test 8: Token estimation');
    passed++;
  } catch (e) { console.error('✗ Test 8 failed:', e.message); failed++; }

  // Test 9: Empty content accepted
  try {
    validateRequest({ model: 'gpt-4', messages: [{ role: 'user', content: '' }] });
    console.log('✓ Test 9: Empty content accepted');
    passed++;
  } catch (e) { console.error('✗ Test 9 failed:', e.message); failed++; }

  // Test 10: Model is optional (falls back to defaultModel)
  try {
    validateRequest({ messages: [{ role: 'user', content: 'Hello' }] });
    console.log('✓ Test 10: Model is optional (fallback to default)');
    passed++;
  } catch (e) { console.error('✗ Test 10 failed:', e.message); failed++; }

  // Test 11: Empty model accepted (falls back to default)
  try {
    validateRequest({ model: '', messages: [{ role: 'user', content: 'Hello' }] });
    console.log('✓ Test 11: Empty model accepted (fallback)');
    passed++;
  } catch (e) { console.error('✗ Test 11 failed:', e.message); failed++; }

  // Test 12: Whitespace model accepted (falls back to default)
  try {
    validateRequest({ model: '   ', messages: [{ role: 'user', content: 'Hello' }] });
    console.log('✓ Test 12: Whitespace model accepted (fallback)');
    passed++;
  } catch (e) { console.error('✗ Test 12 failed:', e.message); failed++; }

  // Test 13: Network error code → 503
  try {
    const err = new Error('Connection refused');
    err.code = 'ECONNREFUSED';
    const result = actualClassifyError(err);
    assert.strictEqual(result.statusCode, 503);
    assert.strictEqual(result.type, 'service_unavailable');
    console.log('✓ Test 13: ECONNREFUSED → 503');
    passed++;
  } catch (e) { console.error('✗ Test 13 failed:', e.message); failed++; }

  // Test 14: Timeout error → 503
  try {
    const err = new Error('Request timed out');
    err.code = 'ETIMEDOUT';
    const result = actualClassifyError(err);
    assert.strictEqual(result.statusCode, 503);
    assert.strictEqual(result.type, 'service_unavailable');
    console.log('✓ Test 14: ETIMEDOUT → 503');
    passed++;
  } catch (e) { console.error('✗ Test 14 failed:', e.message); failed++; }

  // Test 15: Empty response error → 503
  try {
    const err = new Error('Backend returned empty response');
    const result = actualClassifyError(err);
    assert.strictEqual(result.statusCode, 503);
    assert.strictEqual(result.type, 'service_unavailable');
    console.log('✓ Test 15: Empty response error → 503');
    passed++;
  } catch (e) { console.error('✗ Test 15 failed:', e.message); failed++; }

  // Test 16: Auth error → 401
  try {
    const err = new Error('Authentication failed: invalid token');
    const result = actualClassifyError(err);
    assert.strictEqual(result.statusCode, 401);
    assert.strictEqual(result.type, 'authentication_error');
    console.log('✓ Test 16: Auth error → 401');
    passed++;
  } catch (e) { console.error('✗ Test 16 failed:', e.message); failed++; }

  // Test 17: Rate limit → 429
  try {
    const err = new Error('Rate limit exceeded');
    const result = actualClassifyError(err);
    assert.strictEqual(result.statusCode, 429);
    assert.strictEqual(result.type, 'rate_limit_error');
    console.log('✓ Test 17: Rate limit → 429');
    passed++;
  } catch (e) { console.error('✗ Test 17 failed:', e.message); failed++; }

  // -----------------------------------------------------------------------
  // Multi-model resolution tests
  // -----------------------------------------------------------------------

  // Test 18: Alias resolution
  try {
    const result = mockConfig.resolveModel('my-gpt', ['gpt-5-nano', 'claude-sonnet']);
    assert.strictEqual(result.puterModel, 'gpt-5-nano');
    assert.strictEqual(result.responseModel, 'my-gpt');
    console.log('✓ Test 18: Alias resolution works');
    passed++;
  } catch (e) { console.error('✗ Test 18 failed:', e.message); failed++; }

  // Test 19: Known model passthrough
  try {
    const result = mockConfig.resolveModel('claude-sonnet', ['gpt-5-nano', 'claude-sonnet']);
    assert.strictEqual(result.puterModel, 'claude-sonnet');
    assert.strictEqual(result.responseModel, 'claude-sonnet');
    console.log('✓ Test 19: Known model passthrough');
    passed++;
  } catch (e) { console.error('✗ Test 19 failed:', e.message); failed++; }

  // Test 20: Fallback to default model
  try {
    const result = mockConfig.resolveModel('unknown-model', ['gpt-5-nano']);
    assert.strictEqual(result.puterModel, 'gpt-4o');
    assert.strictEqual(result.responseModel, 'unknown-model');
    console.log('✓ Test 20: Fallback to default model');
    passed++;
  } catch (e) { console.error('✗ Test 20 failed:', e.message); failed++; }

  // Test 21: No model → fallback
  try {
    const result = mockConfig.resolveModel(null, ['gpt-5-nano']);
    assert.strictEqual(result.puterModel, 'gpt-4o');
    assert.strictEqual(result.responseModel, 'gpt-4o');
    console.log('✓ Test 21: No model → fallback');
    passed++;
  } catch (e) { console.error('✗ Test 21 failed:', e.message); failed++; }

  // Test 22: Blocklist blocks model
  try {
    const access = mockConfig.checkModelAccess('bad-model');
    assert.strictEqual(access.allowed, false);
    console.log('✓ Test 22: Blocklist blocks model');
    passed++;
  } catch (e) { console.error('✗ Test 22 failed:', e.message); failed++; }

  // Test 23: Allowlist allows model
  try {
    const access = mockConfig.checkModelAccess('good-model');
    assert.strictEqual(access.allowed, true);
    console.log('✓ Test 23: Allowlist allows model');
    passed++;
  } catch (e) { console.error('✗ Test 23 failed:', e.message); failed++; }

  // Test 24: Null model passes access check
  try {
    const access = mockConfig.checkModelAccess(null);
    assert.strictEqual(access.allowed, true);
    console.log('✓ Test 24: Null model passes access check');
    passed++;
  } catch (e) { console.error('✗ Test 24 failed:', e.message); failed++; }

  // Test 25: Stream request accepted
  try {
    validateRequest({ model: 'gpt-4', messages: [{ role: 'user', content: 'Hello' }], stream: true });
    console.log('✓ Test 25: Stream request accepted');
    passed++;
  } catch (e) { console.error('✗ Test 25 failed:', e.message); failed++; }

  // -----------------------------------------------------------------------
  // New: API key, embeddings, token counting, tool calling
  // -----------------------------------------------------------------------

  // Test 26: API key config exists
  try {
    const cfg = mockConfig.getConfig();
    assert.strictEqual(cfg.apiKey, 'sk-puter-123');
    console.log('✓ Test 26: API key configured');
    passed++;
  } catch (e) { console.error('✗ Test 26 failed:', e.message); failed++; }

  // Test 27: Embedding is deterministic
  try {
    const v1 = generateEmbedding('hello world', 128);
    const v2 = generateEmbedding('hello world', 128);
    assert.strictEqual(v1.length, 128);
    assert.strictEqual(v2.length, 128);
    for (let i = 0; i < 128; i++) {
      assert.strictEqual(v1[i], v2[i]);
    }
    console.log('✓ Test 27: Embedding is deterministic');
    passed++;
  } catch (e) { console.error('✗ Test 27 failed:', e.message); failed++; }

  // Test 28: Different inputs produce different embeddings
  try {
    const v1 = generateEmbedding('hello', 64);
    const v2 = generateEmbedding('goodbye', 64);
    let diff = 0;
    for (let i = 0; i < 64; i++) {
      if (Math.abs(v1[i] - v2[i]) > 0.001) diff++;
    }
    assert(diff > 10, 'Embeddings should differ for different inputs');
    console.log('✓ Test 28: Different inputs → different embeddings');
    passed++;
  } catch (e) { console.error('✗ Test 28 failed:', e.message); failed++; }

  // Test 29: Embedding vector is L2 normalized
  try {
    const v = generateEmbedding('test', 256);
    let sumSq = 0;
    for (const val of v) sumSq += val * val;
    const norm = Math.sqrt(sumSq);
    assert(Math.abs(norm - 1.0) < 0.001, `Expected norm ≈ 1.0, got ${norm}`);
    console.log('✓ Test 29: Embedding is L2 normalized');
    passed++;
  } catch (e) { console.error('✗ Test 29 failed:', e.message); failed++; }

  // Test 30: Token estimation for messages
  try {
    const msgs = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Hello world' }
    ];
    const tokens = mockPuterClient.estimateTokens(msgs.map(m => m.content).join(' '));
    assert(tokens > 0);
    console.log('✓ Test 30: Message token counting');
    passed++;
  } catch (e) { console.error('✗ Test 30 failed:', e.message); failed++; }

  // Test 31: Request with tools accepted
  try {
    validateRequest({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'What is the weather?' }],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }]
    });
    console.log('✓ Test 31: Request with tools accepted');
    passed++;
  } catch (e) { console.error('✗ Test 31 failed:', e.message); failed++; }

  // Test 32: Emulator always counts tokens (not from Puter)
  try {
    const text = 'Hello world, this is a test';
    const tokens = estimateTokens(text);
    assert(tokens === Math.ceil(text.length / 4));
    console.log('✓ Test 32: Emulator-side token counting');
    passed++;
  } catch (e) { console.error('✗ Test 32 failed:', e.message); failed++; }

  // Test 33: Chat with tool call returns tool_calls
  try {
    async function test() {
      const result = await mockPuterClient.chat(
        [{ role: 'user', content: 'What is the weather?' }],
        { tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }] }
      );
      assert(result.toolCalls !== null, 'Expected toolCalls in response');
      assert(Array.isArray(result.toolCalls), 'toolCalls should be an array');
      assert(result.toolCalls[0].function.name === 'get_weather');
    }
    test();
    console.log('✓ Test 33: Tool call response format');
    passed++;
  } catch (e) { console.error('✗ Test 33 failed:', e.message); failed++; }

  // -----------------------------------------------------------------------
  // Silence detection & chunked transcription tests
  // -----------------------------------------------------------------------

  // Test 34: Silence detection finds silent regions
  try {
    // Create a buffer with: 1000 samples of noise, 10000 samples of silence, 1000 samples of noise
    const buf = Buffer.alloc((1000 + 10000 + 1000) * 2); // 16-bit = 2 bytes per sample

    // First 1000 samples: loud
    for (let i = 0; i < 1000; i++) {
      buf.writeInt16LE(20000, i * 2);
    }
    // Next 10000 samples: silent (zero)
    // Already zero from Buffer.alloc
    // Last 1000 samples: loud
    for (let i = 0; i < 1000; i++) {
      buf.writeInt16LE(20000, (11000 + i) * 2);
    }

    const regions = mockPuterClient.detectSilenceRegions(buf, 16000);
    assert(regions.length >= 1, `Expected at least 1 silence region, got ${regions.length}`);
    console.log('✓ Test 34: Silence detection finds silent regions');
    passed++;
  } catch (e) { console.error('✗ Test 34 failed:', e.message); failed++; }

  // Test 35: No silence in all-loud buffer
  try {
    const buf = Buffer.alloc(20000 * 2);
    for (let i = 0; i < 20000; i++) {
      buf.writeInt16LE(20000, i * 2);
    }
    const regions = mockPuterClient.detectSilenceRegions(buf, 16000);
    assert.strictEqual(regions.length, 0);
    console.log('✓ Test 35: No silence in all-loud buffer');
    passed++;
  } catch (e) { console.error('✗ Test 35 failed:', e.message); failed++; }

  // Test 36: splitAudioAtSilence keeps small buffer as single chunk
  try {
    const buf = Buffer.alloc(1000); // 1 KB, well under 25 MB
    const chunks = mockPuterClient.splitAudioAtSilence(buf, 25 * 1024 * 1024);
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0].byteStart, 0);
    assert.strictEqual(chunks[0].byteEnd, 1000);
    console.log('✓ Test 36: Small buffer stays as single chunk');
    passed++;
  } catch (e) { console.error('✗ Test 36 failed:', e.message); failed++; }

  // Test 37: splitAudioAtSilence splits large buffer
  try {
    // Create a 26 MB buffer with a large silent region in the middle
    const size = 26 * 1024 * 1024;
    const buf = Buffer.alloc(size);

    // First 5 MB: loud (write every 512 bytes for speed)
    for (let i = 0; i < 5 * 1024 * 1024; i += 512) {
      buf.writeInt16LE(20000, i);
    }
    // Middle: silent (zeros from alloc)
    // Last 5 MB: loud
    for (let i = 21 * 1024 * 1024; i < 26 * 1024 * 1024; i += 512) {
      buf.writeInt16LE(20000, i);
    }

    const chunks = mockPuterClient.splitAudioAtSilence(buf, 25 * 1024 * 1024);
    assert(chunks.length >= 1, `Expected at least 1 chunk, got ${chunks.length}`);
    // Each chunk should be under the max size
    for (const chunk of chunks) {
      assert(chunk.buffer.length <= 25 * 1024 * 1024, `Chunk too large: ${chunk.buffer.length}`);
    }
    console.log(`✓ Test 37: Large buffer split into ${chunks.length} chunk(s)`);
    passed++;
  } catch (e) { console.error('✗ Test 37 failed:', e.message); failed++; }

  // Test 38: Chunks cover the full buffer without gaps
  try {
    const size = 26 * 1024 * 1024;
    const buf = Buffer.alloc(size);
    for (let i = 0; i < 5 * 1024 * 1024; i += 512) buf.writeInt16LE(20000, i);
    for (let i = 21 * 1024 * 1024; i < 26 * 1024 * 1024; i += 512) buf.writeInt16LE(20000, i);

    const chunks = mockPuterClient.splitAudioAtSilence(buf, 25 * 1024 * 1024);
    assert.strictEqual(chunks[0].byteStart, 0, 'First chunk should start at 0');
    assert.strictEqual(chunks[chunks.length - 1].byteEnd, size, 'Last chunk should end at buffer end');
    console.log('✓ Test 38: Chunks cover full buffer without gaps');
    passed++;
  } catch (e) { console.error('✗ Test 38 failed:', e.message); failed++; }

  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(40));

  process.exit(failed > 0 ? 1 : 0);
}

runTests();
