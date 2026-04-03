/**
 * OpenAI Chat Completions API adapter
 *
 * Supports:
 *  - Multi-model routing (uses incoming `model` field)
 *  - Alias resolution via config
 *  - Emulated SSE streaming (full response split into chunks)
 *  - Non-streaming
 *  - Tool/function calling passthrough to Puter
 *  - Emulator-side token counting (always)
 */

const { chat, chatStreamEmulated, estimateTokens, countMessageTokens, classifyError } = require('./puter-client');
const { getConfig, isEmulatorActive, resolveModel, checkModelAccess } = require('./config');
const { logRequest, logSuccess, logError } = require('./logger');

function generateCompletionId() {
  return `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(7)}`;
}

function createErrorResponse(error, statusCode = 500, type = 'internal_server_error') {
  return {
    statusCode,
    body: {
      error: {
        message: error.message || 'An error occurred',
        type,
        code: error.code || null
      }
    }
  };
}

function validateRequest(body) {
  if (!body) {
    const error = new Error('Request body is required');
    error.statusCode = 400;
    error.type = 'invalid_request_error';
    throw error;
  }

  if (!body.messages && !body.prompt) {
    const error = new Error('Either messages or prompt field is required');
    error.statusCode = 400;
    error.type = 'invalid_request_error';
    throw error;
  }

  if (body.messages) {
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      const error = new Error('messages must be a non-empty array');
      error.statusCode = 400;
      error.type = 'invalid_request_error';
      throw error;
    }

    for (const msg of body.messages) {
      if (!msg.role || msg.content === undefined) {
        const error = new Error('Each message must have role and content fields');
        error.statusCode = 400;
        error.type = 'invalid_request_error';
        throw error;
      }
    }
  }

  return true;
}

/**
 * Build OpenAI-style usage object using emulator token counting.
 */
function buildUsage(messages, text) {
  const promptTokens = countMessageTokens(messages || []);
  const completionTokens = estimateTokens(text || '');
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens
  };
}

async function handleChatCompletion(requestBody, knownModels = []) {
  try {
    if (!isEmulatorActive()) {
      return createErrorResponse(
        new Error('Emulator is not active. Start it from the configuration UI.'),
        503,
        'service_unavailable'
      );
    }

    validateRequest(requestBody);

    const config = getConfig();
    const {
      model: requestedModel,
      messages,
      prompt,
      temperature,
      max_tokens,
      max_completion_tokens,
      stream,
      tools,
      tool_choice
    } = requestBody;

    // Resolve model: alias -> known Puter model -> fallback
    const { puterModel, responseModel } = resolveModel(requestedModel, knownModels);

    // Check allowlist/blocklist
    const access = checkModelAccess(puterModel);
    if (!access.allowed) {
      return createErrorResponse(new Error(access.reason), 400, 'invalid_request_error');
    }

    logRequest({
      incomingModel: requestedModel,
      puterModel,
      responseModel,
      messageCount: messages ? messages.length : 1,
      hasTools: !!tools,
      streaming: !!stream,
      status: 'processing'
    });

    const options = { model: puterModel };
    if (temperature !== undefined) options.temperature = temperature;
    if (max_tokens !== undefined) options.max_tokens = max_tokens;
    else if (max_completion_tokens !== undefined) options.max_tokens = max_completion_tokens;

    // Pass through tools for function calling
    if (tools && Array.isArray(tools)) {
      options.tools = tools;
    }
    if (tool_choice) {
      options.tool_choice = tool_choice;
    }

    const inputToSend = messages || prompt;

    // Streaming path (emulated)
    if (stream === true) {
      return {
        statusCode: 200,
        stream: true,
        streamGenerator: chatStreamEmulated(inputToSend, options),
        responseModel,
        messages: inputToSend
      };
    }

    // Non-streaming path
    const result = await chat(inputToSend, options);

    const usage = buildUsage(messages, result.text);

    logSuccess({
      puterModel,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens
    });

    // Build response — handle tool calls if present
    const choiceMessage = { role: 'assistant' };
    if (result.toolCalls && result.toolCalls.length > 0) {
      choiceMessage.content = result.text || null;
      choiceMessage.tool_calls = result.toolCalls;
    } else {
      choiceMessage.content = result.text;
    }

    return {
      statusCode: 200,
      body: {
        id: generateCompletionId(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: responseModel,
        choices: [{
          index: 0,
          message: choiceMessage,
          finish_reason: result.toolCalls && result.toolCalls.length > 0 ? 'tool_calls' : 'stop'
        }],
        usage
      }
    };
  } catch (error) {
    logError(error, { endpoint: '/v1/chat/completions', requestedModel: requestBody?.model });

    if (error.statusCode && error.type) {
      return createErrorResponse(error, error.statusCode, error.type);
    }

    const { statusCode, type } = classifyError(error);
    return createErrorResponse(error, statusCode, type);
  }
}

module.exports = { handleChatCompletion, validateRequest, createErrorResponse };
