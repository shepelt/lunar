# 🌙 Lunar Gateway

LLM API Gateway with quota management and usage tracking

## Architecture

```
Client → Kong Gateway (port 8000)
         ├─ key-auth plugin (authentication)
         ├─ lunar-gateway plugin (quota check + usage capture)
         └─ ai-proxy plugin (forward to LLM)
                  ↓
              OpenAI API
                  ↓
         lunar-gateway (captures response)
                  ↓
         Backend API (port 3000)
         - Decompresses response
         - Extracts token usage
         - Calculates cost
         - Updates quota
                  ↓
         PostgreSQL Database
         - consumer_quotas
         - usage_logs
```

**Plugin-based quota tracking:**
1. **Access phase**: Check if consumer has available quota
2. **Body filter phase**: Capture compressed LLM response
3. **Log phase**: Send response to backend (async, no latency impact)
4. **Backend**: Decompress with gzip, extract usage, update quota

## Prerequisites

- Node.js (v18+)
- Docker & Docker Compose
- (Optional) LLM Provider API Keys (OpenAI, Anthropic)

## Quick Start

1. **Install dependencies:**
```bash
npm install
```

2. **Configure environment:**
```bash
cp .env.example .env
# Edit .env and add your LLM provider API keys (optional for testing)
```

3. **Start everything (Kong + Postgres + Backend):**
```bash
npm run all
```

Or start components separately:
```bash
npm run docker:up    # Start Kong + Postgres
npm run dev          # Start backend API
```

4. **Access the dashboard:**
```
Open http://localhost:3000 in your browser
```

## API Endpoints

### Admin Endpoints (Backend API - port 3000)

#### Create Consumer (via Dashboard or API)
```bash
curl -X POST http://localhost:3000/api/admin/consumers \
  -H "Content-Type: application/json" \
  -d '{
    "username": "alice",
    "custom_id": "user-001",
    "quota": 100
  }'

# Response includes consumer ID and API key:
# {
#   "consumer": { "id": "...", "username": "alice" },
#   "api_key": "abc123...",
#   "quota": 100
# }
```

#### List All Consumers
```bash
curl http://localhost:3000/api/consumers
```

#### Get Consumer Usage
```bash
curl http://localhost:3000/api/consumers/{consumer_id}
```

### LLM API (via Kong Gateway - port 8000)

#### Chat Completion (OpenAI-compatible)
```bash
curl -X POST http://localhost:8000/llm/v1/chat/completions \
  -H "apikey: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ],
    "max_completion_tokens": 100
  }'

# Response includes usage data:
# {
#   "id": "chatcmpl-...",
#   "choices": [...],
#   "usage": {
#     "prompt_tokens": 8,
#     "completion_tokens": 12,
#     "total_tokens": 20
#   }
# }
```

**Quota Management:**
- Requests are checked against consumer quota before forwarding to LLM
- Returns 429 (Quota Exceeded) if insufficient quota
- Usage is tracked automatically and deducted from quota
- Cost calculated based on model pricing (GPT-5: $1.25/1M input, $10/1M output)

### Health & Status

#### Backend Health
```bash
curl http://localhost:3000/health
```

#### Kong Status
```bash
curl http://localhost:8001/status
```

## Development

- `npm run dev` - Start backend API with auto-reload
- `npm run docker:up` - Start Kong + Postgres
- `npm run docker:down` - Stop Kong + Postgres
- `npm run kong:reload` - Reload Kong config
- `npm test` - Run Jest tests

## Database

PostgreSQL database (shared with Kong) with tables:
- `consumer_quotas` - Consumer quota management
- `usage_logs` - Audit log of all LLM requests

## Features

✅ **Implemented:**
- **Kong API Gateway** with key-auth authentication
- **Custom Lua plugin** (`lunar-gateway`) for quota management
  - Pre-request quota check (fail fast if quota exceeded)
  - Response body capture (handles gzip compression)
  - Async usage logging (no latency impact)
  - Dynamic model detection from Kong headers
- **AI Proxy plugin** for LLM routing (OpenAI GPT-5)
- **PostgreSQL** for persistent storage (consumer quotas & usage logs)
- **Quota management** with prepaid credits model
- **Accurate usage tracking**
  - Backend decompresses gzip response
  - Extracts token usage from LLM response
  - Calculates cost based on model pricing
  - Updates quota in real-time
- **Real-time dashboard** (React + Material-UI)
- **Consumer CRUD operations** via API
- **Automated tests** (Jest test suite)

## How It Works

### Quota Tracking Flow

1. **Request arrives** at Kong with API key
2. **key-auth plugin** validates key and identifies consumer
3. **lunar-gateway plugin (access phase)** checks quota with backend
   - If insufficient quota → returns 429 immediately
   - If quota available → request proceeds
4. **ai-proxy plugin** forwards request to OpenAI
5. **lunar-gateway plugin (body_filter phase)** captures response chunks
   - Response is gzip-compressed by Kong/OpenAI
   - Plugin collects compressed chunks
6. **lunar-gateway plugin (log phase)** sends data to backend
   - Runs in async timer (no client latency)
   - Sends: consumer_id, model, status, compressed response (base64)
7. **Backend** processes usage
   - Decompresses response with `zlib.gunzipSync()`
   - Parses JSON and extracts `usage.prompt_tokens`, `usage.completion_tokens`
   - Calculates cost based on model pricing
   - Updates `consumer_quotas.used` in database
   - Logs to `usage_logs` table

## Configuration

The AI Proxy currently supports OpenAI. To add more providers:

1. Set provider API keys in `.env`:
```bash
OPENAI_API_KEY=sk-...
```

2. Configure additional routes/plugins in `kong/kong.yaml`

## Testing

```bash
npm test                 # Run all tests
npm run test:watch       # Watch mode
```
