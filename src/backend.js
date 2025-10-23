import express from 'express';
import crypto from 'crypto';
import zlib from 'zlib';
import { pool } from './db.js';
import { logToBlockchain } from './blockchain.js';

const router = express.Router();

// Check quota for consumer (called by lunar-gateway plugin)
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

// Log usage (called by lunar-gateway plugin after request)
// FIXME: More efficient quota logging through batching / memory caching
router.post('/quota/log', async (req, res) => {
  try {
    const {
      consumer_id,
      provider,
      model,
      status,
      request_body,
      response_body_compressed
    } = req.body;

    let prompt_tokens = 0;
    let completion_tokens = 0;
    let total_tokens = 0;
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
        console.log('Request body:', requestText.substring(0, 200));

        // Calculate SHA256 hash of request
        requestHash = crypto.createHash('sha256').update(requestText).digest('hex');
        console.log('Request hash:', requestHash);
      } catch (requestError) {
        console.error('Failed to process request body:', requestError.message);
      }
    }

    // Decompress and extract usage data if response body provided
    if (response_body_compressed) {
      try {
        // Decode from base64
        const compressedBuffer = Buffer.from(response_body_compressed, 'base64');
        console.log('Received compressed response:', compressedBuffer.length, 'bytes');

        // Decompress with gzip
        const decompressed = zlib.gunzipSync(compressedBuffer);
        responseText = decompressed.toString('utf8');
        console.log('Decompressed response:', responseText.substring(0, 200));

        // Calculate SHA256 hash of response
        responseHash = crypto.createHash('sha256').update(responseText).digest('hex');
        console.log('Response hash:', responseHash);

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

    // Only store full request/response text if explicitly enabled (default: false)
    const storeFullData = process.env.STORE_FULL_REQUEST_RESPONSE === 'true';
    const requestDataToStore = storeFullData ? requestText : null;
    const responseDataToStore = storeFullData ? responseText : null;

    await pool.query(
      `INSERT INTO usage_logs
        (id, consumer_id, provider, model, prompt_tokens, completion_tokens, total_tokens, cost, status, request_data, response_data, request_hash, response_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())`,
      [logId, consumer_id, provider, model, prompt_tokens, completion_tokens, total_tokens, cost, status, requestDataToStore, responseDataToStore, requestHash, responseHash]
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
      tokens: { prompt_tokens, completion_tokens, total_tokens },
      cost,
      request_hash: requestHash,
      response_hash: responseHash
    });
  } catch (error) {
    console.error('Error logging usage:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
