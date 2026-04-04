/**
 * Configuration manager for the model emulator
 *
 * Supports:
 *  - customModels: array of { id, name, puterModel } — all always active
 *  - defaultModel: fallback when requested model doesn't match any custom model
 *  - modelAliases: legacy map of alias -> Puter model
 *  - modelAllowlist / modelBlocklist: access control
 *  - Backward compatibility with legacy puterModel / spoofedOpenAIModelId
 */

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const CONFIG_PATH = path.join(CONFIG_DIR, 'default.json');
const MODELS_CACHE_PATH = path.join(CONFIG_DIR, 'models-cache.json');
const SAVED_CONFIGS_PATH = path.join(CONFIG_DIR, 'saved-configs.json');

// Ensure config directory exists so the UI can write cache/preset files
if (!fs.existsSync(CONFIG_DIR)) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

let cachedConfig = null;
let cachedModels = null;
let cachedSavedConfigs = null;
let configMtime = null;
const MODELS_CACHE_TTL = 1000 * 60 * 30; // 30 minutes

function generateId() {
  return `mdl-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

// Main Configuration

function getConfig() {
  try {
    if (cachedConfig) {
      const stats = fs.statSync(CONFIG_PATH);
      if (configMtime && stats.mtime.getTime() === configMtime) {
        return cachedConfig;
      }
      configMtime = stats.mtime.getTime();
    }

    cachedConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    configMtime = fs.statSync(CONFIG_PATH).mtime.getTime();
    return cachedConfig;
  } catch (error) {
    return getDefaultConfig();
  }
}

function getDefaultConfig() {
  return {
    port: 11436,
    backend: 'puter',
    // Legacy single-model fields (backward compatible)
    puterModel: 'gpt-4o',
    spoofedOpenAIModelId: 'gpt-4o-mini',
    // Multi-model: custom models with user-defined names
    customModels: [],
    // Fallback when no custom model matches
    defaultModel: 'gpt-4o',
    // Legacy alias map
    modelAliases: {},
    modelAllowlist: [],
    modelBlocklist: [],
    logging: { enabled: true, logRequests: true, logErrors: true }
  };
}

function updateConfig(updates) {
  const config = { ...getConfig(), ...updates };
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    cachedConfig = config;
    configMtime = fs.statSync(CONFIG_PATH).mtime.getTime();
    return true;
  } catch (error) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Custom Model CRUD
// ---------------------------------------------------------------------------

function getCustomModels() {
  return getConfig().customModels || [];
}

function addCustomModel(name, puterModel) {
  const config = getConfig();
  const models = config.customModels || [];
  const newModel = { id: generateId(), name, puterModel };
  models.push(newModel);
  return updateConfig({ customModels: models }) ? newModel : null;
}

function updateCustomModel(modelId, updates) {
  const config = getConfig();
  const models = config.customModels || [];
  const idx = models.findIndex(m => m.id === modelId);
  if (idx === -1) return null;
  Object.assign(models[idx], updates);
  return updateConfig({ customModels: models }) ? models[idx] : null;
}

function deleteCustomModel(modelId) {
  const config = getConfig();
  const models = config.customModels || [];
  const filtered = models.filter(m => m.id !== modelId);
  if (filtered.length === models.length) return false;
  return updateConfig({ customModels: filtered });
}

function getCustomModelById(modelId) {
  return getCustomModels().find(m => m.id === modelId) || null;
}

function getCustomModelByName(name) {
  return getCustomModels().find(m => m.name === name) || null;
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an incoming model name to the actual Puter model to use.
 *
 * Priority:
 *  1. Match against customModels by name
 *  2. Check legacy alias map
 *  3. If model is a known Puter model (from cache), use it directly
 *  4. Fall back to defaultModel / legacy puterModel
 *
 * Returns { puterModel: string, responseModel: string }
 */
function resolveModel(requestedModel, knownModels = []) {
  const config = getConfig();

  // 1. Check custom models first
  if (requestedModel) {
    const custom = getCustomModelByName(requestedModel);
    if (custom) {
      return {
        puterModel: custom.puterModel,
        responseModel: custom.name
      };
    }
  }

  // 2. Check legacy alias map
  const aliases = config.modelAliases || {};
  if (requestedModel && aliases[requestedModel]) {
    return {
      puterModel: aliases[requestedModel],
      responseModel: requestedModel
    };
  }

  // 3. If requested model is known (in Puter's model list), use it directly
  if (requestedModel && knownModels.length > 0) {
    const knownIds = knownModels.map(m => typeof m === 'string' ? m : m.id);
    if (knownIds.includes(requestedModel)) {
      return {
        puterModel: requestedModel,
        responseModel: requestedModel
      };
    }
  }

  // 4. Fall back to configured default
  const fallback = config.defaultModel || config.puterModel || 'gpt-4o';
  return {
    puterModel: fallback,
    responseModel: requestedModel || fallback
  };
}

/**
 * Check if a model is allowed by the allowlist/blocklist.
 * Returns { allowed: boolean, reason?: string }
 */
function checkModelAccess(model) {
  if (!model) return { allowed: true };

  const config = getConfig();

  // Blocklist check
  const blocklist = config.modelBlocklist || [];
  if (blocklist.includes(model)) {
    return { allowed: false, reason: `Model "${model}" is blocked by configuration` };
  }

  // Allowlist check (empty allowlist means all allowed)
  const allowlist = config.modelAllowlist || [];
  if (allowlist.length > 0 && !allowlist.includes(model)) {
    return { allowed: false, reason: `Model "${model}" is not in the allowlist` };
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Models Cache
// ---------------------------------------------------------------------------

function getModelsCache() {
  if (cachedModels) return cachedModels;
  try {
    if (fs.existsSync(MODELS_CACHE_PATH)) {
      const cache = JSON.parse(fs.readFileSync(MODELS_CACHE_PATH, 'utf8'));
      if (cache.models && Array.isArray(cache.models)) {
        cachedModels = cache;
        return cache;
      }
    }
  } catch (error) {}
  return { models: [], lastUpdated: null };
}

function isModelsCacheStale(ttlMs = MODELS_CACHE_TTL) {
  const cache = getModelsCache();
  if (!cache.lastUpdated) return true;
  return Date.now() - cache.lastUpdated > ttlMs;
}

function saveModelsCache(models) {
  try {
    const cache = { lastUpdated: Date.now(), models };
    fs.writeFileSync(MODELS_CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
    cachedModels = cache;
    return true;
  } catch (error) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Saved Configurations (legacy presets)
// ---------------------------------------------------------------------------

function getSavedConfigs() {
  if (cachedSavedConfigs) return cachedSavedConfigs;
  try {
    if (fs.existsSync(SAVED_CONFIGS_PATH)) {
      const configs = JSON.parse(fs.readFileSync(SAVED_CONFIGS_PATH, 'utf8'));
      if (Array.isArray(configs)) {
        cachedSavedConfigs = configs;
        return configs;
      }
    }
  } catch (error) {}
  return [];
}

function saveSavedConfigs(configs) {
  try {
    fs.writeFileSync(SAVED_CONFIGS_PATH, JSON.stringify(configs, null, 2), 'utf8');
    cachedSavedConfigs = configs;
    return true;
  } catch (error) {
    return false;
  }
}

function addSavedConfig(name, puterModelId, spoofedOpenAIModelId) {
  const configs = getSavedConfigs();
  const newConfig = {
    id: generateId(),
    name,
    puterModelId,
    spoofedOpenAIModelId: spoofedOpenAIModelId || ''
  };
  configs.push(newConfig);
  return saveSavedConfigs(configs) ? newConfig : null;
}

function updateSavedConfig(configId, newName, puterModelId, spoofedOpenAIModelId) {
  const configs = getSavedConfigs();
  const config = configs.find(c => c.id === configId);
  if (!config) return false;
  if (newName) config.name = newName;
  if (puterModelId) config.puterModelId = puterModelId;
  if (spoofedOpenAIModelId !== undefined) config.spoofedOpenAIModelId = spoofedOpenAIModelId || '';
  return saveSavedConfigs(configs);
}

function deleteSavedConfig(configId) {
  const configs = getSavedConfigs();
  const filtered = configs.filter(c => c.id !== configId);
  if (filtered.length === configs.length) return false;
  return saveSavedConfigs(filtered);
}

function getSavedConfigById(configId) {
  return getSavedConfigs().find(c => c.id === configId) || null;
}

function getLastConfig() {
  return getConfig().lastConfig || null;
}

module.exports = {
  getConfig,
  updateConfig,
  getDefaultConfig,
  // Custom model management
  getCustomModels,
  addCustomModel,
  updateCustomModel,
  deleteCustomModel,
  getCustomModelById,
  getCustomModelByName,
  // Model resolution
  resolveModel,
  checkModelAccess,
  // Models cache
  getModelsCache,
  isModelsCacheStale,
  saveModelsCache,
  // Saved configs (legacy presets)
  getSavedConfigs,
  addSavedConfig,
  updateSavedConfig,
  deleteSavedConfig,
  getSavedConfigById,
  getLastConfig
};
