import { pool } from './db.js';

// In-memory pricing cache
let pricingCache = new Map();

// Invalidation flag - set to true when pricing needs to be reloaded
let needsReload = false;

/**
 * Load pricing from database into memory
 */
export async function loadPricing() {
  try {
    const result = await pool.query(`
      SELECT provider, model, input_rate, output_rate, cache_write_rate, cache_read_rate
      FROM model_pricing
      ORDER BY provider, model NULLS FIRST
    `);

    // Clear existing cache
    pricingCache.clear();

    // Build cache with provider or provider:model as key
    for (const row of result.rows) {
      const key = (row.model && row.model !== '') ? `${row.provider}:${row.model}` : row.provider;

      pricingCache.set(key, {
        provider: row.provider,
        model: row.model === '' ? null : row.model,
        inputRate: parseFloat(row.input_rate) || 0,
        outputRate: parseFloat(row.output_rate) || 0,
        cacheWriteRate: parseFloat(row.cache_write_rate) || 0,
        cacheReadRate: parseFloat(row.cache_read_rate) || 0
      });
    }

    needsReload = false;
    console.log(`✅ Loaded ${pricingCache.size} pricing configs into memory`);
    return pricingCache.size;
  } catch (error) {
    console.error('❌ Failed to load pricing:', error);
    throw error;
  }
}

/**
 * Get pricing for a provider/model
 * Returns exact match only - no fallback to prevent incorrect pricing
 * Throws error if model pricing not found
 */
export function getPricing(provider, model = null) {
  if (!provider) {
    throw new Error('Provider is required');
  }

  // Look up exact provider:model combination
  const key = (model && model !== '') ? `${provider}:${model}` : provider;

  if (pricingCache.has(key)) {
    return pricingCache.get(key);
  }

  // No pricing found - reject request to prevent incorrect cost tracking
  const modelText = model ? ` with model "${model}"` : '';
  throw new Error(`Unsupported model: No pricing configured for provider "${provider}"${modelText}. Please add pricing via the dashboard or contact admin.`);
}

/**
 * Calculate cost based on token counts and pricing
 */
export function calculateCost(tokens, pricing) {
  const {
    prompt_tokens = 0,
    completion_tokens = 0,
    cache_creation_input_tokens = 0,
    cache_read_input_tokens = 0
  } = tokens;

  const cost =
    (prompt_tokens * pricing.inputRate) +
    (completion_tokens * pricing.outputRate) +
    (cache_creation_input_tokens * pricing.cacheWriteRate) +
    (cache_read_input_tokens * pricing.cacheReadRate);

  return cost;
}

/**
 * Set invalidation flag to trigger reload on next request
 */
export function invalidateCache() {
  needsReload = true;
  console.log('🔄 Pricing cache invalidated - will reload on next request');
}

/**
 * Check if cache needs reload and reload if necessary
 * Call this at the start of each request
 */
export async function checkAndReload() {
  if (needsReload) {
    console.log('🔄 Reloading pricing cache...');
    await loadPricing();
  }
}

/**
 * Get current cache size (for debugging/monitoring)
 */
export function getCacheSize() {
  return pricingCache.size;
}

/**
 * Check if cache needs reload (for debugging/monitoring)
 */
export function needsReloadFlag() {
  return needsReload;
}
