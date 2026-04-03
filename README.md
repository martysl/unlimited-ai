# Puter API

A docker and pinokio app that provides a local OpenAI-compatible HTTP endpoint backed by Puter AI. Access 500+ AI models through Puter's free API using standard OpenAI formats for chat, TTS, image generation, transcription, and embeddings.

## What is this?

A translation layer between applications expecting an OpenAI-compatible API and Puter AI's backend. Instead of running local models or paying for OpenAI API keys, use Puter's free AI service through a localhost endpoint.

### Key Features

- **API Key Authentication**: All `/v1/*` endpoints require `sk-puter-123` (configurable)
- **OpenAI-Compatible Endpoints**: Chat completions, TTS, image generation, transcription, embeddings
- **500+ Models Available**: Access GPT-5, Claude, Gemini, and more through Puter
- **Multi-Model Routing**: Each request can target a different model via the `model` field
- **Model Aliasing**: Map custom names to real Puter models (e.g., `"gpt-4o"` → `"gpt-5-nano"`)
- **Emulated SSE Streaming**: Realistic streaming by splitting full responses into word-level chunks
- **Tool/Function Calling**: Passthrough to Puter's tool support with OpenAI-compatible format
- **Text-to-Speech**: Generate audio via `/v1/audio/speech`
- **Image Generation with Caching**: Images cached to disk, served via local URLs
- **Speech-to-Text**: Transcribe audio via `/v1/audio/transcriptions` (server-managed for large files)
- **Embeddings**: Simulated deterministic embeddings for testing workflows
- **Allowlist/Blocklist**: Control which models are accessible
- **Hot Configuration**: Changes take effect immediately without server restart
- **Health Monitoring**: Built-in connectivity and status checking

## Installation

### Via Pinokio (Recommended)

1. Open Pinokio
2. Navigate to the "Discover" tab
3. Search for "Puter Local Model Emulator" or paste the repository URL
4. Click "Install"

The app will automatically:
- Install Node.js dependencies
- Start the server
- Open the configuration UI

### Manual Installation
```bash
git clone https://github.com/martysl/unlimited-ai.git
cd puter-local-model-emulator
npm install
npm start
```

Server starts on `http://localhost:11436` by default.

### Docker

**Quick start:**
```bash
docker run -d \
  --name unlimited-ai \
  -p 11436:11436 \
  -e PUTER_AUTH_TOKEN=your_token_here \
  -v $(pwd)/config:/app/config \
  -v $(pwd)/cache:/app/cache \
  --restart unless-stopped \
  ghcr.io/martysl/unlimited-ai:latest
```

**With docker-compose:**
```bash
# Create .env file
echo "PUTER_AUTH_TOKEN=your_token_here" > .env

# Start
docker compose up -d

# View logs
docker compose logs -f
```

Server starts on `http://localhost:11436` by default.

## Usage

### Configuration UI

The configuration UI opens automatically when the app starts, or access it at:
```
http://localhost:11436/config.html
```

**Features:**
- **Puter Model**: Search/select from 500+ available models (test models filtered out)
- **Spoofed Model ID**: Set the model name your app expects (e.g., "gpt-4o")
- **Presets**: Save configurations for quick switching between setups
- **Status Indicators**: See Puter connectivity and emulator state at a glance

**Workflow:**
1. Select a Puter model from the searchable dropdown
2. (Optional) Enter a spoofed OpenAI model ID
3. Click "Start" to activate the emulator
4. Use the endpoint in your applications

### Stopping the Server

Use Pinokio's **"stop start.json"** button on the app's home page. The server runs as a daemon and persists even if you navigate away from the Emulator tab - this is intentional so other apps can continue using the endpoint.

### Available Models

Common Puter models include:

**GPT Models:**
- `gpt-5-nano` - Fastest, optimized for low latency
- `gpt-5-mini` - Balanced for general tasks
- `gpt-5` - Full GPT-5 with advanced reasoning
- `gpt-5.1` - Latest version
- `gpt-4o` - GPT-4 optimized

