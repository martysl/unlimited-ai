#!/usr/bin/env node

/**
 * Puter Local Model Emulator - Main Server
 *
 * OpenAI-compatible endpoints backed by Puter AI:
 *  - POST /v1/chat/completions   (emulated streaming + non-streaming + tools)
 *  - GET  /v1/models
 *  - POST /v1/audio/speech
 *  - POST /v1/images/generations
 *  - POST /v1/audio/transcriptions
 *  - POST /v1/embeddings
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const {
  getConfig, updateConfig, getModelsCache, isModelsCacheStale, saveModelsCache,
  getSavedConfigs, addSavedConfig, updateSavedConfig, deleteSavedConfig,
  getSavedConfigById, getLastConfig,
  getCustomModels, addCustomModel, updateCustomModel, deleteCustomModel, getCustomModelById,
  resolveModel, checkModelAccess
} = require('./config');
const { handleChatCompletion } = require('./openai-adapter');
const { logInfo, logError, getHealthInfo } = require('./logger');
const {
  listModels, checkConnectivity, isPuterOnline,
  textToSpeech, generateImage, transcribeAudio,
  generateEmbedding, estimateTokens, countMessageTokens
} = require('./puter-client');

const MODELS_TTL_MS = 1000 * 60 * 30; // 30 minutes

const app = express();

// Use larger limit for transcription/uploads (25 MB+)
app.use(express.json({ limit: '50mb' }));
app.use(express.raw({ type: 'audio/*', limit: '50mb' }));
app.use(express.raw({ type: 'multipart/form-data', limit: '50mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Ensure cache directories exist
const CACHE_IMG_DIR = path.join(__dirname, '..', 'cache', 'images');
const CACHE_TEMP_DIR = path.join(__dirname, '..', 'cache', 'temp');
if (!fs.existsSync(CACHE_IMG_DIR)) fs.mkdirSync(CACHE_IMG_DIR, { recursive: true });
if (!fs.existsSync(CACHE_TEMP_DIR)) fs.mkdirSync(CACHE_TEMP_DIR, { recursive: true });

// Serve cached images
app.use('/cache/images', express.static(CACHE_IMG_DIR));

// ---------------------------------------------------------------------------
// API Key Middleware
// ---------------------------------------------------------------------------

/**
 * Validate the API key from Authorization header or query string.
 * Configured key defaults to "sk-puter-123".
 * Health, config, emulator control, and static routes are exempt.
 */
