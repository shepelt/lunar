#!/bin/sh
set -e

# Set defaults for optional environment variables
export OPENAI_API_KEY="${OPENAI_API_KEY:-}"
export OLLAMA_BACKEND_URL="${OLLAMA_BACKEND_URL:-http://localhost:11434}"
export OLLAMA_MODEL_NAME="${OLLAMA_MODEL_NAME:-gpt-oss:120b}"

# Substitute environment variables in kong.yaml
envsubst < /kong-template.yaml > /tmp/kong.yaml

# Sync Kong configuration
# For super image deployment, Kong runs inside lunar-super container
KONG_ADDR="${KONG_ADMIN_URL:-http://kong:8001}"
deck gateway sync /tmp/kong.yaml --kong-addr="$KONG_ADDR"
