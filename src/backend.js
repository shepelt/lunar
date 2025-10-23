import express from 'express';
import crypto from 'crypto';
import zlib from 'zlib';
import { pool } from './db.js';

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

export default router;
