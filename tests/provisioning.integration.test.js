/**
 * Integration tests for Kong Gateway
 *
 * Tests the full Kong setup including:
 * - Provisioning (consumer creation, credentials)
 * - Authentication (basic-auth)
 * - Routes and services configuration
 * - Gateway functionality
 * - Special character handling in passwords
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

// Kong Admin API endpoint
const KONG_ADMIN_URL = process.env.KONG_ADMIN_URL || 'http://localhost:8001';
const KONG_GATEWAY_URL = process.env.KONG_GATEWAY_URL || 'http://localhost:8000';

// Test credentials (must match docker-compose.test.yml)
const TEST_ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'test-admin';
const TEST_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test-password-123';

/**
 * Helper function to call Kong Admin API
 */
async function kongAdminRequest(path, options = {}) {
  const url = `${KONG_ADMIN_URL}${path}`;
  const response = await fetch(url, options);

  if (!response.ok && response.status !== 404 && response.status !== 409) {
    throw new Error(`Kong API error: ${response.status} ${response.statusText}`);
  }

  return response;
}

/**
 * Helper function to test authentication against Kong Gateway
 */
async function testAuthentication(username, password) {
  const credentials = Buffer.from(`${username}:${password}`).toString('base64');
  const response = await fetch(`${KONG_GATEWAY_URL}/admin/api/config`, {
    headers: {
      'Authorization': `Basic ${credentials}`
    }
  });

  return response.ok;
}

/**
 * Helper function to cleanup test resources
 */
async function cleanupTestConsumer() {
  try {
    // Get all credentials for noosphere-router-admin consumer
    const credsResponse = await kongAdminRequest('/consumers/noosphere-router-admin/basic-auth');
    if (credsResponse.ok) {
      const creds = await credsResponse.json();

      // Delete all credentials
      for (const cred of creds.data || []) {
        await kongAdminRequest(`/consumers/noosphere-router-admin/basic-auth/${cred.id}`, {
          method: 'DELETE'
        });
      }
    }
  } catch (error) {
    // Ignore cleanup errors
  }
}

