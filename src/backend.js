import express from 'express';
import crypto from 'crypto';
import { pool } from './db.js';
// Use Merkle batch implementation
import { logToBlockchain, verifyLog } from './blockchain-merkle.js';
import { checkAndReload, getPricing, calculateCost } from './pricing.js';

const router = express.Router();

// Check quota for consumer (called by noosphere-router plugin)
router.get('/quota/check/:consumer_id', async (req, res) => {
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

// Log usage (called by noosphere-router plugin after request)
// FIXME: More efficient quota logging through batching / memory caching
router.post('/quota/log', async (req, res) => {
  try {
    // Check if pricing needs reload
    await checkAndReload();

    const {
      consumer_id,
      provider,
      model,
      http_status,  // HTTP status code (200, 499, etc.)
      status,       // Legacy: "success" or "error" (for backward compatibility)
      request_body,
      response_body_compressed  // base64-encoded response body (not gzipped)
    } = req.body;

    // Use http_status if provided, otherwise fall back to legacy status field
    const statusCode = http_status || (status === 'success' ? 200 : 500);
    const isError = statusCode >= 400;

    let prompt_tokens = 0;
    let completion_tokens = 0;
    let total_tokens = 0;
    let cache_creation_input_tokens = 0;
    let cache_read_input_tokens = 0;
    let cost = 0;
    let requestText = null;
    let responseText = null;
    let requestHash = null;
    let responseHash = null;

    // Process request body
    if (request_body) {
      try {
        // Decode from base64
        const requestBuffer = Buffer.from(request_body, 'base64');
        requestText = requestBuffer.toString('utf8');

        // Calculate SHA256 hash of request
        requestHash = crypto.createHash('sha256').update(requestText).digest('hex');
      } catch (requestError) {
        console.error('Failed to process request body:', requestError.message);
      }
    }

    // Extract usage data from response body if provided
    if (response_body_compressed) {
      try {
        // Decode from base64
        const responseBuffer = Buffer.from(response_body_compressed, 'base64');

        // Check if response is gzipped (starts with 0x1f8b magic bytes)
        if (responseBuffer[0] === 0x1f && responseBuffer[1] === 0x8b) {
          // Decompress gzip
          const zlib = await import('zlib');
          const decompressed = zlib.gunzipSync(responseBuffer);
          responseText = decompressed.toString('utf8');
        } else {
          // Plain text
          responseText = responseBuffer.toString('utf8');
        }

        // Calculate SHA256 hash of response
        responseHash = crypto.createHash('sha256').update(responseText).digest('hex');

        // Parse response - handle both streaming (SSE) and non-streaming formats
        let responseData = null;

        // Check if response is in SSE format (starts with "event:" or "data: ")
        if (responseText.trim().startsWith('event:') || responseText.trim().startsWith('data: ')) {
          // Parse SSE format - extract the last data chunk that contains usage info
          const lines = responseText.split('\n');

          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
              try {
                const jsonStr = line.substring(6); // Remove "data: " prefix
                const chunk = JSON.parse(jsonStr);

                // For Anthropic: look for message_delta with usage
                if (provider === 'anthropic' && chunk.type === 'message_delta' && chunk.usage) {
                  responseData = chunk;
                  break;
                }
                // For OpenAI and others: look for usage directly in chunk
                else if (chunk.usage) {
                  responseData = chunk;
                  break;
                }
              } catch (e) {
                // Skip invalid JSON
              }
            }
          }
        } else {
          // Regular JSON response
          try {
            responseData = JSON.parse(responseText);
          } catch (e) {
            console.warn('Failed to parse response as JSON:', e.message);
          }
        }

        // Extract usage data if found
        if (responseData && responseData.usage) {
          // Handle both OpenAI and Anthropic formats
          // OpenAI: prompt_tokens, completion_tokens, total_tokens
          // Anthropic: input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens
          prompt_tokens = responseData.usage.prompt_tokens || responseData.usage.input_tokens || 0;
          completion_tokens = responseData.usage.completion_tokens || responseData.usage.output_tokens || 0;
          total_tokens = responseData.usage.total_tokens || (prompt_tokens + completion_tokens);

          // Extract cache tokens
          // Anthropic format: cache_creation_input_tokens, cache_read_input_tokens
          cache_creation_input_tokens = responseData.usage.cache_creation_input_tokens || 0;
          cache_read_input_tokens = responseData.usage.cache_read_input_tokens || 0;

          // OpenAI format: prompt_tokens_details.cached_tokens
          if (responseData.usage.prompt_tokens_details?.cached_tokens) {
            const openai_cached = responseData.usage.prompt_tokens_details.cached_tokens;
            // For OpenAI: cached tokens are read from cache (discounted rate)
            // Uncached tokens use regular input rate
            cache_read_input_tokens = openai_cached;
            prompt_tokens = prompt_tokens - openai_cached; // Only count uncached as regular prompt tokens
          }

          // Calculate cost using dynamic pricing
          // Reject request if model pricing is not configured
          const pricing = getPricing(provider, model);
          cost = calculateCost({
            prompt_tokens,
            completion_tokens,
            cache_creation_input_tokens,
            cache_read_input_tokens
          }, pricing);
        } else {
          console.warn('No usage data in response - estimating from response body size');
          // Estimate tokens from response body when actual usage data is missing
          // This handles cases where streaming requests are terminated early

          // Rough estimation: 1 token ≈ 4 characters (conservative estimate)
          // For streaming, we have the captured response body text
          if (responseText) {
            completion_tokens = Math.ceil(responseText.length / 4);
          }

          // Estimate prompt tokens from request body if available
          if (requestText) {
            try {
              const reqData = JSON.parse(requestText);
              if (reqData.messages) {
                // Estimate from messages content
                const messageText = reqData.messages.map(m => m.content).join(' ');
                prompt_tokens = Math.ceil(messageText.length / 4);
              } else if (reqData.prompt) {
                // OpenAI legacy format
                prompt_tokens = Math.ceil(reqData.prompt.length / 4);
              }
            } catch (e) {
              // If can't parse, use conservative estimate
              prompt_tokens = Math.ceil(requestText.length / 6);
            }
          }

          total_tokens = prompt_tokens + completion_tokens;

          // Calculate cost with estimated tokens using dynamic pricing
          // Reject request if model pricing is not configured
          const pricing = getPricing(provider, model);
          cost = calculateCost({
            prompt_tokens,
            completion_tokens,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0
          }, pricing);

          console.log(`Estimated usage - input: ${prompt_tokens}, output: ${completion_tokens}, cost: ${cost}`);
        }
      } catch (parseError) {
        console.error('Failed to parse response:', parseError.message);
        return res.status(500).json({
          error: 'Failed to parse response',
          message: parseError.message
        });
      }
    }

    // If we still have no token counts and status is error, try to estimate from request only
    // This handles HTTP 499 (client cancelled) where request was sent but no response received
    if (prompt_tokens === 0 && completion_tokens === 0 && isError && requestText) {
      console.warn('No response received (likely HTTP 499) - estimating input tokens from request');
      try {
        const reqData = JSON.parse(requestText);
        if (reqData.messages) {
          // Estimate from messages content
          const messageText = reqData.messages.map(m => {
            // Handle both string and array content formats
            if (typeof m.content === 'string') {
              return m.content;
            } else if (Array.isArray(m.content)) {
              // Extract text from content blocks
              return m.content.map(block => block.text || '').join(' ');
            }
            return '';
          }).join(' ');
          prompt_tokens = Math.ceil(messageText.length / 4);
        } else if (reqData.prompt) {
          // OpenAI legacy format
          prompt_tokens = Math.ceil(reqData.prompt.length / 4);
        }
      } catch (e) {
        // If can't parse, use conservative estimate based on full request size
        prompt_tokens = Math.ceil(requestText.length / 6);
      }

      total_tokens = prompt_tokens;

      // Calculate cost for input tokens only (no output was generated)
      // Reject request if model pricing is not configured
      const pricing = getPricing(provider, model);
      cost = calculateCost({
        prompt_tokens,
        completion_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      }, pricing);

      console.log(`Estimated input-only usage - input: ${prompt_tokens}, cost: ${cost}`);
    }

    // Validate we have at least some token count
    if (prompt_tokens === 0 && completion_tokens === 0 && !isError) {
      console.warn('Unable to estimate tokens - no request or response data');
      return res.status(400).json({
        error: 'Invalid usage data',
        message: 'Cannot log successful request with zero tokens - no data to estimate from'
      });
    }

    // Insert usage log
    const logId = crypto.randomUUID();

    // Only store full request/response text if explicitly enabled (default: false)
    const storeFullData = process.env.STORE_FULL_REQUEST_RESPONSE === 'true';
    const requestDataToStore = storeFullData ? requestText : null;
    const responseDataToStore = storeFullData ? responseText : null;

    await pool.query(
      `INSERT INTO usage_logs
        (id, consumer_id, provider, model, prompt_tokens, completion_tokens, total_tokens, cache_creation_input_tokens, cache_read_input_tokens, cost, status, request_data, response_data, request_hash, response_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())`,
      [logId, consumer_id, provider, model, prompt_tokens, completion_tokens, total_tokens, cache_creation_input_tokens, cache_read_input_tokens, cost, statusCode.toString(), requestDataToStore, responseDataToStore, requestHash, responseHash]
    );

    // Update consumer quota
    await pool.query(
      `UPDATE consumer_quotas
       SET used = used + $1
       WHERE consumer_id = $2`,
      [cost, consumer_id]
    );

    // Log to blockchain asynchronously (don't wait for it)
    if (requestHash && responseHash) {
      logToBlockchain({
        logId,
        consumerId: consumer_id,
        provider: provider || 'unknown',
        model: model || 'unknown',
        promptTokens: prompt_tokens,
        completionTokens: completion_tokens,
        requestHash: '0x' + requestHash,
        responseHash: '0x' + responseHash
      }).catch(err => {
        console.error('Blockchain logging failed:', err.message);
      });
    }

    res.json({
      message: 'Usage logged successfully',
      tokens: {
        prompt_tokens,
        completion_tokens,
        total_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens
      },
      cost,
      request_hash: requestHash,
      response_hash: responseHash
    });
  } catch (error) {
    console.error('Error logging usage:', error);

    // Return 422 for unsupported model errors (pricing not configured)
    if (error.message && error.message.includes('Unsupported model')) {
      return res.status(422).json({
        error: 'Unsupported model',
        message: error.message
      });
    }

    res.status(500).json({ error: error.message });
  }
});

