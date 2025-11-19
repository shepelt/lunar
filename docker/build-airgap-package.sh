#!/bin/bash
# Build Noosphere Router Air-Gapped Deployment Package
# This script creates a complete deployment package that can be transferred
# to machines without internet access or GitHub access.
#
# Usage: ./build-airgap-package.sh [--no-postgres]
#   --no-postgres    Exclude PostgreSQL from package (useful if target has PostgreSQL)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PACKAGE_DIR="noosphere-router-airgap-deployment"
PACKAGE_FILE="noosphere-router-airgap-deployment.tar.gz"

# Parse command line arguments
INCLUDE_POSTGRES=true
while [[ $# -gt 0 ]]; do
  case $1 in
    --no-postgres)
      INCLUDE_POSTGRES=false
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--no-postgres]"
      exit 1
      ;;
  esac
done

echo "🌙 Building Noosphere Router Air-Gapped Deployment Package"
echo "================================================"
if [ "$INCLUDE_POSTGRES" = false ]; then
  echo "⚠️  PostgreSQL will be EXCLUDED from this package"
fi
echo ""

# Clean up previous builds
if [ -d "$PACKAGE_DIR" ]; then
  echo "🧹 Cleaning up previous build..."
  rm -rf "$PACKAGE_DIR"
fi

if [ -f "$PACKAGE_FILE" ]; then
  rm -f "$PACKAGE_FILE"
fi

# Create package directory
mkdir -p "$PACKAGE_DIR"

# Step 1: Build Noosphere Router super image
echo "📦 Building Noosphere Router super image..."
cd "$SCRIPT_DIR"
docker-compose build noosphere-router-super

# Tag the image with a consistent name
echo "🏷️  Tagging image as noosphere-router-super:latest..."
BUILT_IMAGE=$(docker images --format "{{.Repository}}:{{.Tag}}" | grep -E "docker.*noosphere-router-super|lunar.*super" | head -1)
if [ -z "$BUILT_IMAGE" ]; then
  echo "❌ Error: Could not find built noosphere-router-super image"
  exit 1
fi
docker tag "$BUILT_IMAGE" noosphere-router-super:latest

# Step 2: Pull base images
echo "📥 Pulling base images..."
if [ "$INCLUDE_POSTGRES" = true ]; then
  docker pull postgres:15-alpine
fi
docker pull kong:3.9.1
docker pull alpine:latest

# Step 3: Save images as tarballs
echo "💾 Saving Docker images as tarballs..."
echo "  - noosphere-router-super (this may take a few minutes)..."
docker save -o "$PACKAGE_DIR/noosphere-router-super.tar" noosphere-router-super:latest

if [ "$INCLUDE_POSTGRES" = true ]; then
  echo "  - postgres:15-alpine..."
  docker save -o "$PACKAGE_DIR/postgres-15-alpine.tar" postgres:15-alpine
fi

echo "  - kong:3.9.1..."
docker save -o "$PACKAGE_DIR/kong-3.9.1.tar" kong:3.9.1

echo "  - alpine:latest..."
docker save -o "$PACKAGE_DIR/alpine-latest.tar" alpine:latest

echo "  - tailscale/tailscale:latest..."
docker pull tailscale/tailscale:latest
docker save -o "$PACKAGE_DIR/tailscale-latest.tar" tailscale/tailscale:latest

# Step 4: Copy configuration files
echo "📋 Copying configuration files..."
cp -r "$PROJECT_ROOT/kong" "$PACKAGE_DIR/"
cp -r "$PROJECT_ROOT/kong-plugins" "$PACKAGE_DIR/"

# Copy .env.example (but NOT .env - let deploy script handle that)
echo "  Copying .env.example..."
cp "$PROJECT_ROOT/.env.example" "$PACKAGE_DIR/.env.example"

# Copy Tailscale configuration
echo "  Copying tailscale-serve.json..."
cp "tailscale-serve.json" "$PACKAGE_DIR/tailscale-serve.json"

# Create modified docker-compose.yml for air-gap deployment
echo "📝 Creating air-gap docker-compose.yml..."
cat docker-compose.yml | \
  sed 's|build:|image: noosphere-router-super:latest\n    # build:|' | \
  sed 's|context: ..|# context: ..|' | \
  sed 's|dockerfile: docker/Dockerfile|# dockerfile: docker/Dockerfile|' | \
  sed 's|\.\./kong/|./kong/|g' | \
  sed 's|\.\./kong-plugins|./kong-plugins|g' \
  > "$PACKAGE_DIR/docker-compose.yml"

# Step 5: Create deployment script
echo "📝 Creating deployment script..."
cat > "$PACKAGE_DIR/deploy.sh" << 'EOF'
#!/bin/bash
set -e

echo "🌙 Noosphere Router Gateway - Air-Gapped Deployment"
echo "========================================="
echo ""

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    exit 1
fi

if ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose is not installed. Please install Docker Compose first."
    exit 1
fi

echo "Loading Docker images..."
echo "  - noosphere-router-super.tar..."
docker load -i noosphere-router-super.tar

if [ -f "postgres-15-alpine.tar" ]; then
  echo "  - postgres-15-alpine.tar..."
  docker load -i postgres-15-alpine.tar
else
  echo "  ⚠️  PostgreSQL not included - ensure postgres:15-alpine is available"
fi

echo "  - kong-3.9.1.tar..."
docker load -i kong-3.9.1.tar

echo "  - alpine-latest.tar..."
docker load -i alpine-latest.tar

echo "  - tailscale-latest.tar..."
docker load -i tailscale-latest.tar

echo ""
echo "✅ All Docker images loaded successfully!"
echo ""
echo "📋 Next steps:"
echo "  1. Configure environment: nano .env  (or cp .env.example .env if missing)"
echo "  2. Start services: docker-compose up -d"
echo "  3. (Optional) Start with Tailscale: docker-compose --profile tailscale up -d"
echo "  4. View logs: docker-compose logs -f"
echo "  5. Access dashboard: http://localhost:8000/admin"
echo ""
EOF

chmod +x "$PACKAGE_DIR/deploy.sh"

# Step 6: Create README
echo "📖 Creating deployment README..."
cat > "$PACKAGE_DIR/README.txt" << EOF
Noosphere Router Gateway - Air-Gapped Deployment Package
==============================================

This package contains everything needed to deploy Noosphere Router Gateway on a
machine without internet access or GitHub access.

CONTENTS:
  - noosphere-router-super.tar        : Noosphere Router application (Kong + Backend)
$([ "$INCLUDE_POSTGRES" = true ] && echo "  - postgres-15-alpine.tar : PostgreSQL database (Alpine Linux)" || echo "  (PostgreSQL not included - use existing installation)")
  - kong-3.9.1.tar         : Kong Gateway base image
  - alpine-latest.tar      : Alpine Linux (for provisioner)
  - docker-compose.yml     : Deployment configuration
  - kong/                  : Kong configuration files
  - kong-plugins/          : Custom Kong plugins
  - .env.example           : Configuration template
  - deploy.sh              : Deployment script
  - README.txt             : This file

PREREQUISITES:
  - Docker Engine 20.10+
  - Docker Compose 2.0+
$([ "$INCLUDE_POSTGRES" = false ] && echo "  - PostgreSQL 15 (Alpine) - must be available as postgres:15-alpine image")

DEPLOYMENT STEPS:

1. Load Docker images:
   ./deploy.sh

2. Configure environment (if needed):
   # .env is auto-created from .env.example on first build
   nano .env

   Required configuration:
   - BLOCKCHAIN_PRIVATE_KEY
   - BLOCKCHAIN_RPC_URL
   - BLOCKCHAIN_CONTRACT_ADDRESS
   - OPENAI_API_KEY (optional)
   - OLLAMA_BACKEND_URL (optional)

3. Start services:
   docker-compose up -d

4. Verify deployment:
   docker-compose ps
   curl http://localhost:5872/health

ACCESS POINTS:
  - Dashboard:       http://localhost:5872
  - Kong Gateway:    http://localhost:8000
  - Kong Admin API:  http://localhost:8001

TROUBLESHOOTING:
  - View logs: docker-compose logs -f
  - Check status: docker-compose ps
  - Restart: docker-compose restart
  - Shell access: docker exec -it noosphere-router-super sh

For full documentation, see docker/README.md in the source repository.
EOF

# Step 7: Get package size information
echo ""
echo "📊 Package size information:"
du -sh "$PACKAGE_DIR"/*.tar | sort -h

# Step 8: Create compressed tarball
echo ""
echo "🗜️  Creating compressed deployment package..."
tar -czf "$PACKAGE_FILE" "$PACKAGE_DIR/"

# Calculate sizes
UNCOMPRESSED_SIZE=$(du -sh "$PACKAGE_DIR" | cut -f1)
COMPRESSED_SIZE=$(du -sh "$PACKAGE_FILE" | cut -f1)

echo ""
echo "✅ Air-gapped deployment package created successfully!"
echo ""
echo "📦 Package Details:"
echo "  Uncompressed: $UNCOMPRESSED_SIZE"
echo "  Compressed:   $COMPRESSED_SIZE"
echo "  Location:     $SCRIPT_DIR/$PACKAGE_FILE"
echo ""
echo "🚀 Deploy to remote server:"
echo "  npm run docker:airgap:deploy <hostname>"
echo "  Example: npm run docker:airgap:deploy your-server.example.com"
echo ""
echo "📝 Rebuild package:"
echo "  npm run docker:airgap:build"
echo "  npm run docker:airgap:build:no-postgres  (exclude PostgreSQL)"
echo ""
echo "Or manually transfer and extract:"
echo "  scp $PACKAGE_FILE user@server:/tmp/"
echo "  ssh user@server 'cd ~ && tar -xzf /tmp/$PACKAGE_FILE'"
echo ""