describe('Kong Provisioning Integration Tests', () => {

  beforeAll(async () => {
    // Ensure Kong is running
    try {
      const response = await kongAdminRequest('/status');
      expect(response.ok).toBe(true);
    } catch (error) {
      throw new Error('Kong is not running. Start Kong with: docker-compose up -d');
    }

    // Note: Don't cleanup credentials here - the provisioner has already set them up
    // and other tests depend on them existing. Individual tests will clean up after themselves.
  });

  afterAll(async () => {
    // Instead of deleting all credentials, ensure the expected test credentials exist
    // so other tests can continue to work
    try {
      // Get current credentials
      const credsResponse = await kongAdminRequest('/consumers/noosphere-router-admin/basic-auth');
      if (credsResponse.ok) {
        const creds = await credsResponse.json();

        // Check if test-admin credential exists with correct password
        const hasCorrectCred = creds.data?.some(c => c.username === TEST_ADMIN_USERNAME);

        if (!hasCorrectCred) {
          // Restore the test credential
          const formData = new URLSearchParams();
          formData.append('username', TEST_ADMIN_USERNAME);
          formData.append('password', TEST_ADMIN_PASSWORD);

          await kongAdminRequest('/consumers/noosphere-router-admin/basic-auth', {
            method: 'POST',
            body: formData
          });
        }
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  test('should create noosphere-router-admin consumer if not exists', async () => {
    // Try to create consumer
    const response = await kongAdminRequest('/consumers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'noosphere-router-admin' })
    });

    // Should either create (201) or already exist (409)
    expect([201, 409]).toContain(response.status);

    // Verify consumer exists
    const getResponse = await kongAdminRequest('/consumers/noosphere-router-admin');
    expect(getResponse.ok).toBe(true);

    const consumer = await getResponse.json();
    expect(consumer.username).toBe('noosphere-router-admin');
    expect(consumer.id).toBeDefined();
  });

  test('should extract consumer ID from API response using jq pattern', async () => {
    // Simulate what provision.sh does
    const response = await kongAdminRequest('/consumers/noosphere-router-admin');
    const consumer = await response.json();

    // Test jq pattern: .id
    expect(consumer.id).toBeDefined();
    expect(typeof consumer.id).toBe('string');
    expect(consumer.id.length).toBeGreaterThan(0);
  });

  test('should create basic-auth credential with special characters in password', async () => {
    // Delete existing credential first (if any)
    const existingCredsResponse = await kongAdminRequest('/consumers/noosphere-router-admin/basic-auth');
    if (existingCredsResponse.ok) {
      const existingCreds = await existingCredsResponse.json();
      for (const cred of existingCreds.data || []) {
        await kongAdminRequest(`/consumers/noosphere-router-admin/basic-auth/${cred.id}`, {
          method: 'DELETE'
        });
      }
    }

    // Create credential with complex password
    const formData = new URLSearchParams();
    formData.append('username', TEST_ADMIN_USERNAME);
    formData.append('password', TEST_ADMIN_PASSWORD);

    const response = await kongAdminRequest('/consumers/noosphere-router-admin/basic-auth', {
      method: 'POST',
      body: formData
    });

    expect(response.ok).toBe(true);

    const credential = await response.json();
    expect(credential.username).toBe(TEST_ADMIN_USERNAME);
    expect(credential.id).toBeDefined();
    expect(credential.password).toBeDefined(); // Hashed password

    // Verify authentication works with special character password
    const authWorks = await testAuthentication(TEST_ADMIN_USERNAME, TEST_ADMIN_PASSWORD);
    expect(authWorks).toBe(true);
  });

  test('should extract credential ID correctly (not consumer ID)', async () => {
    // Get credentials list
    const response = await kongAdminRequest('/consumers/noosphere-router-admin/basic-auth');
    expect(response.ok).toBe(true);

    const data = await response.json();

    // Test jq pattern: .data[0].id
    expect(data.data).toBeDefined();
    expect(Array.isArray(data.data)).toBe(true);

    if (data.data.length > 0) {
      const firstCred = data.data[0];
      expect(firstCred.id).toBeDefined();
      expect(typeof firstCred.id).toBe('string');

      // Credential ID should be different from consumer ID
      const consumerResponse = await kongAdminRequest('/consumers/noosphere-router-admin');
      const consumer = await consumerResponse.json();

      expect(firstCred.id).not.toBe(consumer.id);
      expect(firstCred.consumer.id).toBe(consumer.id);
    }
  });

  test('should handle idempotent credential updates', async () => {
    // Get existing credential
    const getResponse = await kongAdminRequest('/consumers/noosphere-router-admin/basic-auth');
    const initialData = await getResponse.json();
    const initialCredId = initialData.data[0]?.id;

    expect(initialCredId).toBeDefined();

    // Delete existing credential
    const deleteResponse = await kongAdminRequest(
      `/consumers/noosphere-router-admin/basic-auth/${initialCredId}`,
      { method: 'DELETE' }
    );
    expect(deleteResponse.ok).toBe(true);

    // Create new credential with same username but potentially different password
    const newPassword = 'N3w*P@ssw0rd!2025';
    const formData = new URLSearchParams();
    formData.append('username', TEST_ADMIN_USERNAME);
    formData.append('password', newPassword);

    const createResponse = await kongAdminRequest('/consumers/noosphere-router-admin/basic-auth', {
      method: 'POST',
      body: formData
    });
    expect(createResponse.ok).toBe(true);

    const newCred = await createResponse.json();
    expect(newCred.id).toBeDefined();
    expect(newCred.id).not.toBe(initialCredId); // Should be a new credential

    // Verify new password works
    const authWorks = await testAuthentication(TEST_ADMIN_USERNAME, newPassword);
    expect(authWorks).toBe(true);

    // CLEANUP: Restore original password for other tests
    await kongAdminRequest(`/consumers/noosphere-router-admin/basic-auth/${newCred.id}`, {
      method: 'DELETE'
    });

    const restoreFormData = new URLSearchParams();
    restoreFormData.append('username', TEST_ADMIN_USERNAME);
    restoreFormData.append('password', TEST_ADMIN_PASSWORD);

    await kongAdminRequest('/consumers/noosphere-router-admin/basic-auth', {
      method: 'POST',
      body: restoreFormData
    });
  });

  test('should fail authentication with wrong password', async () => {
    const wrongPassword = 'WrongPassword123';
    const authFails = await testAuthentication(TEST_ADMIN_USERNAME, wrongPassword);
    expect(authFails).toBe(false);
  });

  test('should handle URL encoding for special characters', () => {
    // Test that special characters are properly encoded
    const specialPassword = 'P@ss&rd!#2025';
    const formData = new URLSearchParams();
    formData.append('password', specialPassword);

    const encoded = formData.toString();

    // Should be URL-encoded
    expect(encoded).toContain('password=');
    expect(encoded).not.toContain('@'); // @ should be encoded to %40
    expect(encoded).not.toContain('&'); // & should be encoded to %26 (important: separates params)
    expect(encoded).not.toContain('!'); // ! should be encoded to %21
    expect(encoded).not.toContain('#'); // # should be encoded to %23
    // Note: * is an unreserved character (RFC 3986) and doesn't need encoding
  });

  test('should validate provision.sh jq patterns', async () => {
    // Test the actual jq patterns used in provision.sh

    // Pattern 1: Extract consumer ID from create/get response
    const consumerResponse = await kongAdminRequest('/consumers/noosphere-router-admin');
    const consumer = await consumerResponse.json();

    // Simulate: jq -r '.id // empty'
    const consumerId = consumer.id || '';
    expect(consumerId).toBeTruthy();

    // Pattern 2: Extract credential ID from list
    const credsResponse = await kongAdminRequest('/consumers/noosphere-router-admin/basic-auth');
    const creds = await credsResponse.json();

    // Simulate: jq -r '.data[0].id // empty'
    const credId = creds.data?.[0]?.id || '';
    expect(credId).toBeTruthy();

    // Pattern 3: Check if credential creation succeeded
    // Simulate: jq -e '.id'
    expect(creds.data[0].id).toBeDefined();
  });

  test('should verify Kong routes are provisioned correctly', async () => {
    // Check that essential routes exist
    const routesResponse = await kongAdminRequest('/routes');
    expect(routesResponse.ok).toBe(true);

    const routes = await routesResponse.json();
    const routeNames = routes.data.map(r => r.name);

    // Essential routes that should be provisioned
    expect(routeNames).toContain('admin-dashboard');
    expect(routeNames).toContain('admin-api');
    expect(routeNames).toContain('llm-proxy');
  });

  test('should verify basic-auth plugin is enabled on admin routes', async () => {
    // Get admin-dashboard route
    const routeResponse = await kongAdminRequest('/routes/admin-dashboard');
    expect(routeResponse.ok).toBe(true);

    const route = await routeResponse.json();

    // Get plugins for this route
    const pluginsResponse = await kongAdminRequest(`/routes/${route.id}/plugins`);
    const plugins = await pluginsResponse.json();

    // Should have basic-auth plugin
    const hasBasicAuth = plugins.data.some(p => p.name === 'basic-auth');
    expect(hasBasicAuth).toBe(true);
  });

  test('should handle concurrent provisioning requests', async () => {
    // Simulate multiple provisioning attempts running concurrently
    // This tests the idempotency and race condition handling

    const promises = Array.from({ length: 5 }, async (_, i) => {
      const formData = new URLSearchParams();
      formData.append('username', `concurrent-test-${i}`);
      formData.append('password', 'TestPass123');

      try {
        const response = await kongAdminRequest('/consumers/noosphere-router-admin/basic-auth', {
          method: 'POST',
          body: formData
        });
        return response.ok;
      } catch (error) {
        return false;
      }
    });

    const results = await Promise.all(promises);

    // At least one should succeed
    expect(results.some(r => r === true)).toBe(true);

    // Cleanup concurrent test credentials
    const credsResponse = await kongAdminRequest('/consumers/noosphere-router-admin/basic-auth');
    const creds = await credsResponse.json();

    for (const cred of creds.data || []) {
      if (cred.username.startsWith('concurrent-test-')) {
        await kongAdminRequest(`/consumers/noosphere-router-admin/basic-auth/${cred.id}`, {
          method: 'DELETE'
        });
      }
    }
  });
});