function requireApiKey(req, res, next) {
  const config = getConfig();
  const expectedKey = config.apiKey || 'sk-puter-123';

  // Extract key from header or query
  const authHeader = req.headers.authorization || '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const providedKey = bearerMatch
    ? bearerMatch[1]
    : (req.query.api_key || req.headers['x-api-key'] || '');

  if (!providedKey) {
    return res.status(401).json({
      error: {
        message: 'No API key provided. Use Authorization: Bearer <key> or ?api_key=<key>',
        type: 'invalid_request_error'
      }
    });
  }

  if (providedKey !== expectedKey) {
    return res.status(401).json({
      error: {
        message: 'Invalid API key',
        type: 'invalid_request_error'
      }
    });
  }

  next();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeModel(model) {
  if (!model) return null;
  if (typeof model === 'string') {
    return { id: model, label: model, provider: 'puter', isFree: true };
  }

  const id = model.id || model.model || model.name;
  if (!id) return null;

  return {
    id,
    label: model.title || model.label || model.display_name || id,
    provider: model.provider || model.source || 'puter',
    isFree: Boolean(model.isFree ?? model.free ?? model.is_free ?? model.free_tier),
    price: model.price || model.cost || model.pricing || null
  };
}

async function getModels(force = false) {
  const cache = getModelsCache();
  if (!force && cache.models.length && !isModelsCacheStale(MODELS_TTL_MS)) {
    return { models: cache.models, lastUpdated: cache.lastUpdated, puterOnline: isPuterOnline(), source: 'cache' };
  }

  try {
    const models = await listModels();
    const normalized = (models || [])
      .map(normalizeModel)
      .filter(Boolean);
    saveModelsCache(normalized);
    return { models: normalized, lastUpdated: Date.now(), puterOnline: true, source: 'puter' };
  } catch (error) {
    return { models: cache.models || [], lastUpdated: cache.lastUpdated || null, puterOnline: false, error: error.message, source: 'cache' };
  }
}

function buildEndpoint() {
  const config = getConfig();
  const port = process.env.PORT || config.port || 11436;
  return `http://localhost:${port}/v1/chat/completions`;
}

async function buildStatePayload(forceModels = false) {
  const config = getConfig();
  const models = await getModels(forceModels);
  const health = getHealthInfo();

  return {
    endpoint: buildEndpoint(),
    config,
    presets: getSavedConfigs(),
    models: models.models,
    modelsLastUpdated: models.lastUpdated,
    customModels: getCustomModels(),
    puterOnline: models.puterOnline,
    lastConfig: getLastConfig(),
    health: {
      lastSuccessfulCompletion: health.lastSuccessfulCompletion,
      lastError: health.lastError
    }
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible endpoints (all require API key)
// ---------------------------------------------------------------------------

// GET /v1/models — OpenAI-style model list
app.get('/v1/models', requireApiKey, async (req, res) => {
  try {
    const modelsData = await getModels(req.query.force === 'true');
    const config = getConfig();
    const aliases = config.modelAliases || {};
    const customModels = getCustomModels();

    const data = [];

    // Add custom models first (user-defined names)
    for (const cm of customModels) {
      data.push({
        id: cm.name,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'custom',
        active: true,
        puter_model: cm.puterModel
      });
    }

    // Add Puter models
    for (const m of (modelsData.models || [])) {
      data.push({
        id: m.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: m.provider || 'puter',
        active: true
      });
    }

    // Expose aliased models as separate entries
    for (const [alias, target] of Object.entries(aliases)) {
      data.push({
        id: alias,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'alias',
        active: true,
        aliases_to: target
      });
    }

    res.json({
      object: 'list',
      data
    });
  } catch (error) {
    logError(error, { endpoint: '/v1/models' });
    res.status(500).json({ error: { message: 'Failed to list models', type: 'internal_server_error' } });
  }
});

// POST /v1/chat/completions — with emulated streaming + tool calling
app.post('/v1/chat/completions', requireApiKey, async (req, res) => {
  try {
    const modelsData = await getModels(false);
    const knownModelIds = (modelsData.models || []).map(m => m.id);

    const result = await handleChatCompletion(req.body, knownModelIds);

    if (result.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      for await (const chunk of result.streamGenerator) {
        res.write(chunk);
      }

      res.end();
      return;
    }

    res.status(result.statusCode).json(result.body);
  } catch (error) {
    logError(error, { endpoint: '/v1/chat/completions' });
    res.status(500).json({ error: { message: 'Internal server error', type: 'internal_server_error' } });
  }
});

// POST /v1/audio/speech — Text-to-Speech
app.post('/v1/audio/speech', requireApiKey, async (req, res) => {
  try {
    const { input, model, voice, response_format } = req.body;

    if (!input) {
      return res.status(400).json({ error: { message: 'input field is required', type: 'invalid_request_error' } });
    }

    const { puterModel } = resolveModel(model, []);

    logInfo(`TTS request: model=${puterModel}, voice=${voice || 'default'}, format=${response_format || 'mp3'}`);

    const ttsOptions = {};
    if (voice) ttsOptions.voice = voice;
    if (model) ttsOptions.provider = model;

    const result = await textToSpeech(input, ttsOptions);

    // JSON response for API compatibility
    if (req.headers.accept === 'application/json') {
      return res.json({
        model: puterModel,
        format: response_format || 'mp3',
        data: result.base64
      });
    }

    // Raw audio
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="speech.${response_format || 'mp3'}"`);
    res.send(Buffer.from(result.base64, 'base64'));
  } catch (error) {
    logError(error, { endpoint: '/v1/audio/speech' });
    const { statusCode, type } = require('./puter-client').classifyError(error);
    res.status(statusCode).json({ error: { message: error.message, type } });
  }
});

// POST /v1/images/generations — Image Generation (cached to disk)
app.post('/v1/images/generations', requireApiKey, async (req, res) => {
  try {
    const { prompt, model, n = 1, size, response_format = 'url' } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: { message: 'prompt field is required', type: 'invalid_request_error' } });
    }

    logInfo(`Image generation: model=${model || 'default'}, prompt=${prompt.substring(0, 80)}...`);

    const imgOptions = {};
    if (model) imgOptions.model = model;
    if (size) imgOptions.size = size;

    const images = [];
    for (let i = 0; i < Math.min(n, 4); i++) {
      const result = await generateImage(prompt, imgOptions);

      if (response_format === 'b64_json') {
        // Read the cached file and return base64
        const filepath = path.join(__dirname, '..', result.url);
        const fileData = require('fs').readFileSync(filepath);
        images.push({ b64_json: fileData.toString('base64') });
      } else {
        // Return full URL
        const config = getConfig();
        const port = process.env.PORT || config.port || 11436;
        images.push({ url: `http://localhost:${port}${result.url}` });
      }
    }

    res.json({
      created: Math.floor(Date.now() / 1000),
      data: images
    });
  } catch (error) {
    logError(error, { endpoint: '/v1/images/generations' });
    const { statusCode, type } = require('./puter-client').classifyError(error);
    res.status(statusCode).json({ error: { message: error.message, type } });
  }
});

// POST /v1/audio/transcriptions — Speech-to-Text (server-managed for large files)
app.post('/v1/audio/transcriptions', requireApiKey, async (req, res) => {
  try {
    let audioSource = null;
    let language = null;
    let model = req.body?.model;
    let responseFormat = req.body?.response_format;

    if (req.body && Buffer.isBuffer(req.body)) {
      audioSource = req.body;
    }

    if (req.file) {
      audioSource = req.file.buffer;
    }

    if (!audioSource && req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      if (req.body.audio) {
        audioSource = req.body.audio;
      }
      if (req.body.language) language = req.body.language;
      if (req.body.model) model = req.body.model;
      if (req.body.response_format) responseFormat = req.body.response_format;
    }

    if (!audioSource) {
      return res.status(400).json({
        error: {
          message: 'audio file is required. Send as multipart/form-data with field "file", or as base64 in JSON body under "audio"',
          type: 'invalid_request_error'
        }
      });
    }

    logInfo(`Transcription: model=${model || 'default'}, language=${language || 'auto'}, size=${Buffer.isBuffer(audioSource) ? (audioSource.length / 1024 / 1024).toFixed(1) + ' MB' : 'unknown'}`);

    const transcribeOptions = {};
    if (model) transcribeOptions.model = model;
    if (language) transcribeOptions.language = language;
    if (responseFormat) transcribeOptions.response_format = responseFormat;

    const result = await transcribeAudio(audioSource, transcribeOptions);

    if (responseFormat === 'text') {
      res.setHeader('Content-Type', 'text/plain');
      return res.send(result.text);
    }

    if (responseFormat === 'json') {
      const resp = { text: result.text };
      if (result.chunked) resp.parts = result.parts;
      return res.json(resp);
    }

    if (responseFormat === 'verbose_json') {
      return res.json({
        text: result.text,
        language: result.language || 'unknown',
        duration: 0,
        segments: result.parts || [],
        chunked: result.chunked || false
      });
    }

    // Default response — include parts if chunked
    const resp = { text: result.text };
    if (result.chunked) {
      resp.parts = result.parts;
    }
    res.json(resp);
  } catch (error) {
    logError(error, { endpoint: '/v1/audio/transcriptions' });
    const { statusCode, type } = require('./puter-client').classifyError(error);
    res.status(statusCode).json({ error: { message: error.message, type } });
  }
});

// POST /v1/embeddings — Simulated embeddings (Puter has no embedding API)
app.post('/v1/embeddings', requireApiKey, async (req, res) => {
  try {
    const { input, model, encoding_format = 'float' } = req.body;

    if (!input) {
      return res.status(400).json({ error: { message: 'input field is required', type: 'invalid_request_error' } });
    }

    const inputs = Array.isArray(input) ? input : [input];
    const modelName = model || 'text-embedding-ada-002';
    const dimensions = 1536; // Standard for ada-002

    logInfo(`Embeddings: model=${modelName}, inputs=${inputs.length}`);

    const data = inputs.map((text, idx) => {
      const vector = generateEmbedding(text, dimensions);
      const tokenCount = estimateTokens(text);

      return {
        object: 'embedding',
        index: idx,
        embedding: encoding_format === 'base64'
          ? Buffer.from(new Float32Array(vector).buffer).toString('base64')
          : vector,
        prompt_tokens: tokenCount
      };
    });

    const totalTokens = inputs.reduce((sum, t) => sum + estimateTokens(t), 0);

    res.json({
      object: 'list',
      data,
      model: modelName,
      usage: {
        prompt_tokens: totalTokens,
        total_tokens: totalTokens
      }
    });
  } catch (error) {
    logError(error, { endpoint: '/v1/embeddings' });
    const { statusCode, type } = require('./puter-client').classifyError(error);
    res.status(statusCode).json({ error: { message: error.message, type } });
  }
});

// ---------------------------------------------------------------------------
// Health & config endpoints (no API key required)
// ---------------------------------------------------------------------------

app.get('/health', async (req, res) => {
  try {
    const online = await checkConnectivity();
    res.json({ online: online === true, message: online ? 'Puter is reachable' : 'Puter appears offline' });
  } catch (error) {
    res.status(503).json({ online: false, message: error.message || 'Unable to reach Puter' });
  }
});

app.get('/config/state', async (req, res) => {
  const force = req.query.force === 'true';
  const payload = await buildStatePayload(force);
  res.json(payload);
});

app.post('/config/save', (req, res) => {
  const { puterModelId, spoofedOpenAIModelId, port, apiKey } = req.body;
  const updates = {};
  if (puterModelId !== undefined) updates.puterModel = puterModelId;
  if (spoofedOpenAIModelId !== undefined) updates.spoofedOpenAIModelId = spoofedOpenAIModelId;
  if (port !== undefined) updates.port = parseInt(port, 10);
  if (apiKey !== undefined) updates.apiKey = apiKey;

  const success = updateConfig(updates);
  if (success) {
    res.json({ success: true, config: getConfig() });
  } else {
    res.status(500).json({ success: false, error: 'Failed to save configuration' });
  }
});

app.post('/config/savePreset', (req, res) => {
  const { id, name, puterModelId, spoofedOpenAIModelId } = req.body;
  if (!name?.trim()) return res.status(400).json({ success: false, error: 'Name is required' });
  if (!puterModelId) return res.status(400).json({ success: false, error: 'Puter model ID is required' });

  if (id) {
    if (!getSavedConfigById(id)) return res.status(404).json({ success: false, error: 'Preset not found' });
    const ok = updateSavedConfig(id, name.trim(), puterModelId, spoofedOpenAIModelId);
    const updated = ok ? getSavedConfigById(id) : null;
    return ok ? res.json({ success: true, preset: updated }) : res.status(500).json({ success: false, error: 'Failed to update preset' });
  }

  const preset = addSavedConfig(name.trim(), puterModelId, spoofedOpenAIModelId);
  if (preset) return res.json({ success: true, preset });
  return res.status(500).json({ success: false, error: 'Failed to save preset' });
});

// Legacy models cache endpoint (non-OpenAI format)
app.get('/models', async (req, res) => {
  const force = req.query.force === 'true';
  const models = await getModels(force);
  res.json(models);
});

// ---------------------------------------------------------------------------
// Custom Model Management
// ---------------------------------------------------------------------------

app.get('/models/custom', requireApiKey, (req, res) => {
  res.json({ customModels: getCustomModels() });
});

app.post('/models/custom', requireApiKey, (req, res) => {
  const { name, puterModel } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!puterModel) return res.status(400).json({ error: 'Puter model is required' });

  // Check for duplicate name
  if (getCustomModelByName(name)) {
    return res.status(409).json({ error: `Model "${name}" already exists` });
  }

  const model = addCustomModel(name.trim(), puterModel);
  if (model) return res.json({ success: true, model });
  res.status(500).json({ error: 'Failed to create model' });
});

