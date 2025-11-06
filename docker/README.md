# Noosphere Router - Docker Deployment

Fully containerized deployment with Kong + Backend combined in a single container.

## Architecture

```
┌─────────────────────────────────────┐
│     noosphere-router-super (Kong + Backend)    │
│  ┌───────────┐    ┌──────────────┐  │
│  │   Kong    │    │   Node.js    │  │
│  │  :8000    │    │   Backend    │  │
│  │  :8001    │    │   :5872      │  │
│  └───────────┘    └──────────────┘  │
│       (managed by supervisord)      │
└─────────────────────────────────────┘
              │
              ↓
    ┌──────────────────┐
    │    PostgreSQL    │
    │      :5432       │
    └──────────────────┘
```

**Components:**
- **noosphere-router-super**: Combined Kong API Gateway + Node.js Backend
- **postgres**: PostgreSQL database (shared)
- **kong-provisioner**: One-time Kong configuration setup

## Quick Start

### Prerequisites
- Docker & Docker Compose installed
- `.env` file configured

### Deployment

```bash
# From project root
cd docker

# Copy and configure environment
cp ../.env.example ../.env
nano ../.env  # Edit configuration

# Start everything
docker-compose up -d

# View logs
docker-compose logs -f

# Stop everything
docker-compose down
```

### Access Points

Once running:
- **Dashboard**: http://localhost:5872
- **Kong Gateway**: http://localhost:8000
- **Kong Admin API**: http://localhost:8001

## Environment Configuration

Edit `../.env` file with your settings:

```bash
# LLM Providers
OPENAI_API_KEY=sk-your-key-here
OLLAMA_BACKEND_URL=http://host.docker.internal:11434
OLLAMA_MODEL_NAME=gpt-oss:120b

# Public Endpoint (for dashboard display)
LUNAR_ENDPOINT_URL=http://your-server.tailscale.ts.net:8000

# Blockchain
BLOCKCHAIN_PRIVATE_KEY=0x...
BLOCKCHAIN_RPC_URL=https://sepolia.hpp.io
BLOCKCHAIN_CONTRACT_ADDRESS=0x...
```

## Deployment on Remote Server

```bash
# 1. Clone repository
git clone <your-repo> ~/lunar
cd ~/lunar

# 2. Configure environment
cp .env.example .env
nano .env

# 3. Deploy
cd docker
docker-compose up -d
```

## Container Management

```bash
# View status
docker-compose ps

# View logs
docker-compose logs -f noosphere-router-super
docker-compose logs -f postgres

# Restart services
docker-compose restart

# Rebuild after code changes
docker-compose up -d --build

# Stop and remove everything (preserves data)
docker-compose down

# Stop and remove everything including data
docker-compose down -v
```

## Troubleshooting

### Check if services are running inside container
```bash
docker exec noosphere-router-super supervisorctl status
```

### Access container shell
```bash
docker exec -it noosphere-router-super sh
```

### Check Kong configuration
```bash
docker exec noosphere-router-super kong config db_export
```

### Check backend health
```bash
curl http://localhost:5872/health
```

### Kong not responding
```bash
# Check Kong logs
docker-compose logs kong-provisioner

# Verify Kong is running
docker exec noosphere-router-super kong health
```

## Benefits of Combined Container

✅ **Simplified deployment** - Only 2 main containers instead of 4
✅ **Reduced network complexity** - Kong and Backend communicate via localhost
✅ **Faster startup** - No inter-container network delays
✅ **Easier debugging** - Everything in one place
✅ **Lower resource usage** - Fewer container processes
✅ **Perfect for appliance deployment** - Single deployable unit

## Air-Gapped Deployment (No Internet/Repository Access)

For secure environments without internet access or GitHub access, you can deploy using pre-built Docker image tarballs.

### Step 1: Prepare Images (On Machine with Internet)