**Other Providers via Puter:**
- Claude, Gemini, Llama, Mistral, and more
- See full list in the UI's searchable dropdown or via `GET /v1/models`

### Authentication

All `/v1/*` endpoints require an API key. The default key is `sk-puter-123`.

Pass it via:
- **Authorization header**: `Authorization: Bearer sk-puter-123`
- **Query parameter**: `?api_key=sk-puter-123`
- **X-API-Key header**: `X-API-Key: sk-puter-123`

**Example:**
```bash
curl http://localhost:11436/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-puter-123" \
  -d '{"model": "gpt-5-nano", "messages": [{"role": "user", "content": "Hello!"}]}'
```

Change the key in `config/default.json` under `"apiKey"`.

### Using the Endpoint

Point any OpenAI-compatible application to:
```
http://localhost:11436/v1
```

**Example: Python**
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:11436/v1",
    api_key="sk-puter-123"
)

response = client.chat.completions.create(
    model="gpt-5-nano",
    messages=[{"role": "user", "content": "Hello!"}]
)

print(response.choices[0].message.content)
```

### Health Check
```bash
curl http://localhost:11436/health
```

Returns Puter connectivity status and server health.

## Configuration

Edit `config/default.json` or use the configuration UI.

### Configuration Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `port` | number | `11436` | Server port |
| `apiKey` | string | `"sk-puter-123"` | API key required for all `/v1/*` endpoints |
| `defaultModel` | string | `"gpt-4o"` | Fallback Puter model when no `model` is specified or the requested model is unknown |
| `puterModel` | string | `"gpt-4o"` | Legacy: single-model mode (backward compatible) |
| `spoofedOpenAIModelId` | string | `""` | Legacy: response model name override (backward compatible) |
| `modelAliases` | object | `{}` | Map of alias → real Puter model. E.g. `{"gpt-4o": "gpt-5-nano"}` |
| `modelAllowlist` | array | `[]` | If non-empty, only these models are accepted. Empty means all allowed |
| `modelBlocklist` | array | `[]` | These models are always rejected |
| `emulatorActive` | boolean | `false` | Whether the emulator is running |
| `logging.enabled` | boolean | `true` | Enable logging |
| `logging.logRequests` | boolean | `true` | Log incoming requests |
| `logging.logErrors` | boolean | `true` | Log errors |

### Example: Model Aliases

Map familiar OpenAI names to available Puter models:

```json
{
  "modelAliases": {
    "gpt-4o": "gpt-5-nano",
    "gpt-4-turbo": "gpt-5-mini",
    "claude-3.5-sonnet": "claude-sonnet-4-20250514"
  }
}
```

### Example: Allowlist

Only allow specific models:

```json
{
  "modelAllowlist": ["gpt-5-nano", "gpt-5-mini", "claude-sonnet-4-20250514"]
}
```

### Example: Blocklist

Block specific models:

```json
{
  "modelBlocklist": ["test-model-alpha", "deprecated-model"]
}
```

## API Endpoints

### `GET /v1/models`

List all available models in OpenAI format.

**Request:**
```bash
curl http://localhost:11436/v1/models \
  -H "Authorization: Bearer sk-puter-123"
```

**Response:**
```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-5-nano",
      "object": "model",
      "created": 1234567890,
      "owned_by": "puter",
      "active": true
    },
    {
      "id": "gpt-4o",
      "object": "model",
      "created": 1234567890,
      "owned_by": "alias",
      "active": true,
      "aliases_to": "gpt-5-nano"
    }
  ]
}
```

### `POST /v1/chat/completions`

OpenAI-compatible chat completions with emulated streaming and tool calling.

**Request (non-streaming):**
```json
{
  "model": "gpt-5-nano",
  "messages": [{"role": "user", "content": "Hello"}],
  "temperature": 0.7,
  "max_tokens": 1000
}
```

**Response:**
```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "gpt-5-nano",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "Hi!"},
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 5,
    "total_tokens": 15
  }
}
```

**Streaming Request:**
```json
{
  "model": "gpt-5-nano",
  "messages": [{"role": "user", "content": "Write a poem"}],
  "stream": true
}
```

**Streaming Response (SSE):**
```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1234567890,"model":"gpt-5-nano","choices":[{"index":0,"delta":{"content":"The"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1234567890,"model":"gpt-5-nano","choices":[{"index":0,"delta":{"content":" sun"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1234567890,"model":"gpt-5-nano","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

**Streaming Example (curl):**
```bash
curl http://localhost:11436/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-puter-123" \
  -d '{
    "model": "gpt-5-nano",
    "messages": [{"role": "user", "content": "Write a haiku"}],
    "stream": true
  }'
```

**Streaming Example (Python):**
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:11436/v1",
    api_key="sk-puter-123"
)

stream = client.chat.completions.create(
    model="gpt-5-nano",
    messages=[{"role": "user", "content": "Write a haiku"}],
    stream=True
)

for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
```

**Tool/Function Calling Example:**
```json
{
  "model": "gpt-5-nano",
  "messages": [{"role": "user", "content": "What's the weather in Paris?"}],
  "tools": [{
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "Get current weather for a location",
      "parameters": {
        "type": "object",
        "properties": {
          "location": {"type": "string"}
        },
        "required": ["location"]
      }
    }
  }]
}
```

**Response with tool calls:**
```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "model": "gpt-5-nano",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "I will check the weather for you.",
      "tool_calls": [{
        "id": "call_abc123",
        "type": "function",
        "function": {
          "name": "get_weather",
          "arguments": "{\"location\":\"Paris\"}"
        }
      }]
    },
    "finish_reason": "tool_calls"
  }],
  "usage": {
    "prompt_tokens": 45,
    "completion_tokens": 30,
    "total_tokens": 75
  }
}
```

### `POST /v1/audio/speech`

Text-to-speech. Returns raw audio bytes.

**Request:**
```json
{
  "model": "aws-polly",
  "input": "Hello, welcome to the Puter model emulator.",
  "voice": "Joanna",
  "response_format": "mp3"
}
```

**Example (curl, save to file):**
```bash
curl http://localhost:11436/v1/audio/speech \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-puter-123" \
  -d '{
    "input": "Hello world from Puter!",
    "voice": "Joanna"
  }' \
  --output speech.mp3
```

**Example (Python):**
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:11436/v1",
    api_key="sk-puter-123"
)

response = client.audio.speech.create(
    model="aws-polly",
    voice="Joanna",
    input="Hello from the Puter emulator!"
)

response.stream_to_file("output.mp3")
```

**Supported TTS providers via Puter:** `aws-polly` (default), `openai`, `elevenlabs`

### `POST /v1/images/generations`

Image generation with disk caching. Images are saved to `cache/images/` and served via local HTTP URLs.

**Request:**
```json
{
  "prompt": "A beautiful sunset over mountains",
  "model": "gemini-2.5-flash-image-preview",
  "n": 1,
  "size": "1024x1024",
  "response_format": "url"
}
```

**Response (url format):**
```json
{
  "created": 1234567890,
  "data": [
    {
      "url": "http://localhost:11436/cache/images/abc123def456.png"
    }
  ]
}
```

**Response (b64_json format):**
```json
{
  "created": 1234567890,
  "data": [
    {
      "b64_json": "<base64-encoded-image-data>"
    }
  ]
}
```

**Example (curl):**
```bash
curl http://localhost:11436/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-puter-123" \
  -d '{
    "prompt": "A cat wearing a top hat",
    "size": "1024x1024"
  }'
```

**Example (Python):**
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:11436/v1",
    api_key="sk-puter-123"
)

response = client.images.generate(
    model="gemini-2.5-flash-image-preview",
    prompt="A cat wearing a top hat",
    size="1024x1024",
    n=1
)

print(response.data[0].url)
```

### `POST /v1/audio/transcriptions`

Speech-to-text transcription. For files larger than 25 MB, the server automatically splits the audio at silence points, transcribes each chunk separately, and returns results in parts.

**Request (multipart/form-data):**
```
POST /v1/audio/transcriptions
Content-Type: multipart/form-data

file: <audio file>
model: whisper-1 (optional)
language: en (optional)
response_format: json (optional)
```

**Request (JSON with base64):**
```json
{
  "audio": "<base64-encoded-audio>",
  "model": "whisper-1",
  "language": "en",
  "response_format": "json"
}
```

**Response (small file):**
```json
{
  "text": "Hello, this is a transcription of the audio file."
}
```

**Response (large file, split into parts):**
```json
{
  "text": "Full combined transcription text...",
  "parts": [
    {
      "index": 0,
      "text": "First part of the transcription.",
      "byteStart": 0,
      "byteEnd": 25000000,
      "language": "en"
    },
    {
      "index": 1,
      "text": "Second part continues here.",
      "byteStart": 25000000,
      "byteEnd": 50000000,
      "language": "en"
    }
  ]
}
```

**Example (curl):**
```bash
curl http://localhost:11436/v1/audio/transcriptions \
  -H "Authorization: Bearer sk-puter-123" \
  -F "file=@recording.mp3" \
  -F "language=en"
```

**Example (Python):**
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:11436/v1",
    api_key="sk-puter-123"
)

with open("recording.mp3", "rb") as audio_file:
    transcript = client.audio.transcriptions.create(
        model="whisper-1",
        file=audio_file
    )

print(transcript.text)
```

### `POST /v1/embeddings`

Simulated embeddings. Puter has no embedding API, so this generates deterministic pseudo-random vectors using a seeded PRNG. The same input always produces the same vector. Useful for testing embedding workflows.

**Request:**
```json
{
  "input": "The quick brown fox",
  "model": "text-embedding-ada-002",
  "encoding_format": "float"
}
```

**Response:**
```json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "index": 0,
      "embedding": [0.012, -0.034, 0.056, ...],
      "prompt_tokens": 6
    }
  ],
  "model": "text-embedding-ada-002",
  "usage": {
    "prompt_tokens": 6,
    "total_tokens": 6
  }
}
```

**Example (curl):**
```bash
curl http://localhost:11436/v1/embeddings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-puter-123" \
  -d '{
    "input": "Hello world",
    "encoding_format": "float"
  }'
```

**Example (Python):**
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:11436/v1",
    api_key="sk-puter-123"
)

response = client.embeddings.create(
    model="text-embedding-ada-002",
    input="Hello world"
)

vector = response.data[0].embedding
print(f"Vector dimensions: {len(vector)}")
```

### `GET /health`

Server health and Puter connectivity check (no API key required).

### `GET /config/state`

Current configuration, presets, models, and emulator state (no API key required).

### `POST /emulator/start`

Activate the emulator with specified models (no API key required).

### `POST /emulator/stop`

Deactivate the emulator (no API key required).

## Architecture

```
/puter-local-model-emulator
├── server/
│   ├── index.js          # Express server + all route definitions + API key middleware
│   ├── config.js         # Configuration with hot-reload + model resolution
│   ├── logger.js         # Logging and diagnostics
│   ├── puter-client.js   # Puter.js integration (chat, TTS, images, transcription, embeddings)
│   └── openai-adapter.js # OpenAI format translation + emulated streaming + tools
├── cache/
│   ├── images/           # Cached generated images (served via /cache/images/)
│   └── temp/             # Temporary files for large transcription uploads
├── config/
│   ├── default.json      # User configuration
│   ├── models-cache.json # Cached model list
│   └── saved-configs.json # Saved presets
├── public/
│   └── config.html       # Configuration UI
├── tests/
│   └── adapter.test.js   # Unit tests
├── pinokio.js            # Pinokio app definition (v4.0)
├── install.json          # Dependency installation
├── start.json            # Server startup (daemon)
└── package.json
```

## Limitations & Compatibility Notes

1. **API Key**: Default key is `sk-puter-123`. Change it in `config/default.json` under `apiKey`. All `/v1/*` endpoints require it.

2. **Streaming**: Emulated by fetching the full response and splitting it into word-level SSE chunks with a small delay. This provides a realistic streaming experience for clients. Puter's native streaming is not used because it doesn't provide per-chunk metadata.

3. **Token Counts**: Always calculated by the emulator (4 chars ≈ 1 token). Puter's usage data is not used, ensuring consistent token counting across all requests.

4. **Tool/Function Calling**: Tools are passed through to Puter's backend using the OpenAI tools format. Puter's driver supports the `tools` parameter directly. Tool execution results must be handled by the client and sent back as a follow-up message.

5. **Image Caching**: Generated images are saved to `cache/images/` on disk and served via local HTTP URLs (`http://localhost:11436/cache/images/<hash>.ext`). URLs are absolute. The `b64_json` format reads the cached file and returns base64.

6. **TTS Audio Format**: Puter's TTS returns audio as a data URI. The endpoint decodes and returns raw audio bytes. The `response_format` field is accepted but Puter determines the actual output format (typically MP3 or WAV depending on provider).

7. **Transcription**: Supports multipart/form-data or base64 JSON. For files larger than 25 MB, the server automatically detects silence regions in the audio and splits at those points, transcribing each chunk separately. Results are returned as a combined `text` field plus a `parts` array with per-chunk text and byte offsets. If no silence is found, the file is split at fixed 20 MB intervals. The `response_format` options `text`, `json`, and `verbose_json` are supported but `verbose_json` returns minimal segment data.

8. **Embeddings**: Simulated using a seeded PRNG (Mulberry32) based on SHA-256 hash of input text. Vectors are L2-normalized to 1536 dimensions. The same input always produces the same vector. This is NOT a real embedding model — it's for testing embedding workflows only.

9. **No Function Calling Execution**: The emulator passes tool calls through to Puter but does not execute the tools. The client must handle tool execution and send results back.

10. **Rate Limiting**: The emulator does not implement rate limiting. Puter's own rate limits still apply.

11. **Model Availability**: Not all models listed by Puter may be available for all endpoints. Chat models work with `/v1/chat/completions`, but image generation and TTS use separate model sets.

## Troubleshooting

**Server won't start**
- Check if port 11436 is in use
- Change port in `config/default.json`
- Verify Node.js 21+ installed

**401 Unauthorized errors**
- Ensure you're passing the correct API key: `sk-puter-123`
- Use `-H "Authorization: Bearer sk-puter-123"` in curl
- Or add `?api_key=sk-puter-123` to the URL

**Models not loading**
- Check internet connection (Puter requires network)
- Verify `PUTER_AUTH_TOKEN` if using authenticated access
- Click "Refresh Models" in UI

**Puter appears offline**
- Test connectivity: `curl http://localhost:11436/health`
- Check Puter service status at puter.com
- Try different Puter models

**Configuration UI won't open**
- Ensure server running (check Pinokio app home)
- Access directly: `http://localhost:11436/config.html`
- Check browser console for errors

**Running Tests:**
```bash
npm test
```

**Adding Backends:**
Edit `server/puter-client.js` to integrate alternative AI providers.

**Adding Endpoints:**
Add routes in `server/index.js` and corresponding Puter client methods in `server/puter-client.js`.

## License

MIT

## Contributing

Feel free to fork and extend for your needs.

---

Updated and Tested by Tasia with <3
