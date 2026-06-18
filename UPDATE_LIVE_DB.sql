-- Script to update LIVE Database with new GST and Pay Mode columns
-- Run this on your Railway MySQL database

-- 1. Update Drivers Table
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS pay_mode ENUM('Driver', 'Sub-contractor') DEFAULT 'Driver';
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS gst_number VARCHAR(50) DEFAULT NULL;

-- 2. Update Tickets Table
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS pay_quantity DECIMAL(10, 2) DEFAULT 0.00;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS extra_hours DECIMAL(10, 2) DEFAULT 0.00;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS gst_amount DECIMAL(10, 2) DEFAULT 0.00;

-- Optional: Update existing subcontractor tickets to have 5% GST if it was 0
UPDATE tickets t
JOIN drivers d ON t.driver_id = d.id
SET t.gst_amount = t.total_pay * 0.05
WHERE d.pay_mode = 'Sub-contractor' AND (t.gst_amount IS NULL OR t.gst_amount = 0);

SELECT 'Live database updated successfully!' AS Message;