// Verify a log entry (Merkle proof verification)
router.get('/verify/:log_id', async (req, res) => {
  try {
    const { log_id } = req.params;

    const result = await verifyLog(log_id);

    res.json(result);
  } catch (error) {
    console.error('Error verifying log:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get blockchain statistics
router.get('/blockchain/stats', async (req, res) => {
  try {
    const { getBlockchainStats } = await import('./blockchain-merkle.js');
    const stats = await getBlockchainStats();
    res.json(stats);
  } catch (error) {
    console.error('Error getting blockchain stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Force flush current batch (admin endpoint)
router.post('/blockchain/flush', async (req, res) => {
  try {
    const { flushBatch } = await import('./blockchain-merkle.js');
    await flushBatch();
    res.json({ success: true, message: 'Batch flushed' });
  } catch (error) {
    console.error('Error flushing batch:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get batch information
router.get('/blockchain/batch/:batch_id', async (req, res) => {
  try {
    const { batch_id } = req.params;

    const result = await pool.query(`
      SELECT
        bb.*,
        COUNT(ul.id) as actual_log_count
      FROM blockchain_batches bb
      LEFT JOIN usage_logs ul ON ul.batch_id = bb.id
      WHERE bb.id = $1
      GROUP BY bb.id
    `, [batch_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error getting batch:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get logs in a batch
router.get('/blockchain/batch/:batch_id/logs', async (req, res) => {
  try {
    const { batch_id } = req.params;

    const result = await pool.query(`
      SELECT
        id,
        consumer_id,
        provider,
        model,
        prompt_tokens,
        completion_tokens,
        cost,
        leaf_hash,
        created_at
      FROM usage_logs
      WHERE batch_id = $1
      ORDER BY created_at ASC
    `, [batch_id]);

    res.json({
      batch_id,
      log_count: result.rows.length,
      logs: result.rows
    });
  } catch (error) {
    console.error('Error getting batch logs:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
