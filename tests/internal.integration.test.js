/**
 * Internal networking tests
 *
 * These tests run INSIDE the Docker network to verify:
 * - Kong → Backend connectivity (localhost:5872 inside super container)
 * - Service-to-service communication
 * - Internal route resolution
 * - End-to-end LLM proxy functionality
 * - Audit logging pipeline
 *
 * Run with: docker-compose run test-runner
 * or: npm run test:internal
 */

import { describe, test, expect, beforeAll } from '@jest/globals';

// These URLs access Kong from inside Docker network
const KONG_ADMIN_URL = process.env.KONG_ADMIN_URL || 'http://lunar-super:8001';
const KONG_GATEWAY_URL = process.env.KONG_GATEWAY_URL || 'http://lunar-super:8000';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'test-admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test-password-123';

const TEST_INTERNAL = process.env.TEST_INTERNAL === 'true';

/**
 * Helper to call Kong Admin API
 */
async function kongAdminRequest(path, options = {}) {
  const url = `${KONG_ADMIN_URL}${path}`;
  const response = await fetch(url, options);

  if (!response.ok && response.status !== 404 && response.status !== 409) {
    const text = await response.text();
    throw new Error(`Kong API error: ${response.status} ${response.statusText}: ${text}`);
  }

  return response;
}

/**
 * Helper to call Kong Gateway with auth
 */
async function kongGatewayRequest(path, options = {}) {
  const credentials = Buffer.from(`${ADMIN_USERNAME}:${ADMIN_PASSWORD}`).toString('base64');
  const url = `${KONG_GATEWAY_URL}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Basic ${credentials}`,
      ...options.headers
    }
  });

  return response;
}

