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

# Prepare .env file with host-specific values
echo "📝 Preparing .env file for $REMOTE_HOST..."
if [ ! -f "$PROJECT_ROOT/.env" ]; then
  echo "❌ Error: .env file not found at $PROJECT_ROOT/.env"
  exit 1
fi

# Create temporary .env with substituted values
TMP_ENV="/tmp/lunar-deploy-${REMOTE_HOST}.env"
cat "$PROJECT_ROOT/.env" | \
  sed "s|LUNAR_ENDPOINT_URL=.*|LUNAR_ENDPOINT_URL=http://${REMOTE_HOST}:8000|" | \
  sed "s|OLLAMA_BACKEND_URL=.*|OLLAMA_BACKEND_URL=http://localhost:11434|" | \
  sed "s|BACKEND_URL=.*|BACKEND_URL=http://localhost:5872|" \
  > "$TMP_ENV"

echo "✅ .env configured for $REMOTE_HOST"

# Transfer .env file
echo "📤 Transferring .env file..."
scp "$TMP_ENV" "$REMOTE_HOST:~/lunar-airgap-deployment/.env"

# Transfer updated image
echo "📤 Transferring updated image..."
rsync -avz --progress /tmp/lunar-super-fixed.tar $REMOTE_HOST:~/lunar-airgap-deployment/

# Clean up temp file
rm "$TMP_ENV"

# Deploy on remote server
echo ""
echo "🚀 Deploying on remote server..."
ssh $REMOTE_HOST "bash -s" << 'EOF'
set -e

cd ~/lunar-airgap-deployment

# Stop existing containers
echo "⏹️  Stopping existing containers..."
/usr/local/bin/docker-compose down || true

# Load new image
echo "📦 Loading updated lunar-super image..."
/usr/local/bin/docker load -i lunar-super-fixed.tar

# Start services
echo "🚀 Starting services..."
/usr/local/bin/docker-compose up -d

# Wait a bit for services to initialize
sleep 10

# Check status
echo ""
echo "📊 Container status:"
/usr/local/bin/docker-compose ps

echo ""
echo "🔍 Recent logs:"
/usr/local/bin/docker-compose logs --tail=20 lunar-super

echo ""
echo "✅ Deployment complete!"
EOF

echo ""
echo "🌐 Dashboard: http://$REMOTE_HOST:5872"
echo "🔌 Kong Gateway: http://$REMOTE_HOST:8000"
