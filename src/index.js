import dotenv from 'dotenv';
import app from './app.js';
import { initDatabase, testConnection } from './db.js';

dotenv.config();

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    // Test database connection
    await testConnection();

    // Initialize database tables
    await initDatabase();

    // Start server
    app.listen(PORT, () => {
      console.log(`🌙 Lunar Gateway Backend running on http://localhost:${PORT}`);
      console.log(`📊 Storage: PostgreSQL (persistent)`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
