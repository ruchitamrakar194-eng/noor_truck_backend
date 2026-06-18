const pool = require('./config/db');

async function fixDecimals() {
    try {
        console.log("Altering tickets table...");
        const alterQuery = `
            ALTER TABLE tickets 
            MODIFY quantity DECIMAL(10,2) NOT NULL DEFAULT 0.00,
            MODIFY pay_quantity DECIMAL(10,2) DEFAULT 0.00,
            MODIFY bill_rate DECIMAL(10,2) NOT NULL DEFAULT 0.00,
            MODIFY pay_rate DECIMAL(10,2) NOT NULL DEFAULT 0.00,
            MODIFY total_bill DECIMAL(10,2) NOT NULL DEFAULT 0.00,
            MODIFY total_pay DECIMAL(10,2) NOT NULL DEFAULT 0.00,
            MODIFY gst_amount DECIMAL(10,2) DEFAULT 0.00,
            MODIFY extra_hours DECIMAL(10,2) DEFAULT 0.00;
        `;
        
        await pool.query(alterQuery);
        console.log("✅ Decimals fixed successfully in live database!");
    } catch (error) {
        console.error("❌ Error altering table:", error);
    } finally {
        process.exit();
    }
}

fixDecimals();
