import express from 'express';
import crypto from 'crypto';
import zlib from 'zlib';
import { nanoid } from 'nanoid';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { pool } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

app.use(express.json());

// Serve static files from public directory
app.use(express.static(join(__dirname, '..', 'public')));

// Middleware to log all requests
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Middleware to extract Kong consumer info
app.use('/api', async (req, res, next) => {
  const consumerId = req.headers['x-consumer-id'];
  const consumerUsername = req.headers['x-consumer-username'];
  const consumerCustomId = req.headers['x-consumer-custom-id'];

  if (consumerId) {
    req.consumer = {
      id: consumerId,
      username: consumerUsername || null,
      custom_id: consumerCustomId || null
    };

    // Initialize consumer in database if not exists (with default quota)
    try {
      await pool.query(`
        INSERT INTO consumer_quotas (consumer_id, username, custom_id, quota, used)
        VALUES ($1, $2, $3, 100, 0)
        ON CONFLICT (consumer_id) DO NOTHING
      `, [consumerId, consumerUsername, consumerCustomId]);
    } catch (error) {
      console.error('Error initializing consumer:', error);
    }
  }

  next();
});

// Set consumer quota (admin endpoint)
app.post('/api/consumers/:consumer_id/quota', async (req, res) => {
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
app.get('/api/consumers/:consumer_id', async (req, res) => {
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
app.get('/api/consumers', async (req, res) => {
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

    const consumers = result.rows.map(row => ({
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
app.get('/api/quota-check', async (req, res) => {
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
app.post('/api/audit', async (req, res) => {
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

    res.json({ id, cost, total_tokens, consumer_id: consumerId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get usage stats for current consumer
app.get('/api/usage', async (req, res) => {
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
app.get('/api/audit', async (req, res) => {
  try {
    const { limit = 100 } = req.query;

    let query = `
      SELECT * FROM usage_logs
      WHERE 1=1
    `;
    const params = [];

    // Filter by consumer if authenticated via Kong
    if (req.consumer) {
      params.push(req.consumer.id);
      query += ` AND consumer_id = $${params.length}`;
    } else if (req.query.consumer_id) {
      params.push(req.query.consumer_id);
      query += ` AND consumer_id = $${params.length}`;
    }

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
      created_at: new Date(row.created_at).getTime()
    }));

    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin endpoint: Create new consumer in Kong
app.post('/api/admin/consumers', async (req, res) => {
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
app.delete('/api/admin/consumers/:consumer_id', async (req, res) => {
  try {
    const { consumer_id } = req.params;
    const kongAdminUrl = process.env.KONG_ADMIN_URL || 'http://localhost:8001';

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

// Check quota for consumer (called by lunar-gateway plugin)
app.get('/api/quota/check/:consumer_id', async (req, res) => {
  try {
    const { consumer_id } = req.params;

    // Get consumer quota
    const result = await pool.query(
      `SELECT quota, used FROM consumer_quotas WHERE consumer_id = $1`,
      [consumer_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Consumer not found' });
    }

    const { quota, used } = result.rows[0];
    const remaining = quota - used;
    const allowed = remaining > 0;

    res.json({
      allowed,
      quota,
      used,
      remaining
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Log usage (called by lunar-gateway plugin after request)
// FIXME: More efficient quota logging through batching / memory caching
app.post('/api/quota/log', async (req, res) => {
  try {
    const {
      consumer_id,
      provider,
      model,
      status,
      response_body_compressed
    } = req.body;

    let prompt_tokens = 0;
    let completion_tokens = 0;
    let total_tokens = 0;
    let cost = 0;

    // Decompress and extract usage data if response body provided
    if (response_body_compressed) {
      try {
        // Decode from base64
        const compressedBuffer = Buffer.from(response_body_compressed, 'base64');
        console.log('Received compressed response:', compressedBuffer.length, 'bytes');

        // Decompress with gzip
        const decompressed = zlib.gunzipSync(compressedBuffer);
        const responseText = decompressed.toString('utf8');
        console.log('Decompressed response:', responseText.substring(0, 200));

        // Parse JSON and extract usage
        const responseData = JSON.parse(responseText);
        if (responseData.usage) {
          prompt_tokens = responseData.usage.prompt_tokens || 0;
          completion_tokens = responseData.usage.completion_tokens || 0;
          total_tokens = responseData.usage.total_tokens || 0;

          // Calculate cost based on GPT-5 pricing
          // Input: $1.25 per 1M tokens, Output: $10.00 per 1M tokens
          cost = (prompt_tokens * 0.00000125) + (completion_tokens * 0.00001);

          console.log(`Extracted usage - prompt: ${prompt_tokens}, completion: ${completion_tokens}, total: ${total_tokens}, cost: $${cost.toFixed(6)}`);
        } else {
          console.warn('No usage data in response');
        }
      } catch (decompressError) {
        console.error('Failed to decompress/parse response:', decompressError.message);
        // Continue with zero tokens if decompression fails
      }
    } else {
      console.warn('No response body provided');
    }

    // Insert usage log
    const logId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO usage_logs
        (id, consumer_id, provider, model, prompt_tokens, completion_tokens, total_tokens, cost, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
      [logId, consumer_id, provider, model, prompt_tokens, completion_tokens, total_tokens, cost, status]
    );

    // Update consumer quota
    await pool.query(
      `UPDATE consumer_quotas
       SET used = used + $1
       WHERE consumer_id = $2`,
      [cost, consumer_id]
    );

    res.json({
      message: 'Usage logged successfully',
      tokens: { prompt_tokens, completion_tokens, total_tokens },
      cost
    });
  } catch (error) {
    console.error('Error logging usage:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get AI Proxy status from Kong
app.get('/api/ai-proxy/status', async (req, res) => {
  try {
    const kongAdminUrl = process.env.KONG_ADMIN_URL || 'http://localhost:8001';

    // Get all plugins
    const response = await fetch(`${kongAdminUrl}/plugins`);
    const data = await response.json();

    const aiProxyPlugins = data.data.filter(p => p.name === 'ai-proxy');
    const lunarGatewayPlugins = data.data.filter(p => p.name === 'lunar-gateway');

    if (aiProxyPlugins.length === 0) {
      return res.json({
        configured: false,
        providers: []
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
      providers
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Helper function for testing - clear storage
export async function clearStorage() {
  await pool.query('TRUNCATE TABLE usage_logs');
  await pool.query('TRUNCATE TABLE consumer_quotas');
}

export default app;
