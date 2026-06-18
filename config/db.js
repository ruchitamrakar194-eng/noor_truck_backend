/**
 * Database Configuration
 * Creates and exports a MySQL connection pool using mysql2
 */

const mysql = require('mysql2/promise');
require('dotenv').config();

// Create connection pool for better performance
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  dateStrings: true
});

// Test the connection
pool.getConnection()
  .then(async (connection) => {
    console.log('✅ Database connected successfully');
    
    // Automatically fix decimal issue on startup
    try {
      console.log('Running automatic decimal fix for tickets table...');
      await connection.query(`
        ALTER TABLE tickets 
        MODIFY quantity DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        MODIFY pay_quantity DECIMAL(10,2) DEFAULT 0.00,
        MODIFY bill_rate DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        MODIFY pay_rate DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        MODIFY total_bill DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        MODIFY total_pay DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        MODIFY gst_amount DECIMAL(10,2) DEFAULT 0.00,
        MODIFY extra_hours DECIMAL(10,2) DEFAULT 0.00
      `);
      console.log('✅ Tickets table decimals fixed successfully!');
    } catch (err) {
      console.error('❌ Failed to fix decimals:', err.message);
    }
    
    connection.release();
  })
  .catch(err => {
    console.error('❌ Database connection error:', err.message);
  });

module.exports = pool;

