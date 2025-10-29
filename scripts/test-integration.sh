#!/bin/bash
# Integration test runner
# Spins up isolated test environment, runs integration tests, tears down

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}Running Integration Tests${NC}"
echo -e "${BLUE}================================================${NC}"
echo ""

# Cleanup function
cleanup() {
  echo ""
  echo -e "${YELLOW}Cleaning up test environment...${NC}"
  docker-compose -f docker-compose.test.yml down -v > /dev/null 2>&1 || true
  echo -e "${GREEN}✓ Cleanup complete${NC}"
}

# Trap to ensure cleanup on exit
trap cleanup EXIT INT TERM

# Step 1: Build super image if needed
echo -e "${BLUE}Step 1: Building lunar-super image...${NC}"
docker-compose -f docker-compose.test.yml build lunar-super-test

# Step 2: Start test environment
echo ""
echo -e "${BLUE}Step 2: Starting test environment...${NC}"
docker-compose -f docker-compose.test.yml up -d postgres-test test-proxy kong-migrations-test lunar-super-test kong-provisioner-test

# Step 3: Wait for services to be healthy
echo ""
echo -e "${BLUE}Step 3: Waiting for services to be healthy...${NC}"

MAX_WAIT=60
ELAPSED=0

while [ $ELAPSED -lt $MAX_WAIT ]; do
  if docker-compose -f docker-compose.test.yml ps | grep -q "lunar-test-super.*healthy"; then
    echo -e "${GREEN}✓ All services are healthy${NC}"
    break
  fi

  echo -n "."
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

if [ $ELAPSED -ge $MAX_WAIT ]; then
  echo ""
  echo -e "${RED}✗ Services failed to become healthy within ${MAX_WAIT}s${NC}"
  echo ""
  echo -e "${YELLOW}Service status:${NC}"
  docker-compose -f docker-compose.test.yml ps
  echo ""
  echo -e "${YELLOW}Logs:${NC}"
  docker-compose -f docker-compose.test.yml logs --tail=50
  exit 1
fi

# Step 4: Wait for provisioner to complete and verify routes
echo ""
echo -e "${BLUE}Step 4: Waiting for Kong provisioning to complete...${NC}"

MAX_WAIT=30
ELAPSED=0

while [ $ELAPSED -lt $MAX_WAIT ]; do
  # Check if provisioner container has exited successfully
  if docker-compose -f docker-compose.test.yml ps -a | grep -q "lunar-test-provisioner.*Exited (0)"; then
    echo -e "${GREEN}✓ Kong provisioning completed${NC}"
    # Give Kong a moment to fully reload configuration
    sleep 2
    break
  fi

  echo -n "."
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

if [ $ELAPSED -ge $MAX_WAIT ]; then
  echo ""
  echo -e "${RED}✗ Provisioner failed to complete within ${MAX_WAIT}s${NC}"
  echo ""
  echo -e "${YELLOW}Provisioner logs:${NC}"
  docker-compose -f docker-compose.test.yml logs kong-provisioner-test
  exit 1
fi

# Step 5: Run integration tests
echo ""
echo -e "${BLUE}Step 5: Running integration tests...${NC}"
echo ""

# Check if specific test file was provided
TEST_PATTERN="${1:-tests/*.integration.test.js}"
if [ -n "$1" ]; then
  echo -e "${YELLOW}Running specific test: $1${NC}"
fi

# Run tests with test-runner container
if docker-compose -f docker-compose.test.yml run --rm test-runner npx jest --runInBand $TEST_PATTERN; then
  EXIT_CODE=0
  echo ""
  echo -e "${GREEN}================================================${NC}"
  echo -e "${GREEN}✓ All integration tests passed!${NC}"
  echo -e "${GREEN}================================================${NC}"
else
  EXIT_CODE=1
  echo ""
  echo -e "${RED}================================================${NC}"
  echo -e "${RED}✗ Integration tests failed${NC}"
  echo -e "${RED}================================================${NC}"
  echo ""
  echo -e "${YELLOW}Test environment logs:${NC}"
  docker-compose -f docker-compose.test.yml logs --tail=100 lunar-super-test
fi

# Cleanup happens in trap
exit $EXIT_CODE
