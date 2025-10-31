import express from 'express';
import { nanoid } from 'nanoid';
import { pool } from './db.js';
import { isBlockchainEnabled, getBlockchainStats, logToBlockchain } from './blockchain.js';

const router = express.Router();

// Set consumer quota (admin endpoint)
router.post('/consumers/:consumer_id/quota', async (req, res) => {
  try {
    const { consumer_id } = req.params;
    const { quota } = req.body;

    const result = await pool.query(`
      INSERT INTO consumer_quotas (consumer_id, quota, used)
      VALUES ($1, $2, 0)
      ON CONFLICT (consumer_id) DO UPDATE
      SET quota = $2, updated_at = NOW()
      RETURNING *
    `, [consumer_id, quota]);

    const row = result.rows[0];
    res.json({
      id: row.consumer_id,
      username: row.username,
      custom_id: row.custom_id,
      quota: parseFloat(row.quota),
      used: parseFloat(row.used),
      created_at: row.created_at,
      updated_at: row.updated_at
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get consumer quota/usage
router.get('/consumers/:consumer_id', async (req, res) => {
  try {
    const { consumer_id } = req.params;

    const consumerResult = await pool.query(
      'SELECT * FROM consumer_quotas WHERE consumer_id = $1',
      [consumer_id]
    );

    if (consumerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Consumer not found' });
    }

    const consumer = consumerResult.rows[0];

    const statsResult = await pool.query(`
      SELECT
        COUNT(*)::int as requests,
        COALESCE(SUM(total_tokens), 0)::int as total_tokens,
        COALESCE(SUM(cost), 0)::decimal as total_cost
      FROM usage_logs
      WHERE consumer_id = $1
    `, [consumer_id]);

    const stats = statsResult.rows[0];

    res.json({
      id: consumer.consumer_id,
      username: consumer.username,
      custom_id: consumer.custom_id,
      quota: parseFloat(consumer.quota),
      used: parseFloat(consumer.used),
      remaining: parseFloat(consumer.quota) - parseFloat(consumer.used),
      requests: stats.requests,
      total_tokens: stats.total_tokens,
      total_cost: parseFloat(stats.total_cost)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List all consumers
router.get('/consumers', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        cq.*,
        COUNT(ul.id)::int as requests
      FROM consumer_quotas cq
      LEFT JOIN usage_logs ul ON cq.consumer_id = ul.consumer_id
      GROUP BY cq.consumer_id
      ORDER BY cq.created_at DESC
    `);

    const consumers = result.rows
      .filter(row => row.username !== 'lunar-admin') // Hide lunar-admin from dashboard
      .map(row => ({
        id: row.consumer_id,
        username: row.username,
        custom_id: row.custom_id,
        quota: parseFloat(row.quota),
        used: parseFloat(row.used),
        requests: row.requests,
        created_at: row.created_at
      }));

    res.json(consumers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Check if consumer has quota available
router.get('/quota-check', async (req, res) => {
  try {
    if (!req.consumer) {
      return res.status(401).json({ error: 'No consumer information' });
    }

    const result = await pool.query(
      'SELECT * FROM consumer_quotas WHERE consumer_id = $1',
      [req.consumer.id]
    );

    if (result.rows.length === 0) {
      // Auto-initialize with default quota
      return res.json({
        has_quota: true,
        remaining: 100,
        message: 'New consumer with default quota'
      });
    }

    const consumer = result.rows[0];
    const quota = parseFloat(consumer.quota);
    const used = parseFloat(consumer.used);
    const hasQuota = used < quota;

    res.json({
      has_quota: hasQuota,
      quota,
      used,
      remaining: quota - used
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Log LLM usage (called after LLM response)
router.post('/audit', async (req, res) => {
  try {
    const {
      provider,
      model,
      prompt_tokens = 0,
      completion_tokens = 0,
      status = 'success'
    } = req.body;

    // Use Kong consumer info if available, otherwise allow manual consumer_id
    const consumerId = req.consumer?.id || req.body.consumer_id;

    if (!consumerId) {
      return res.status(400).json({ error: 'No consumer information available' });
    }

    const total_tokens = prompt_tokens + completion_tokens;

    // GPT-5 pricing: $1.25/1M input, $10/1M output
    const cost = (prompt_tokens * 0.00000125) + (completion_tokens * 0.00001);

    const id = nanoid();

    // Insert usage log
    await pool.query(`
      INSERT INTO usage_logs (id, consumer_id, provider, model, prompt_tokens, completion_tokens, total_tokens, cost, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [id, consumerId, provider, model, prompt_tokens, completion_tokens, total_tokens, cost, status]);

    // Update consumer usage
    await pool.query(`
      UPDATE consumer_quotas
      SET used = used + $1, updated_at = NOW()
      WHERE consumer_id = $2
    `, [cost, consumerId]);

    // Log to blockchain if enabled
    if (isBlockchainEnabled()) {
      try {
        await logToBlockchain({
          logId: id,
          consumerId,
          provider,
          model,
          promptTokens: prompt_tokens,
          completionTokens: completion_tokens,
          requestHash: 'test-request-hash',
          responseHash: 'test-response-hash'
        });
      } catch (error) {
        console.error('Blockchain logging failed:', error.message);
        // Don't fail the request if blockchain logging fails
      }
    }

    res.json({ id, cost, total_tokens, consumer_id: consumerId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get usage stats for current consumer
router.get('/usage', async (req, res) => {
  try {
    if (!req.consumer) {
      return res.status(401).json({ error: 'No consumer information' });
    }

    const consumerResult = await pool.query(
      'SELECT * FROM consumer_quotas WHERE consumer_id = $1',
      [req.consumer.id]
    );

    if (consumerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Consumer not found' });
    }

    const consumer = consumerResult.rows[0];

    const statsResult = await pool.query(`
      SELECT
        COUNT(*)::int as requests,
        COALESCE(SUM(total_tokens), 0)::int as total_tokens,
        COALESCE(SUM(cost), 0)::decimal as total_cost
      FROM usage_logs
      WHERE consumer_id = $1
    `, [req.consumer.id]);

    const stats = statsResult.rows[0];

    res.json({
      consumer_id: req.consumer.id,
      username: req.consumer.username,
      custom_id: req.consumer.custom_id,
      quota: parseFloat(consumer.quota),
      used: parseFloat(consumer.used),
      remaining: parseFloat(consumer.quota) - parseFloat(consumer.used),
      requests: stats.requests,
      total_tokens: stats.total_tokens,
      total_cost: parseFloat(stats.total_cost)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all requests (audit log)
router.get('/audit', async (req, res) => {
  try {
    const { limit = 100 } = req.query;

    let query = `
      SELECT
        id, consumer_id, provider, model,
        prompt_tokens, completion_tokens, total_tokens,
        cost, status, blockchain_tx_hash,
        EXTRACT(EPOCH FROM created_at) * 1000 as created_at_ms
      FROM usage_logs
      WHERE 1=1
    `;
    const params = [];

    // Filter by consumer if authenticated via Kong (but not for admin users)
    if (req.consumer && req.consumer.username !== 'lunar-admin') {
      // Regular consumers only see their own logs
      params.push(req.consumer.id);
      query += ` AND consumer_id = $${params.length}`;
    } else if (req.query.consumer_id) {
      // Admin can filter by specific consumer_id via query param
      params.push(req.query.consumer_id);
      query += ` AND consumer_id = $${params.length}`;
    }
    // If consumer is lunar-admin or no consumer, show all logs

    params.push(parseInt(limit));
    query += ` ORDER BY created_at DESC LIMIT $${params.length}`;

    const result = await pool.query(query, params);

    const logs = result.rows.map(row => ({
      id: row.id,
      consumer_id: row.consumer_id,
      provider: row.provider,
      model: row.model,
      prompt_tokens: row.prompt_tokens,
      completion_tokens: row.completion_tokens,
      total_tokens: row.total_tokens,
      cost: parseFloat(row.cost),
      status: row.status,
      blockchain_tx_hash: row.blockchain_tx_hash,
      // Use Unix timestamp directly from PostgreSQL to avoid timezone issues
      created_at: parseFloat(row.created_at_ms)
    }));

    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get provider statistics
router.get('/stats/providers', async (req, res) => {
  try {
    const query = `
      SELECT
        provider,
        COUNT(*) as request_count,
        SUM(prompt_tokens) as total_prompt_tokens,
        SUM(completion_tokens) as total_completion_tokens,
        SUM(total_tokens) as total_tokens,
        SUM(cost) as total_cost
      FROM usage_logs
      WHERE status = 'success'
      GROUP BY provider
      ORDER BY total_cost DESC
    `;

    const result = await pool.query(query);

    const stats = result.rows.map(row => ({
      provider: row.provider,
      requests: parseInt(row.request_count),
      prompt_tokens: parseInt(row.total_prompt_tokens) || 0,
      completion_tokens: parseInt(row.total_completion_tokens) || 0,
      total_tokens: parseInt(row.total_tokens) || 0,
      cost: parseFloat(row.total_cost)
    }));

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get configuration
router.get('/config', async (req, res) => {
  try {
    const blockchain_enabled = isBlockchainEnabled();
    const response = {
      ollama_model: process.env.OLLAMA_MODEL_NAME || 'gpt-oss:120b',
      ollama_backend: process.env.OLLAMA_BACKEND_URL || 'http://localhost:11434',
      lunar_endpoint_url: process.env.LUNAR_ENDPOINT_URL || 'http://localhost:8000',
      blockchain_enabled
    };

    // Include blockchain stats if enabled
    if (blockchain_enabled) {
      try {
        response.blockchain_stats = await getBlockchainStats();
      } catch (error) {
        console.error('Failed to get blockchain stats:', error.message);
      }
    }

    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin endpoint: Create new consumer in Kong
router.post('/admin/consumers', async (req, res) => {
  try {
    const { username, custom_id, quota = 100 } = req.body;

    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }

    const kongAdminUrl = process.env.KONG_ADMIN_URL || 'http://localhost:8001';

    // Create consumer in Kong
    const consumerResponse = await fetch(`${kongAdminUrl}/consumers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        custom_id: custom_id || null
      })
    });

    if (!consumerResponse.ok) {
      const error = await consumerResponse.text();
      return res.status(consumerResponse.status).json({ error });
    }

    const consumer = await consumerResponse.json();

    // Create API key for the consumer
    const keyResponse = await fetch(`${kongAdminUrl}/consumers/${consumer.id}/key-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    if (!keyResponse.ok) {
      const error = await keyResponse.text();
      return res.status(keyResponse.status).json({ error });
    }

    const key = await keyResponse.json();

    // Initialize quota in our database
    await pool.query(`
      INSERT INTO consumer_quotas (consumer_id, username, custom_id, quota, used)
      VALUES ($1, $2, $3, $4, 0)
      ON CONFLICT (consumer_id) DO UPDATE
      SET username = $2, custom_id = $3, quota = $4, updated_at = NOW()
    `, [consumer.id, username, custom_id || null, quota]);

    res.json({
      consumer: {
        id: consumer.id,
        username: consumer.username,
        custom_id: consumer.custom_id
      },
      api_key: key.key,
      quota
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin endpoint: Delete consumer from Kong
router.delete('/admin/consumers/:consumer_id', async (req, res) => {
  try {
    const { consumer_id } = req.params;
    const kongAdminUrl = process.env.KONG_ADMIN_URL || 'http://localhost:8001';

    // First, check if this is the lunar-admin consumer (protect it from deletion)
    const consumerResponse = await fetch(`${kongAdminUrl}/consumers/${consumer_id}`);
    if (consumerResponse.ok) {
      const consumer = await consumerResponse.json();
      if (consumer.username === 'lunar-admin') {
        return res.status(403).json({ error: 'Cannot delete lunar-admin consumer (used for basic auth)' });
      }
    }

    // Delete from Kong
    const response = await fetch(`${kongAdminUrl}/consumers/${consumer_id}`, {
      method: 'DELETE'
    });

    if (!response.ok && response.status !== 404) {
      const error = await response.text();
      return res.status(response.status).json({ error });
    }

    // Delete from our database
    await pool.query('DELETE FROM consumer_quotas WHERE consumer_id = $1', [consumer_id]);
    await pool.query('DELETE FROM usage_logs WHERE consumer_id = $1', [consumer_id]);

    res.json({ message: 'Consumer deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// OpenAI-compatible LLM proxy endpoint (accepts Bearer token, supports streaming)
router.post('/llm/v1/chat/completions', async (req, res) => {
  try {
    const kongUrl = process.env.KONG_GATEWAY_URL || 'http://localhost:8000';

    // Extract API key from Authorization header (Bearer token) or apikey header
    let apiKey = null;
    const authHeader = req.headers.authorization;
    const apikeyHeader = req.headers.apikey;

    if (authHeader) {
      // Extract token from "Bearer <token>" format
      const match = authHeader.match(/^Bearer\s+(.+)$/);
      if (match) {
        apiKey = match[1];
      }
    } else if (apikeyHeader) {
      apiKey = apikeyHeader;
    }

    if (!apiKey) {
      return res.status(401).json({
        error: {
          message: 'No API key found in request',
          type: 'invalid_request_error',
          code: 'missing_api_key'
        }
      });
    }

    // Transform model name - map custom model names to Kong-configured model
    // Kong's ai-proxy expects real OpenAI model names (configured as gpt-5 in kong.yaml)
    const requestBody = { ...req.body };
    const originalModel = requestBody.model;

    // Map any custom model name to the Kong-configured model
    // This allows Dyad and other clients to use custom model names like "lunar-openai"
    if (requestBody.model && requestBody.model !== 'gpt-5') {
      requestBody.model = 'gpt-5'; // Use the model configured in kong.yaml
    }

    // Note: Kong's lunar-gateway plugin handles max_tokens ↔ max_completion_tokens
    // transformation based on provider (GPT-5/o1 vs Ollama). Backend stays transparent.

    // Forward request to Kong with apikey header
    const response = await fetch(`${kongUrl}/llm/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': apiKey
      },
      body: JSON.stringify(requestBody)
    });

    // Handle streaming responses
    if (req.body.stream) {
      // Set appropriate headers for Server-Sent Events
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.status(response.status);

      // Convert Web Stream to Node.js stream and pipe to client
      const { Readable } = await import('stream');
      const nodeStream = Readable.fromWeb(response.body);

      nodeStream.pipe(res);

      // Handle errors
      nodeStream.on('error', (error) => {
        console.error('Stream error:', error);
        res.end();
      });

      return;
    }

    // Non-streaming response (original behavior)
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({
      error: {
        message: error.message,
        type: 'server_error'
      }
    });
  }
});

// Proxy LLM requests (for dashboard testing - legacy endpoint)
router.post('/llm-proxy', async (req, res) => {
  try {
    const { api_key, prompt, provider = 'openai', model, max_tokens } = req.body;

    if (!api_key) {
      return res.status(400).json({ error: 'API key is required' });
    }

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    const kongUrl = process.env.KONG_GATEWAY_URL || 'http://localhost:8000';

    // All providers now use the unified endpoint with model-based routing
    const endpoint = '/llm/v1/chat/completions';

    // Determine model with provider/model format
    let modelName;
    if (model) {
      // If model is provided, ensure it has provider prefix
      modelName = model.includes('/') ? model : `${provider}/${model}`;
    } else {
      // Use defaults
      modelName = provider === 'ollama' ? `ollama/${process.env.OLLAMA_MODEL_NAME || 'gpt-oss:120b'}` :
                  provider === 'anthropic' ? 'anthropic/claude-sonnet-4-5-20250929' :
                  'openai/gpt-5';
    }

    // Forward request to Kong
    const response = await fetch(`${kongUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': api_key
      },
      body: JSON.stringify({
        model: modelName,
        messages: [
          { role: 'user', content: prompt }
        ],
        ...(max_tokens && { max_tokens })  // Only include if provided
      })
    });

    // Try to parse as JSON, fall back to text if it fails
    let data;
    const contentType = response.headers.get('content-type');

    try {
      data = await response.json();
    } catch (jsonError) {
      // If JSON parsing fails, get the raw text
      const text = await response.text();
      data = {
        error: `Invalid JSON response from LLM provider: ${text.substring(0, 200)}`,
        raw_response: text.substring(0, 500)
      };
    }

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get AI Proxy status from Kong
router.get('/ai-proxy/status', async (req, res) => {
  try {
    const kongAdminUrl = process.env.KONG_ADMIN_URL || 'http://localhost:8001';
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:3000';

    // Get all plugins
    const response = await fetch(`${kongAdminUrl}/plugins`);
    const data = await response.json();

    const aiProxyPlugins = data.data.filter(p => p.name === 'ai-proxy');
    const lunarGatewayPlugins = data.data.filter(p => p.name === 'lunar-gateway');

    if (aiProxyPlugins.length === 0) {
      return res.json({
        configured: false,
        providers: [],
        llm_endpoint: `${backendUrl}/api/llm/v1/chat/completions`
      });
    }

    const providers = aiProxyPlugins.map(plugin => {
      const config = plugin.config;

      // Check if API key is configured via ai-proxy auth (old way) or lunar-gateway (new way)
      const hasDirectAuth = config.auth && config.auth.header_value && config.auth.header_value.length > 0;
      const hasLunarGateway = lunarGatewayPlugins.some(lg =>
        lg.config?.openai_api_key && lg.config.openai_api_key.length > 0
      );
      const hasApiKey = hasDirectAuth || hasLunarGateway;

      return {
        provider: config.model?.provider || 'unknown',
        model: config.model?.name || 'unknown',
        route_type: config.route_type,
        configured: hasApiKey,
        enabled: plugin.enabled,
        max_tokens: config.model?.options?.max_tokens,
        temperature: config.model?.options?.temperature
      };
    });

    res.json({
      configured: true,
      count: providers.length,
      providers,
      llm_endpoint: `${backendUrl}/api/llm/v1/chat/completions`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Landing page
router.get('/info', async (req, res) => {
  const version = process.env.npm_package_version || '0.1.0';
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LunarGW - LLM Gateway</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gradient-to-br from-gray-900 via-purple-900 to-blue-900 min-h-screen flex items-center justify-center p-6">
  <div class="max-w-3xl mx-auto bg-black bg-opacity-60 backdrop-blur-lg rounded-2xl shadow-2xl p-10 border border-purple-500">
    <div class="text-center mb-8">
      <h1 class="text-6xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-blue-400 mb-4">🌙 LunarGW</h1>
      <p class="text-xl text-gray-300">Language Model Union Network & Audit Relay</p>
      <p class="text-sm text-gray-500 mt-2">Version ${version}</p>
    </div>

    <div class="space-y-6 text-gray-300">
      <div class="bg-gray-800 bg-opacity-50 rounded-lg p-6">
        <h2 class="text-2xl font-semibold text-purple-400 mb-4">🎯 Available Endpoints</h2>
        <ul class="space-y-3">
          <li class="flex items-start">
            <span class="text-green-400 mr-3">▸</span>
            <div>
              <code class="text-blue-300">/admin</code>
              <span class="text-gray-400 ml-2">- Dashboard & Analytics</span>
            </div>
          </li>
          <li class="flex items-start">
            <span class="text-green-400 mr-3">▸</span>
            <div>
              <code class="text-blue-300">/llm/v1/chat/completions</code>
              <span class="text-gray-400 ml-2">- Unified LLM API (OpenAI, Anthropic, Ollama)</span>
              <div class="text-xs text-gray-500 mt-1 ml-6">
                Routes to provider based on model name:
                <ul class="list-disc ml-4 mt-1">
                  <li><code>gpt-*</code>, <code>o1-*</code> → OpenAI</li>
                  <li><code>claude-*</code> → Anthropic</li>
                  <li>Others → Ollama</li>
                </ul>
              </div>
            </div>
          </li>
        </ul>
      </div>

      <div class="bg-gray-800 bg-opacity-50 rounded-lg p-6">
        <h2 class="text-2xl font-semibold text-purple-400 mb-4">✨ Features</h2>
        <ul class="space-y-2 text-gray-400">
          <li>• Multi-provider LLM routing (OpenAI, Anthropic, Ollama)</li>
          <li>• Unified OpenAI-compatible API endpoint</li>
          <li>• Model-based automatic provider selection</li>
          <li>• API key authentication & quota management</li>
          <li>• Real-time usage tracking & auditing</li>
          <li>• Cost calculation & billing analytics</li>
          <li>• Blockchain audit logging (optional)</li>
        </ul>
      </div>

      <div class="text-center pt-4">
        <a href="/admin" class="inline-block px-6 py-3 bg-gradient-to-r from-purple-500 to-blue-500 hover:from-purple-600 hover:to-blue-600 text-white font-semibold rounded-lg shadow-lg transition-all duration-200 transform hover:scale-105">
          Go to Dashboard →
        </a>
      </div>
    </div>

    <div class="mt-8 pt-6 border-t border-gray-700 text-center text-gray-500 text-sm">
      Powered by Kong Gateway • Built with Node.js
    </div>
  </div>
</body>
</html>
  `;
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

export default router;
