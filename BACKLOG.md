# Lunar Backlog

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

## In Progress

## Future Ideas

- TASK-11: Cryptographic hashing of LLM responses for audit trail
- TASK-12: Blockchain integration for immutable audit logs
- TASK-13: Batching for quota logging (reduce DB calls)
- TASK-14: In-memory caching for quota checks
- TASK-15: Multi-provider LLM support
- TASK-16: Streaming response support with real-time token counting
- TASK-17: Time-based quota resets (daily/monthly limits)
- TASK-18: Rate limiting (requests per minute/hour)
- TASK-19: Webhook notifications for quota alerts
- TASK-20: API documentation and client SDKs
- TASK-21: Metrics export and monitoring dashboards
- TASK-22: Multi-tenancy with organization hierarchies
