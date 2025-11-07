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
