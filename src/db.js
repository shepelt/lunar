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
