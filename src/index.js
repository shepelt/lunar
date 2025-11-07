import dotenv from 'dotenv';
import app from './app.js';
import { initDatabase, testConnection } from './db.js';
// Use Merkle batch implementation
import { initBlockchain } from './blockchain-merkle.js';

dotenv.config();

const PORT = process.env.PORT || 5872;

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
      console.log(`🌙 Noosphere Router Backend running on http://localhost:${PORT}`);
      console.log(`📊 Storage: PostgreSQL (persistent)`);
      if (blockchainEnabled) {
        console.log(`⛓️  Blockchain: HPP Sepolia (Merkle batch audit logs)`);
      }
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
