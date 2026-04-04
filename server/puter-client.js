/**
 * Puter.js integration client
 *
 * Provides chat (emulated streaming + non-streaming), TTS, image generation,
 * image caching, transcription, embeddings (simulated), model listing, and connectivity checks.
 */

const { init } = require("@heyputer/puter.js/src/init.cjs");
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let puterInstance = null;
let puterOnline = false;

// ---------------------------------------------------------------------------
// Image cache directory
// ---------------------------------------------------------------------------

const IMAGE_CACHE_DIR = path.join(__dirname, '..', 'cache', 'images');

function ensureImageCacheDir() {
  if (!fs.existsSync(IMAGE_CACHE_DIR)) {
    fs.mkdirSync(IMAGE_CACHE_DIR, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Puter init
// ---------------------------------------------------------------------------

function initPuter() {
  if (puterInstance) return puterInstance;
  // Priority: env var > config file
  const authToken = process.env.PUTER_AUTH_TOKEN
    || process.env.puterAuthToken
    || (function() { try { return require('./config').getConfig().puterAuthToken; } catch { return ''; } })();
  puterInstance = init(authToken);
  return puterInstance;
}

function isPuterOnline() {
  return puterOnline;
}

async function listModels() {
  const puter = initPuter();
  try {
    const models = await puter.ai.listModels();
    puterOnline = true;
    return models;
  } catch (error) {
    puterOnline = false;
    throw error;
  }
}

async function checkConnectivity() {
  try {
    await listModels();
    return true;
  } catch (error) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Token counting (emulator-side, always used)
// ---------------------------------------------------------------------------

/**
 * Estimate tokens for text. 4 chars ≈ 1 token.
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Count tokens for an array of messages.
 */
function countMessageTokens(messages) {
  if (!Array.isArray(messages)) return estimateTokens(messages || '');
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content || '');
    total += estimateTokens(msg.role || '');
    if (msg.name) total += estimateTokens(msg.name);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Chat (non-streaming)
// ---------------------------------------------------------------------------

async function chat(messagesOrPrompt, options = {}) {
  const puter = initPuter();

  const puterOptions = {};
  if (options.model) puterOptions.model = options.model;
  if (options.temperature !== undefined) puterOptions.temperature = options.temperature;
  if (options.max_tokens !== undefined) puterOptions.max_tokens = options.max_tokens;
  // Pass through tools for function calling
  if (options.tools) puterOptions.tools = options.tools;
  if (options.tool_choice) puterOptions.tool_choice = options.tool_choice;

  try {
    const response = await puter.ai.chat(messagesOrPrompt, puterOptions);
    puterOnline = true;

    let text = '';
    let toolCalls = null;

    if (typeof response === 'string') {
      text = response;
    } else if (response && typeof response === 'object') {
      if (response.message && typeof response.message === 'object') {
        text = response.message.content || '';
        // Extract tool calls if present
        if (response.message.tool_calls && Array.isArray(response.message.tool_calls)) {
          toolCalls = response.message.tool_calls;
        }
      } else if (typeof response.message === 'string') {
        text = response.message;
      } else if (response.content) {
        text = response.content;
      } else if (response.text) {
        text = response.text;
      }
    }

    if (!text && !toolCalls) {
      throw new Error('Backend returned empty response');
    }

    return { text, toolCalls };
  } catch (error) {
    puterOnline = false;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Chat (emulated streaming)
//
// Get the full response, then split it into word-level SSE chunks.
// This gives clients a realistic streaming experience without requiring
// Puter's native stream support.
// ---------------------------------------------------------------------------

/**
 * Split text into word-level chunks for emulated streaming.
 * Returns an array of { content: string } objects.
 */
function splitIntoChunks(text, chunkSize = 4) {
  const words = text.split(/(\s+)/).filter(Boolean);
  const chunks = [];
  let current = '';

  for (const word of words) {
    current += word;
    if (current.length >= chunkSize || word === '\n') {
      chunks.push({ content: current });
      current = '';
    }
  }
  if (current) {
    chunks.push({ content: current });
  }
  return chunks.length > 0 ? chunks : [{ content: text }];
}

/**
 * Returns an async iterable of OpenAI-style SSE chunk strings.
 * Emulates streaming by splitting the full response into small chunks.
 */
async function* chatStreamEmulated(messagesOrPrompt, options = {}) {
  // Get the full response first
  const result = await chat(messagesOrPrompt, options);
  const text = result.text || '';
  const chunks = splitIntoChunks(text);

  const completionId = `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  const model = options.model || 'unknown';
  const created = Math.floor(Date.now() / 1000);

  // Yield content chunks
  for (let i = 0; i < chunks.length; i++) {
    const sseChunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{
        index: 0,
        delta: { content: chunks[i].content },
        finish_reason: null
      }]
    };
    yield `data: ${JSON.stringify(sseChunk)}\n\n`;

    // Small delay to simulate real streaming
    await new Promise(r => setTimeout(r, 15));
  }

  // Final chunk with finish_reason
  const finalChunk = {
    id: completionId,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{
      index: 0,
      delta: {},
      finish_reason: 'stop'
    }]
  };

  yield `data: ${JSON.stringify(finalChunk)}\n\n`;
  yield 'data: [DONE]\n\n';
}

// ---------------------------------------------------------------------------
// Text-to-Speech
// ---------------------------------------------------------------------------

/**
 * Returns a data-URI string for the generated audio.
 */
async function textToSpeech(text, options = {}) {
  const puter = initPuter();

  const puterOptions = {};
  if (options.voice) puterOptions.voice = options.voice;
  if (options.engine) puterOptions.engine = options.engine;
  if (options.language) puterOptions.language = options.language;
  if (options.provider) puterOptions.provider = options.provider;

  try {
    const audio = await puter.ai.txt2speech(text, puterOptions);
    puterOnline = true;

    const dataUri = audio.src;

    let contentType = 'audio/mpeg';
    if (dataUri.startsWith('data:')) {
      const match = dataUri.match(/^data:([^;]+);/);
      if (match) contentType = match[1];
    }

    const base64 = dataUri.includes(',') ? dataUri.split(',')[1] : dataUri;

    return { base64, contentType, dataUri };
  } catch (error) {
    puterOnline = false;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Image Generation with disk caching
// ---------------------------------------------------------------------------

/**
 * Generates an image and caches it to disk.
 * Returns { url, cached, contentType }.
 * URL is a local HTTP path: /cache/images/<hash>.png
 */
async function generateImage(prompt, options = {}) {
  const puter = initPuter();

  const puterOptions = {};
  if (options.model) puterOptions.model = options.model;
  if (options.size) {
    const match = options.size.match(/^(\d+)x(\d+)$/);
    if (match) {
      puterOptions.ratio = { w: parseInt(match[1], 10), h: parseInt(match[2], 10) };
    }
  }

  try {
    const img = await puter.ai.txt2img(prompt, puterOptions);
    puterOnline = true;

    const dataUri = img.src;
    let contentType = 'image/png';
    if (dataUri.startsWith('data:')) {
      const match = dataUri.match(/^data:([^;]+);/);
      if (match) contentType = match[1];
    }

    const base64 = dataUri.includes(',') ? dataUri.split(',')[1] : dataUri;

    // Determine extension from content type
    const ext = contentType.split('/')[1] || 'png';

    // Cache to disk
    ensureImageCacheDir();
    const hash = crypto.createHash('md5').update(prompt + Date.now()).digest('hex');
    const filename = `${hash}.${ext}`;
    const filepath = path.join(IMAGE_CACHE_DIR, filename);

    const buffer = Buffer.from(base64, 'base64');
    fs.writeFileSync(filepath, buffer);

    return {
      url: `/cache/images/${filename}`,
      cached: false,
      contentType
    };
  } catch (error) {
    puterOnline = false;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Speech-to-Text / Transcription (server-managed for large files)
// ---------------------------------------------------------------------------

const TEMP_DIR = path.join(__dirname, '..', 'cache', 'temp');
const MAX_PUTER_SIZE = 25 * 1024 * 1024; // 25 MB
const SILENCE_THRESHOLD = 0.01;  // RMS amplitude below this = silence
const MIN_SILENCE_FRAMES = 8000; // minimum consecutive silent samples (~0.18s at 44.1kHz)

function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
}

/**
 * Detect silence regions in a raw PCM buffer (16-bit little-endian).
 * Returns an array of { start, end } byte offsets where silence occurs.
 * Optimized: samples every Nth sample for speed on large buffers.
 */
function detectSilenceRegions(buffer, sampleRate = 16000) {
  const regions = [];
  let silenceStart = -1;
  let silentFrames = 0;

  const totalSamples = Math.floor(buffer.length / 2);
  // Sample every 256th sample for speed (still accurate enough for silence detection)
  const step = totalSamples > 1000000 ? 256 : 1;

  for (let i = 0; i < totalSamples; i += step) {
    const byteOffset = i * 2;
    const sample = buffer.readInt16LE(byteOffset);
    const amplitude = Math.abs(sample) / 32768;

    if (amplitude < SILENCE_THRESHOLD) {
      if (silenceStart === -1) {
        silenceStart = byteOffset;
      }
      silentFrames += step;
    } else {
      if (silentFrames >= MIN_SILENCE_FRAMES) {
        regions.push({ start: silenceStart, end: byteOffset });
      }
      silenceStart = -1;
      silentFrames = 0;
    }
  }

  // Handle trailing silence
  if (silentFrames >= MIN_SILENCE_FRAMES) {
    regions.push({ start: silenceStart, end: buffer.length });
  }

  return regions;
}

/**
 * Split audio buffer at silence points so each chunk fits under maxSize.
 * Returns an array of { buffer, byteStart, byteEnd } objects.
 * Fully iterative — no recursion.
 */
function splitAudioAtSilence(buffer, maxSize = MAX_PUTER_SIZE) {
  // If already small enough, return as single chunk
  if (buffer.length <= maxSize) {
    return [{ buffer, byteStart: 0, byteEnd: buffer.length }];
  }

  // Try to detect silence regions
  const silenceRegions = detectSilenceRegions(buffer);

  if (silenceRegions.length === 0) {
    // No silence found — split at fixed intervals
    const chunkSize = Math.floor(maxSize * 0.8); // 80% of max for safety
    const chunks = [];
    for (let offset = 0; offset < buffer.length; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, buffer.length);
      chunks.push({
        buffer: buffer.subarray(offset, end),
        byteStart: offset,
        byteEnd: end
      });
    }
    return chunks;
  }

  // Build split points: use silence region starts as natural split points
  // Also add forced split points every maxSize bytes to guarantee no chunk exceeds limit
  const splitPoints = new Set();

  // Add silence-based split points
  for (const region of silenceRegions) {
    splitPoints.add(region.start);
  }

  // Add forced split points every maxSize bytes
  for (let offset = maxSize; offset < buffer.length; offset += maxSize) {
    // Try to find the nearest silence region to this offset (within 2 MB)
    let bestSplit = offset;
    for (const region of silenceRegions) {
      if (Math.abs(region.start - offset) < 2 * 1024 * 1024) {
        bestSplit = region.start;
        break;
      }
    }
    splitPoints.add(bestSplit);
  }

  // Convert to sorted array
  const points = Array.from(splitPoints).sort((a, b) => a - b);

  // Build chunks from split points
  const chunks = [];
  let prev = 0;

  for (const point of points) {
    if (point <= prev) continue;
    if (point > buffer.length) break;

    const chunkEnd = Math.min(point, buffer.length);
    if (chunkEnd - prev > 0) {
      chunks.push({
        buffer: buffer.subarray(prev, chunkEnd),
        byteStart: prev,
        byteEnd: chunkEnd
      });
    }
    prev = chunkEnd;
  }

  // Add remaining data
  if (prev < buffer.length) {
    chunks.push({
      buffer: buffer.subarray(prev),
      byteStart: prev,
      byteEnd: buffer.length
    });
  }

  return chunks.length > 0 ? chunks : [{ buffer, byteStart: 0, byteEnd: buffer.length }];
}

/**
 * Transcribes audio. Accepts a Buffer, base64 string, or data URI.
 * For files > 25 MB, splits at silence points, transcribes each chunk,
 * and returns results as an array of parts.
 *
 * Returns:
 *   { text, language?, parts?: [{ text, byteStart, byteEnd, index }] }
 *   When the file is small, returns { text, language? } directly.
 *   When split into chunks, returns { text: combined, language?, parts: [...] }
 */
async function transcribeAudio(source, options = {}) {
  const puter = initPuter();

  const puterOptions = {};
  if (options.model) puterOptions.model = options.model;
  if (options.language) puterOptions.language = options.language;
  if (options.response_format) puterOptions.response_format = options.response_format;

  try {
    let sourceBuffer;

    if (Buffer.isBuffer(source)) {
      sourceBuffer = source;
    } else if (typeof source === 'string') {
      if (source.startsWith('data:')) {
        const [, base64] = source.split(',');
        sourceBuffer = Buffer.from(base64, 'base64');
      } else {
        sourceBuffer = Buffer.from(source, 'base64');
      }
    } else {
      throw new Error('Unsupported audio source format');
    }

    const isLarge = sourceBuffer.length > MAX_PUTER_SIZE;

    if (!isLarge) {
      // Small file — transcribe directly
      const blob = new Blob([sourceBuffer]);
      const result = await puter.ai.speech2txt(blob, puterOptions);
      puterOnline = true;

      if (typeof result === 'string') {
        return { text: result };
      }
      return {
        text: result.text || '',
        language: result.language || null
      };
    }

    // Large file — split at silence, transcribe each chunk
    console.log(`[${new Date().toISOString()}] INFO: Large audio file (${(sourceBuffer.length / 1024 / 1024).toFixed(1)} MB), splitting at silence points`);

    const chunks = splitAudioAtSilence(sourceBuffer, MAX_PUTER_SIZE);
    console.log(`[${new Date().toISOString()}] INFO: Split into ${chunks.length} chunk(s) for transcription`);

    const parts = [];
    const allText = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const blob = new Blob([chunk.buffer]);

      const result = await puter.ai.speech2txt(blob, puterOptions);
      puterOnline = true;

      const chunkText = typeof result === 'string' ? result : (result.text || '');
      const chunkLang = typeof result === 'string' ? null : (result.language || null);

      allText.push(chunkText);

      parts.push({
        index: i,
        text: chunkText,
        byteStart: chunk.byteStart,
        byteEnd: chunk.byteEnd,
        language: chunkLang
      });

      console.log(`[${new Date().toISOString()}] INFO: Chunk ${i + 1}/${chunks.length} transcribed: ${chunkText.length} chars`);
    }

    return {
      text: allText.join(' ').trim(),
      language: parts.find(p => p.language)?.language || null,
      parts,
      chunked: true
    };
  } catch (error) {
    puterOnline = false;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Embeddings (simulated — Puter has no embedding API)
//
// Generates deterministic pseudo-random vectors based on input text hash.
// This allows clients to test embedding workflows.
// ---------------------------------------------------------------------------

/**
 * Generate a simulated embedding vector for the given input.
 * Uses a seeded PRNG so the same input always produces the same vector.
 *
 * @param {string} input - The text to embed
 * @param {number} dimensions - Vector dimensions (default 1536, like text-embedding-ada-002)
 * @returns {number[]} Float32-like array of values between -1 and 1
 */
function generateEmbedding(input, dimensions = 1536) {
  // Seed from input text hash
  const hash = crypto.createHash('sha256').update(input).digest();

  // Simple seeded PRNG (mulberry32)
  let seed = 0;
  for (let i = 0; i < 8; i++) {
    seed = (seed << 8) | hash[i];
  }
  seed = seed >>> 0; // ensure unsigned

  function mulberry32() {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Generate normalized vector
  const vector = [];
  let sumSq = 0;
  for (let i = 0; i < dimensions; i++) {
    const val = (mulberry32() - 0.5) * 2; // -1 to 1
    vector.push(val);
    sumSq += val * val;
  }

  // L2 normalize
  const norm = Math.sqrt(sumSq);
  for (let i = 0; i < dimensions; i++) {
    vector[i] = vector[i] / norm;
  }

  return vector;
}

// ---------------------------------------------------------------------------
// Error handling helpers
// ---------------------------------------------------------------------------

function classifyError(error) {
  const msg = (error.message || '').toLowerCase();
  const code = error.code || '';

  const networkCodes = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'ENETUNREACH', 'EAI_AGAIN'];
  if (networkCodes.includes(code)) {
    return { statusCode: 503, type: 'service_unavailable' };
  }
  if (msg.includes('network') || msg.includes('timeout') || msg.includes('connect') ||
      msg.includes('offline') || msg.includes('unavailable') || msg.includes('empty response')) {
    return { statusCode: 503, type: 'service_unavailable' };
  }

  if (msg.includes('auth') || msg.includes('token') || msg.includes('unauthorized')) {
    return { statusCode: 401, type: 'authentication_error' };
  }
  if (msg.includes('permission') || msg.includes('forbidden')) {
    return { statusCode: 403, type: 'permission_error' };
  }
  if (msg.includes('rate') || msg.includes('limit') || msg.includes('quota')) {
    return { statusCode: 429, type: 'rate_limit_error' };
  }
  if (msg.includes('invalid') || msg.includes('bad request')) {
    return { statusCode: 400, type: 'invalid_request_error' };
  }
  if (msg.includes('not found')) {
    return { statusCode: 404, type: 'not_found_error' };
  }

  return { statusCode: 500, type: 'internal_server_error' };
}

function resetPuter() {
  puterInstance = null;
  puterOnline = false;
}

module.exports = {
  chat,
  chatStreamEmulated,
  textToSpeech,
  generateImage,
  transcribeAudio,
  generateEmbedding,
  detectSilenceRegions,
  splitAudioAtSilence,
  listModels,
  checkConnectivity,
  isPuterOnline,
  resetPuter,
  estimateTokens,
  countMessageTokens,
  classifyError
};
