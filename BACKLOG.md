# Noosphere Router Backlog

## Rules
- Keep backlog items short and simple, ideally one-liners

## Done (v0.1)

- TASK-1: Kong API Gateway with key-auth and ai-proxy plugins
- TASK-2: Custom Lua plugin (lunar-gateway) with quota check and usage capture
- TASK-3: Response body capture in body_filter (compressed response to backend)
- TASK-4: Async usage logging with ngx.timer.at pattern
- TASK-5: Backend API with gzip decompression and token extraction
- TASK-6: Cost calculation and real-time quota updates
- TASK-7: PostgreSQL schema (consumer_quotas, usage_logs)
- TASK-8: Consumer management API and dashboard
- TASK-9: Docker Compose orchestration
- TASK-10: Automated tests with Jest
- TASK-11: Cryptographic hashing (SHA256) of request/response for audit trail
- TASK-12: Blockchain integration for immutable audit logs (HPP Sepolia)
- TASK-13: Local LLM support through Ollama
- TASK-14: Docker containerization (super image) and air-gapped deployment tooling
- TASK-15: Blockchain nonce management - sequential queue to prevent concurrent transaction nonce collisions
- TASK-16: Consolidated routing for LLM and admin dashboard through Kong (single port exposure via Tailscale funnel)
- TASK-17: HTTP Basic Auth for admin dashboard and API protection
- TASK-18: Removed backend port 5872 exposure (backend only accessible via Kong)
- TASK-19: Docker-based integration test suite with blockchain support
- TASK-20: Renamed "Lunar GW" to "Noosphere Router" throughout the project
- TASK-21: Nonce-based audit chain optimization (96.7% cost reduction, 0.0000021 ETH/log)
- TASK-22: Merkle tree batching with adaptive flow control (50 logs/batch, 10s interval, 2000 tx/day budget)
- TASK-23: External PostgreSQL volume for production (protected from docker-compose down -v)

## In Progress

## Fix Me
- Upstream error handling (timeout, etc)

## Future Ideas
- IP restriction plugin for admin route separation (Tailscale-only access)
- Batching for quota logging (reduce DB calls)
- In-memory caching for quota checks
- Multi-provider LLM support
- Streaming response support with real-time token counting
- Time-based quota resets (daily/monthly limits)
- Rate limiting (requests per minute/hour)
- Webhook notifications for quota alerts
- API documentation and client SDKs
- Metrics export and monitoring dashboards
- Multi-tenancy with organization hierarchies
