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
# For super image deployment, Kong runs inside noosphere-router-super container
# --skip-consumers: Don't manage consumers (they're managed by backend API)
KONG_ADDR="${KONG_ADMIN_URL:-http://kong:8001}"
deck gateway sync /tmp/kong.yaml --kong-addr="$KONG_ADDR" --skip-consumers

# Create admin consumer for basic-auth (if not exists)
echo "Setting up admin basic-auth..."

# Try to create consumer, capture response
CONSUMER_RESPONSE=$(curl -s -X POST "$KONG_ADDR/consumers" \
  -H "Content-Type: application/json" \
  -d '{"username": "noosphere-router-admin"}')

# Extract consumer ID from response (whether newly created or error response)
CONSUMER_ID=$(echo "$CONSUMER_RESPONSE" | jq -r '.id // empty')

# If consumer creation failed (already exists), fetch the existing one
if [ -z "$CONSUMER_ID" ]; then
  CONSUMER_ID=$(curl -s "$KONG_ADDR/consumers/noosphere-router-admin" | jq -r '.id')
fi

# Get existing basic-auth credentials for this consumer
EXISTING_CREDS=$(curl -s "$KONG_ADDR/consumers/noosphere-router-admin/basic-auth")
EXISTING_CRED_ID=$(echo "$EXISTING_CREDS" | jq -r '.data[0].id // empty')

# Delete existing credential if found
if [ -n "$EXISTING_CRED_ID" ]; then
  curl -s -X DELETE "$KONG_ADDR/consumers/noosphere-router-admin/basic-auth/$EXISTING_CRED_ID" > /dev/null 2>&1 || true
fi

# Create new credential with current password from environment
# Use form-encoded data to properly handle special characters in password
CRED_RESPONSE=$(curl -s -X POST "$KONG_ADDR/consumers/noosphere-router-admin/basic-auth" \
  --data-urlencode "username=$ADMIN_USERNAME" \
  --data-urlencode "password=$ADMIN_PASSWORD")

# Check if credential creation was successful
if echo "$CRED_RESPONSE" | jq -e '.id' > /dev/null 2>&1; then
  echo "Admin basic-auth configured for user: $ADMIN_USERNAME"
else
  echo "Error: Failed to create basic-auth credential"
  echo "$CRED_RESPONSE" | jq '.'
  exit 1
fi
