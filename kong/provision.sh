#!/bin/sh
set -e

# Set defaults for optional environment variables
export OPENAI_API_KEY="${OPENAI_API_KEY:-}"
export OLLAMA_BACKEND_URL="${OLLAMA_BACKEND_URL:-http://localhost:11434}"
export OLLAMA_MODEL_NAME="${OLLAMA_MODEL_NAME:-gpt-oss:120b}"
export ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
export ADMIN_PASSWORD="${ADMIN_PASSWORD:-changeme}"

# Substitute environment variables in kong.yaml
envsubst < /kong-template.yaml > /tmp/kong.yaml

# Sync Kong configuration
# For super image deployment, Kong runs inside lunar-super container
# --skip-consumers: Don't manage consumers (they're managed by backend API)
KONG_ADDR="${KONG_ADMIN_URL:-http://kong:8001}"
deck gateway sync /tmp/kong.yaml --kong-addr="$KONG_ADDR" --skip-consumers

# Create admin consumer for basic-auth (if not exists)
echo "Setting up admin basic-auth..."
CONSUMER_ID=$(curl -s -X POST "$KONG_ADDR/consumers" \
  -H "Content-Type: application/json" \
  -d "{\"username\": \"lunar-admin\"}" \
  | grep -o '"id":"[^"]*"' | cut -d'"' -f4 || echo "")

# If consumer creation failed (already exists), get the existing consumer ID
if [ -z "$CONSUMER_ID" ]; then
  CONSUMER_ID=$(curl -s "$KONG_ADDR/consumers/lunar-admin" \
    | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
fi

# Create or update basic-auth credential
# First, get existing credential ID if it exists
EXISTING_CRED_ID=$(curl -s "$KONG_ADDR/consumers/lunar-admin/basic-auth" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

# Delete existing credential if found
if [ -n "$EXISTING_CRED_ID" ]; then
  curl -s -X DELETE "$KONG_ADDR/consumers/lunar-admin/basic-auth/$EXISTING_CRED_ID" > /dev/null 2>&1 || true
fi

# Create new credential with current password from environment
curl -s -X POST "$KONG_ADDR/consumers/lunar-admin/basic-auth" \
  -H "Content-Type: application/json" \
  -d "{\"username\": \"$ADMIN_USERNAME\", \"password\": \"$ADMIN_PASSWORD\"}" \
  > /dev/null

echo "Admin basic-auth configured for user: $ADMIN_USERNAME"
