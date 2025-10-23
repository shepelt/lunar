# AI Development Rules for Lunar

## Project Overview
Lunar (Language Model Union Network & Audit Relay) is an LLM Gateway connecting Noosphere to LLM providers with billing, auditing, and quota management capabilities.

## Technology Stack
- **Gateway**: Kong API Gateway (with Postgres)
- **Backend**: Express.js 4.x
- **Language**: JavaScript (ES6+ modules)
- **Database**: PostgreSQL (shared with Kong)
- **Testing**: Jest with supertest
- **Orchestration**: Docker Compose
- **Runtime**: Node.js (ES modules)

## Architecture
Kong handles authentication (key-auth plugin) → Backend API handles billing/quota → LLM providers

```
Client → Kong (auth) → Backend API (billing/audit) → LLM Provider
                ↓                    ↓
           Postgres (consumers)  Postgres (quotas/usage)
```

## Project Structure

```
/src
  index.js          # Server entry point
  app.js            # Express app (exportable for tests)
  app.test.js       # Tests for app.js (co-located)
  db.js             # PostgreSQL connection & schema
/public             # Static dashboard files
  index.html        # Dashboard UI
  dashboard.js      # Dashboard logic
/kong               # Kong configuration (if needed)
docker-compose.yml  # Kong + Postgres orchestration
```

## Code Conventions

### File Organization
- Keep backend code in `/src`
- Static files in `/public`
- Co-locate tests with source files (e.g., `app.test.js` next to `app.js`)
- Use ES6 `import`/`export` modules (`"type": "module"` in package.json)

### Naming Conventions
- **Files**: camelCase (e.g., `app.js`, `db.js`)
- **Functions**: camelCase (e.g., `initDatabase`, `testConnection`)
- **Endpoints**: REST conventions (e.g., `/api/consumers`, `/api/audit`)
- **Database Tables**: snake_case (e.g., `consumer_quotas`, `usage_logs`)

### Express Patterns
- Export `app` separately from server startup for testing
- Use `async`/`await` for all database operations
- Use parameterized queries to prevent SQL injection: `pool.query($1, [value])`
- Return proper HTTP status codes (400 for validation, 500 for server errors)

## Development Philosophy

### Start Simple, Grow Naturally
- **Flat structure first**: Keep files at root level until organization becomes necessary
  - ✅ `src/app.js` with all routes
  - ❌ `src/routes/consumers/index.js` (too early)

### YAGNI Principle
- Only build what you need right now
- Don't create "future-proof" abstractions
- Examples of YAGNI violations to avoid:
  - Creating a `BaseController` class before you have 2 controllers
  - Adding middleware framework for features that don't exist yet
  - Building a plugin system before you have plugins

### When to Refactor
- When you copy-paste code 3+ times → extract to function
- When a file exceeds 300 lines → consider splitting
- When a pattern becomes clear → then abstract it
- Never before

## Development Workflow

### Running the System
- **Start Everything**: `npm run all` (starts Docker + backend)
- **Backend Only**: `npm run dev` (with auto-reload)
- **Docker Only**: `npm run docker:up`
- **Stop Everything**: `npm run stop`

### Database Management
- Kong and backend share the same Postgres instance
- Schema is auto-initialized on startup via `initDatabase()`
- Use `CREATE TABLE IF NOT EXISTS` for idempotent schema updates
- Decimal precision: Use `DECIMAL(10,6)` for monetary values (costs < $0.01)

### Kong Management
- Admin API: `http://localhost:8001`
- Gateway: `http://localhost:8000`
- Create consumers via backend: `POST /api/admin/consumers`
- Kong stores: consumers, credentials, plugins
- Backend stores: quotas, usage logs
- **Configuration**: Declarative using `kong/kong.yaml` + decK
- **Secrets**: Kong env vault (`{vault://env/openai-key}`)
- **Provisioning**: Automatic via `deck sync` on startup

### Code Changes
- **NEVER modify files without explicit user permission**
  - Always show proposed changes first
  - Wait for user approval before applying
  - Exception: Only when user explicitly requests the change (e.g., "fix that", "do it")
- Keep the backend running during development (Express auto-reloads on file changes with `--watch`)

## Testing

### Test Framework
- **Framework**: Jest with ES modules support
- **HTTP Testing**: supertest
- **Test Files**: Co-located with source (e.g., `src/app.test.js`)
- **Run Tests**: `npm test`
- **Watch Mode**: `npm run test:watch`

### Test Patterns
- Mock Kong consumer headers for authenticated endpoints:
  ```javascript
  .set('x-consumer-id', 'test-consumer')
  .set('x-consumer-username', 'test-user')
  ```
- Clear database before each test suite: `await clearStorage()`
- Use `async`/`await` for all test cases
- Test both success and error cases

### What to Test
- API endpoints (request/response)
- Database operations (CRUD)
- Quota enforcement
- Cost calculations
- Error handling

## API Design

### Endpoint Categories
- `/health` - Health check (no auth)
- `/api/quota-check` - Pre-flight quota check (Kong auth)
- `/api/audit` - Log LLM usage (Kong auth or manual consumer_id)
- `/api/usage` - Get current consumer stats (Kong auth)
- `/api/consumers` - List all consumers (admin)
- `/api/consumers/:id` - Get specific consumer (admin)
- `/api/consumers/:id/quota` - Set quota (admin)
- `/api/admin/consumers` - Create consumer in Kong (admin)

### Response Format
- Success: JSON with relevant data
- Error: `{ error: "message" }` with appropriate HTTP status
- Monetary values: Always as numbers with 6 decimal precision
- Timestamps: ISO strings or Unix timestamps

## Cost Calculation
- GPT-5 pricing (as of 2025):
  - Input tokens: $1.25/1M = $0.00000125 per token
  - Output tokens: $10/1M = $0.00001 per token
- Store costs in `DECIMAL(10,6)` fields
- Update consumer `used` field atomically with audit log

## Notes
This file will evolve as the project grows and patterns emerge.

## References
- Kong Documentation: https://docs.konghq.com/
- Express.js Guide: https://expressjs.com/
- PostgreSQL node-postgres: https://node-postgres.com/