app.put('/models/custom/:id', requireApiKey, (req, res) => {
  const { name, puterModel } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name.trim();
  if (puterModel !== undefined) updates.puterModel = puterModel;

  const model = updateCustomModel(req.params.id, updates);
  if (model) return res.json({ success: true, model });
  res.status(404).json({ error: 'Model not found' });
});

app.delete('/models/custom/:id', requireApiKey, (req, res) => {
  const ok = deleteCustomModel(req.params.id);
  if (ok) return res.json({ success: true });
  res.status(404).json({ error: 'Model not found' });
});

// Shutdown endpoint
app.post('/shutdown', (req, res) => {
  logInfo('Shutdown requested from UI');
  res.json({ success: true, message: 'Shutting down...' });
  setTimeout(() => process.exit(0), 500);
});

// Root redirect
app.get('/', (req, res) => res.redirect('/config.html'));

// Docs redirect
app.get('/docs', (req, res) => res.redirect('/docs.html'));

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

function startServer() {
  const config = getConfig();
  const port = process.env.PORT || config.port || 11436;

  const host = process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';
  const server = app.listen(port, host, () => {
    logInfo(`Puter Local Model Emulator started on http://localhost:${port}`);
    logInfo(`OpenAI endpoint: ${buildEndpoint()}`);
    logInfo(`API Key: ${config.apiKey || 'sk-puter-123'}`);
    logInfo(`Custom models: ${getCustomModels().length}`);
    logInfo(`Config UI: http://localhost:${port}/config.html`);

    // Refresh models cache in background
    getModels(true)
      .then(({ models }) => {
        saveModelsCache(models);
        logInfo(`Models cache: ${models.length} models`);
      })
      .catch(() => logInfo('Models cache refresh failed - using cached data'));
  });

  const shutdown = (signal) => {
    logInfo(`${signal} received, shutting down...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };
