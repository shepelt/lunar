#!/bin/bash
# Build Lunar Air-Gapped Deployment Package
# This script creates a complete deployment package that can be transferred
# to machines without internet access or GitHub access.
#
# Usage: ./build-airgap-package.sh [--no-postgres]
#   --no-postgres    Exclude PostgreSQL from package (useful if target has PostgreSQL)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PACKAGE_DIR="lunar-airgap-deployment"
PACKAGE_FILE="lunar-airgap-deployment.tar.gz"

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

echo "🌙 Building Lunar Air-Gapped Deployment Package"
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

# Step 1: Build Lunar super image
echo "📦 Building Lunar super image..."
cd "$SCRIPT_DIR"
docker-compose build lunar-super

# Tag the image with a consistent name
echo "🏷️  Tagging image as lunar-super:latest..."
BUILT_IMAGE=$(docker images --format "{{.Repository}}:{{.Tag}}" | grep -E "docker.*lunar-super|lunar.*super" | head -1)
if [ -z "$BUILT_IMAGE" ]; then
  echo "❌ Error: Could not find built lunar-super image"
  exit 1
fi
docker tag "$BUILT_IMAGE" lunar-super:latest

# Step 2: Pull base images
echo "📥 Pulling base images..."
if [ "$INCLUDE_POSTGRES" = true ]; then
  docker pull postgres:15-alpine
fi
docker pull kong:3.9.0
docker pull alpine:latest

# Step 3: Save images as tarballs
echo "💾 Saving Docker images as tarballs..."
echo "  - lunar-super (this may take a few minutes)..."
docker save -o "$PACKAGE_DIR/lunar-super.tar" lunar-super:latest

if [ "$INCLUDE_POSTGRES" = true ]; then
  echo "  - postgres:15-alpine..."
  docker save -o "$PACKAGE_DIR/postgres-15-alpine.tar" postgres:15-alpine
fi

echo "  - kong:3.9.0..."
docker save -o "$PACKAGE_DIR/kong-3.9.0.tar" kong:3.9.0

echo "  - alpine:latest..."
docker save -o "$PACKAGE_DIR/alpine-latest.tar" alpine:latest

# Step 4: Copy configuration files
echo "📋 Copying configuration files..."
cp -r "$PROJECT_ROOT/kong" "$PACKAGE_DIR/"
cp -r "$PROJECT_ROOT/kong-plugins" "$PACKAGE_DIR/"
cp "$PROJECT_ROOT/.env.example" "$PACKAGE_DIR/.env.example"

# Create modified docker-compose.yml for air-gap deployment
echo "📝 Creating air-gap docker-compose.yml..."
cat docker-compose.yml | \
  sed 's|build:|image: lunar-super:latest\n    # build:|' | \
  sed 's|context: ..|# context: ..|' | \
  sed 's|dockerfile: docker/Dockerfile|# dockerfile: docker/Dockerfile|' | \
  sed 's|../kong/|./kong/|g' | \
  sed 's|../kong-plugins/|./kong-plugins/|g' \
  > "$PACKAGE_DIR/docker-compose.yml"

# Step 5: Create deployment script
echo "📝 Creating deployment script..."
cat > "$PACKAGE_DIR/deploy.sh" << 'EOF'
#!/bin/bash
set -e

echo "🌙 Lunar Gateway - Air-Gapped Deployment"
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
echo "  - lunar-super.tar..."
docker load -i lunar-super.tar

if [ -f "postgres-15-alpine.tar" ]; then
  echo "  - postgres-15-alpine.tar..."
  docker load -i postgres-15-alpine.tar
else
  echo "  ⚠️  PostgreSQL not included - ensure postgres:15-alpine is available"
fi

echo "  - kong-3.9.0.tar..."
docker load -i kong-3.9.0.tar

echo "  - alpine-latest.tar..."
docker load -i alpine-latest.tar

echo ""
echo "✅ All Docker images loaded successfully!"
echo ""
echo "📋 Next steps:"
echo "  1. Configure environment: cp .env.example .env && nano .env"
echo "  2. Start services: docker-compose up -d"
echo "  3. View logs: docker-compose logs -f"
echo "  4. Access dashboard: http://localhost:5872"
echo ""
EOF

chmod +x "$PACKAGE_DIR/deploy.sh"

# Step 6: Create README
echo "📖 Creating deployment README..."
cat > "$PACKAGE_DIR/README.txt" << EOF
Lunar Gateway - Air-Gapped Deployment Package
==============================================

This package contains everything needed to deploy Lunar Gateway on a
machine without internet access or GitHub access.

CONTENTS:
  - lunar-super.tar        : Lunar application (Kong + Backend)
$([ "$INCLUDE_POSTGRES" = true ] && echo "  - postgres-15-alpine.tar : PostgreSQL database (Alpine Linux)" || echo "  (PostgreSQL not included - use existing installation)")
  - kong-3.9.0.tar         : Kong Gateway base image
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

2. Configure environment:
   cp .env.example .env
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
  - Shell access: docker exec -it lunar-super sh

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
echo "📤 Transfer this file to your air-gapped machine:"
echo "  scp $PACKAGE_FILE user@server:/tmp/"
echo ""
echo "🚀 On the air-gapped machine:"
echo "  tar -xzf $PACKAGE_FILE"
echo "  cd $PACKAGE_DIR"
echo "  ./deploy.sh"
echo ""
