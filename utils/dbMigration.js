const pool = require('../config/db');

/**
 * Automatically ensures all required columns exist in the database
 * This runs every time the server starts
 */
async function ensureDatabaseSchema() {
  console.log('🔄 Checking database schema for updates...');
  
  try {
    const connection = await pool.getConnection();
    
    // 1. Check and add columns to 'drivers' table
    await ensureColumn(connection, 'drivers', 'pay_mode', "ENUM('Driver', 'Sub-contractor') DEFAULT 'Driver'");
    await ensureColumn(connection, 'drivers', 'gst_number', "VARCHAR(50) DEFAULT NULL");
    
    // 2. Check and add columns to 'tickets' table
    await ensureColumn(connection, 'tickets', 'pay_quantity', "DECIMAL(10, 2) DEFAULT 0.00");
    await ensureColumn(connection, 'tickets', 'extra_hours', "DECIMAL(10, 2) DEFAULT 0.00");
    await ensureColumn(connection, 'tickets', 'gst_amount', "DECIMAL(10, 2) DEFAULT 0.00");
    
    connection.release();
    console.log('✅ Database schema is up to date.');
  } catch (error) {
    console.error('❌ Error during database auto-migration:', error.message);
  }
}

async function ensureColumn(connection, tableName, columnName, definition) {
  try {
    const [columns] = await connection.execute(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() 
       AND TABLE_NAME = ? 
       AND COLUMN_NAME = ?`,
      [tableName, columnName]
    );

    if (columns.length === 0) {
      console.log(`➕ Adding missing column [${columnName}] to table [${tableName}]...`);
      await connection.execute(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
      console.log(`✔ Column [${columnName}] added successfully.`);
    }
  } catch (err) {
    console.error(`Failed to ensure column ${columnName} in ${tableName}:`, err.message);
  }
}

module.exports = { ensureDatabaseSchema };
