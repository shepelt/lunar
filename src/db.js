import pg from 'pg';

const { Pool } = pg;

// Connect to Kong's Postgres database
export const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: process.env.POSTGRES_PORT || 5432,
  database: process.env.POSTGRES_DB || 'kong',
  user: process.env.POSTGRES_USER || 'kong',
  password: process.env.POSTGRES_PASSWORD || 'kongpass',
});

// Initialize database tables
export async function initDatabase() {
  try {
    // Create consumer_quotas table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS consumer_quotas (
        consumer_id TEXT PRIMARY KEY,
        username TEXT,
        custom_id TEXT,
        quota DECIMAL(10,6) DEFAULT 100,
        used DECIMAL(10,6) DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Create usage_logs table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usage_logs (
        id TEXT PRIMARY KEY,
        consumer_id TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        cache_creation_input_tokens INTEGER DEFAULT 0,
        cache_read_input_tokens INTEGER DEFAULT 0,
        cost DECIMAL(10,6),
        status TEXT,
        request_data TEXT,
        response_data TEXT,
        request_hash TEXT,
        response_hash TEXT,
        blockchain_tx_hash TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Add new columns if they don't exist (for existing databases)
    await pool.query(`
      DO $$
      BEGIN
        BEGIN
          ALTER TABLE usage_logs ADD COLUMN request_data TEXT;
        EXCEPTION
          WHEN duplicate_column THEN NULL;
        END;
        BEGIN
          ALTER TABLE usage_logs ADD COLUMN response_data TEXT;
        EXCEPTION
          WHEN duplicate_column THEN NULL;
        END;
        BEGIN
          ALTER TABLE usage_logs ADD COLUMN request_hash TEXT;
        EXCEPTION
          WHEN duplicate_column THEN NULL;
        END;
        BEGIN
          ALTER TABLE usage_logs ADD COLUMN response_hash TEXT;
        EXCEPTION
          WHEN duplicate_column THEN NULL;
        END;
        BEGIN
          ALTER TABLE usage_logs ADD COLUMN blockchain_tx_hash TEXT;
        EXCEPTION
          WHEN duplicate_column THEN NULL;
        END;
        -- Nonce chain columns
        BEGIN
          ALTER TABLE usage_logs ADD COLUMN local_hash TEXT;
        EXCEPTION
          WHEN duplicate_column THEN NULL;
        END;
        BEGIN
          ALTER TABLE usage_logs ADD COLUMN tx_nonce BIGINT;
        EXCEPTION
          WHEN duplicate_column THEN NULL;
        END;
        BEGIN
          ALTER TABLE usage_logs ADD COLUMN prev_tx_nonce BIGINT;
        EXCEPTION
          WHEN duplicate_column THEN NULL;
        END;
        BEGIN
          ALTER TABLE usage_logs ADD COLUMN block_number BIGINT;
        EXCEPTION
          WHEN duplicate_column THEN NULL;
        END;
        BEGIN
          ALTER TABLE usage_logs ADD COLUMN anchor_hash TEXT;
        EXCEPTION
          WHEN duplicate_column THEN NULL;
        END;
        BEGIN
          ALTER TABLE usage_logs ADD COLUMN chain_verified BOOLEAN DEFAULT FALSE;
        EXCEPTION
          WHEN duplicate_column THEN NULL;
        END;
        -- Merkle batch columns
        BEGIN
          ALTER TABLE usage_logs ADD COLUMN batch_id BIGINT;
        EXCEPTION
          WHEN duplicate_column THEN NULL;
        END;
        BEGIN
          ALTER TABLE usage_logs ADD COLUMN merkle_proof JSONB;
        EXCEPTION
          WHEN duplicate_column THEN NULL;
        END;
        BEGIN
          ALTER TABLE usage_logs ADD COLUMN leaf_hash TEXT;
        EXCEPTION
          WHEN duplicate_column THEN NULL;
        END;
        -- Cache token columns for prompt caching
        BEGIN
          ALTER TABLE usage_logs ADD COLUMN cache_creation_input_tokens INTEGER DEFAULT 0;
        EXCEPTION
          WHEN duplicate_column THEN NULL;
        END;
        BEGIN
          ALTER TABLE usage_logs ADD COLUMN cache_read_input_tokens INTEGER DEFAULT 0;
        EXCEPTION
          WHEN duplicate_column THEN NULL;
        END;
      END $$;
    `);

    // Create index for faster lookups
    await pool.query(`
      CREATE INDEX IF NOT EXISTS usage_logs_consumer_id_idx
      ON usage_logs(consumer_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS usage_logs_created_at_idx
      ON usage_logs(created_at DESC)
    `);

    // Create indexes for nonce chain queries
    await pool.query(`
      CREATE INDEX IF NOT EXISTS usage_logs_tx_nonce_idx
      ON usage_logs(tx_nonce)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS usage_logs_block_number_idx
      ON usage_logs(block_number)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS usage_logs_anchor_hash_idx
      ON usage_logs(anchor_hash) WHERE anchor_hash IS NOT NULL
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS usage_logs_batch_id_idx
      ON usage_logs(batch_id) WHERE batch_id IS NOT NULL
    `);

    // Create blockchain_batches table for Merkle batching
    await pool.query(`
      CREATE TABLE IF NOT EXISTS blockchain_batches (
        id BIGSERIAL PRIMARY KEY,
        merkle_root TEXT NOT NULL,
        chain_hash TEXT NOT NULL,
        tx_nonce BIGINT NOT NULL,
        prev_tx_nonce BIGINT NOT NULL,
        blockchain_tx_hash TEXT NOT NULL,
        block_number BIGINT NOT NULL,
        log_count INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS blockchain_batches_tx_nonce_idx
      ON blockchain_batches(tx_nonce)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS blockchain_batches_created_at_idx
      ON blockchain_batches(created_at DESC)
    `);

    // Create blockchain_budget table for daily transaction tracking
    await pool.query(`
      CREATE TABLE IF NOT EXISTS blockchain_budget (
        period DATE PRIMARY KEY,
        tx_count INTEGER DEFAULT 0,
        request_count INTEGER DEFAULT 0,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create model_pricing table for dynamic pricing configuration
    await pool.query(`
      CREATE TABLE IF NOT EXISTS model_pricing (
        id SERIAL PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT DEFAULT '',
        input_rate DECIMAL(15,12),
        output_rate DECIMAL(15,12),
        cache_write_rate DECIMAL(15,12),
        cache_read_rate DECIMAL(15,12),
        effective_date TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(provider, model)
      )
    `);

    // Seed comprehensive pricing if table is empty (prices as of Nov 2025)
    const pricingCount = await pool.query('SELECT COUNT(*) FROM model_pricing');
    if (parseInt(pricingCount.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO model_pricing (provider, model, input_rate, output_rate, cache_write_rate, cache_read_rate)
        VALUES
          -- Anthropic Claude 4.x models (verified available via API)
          ('anthropic', 'claude-opus-4-1-20250805', 0.000015, 0.000075, 0.00001875, 0.0000015),
          ('anthropic', 'claude-opus-4-20250514', 0.000015, 0.000075, 0.00001875, 0.0000015),
          ('anthropic', 'claude-sonnet-4-5-20250929', 0.000003, 0.000015, 0.00000375, 0.0000003),
          ('anthropic', 'claude-sonnet-4-20250514', 0.000003, 0.000015, 0.00000375, 0.0000003),
          ('anthropic', 'claude-haiku-4-5-20251001', 0.000001, 0.000005, 0.00000125, 0.0000001),
          -- Anthropic Claude 3.x models (verified available via API)
          ('anthropic', 'claude-3-5-haiku-20241022', 0.0000008, 0.000004, 0.000001, 0.00000008),
          ('anthropic', 'claude-3-haiku-20240307', 0.00000025, 0.00000125, 0.0000003, 0.000000025),

          -- OpenAI GPT-5 series (use max_completion_tokens instead of max_tokens)
          ('openai', 'gpt-5', 0.00000125, 0.00001, NULL, 0.000000125),
          ('openai', 'gpt-5-mini', 0.00000025, 0.000002, NULL, 0.000000025),
          ('openai', 'gpt-5-nano', 0.00000005, 0.0000004, NULL, 0.000000005),
          ('openai', 'gpt-5-chat-latest', 0.00000125, 0.00001, NULL, 0.000000125),

          -- OpenAI GPT-4.1 series
          ('openai', 'gpt-4.1', 0.000002, 0.000008, NULL, 0.0000005),
          ('openai', 'gpt-4.1-mini', 0.0000004, 0.0000016, NULL, 0.0000001),
          ('openai', 'gpt-4.1-nano', 0.0000001, 0.0000004, NULL, 0.000000025),

          -- OpenAI GPT-4o series
          ('openai', 'gpt-4o', 0.0000025, 0.00001, NULL, 0.00000125),
          ('openai', 'gpt-4o-mini', 0.00000015, 0.0000006, NULL, 0.000000075),
          ('openai', 'gpt-4o-2024-05-13', 0.000005, 0.000015, NULL, NULL),

          -- Ollama (local, free)
          ('ollama', 'gpt-oss:120b', 0, 0, NULL, NULL)
      `);
      console.log('✅ Seeded comprehensive pricing data (Nov 2025) for all known models');
    }

    console.log('✅ Database tables initialized');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    throw error;
  }
}

// Test database connection
export async function testConnection() {
  try {
    const result = await pool.query('SELECT NOW()');
    console.log('✅ Database connected:', result.rows[0].now);
    return true;
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    return false;
  }
}

// Helper function to clear storage (for testing)
export async function clearStorage() {
  await pool.query('TRUNCATE TABLE usage_logs');
  await pool.query('TRUNCATE TABLE consumer_quotas');
}