describe('Internal Networking Tests', () => {

  beforeAll(async () => {
    // Verify we're running inside Docker network
    if (!TEST_INTERNAL) {
      console.warn('⚠️  TEST_INTERNAL not set - these tests expect to run inside Docker network');
    }

    // Verify Kong is accessible from inside network
    try {
      const response = await kongAdminRequest('/status');
      expect(response.ok).toBe(true);
    } catch (error) {
      throw new Error(`Cannot reach Kong at ${KONG_ADMIN_URL}: ${error.message}`);
    }
  });

  describe('Kong Admin API Accessibility', () => {
    test('should access Kong Admin API via lunar-super hostname', async () => {
      const response = await kongAdminRequest('/status');
      expect(response.ok).toBe(true);

      const status = await response.json();
      expect(status.database).toBeDefined();
      expect(status.server).toBeDefined();
    });

    test('should access all Kong admin endpoints', async () => {
      const endpoints = [
        '/services',
        '/routes',
        '/consumers',
        '/plugins'
      ];

      for (const endpoint of endpoints) {
        const response = await kongAdminRequest(endpoint);
        expect(response.ok).toBe(true);

        const data = await response.json();
        expect(data.data).toBeDefined();
      }
    });
  });

  describe('Backend Connectivity (Inside Super Container)', () => {
    test('should verify backend service is configured correctly', async () => {
      // Get lunar-backend-admin service
      const response = await kongAdminRequest('/services/lunar-backend-admin');
      expect(response.ok).toBe(true);

      const service = await response.json();

      // Inside super container, backend should be at localhost:5872
      expect(service.host).toBe('localhost');
      expect(service.port).toBe(5872);
    });

    test('should verify lunar-gateway plugin uses correct backend_url', async () => {
      // Get routes and check lunar-gateway plugin config
      const routesResponse = await kongAdminRequest('/routes');
      const routes = await routesResponse.json();

      const llmRoute = routes.data.find(r => r.name === 'llm-proxy');
      expect(llmRoute).toBeDefined();

      // Get plugins for LLM route
      const pluginsResponse = await kongAdminRequest(`/routes/${llmRoute.id}/plugins`);
      const plugins = await pluginsResponse.json();

      const lunarGateway = plugins.data.find(p => p.name === 'lunar-gateway');
      expect(lunarGateway).toBeDefined();

      // Should use localhost:5872 inside super container
      expect(lunarGateway.config.backend_url).toBe('http://localhost:5872');
    });

    test('should access backend through Kong admin routes', async () => {
      // Test accessing backend via Kong's admin-api route
      const response = await kongGatewayRequest('/admin/api/config');
      expect(response.ok).toBe(true);

      const config = await response.json();
      expect(config).toBeDefined();
      expect(config.lunar_endpoint_url).toBeDefined();
    });

    test('should access backend health endpoint through Kong', async () => {
      // The backend has a /health endpoint
      // Access it through Kong's admin routes
      const response = await kongGatewayRequest('/admin/api/config');
      expect(response.ok).toBe(true);

      // If we get config, backend is responding
      const config = await response.json();
      expect(config.blockchain_enabled).toBeDefined();
    });
  });

  describe('Service-to-Service Communication', () => {
    test('should verify all services are configured', async () => {
      const response = await kongAdminRequest('/services');
      const services = await response.json();

      const serviceNames = services.data.map(s => s.name);

      expect(serviceNames).toContain('lunar-backend-admin');
      expect(serviceNames).toContain('lunar-backend');
      expect(serviceNames).toContain('llm-service');
    });

    test('should verify service host configurations', async () => {
      const response = await kongAdminRequest('/services');
      const services = await response.json();

      // Check backend services use localhost (inside super container)
      const backendAdmin = services.data.find(s => s.name === 'lunar-backend-admin');
      expect(backendAdmin.host).toBe('localhost');
      expect(backendAdmin.port).toBe(5872);

      const backendApi = services.data.find(s => s.name === 'lunar-backend');
      expect(backendApi.host).toBe('host.docker.internal');
      expect(backendApi.port).toBe(5872);
    });
  });

  describe('Route Resolution', () => {
    test('should verify all critical routes exist', async () => {
      const response = await kongAdminRequest('/routes');
      const routes = await response.json();

      const routeNames = routes.data.map(r => r.name);

      const criticalRoutes = [
        'landing-page',
        'admin-dashboard',
        'admin-api',
        'backend-api',
        'llm-proxy'
      ];

      for (const routeName of criticalRoutes) {
        expect(routeNames).toContain(routeName);
      }
    });

    test('should verify route-to-service mappings', async () => {
      const routesResponse = await kongAdminRequest('/routes');
      const routes = await routesResponse.json();

      // Get services to map IDs to names
      const servicesResponse = await kongAdminRequest('/services');
      const services = await servicesResponse.json();
      const serviceMap = {};
      services.data.forEach(s => {
        serviceMap[s.id] = s.name;
      });

      // Admin dashboard should route to backend admin service
      const adminDashboard = routes.data.find(r => r.name === 'admin-dashboard');
      expect(adminDashboard).toBeDefined();
      expect(adminDashboard.service).toBeDefined();
      expect(serviceMap[adminDashboard.service.id]).toBe('lunar-backend-admin');

      // Admin API should route to backend admin service
      const adminApi = routes.data.find(r => r.name === 'admin-api');
      expect(adminApi).toBeDefined();
      expect(adminApi.service).toBeDefined();
      expect(serviceMap[adminApi.service.id]).toBe('lunar-backend-admin');

      // LLM proxy should route to LLM service
      const llmProxy = routes.data.find(r => r.name === 'llm-proxy');
      expect(llmProxy).toBeDefined();
      expect(llmProxy.service).toBeDefined();
      expect(serviceMap[llmProxy.service.id]).toBe('llm-service');
    });
  });

  describe('Authentication & Authorization', () => {
    test('should require authentication for admin routes', async () => {
      // Try without auth
      const response = await fetch(`${KONG_GATEWAY_URL}/admin/api/config`);
      expect(response.status).toBe(401);
    });

    test('should accept valid credentials', async () => {
      const response = await kongGatewayRequest('/admin/api/config');
      expect(response.ok).toBe(true);
    });

    test('should reject invalid credentials', async () => {
      const badCredentials = Buffer.from('admin:wrongpassword').toString('base64');
      const response = await fetch(`${KONG_GATEWAY_URL}/admin/api/config`, {
        headers: {
          'Authorization': `Basic ${badCredentials}`
        }
      });

      expect(response.status).toBe(401);
    });
  });

  describe('Backend API Endpoints', () => {
    test('should access /api/config endpoint', async () => {
      const response = await kongGatewayRequest('/admin/api/config');
      expect(response.ok).toBe(true);

      const config = await response.json();
      expect(config.lunar_endpoint_url).toBeDefined();
      expect(config.blockchain_enabled).toBeDefined();
      expect(config.ollama_model).toBeDefined();
    });

    test('should access /api/consumers endpoint', async () => {
      const response = await kongGatewayRequest('/admin/api/consumers');
      expect(response.ok).toBe(true);

      const consumers = await response.json();
      expect(Array.isArray(consumers)).toBe(true);
    });

    test('should access /api/audit endpoint', async () => {
      const response = await kongGatewayRequest('/admin/api/audit?limit=5');
      expect(response.ok).toBe(true);

      const auditLogs = await response.json();
      expect(Array.isArray(auditLogs)).toBe(true);
    });

    test('should access /api/stats/providers endpoint', async () => {
      const response = await kongGatewayRequest('/admin/api/stats/providers');
      expect(response.ok).toBe(true);

      const stats = await response.json();
      expect(stats).toBeDefined();
    });
  });

  describe('Plugin Configuration', () => {
    test('should verify lunar-gateway plugin is installed', async () => {
      const response = await kongAdminRequest('/plugins');
      const plugins = await response.json();

      const lunarGateways = plugins.data.filter(p => p.name === 'lunar-gateway');
      expect(lunarGateways.length).toBeGreaterThan(0);
    });

    test('should verify basic-auth plugin is installed', async () => {
      const response = await kongAdminRequest('/plugins');
      const plugins = await response.json();

      const basicAuths = plugins.data.filter(p => p.name === 'basic-auth');
      expect(basicAuths.length).toBeGreaterThan(0);
    });

    test('should verify key-auth plugin is installed', async () => {
      const response = await kongAdminRequest('/plugins');
      const plugins = await response.json();

      const keyAuths = plugins.data.filter(p => p.name === 'key-auth');
      expect(keyAuths.length).toBeGreaterThan(0);
    });
  });

  describe('Network DNS Resolution', () => {
    test('should resolve lunar-super hostname from inside network', async () => {
      // This test verifies DNS resolution works
      // If we can fetch from lunar-super:8001, DNS is working
      const response = await kongAdminRequest('/status');
      expect(response.ok).toBe(true);

      // Verify the URL contains the docker hostname
      expect(KONG_ADMIN_URL).toContain('lunar-super');
    });

    test('should be able to reach postgres from inside network', async () => {
      // Check that Kong can reach postgres
      const response = await kongAdminRequest('/status');
      const status = await response.json();

      expect(status.database.reachable).toBe(true);
    });
  });

  describe('Health Checks', () => {
    test('should verify Kong health endpoint', async () => {
      const response = await fetch(`${KONG_ADMIN_URL}/status`);
      expect(response.ok).toBe(true);

      const status = await response.json();
      expect(status.server.connections_accepted).toBeGreaterThan(0);
    });

    test('should verify backend health through Kong', async () => {
      // Backend /health is not exposed through Kong, but we can check
      // if backend is responding by checking /api/config
      const response = await kongGatewayRequest('/admin/api/config');
      expect(response.ok).toBe(true);
    });
  });
});
