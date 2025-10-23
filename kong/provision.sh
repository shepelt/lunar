#!/bin/sh
set -e

# Substitute environment variables in kong.yaml
envsubst < /kong-template.yaml > /tmp/kong.yaml

# Sync Kong configuration
deck gateway sync /tmp/kong.yaml --kong-addr=http://kong:8001
