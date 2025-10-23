import dotenv from 'dotenv';
import app from './app.js';
import { initDatabase, testConnection } from './db.js';
import { initBlockchain } from './blockchain.js';

dotenv.config();

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    // Test database connection
    await testConnection();

    // Initialize database tables
    await initDatabase();

    // Initialize blockchain (optional - won't fail if not configured)
    const blockchainEnabled = initBlockchain();

    // Start server
    app.listen(PORT, () => {
      console.log(`🌙 Lunar Gateway Backend running on http://localhost:${PORT}`);
      console.log(`📊 Storage: PostgreSQL (persistent)`);
      if (blockchainEnabled) {
        console.log(`⛓️  Blockchain: HPP Sepolia (immutable audit logs)`);
      }
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
