import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { pool } from './db.js';
import backendRouter from './backend.js';
import dashboardRouter from './dashboard.js';
import llmRouter from './llm-router.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// Increase body size limit for large LLM requests/responses (Dyad sends full codebase)
app.use(express.json({ limit: '10mb' }));

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

// Middleware to extract Kong consumer info (for routes that need it)
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

// Mount routers
app.use('/api', backendRouter);  // Kong plugin routes
app.use('/api', dashboardRouter);  // Dashboard/admin routes
app.use('/llm', llmRouter);  // Unified LLM gateway + legacy /llm endpoint
// Note: /v1/messages (Anthropic API) is handled directly by Kong proxy

// Helper function for testing - clear storage
export async function clearStorage() {
  await pool.query('TRUNCATE TABLE usage_logs');
  await pool.query('TRUNCATE TABLE consumer_quotas');
}

export default app;