```bash
# Clone repository and build images
git clone <your-repo> ~/lunar
cd ~/lunar/docker

# Build the Lunar super image
docker-compose build noosphere-router-super

# Pull required base images
docker pull postgres:15-alpine
docker pull kong:3.9.0
docker pull alpine:latest

# Save images as tarballs
docker save -o noosphere-router-super.tar noosphere-router-super:latest
docker save -o postgres-15-alpine.tar postgres:15-alpine
docker save -o kong-3.9.0.tar kong:3.9.0
docker save -o alpine-latest.tar alpine:latest

# Create deployment package
mkdir lunar-airgap-deployment
cp noosphere-router-super.tar postgres-15-alpine.tar kong-3.9.0.tar alpine-latest.tar lunar-airgap-deployment/
cp docker-compose.yml lunar-airgap-deployment/
cp -r ../kong lunar-airgap-deployment/
cp -r ../kong-plugins lunar-airgap-deployment/
cp ../.env.example lunar-airgap-deployment/.env.example

# Create deployment script
cat > lunar-airgap-deployment/deploy.sh << 'EOF'
#!/bin/bash
set -e

echo "Loading Docker images..."
docker load -i noosphere-router-super.tar
docker load -i postgres-15-alpine.tar
docker load -i kong-3.9.0.tar
docker load -i alpine-latest.tar

echo "✅ Images loaded successfully"
echo ""
echo "Next steps:"
echo "1. Copy .env.example to .env and configure: cp .env.example .env"
echo "2. Edit .env with your configuration: nano .env"
echo "3. Start services: docker-compose up -d"
EOF

chmod +x lunar-airgap-deployment/deploy.sh

# Create tarball of entire deployment package
tar -czf lunar-airgap-deployment.tar.gz lunar-airgap-deployment/

echo "✅ Air-gap deployment package created: lunar-airgap-deployment.tar.gz"
echo "Transfer this file to your air-gapped machine"
```

**Package Contents:**
```
lunar-airgap-deployment.tar.gz
└── lunar-airgap-deployment/
    ├── noosphere-router-super.tar          # Lunar application image (~200MB)
    ├── postgres-15-alpine.tar   # PostgreSQL database Alpine (~50MB)
    ├── kong-3.9.0.tar          # Kong Gateway (~120MB)
    ├── alpine-latest.tar        # Alpine Linux (~4MB)
    ├── docker-compose.yml       # Deployment configuration
    ├── deploy.sh               # Deployment script
    ├── .env.example            # Configuration template
    ├── kong/                   # Kong configuration files
    └── kong-plugins/           # Custom Kong plugins
```

### Step 2: Deploy on Air-Gapped Machine

```bash
# 1. Transfer the deployment package to air-gapped machine
scp lunar-airgap-deployment.tar.gz user@airgapped-server:/tmp/

# 2. On the air-gapped machine
cd /opt
tar -xzf /tmp/lunar-airgap-deployment.tar.gz
cd lunar-airgap-deployment

# 3. Load Docker images
./deploy.sh

# 4. Configure environment
cp .env.example .env
nano .env  # Edit with your configuration

# 5. Start services
docker-compose up -d

# 6. Verify deployment
docker-compose ps
curl http://localhost:5872/health
```

### Step 3: Verify Deployment

```bash
# Check loaded images
docker images | grep -E 'noosphere-router-super|postgres|kong|alpine'

# Expected output:
# noosphere-router-super       latest    ...    937MB
# postgres          15-alpine ...    230MB
# kong              3.9.0     ...    550MB
# alpine            latest    ...    13MB

# Check running containers
docker-compose ps

# Test endpoints
curl http://localhost:5872/health        # Backend health
curl http://localhost:8001/status        # Kong status
```

### Air-Gapped Deployment Notes

**Advantages:**
✅ No internet required during deployment
✅ Consistent across all environments
✅ Pre-validated images
✅ Faster deployment (no downloads)
✅ Suitable for secure/classified networks

**Package Size:** ~380MB total (compressed to ~150MB)

**Updates:** To update an air-gapped deployment:
1. Build new images on internet-connected machine
2. Create new deployment package
3. Transfer to air-gapped machine
4. Load new images: `docker load -i noosphere-router-super.tar`
5. Restart services: `docker-compose up -d --force-recreate`

### Alternative: Save Running System

If you already have Lunar running and want to package it:

```bash
# Save all Lunar-related images
docker images --format "{{.Repository}}:{{.Tag}}" | grep -E 'lunar|postgres|kong|alpine' | xargs -I {} docker save -o {}.tar {}

# Create deployment package
mkdir lunar-package
mv *.tar lunar-package/
docker-compose config > lunar-package/docker-compose.yml
cp -r kong kong-plugins lunar-package/
tar -czf lunar-package.tar.gz lunar-package/
```

## Data Persistence

PostgreSQL data is stored in a Docker volume:
```bash
# Backup database
docker exec lunar-postgres pg_dump -U kong kong > backup.sql

# Restore database
docker exec -i lunar-postgres psql -U kong kong < backup.sql
```
