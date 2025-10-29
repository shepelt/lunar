#!/bin/bash
# Deploy updated Lunar image to remote server
# Usage: ./deploy-to-remote.sh <remote-host>

set -e

REMOTE_HOST=$1
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

if [ -z "$REMOTE_HOST" ]; then
  echo "Usage: $0 <remote-host>"
  echo "Example: $0 your-server.example.com"
  exit 1
fi

echo "🌙 Deploying updated Lunar to $REMOTE_HOST..."
echo ""

# Transfer and extract airgap package
echo "📦 Transferring airgap package..."
PACKAGE_FILE="lunar-airgap-deployment.tar.gz"
if [ ! -f "$SCRIPT_DIR/$PACKAGE_FILE" ]; then
  echo "❌ Error: $PACKAGE_FILE not found. Run 'npm run docker:build:airgap' first."
  exit 1
fi

rsync -avz --progress "$SCRIPT_DIR/$PACKAGE_FILE" $REMOTE_HOST:/tmp/

echo "📂 Extracting package on remote server..."
ssh $REMOTE_HOST "cd ~ && tar -xzf /tmp/$PACKAGE_FILE && rm /tmp/$PACKAGE_FILE"

# Create .env only if it doesn't exist on remote
echo "📝 Checking for .env on remote server..."
if ssh $REMOTE_HOST "[ -f ~/lunar-airgap-deployment/.env ]"; then
  echo "✅ Preserving existing .env file on remote server"
else
  echo "📝 Creating new .env file for $REMOTE_HOST (first time setup)..."
  if [ ! -f "$PROJECT_ROOT/.env" ]; then
    echo "❌ Error: .env file not found at $PROJECT_ROOT/.env"
    exit 1
  fi

  # Create temporary .env with substituted values
  TMP_ENV="/tmp/lunar-deploy-${REMOTE_HOST}.env"
  cat "$PROJECT_ROOT/.env" | \
    sed "s|LUNAR_ENDPOINT_URL=.*|LUNAR_ENDPOINT_URL=http://${REMOTE_HOST}:8000|" | \
    sed "s|^BACKEND_URL=.*|BACKEND_URL=http://localhost:5872|" | \
    sed "s|OLLAMA_BACKEND_URL=.*|OLLAMA_BACKEND_URL=http://host.docker.internal:11434|" \
    > "$TMP_ENV"

  echo "📤 Transferring configured .env file..."
  scp "$TMP_ENV" "$REMOTE_HOST:~/lunar-airgap-deployment/.env"

  # Clean up temp file
  rm "$TMP_ENV"
fi

# Deploy on remote server
echo ""
echo "🚀 Deploying on remote server..."
ssh $REMOTE_HOST "bash -s" << 'EOF'
set -e

cd ~/lunar-airgap-deployment

# Detect Docker paths (support both Docker Desktop and Colima)
if [ -f /opt/homebrew/bin/docker ]; then
  DOCKER_CMD="/opt/homebrew/bin/docker"
  DOCKER_COMPOSE_CMD="/opt/homebrew/bin/docker-compose"
elif [ -f /usr/local/bin/docker ]; then
  DOCKER_CMD="/usr/local/bin/docker"
  DOCKER_COMPOSE_CMD="/usr/local/bin/docker-compose"
elif command -v docker-compose &> /dev/null; then
  DOCKER_CMD="docker"
  DOCKER_COMPOSE_CMD="docker-compose"
elif command -v docker &> /dev/null && docker compose version &> /dev/null; then
  DOCKER_CMD="docker"
  DOCKER_COMPOSE_CMD="docker compose"
else
  echo "❌ Docker not found!"
  exit 1
fi

echo "🐳 Using Docker at: $DOCKER_CMD"

# Stop existing containers
echo "⏹️  Stopping existing containers..."
$DOCKER_COMPOSE_CMD down || true

# Load new images
echo "📦 Loading updated images..."
$DOCKER_CMD load -i lunar-super.tar
$DOCKER_CMD load -i kong-3.9.1.tar

# Start services with architecture detection
echo "🚀 Starting services..."
export DECK_ARCH=$(uname -m | sed 's/aarch64/arm64/;s/x86_64/amd64/')
echo "  Detected architecture: $DECK_ARCH"
$DOCKER_COMPOSE_CMD up -d

# Wait a bit for services to initialize
sleep 10

# Check status
echo ""
echo "📊 Container status:"
$DOCKER_COMPOSE_CMD ps

echo ""
echo "🔍 Recent logs:"
$DOCKER_COMPOSE_CMD logs --tail=20 lunar-super

echo ""
echo "✅ Deployment complete!"
EOF

echo ""
echo "🌐 Dashboard: http://$REMOTE_HOST:8000/admin"
echo "🔌 Kong Gateway: http://$REMOTE_HOST:8000"
