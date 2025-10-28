# Lunar Super Image - Kong + Backend Combined
FROM kong:3.9.0

# Switch to root for installations
USER root

# Install Node.js, npm, supervisor, and other dependencies
# Kong image is based on Debian, so use apt-get
RUN apt-get update && apt-get install -y \
    curl \
    gnupg \
    supervisor \
    wget \
    && curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy and install backend dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy backend application
COPY src/ ./src/
COPY public/ ./public/
COPY contracts/ ./contracts/

# Copy Kong configuration
COPY kong/ /kong/

# Copy supervisor configuration
COPY docker/supervisord.conf /etc/supervisord.conf

# Create log directory for supervisor
RUN mkdir -p /var/log/supervisor

# Expose ports
# 5872: Backend/Dashboard
# 8000: Kong Proxy
# 8001: Kong Admin API
EXPOSE 5872 8000 8001

# Use supervisord to manage both Kong and Backend
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisord.conf"]
