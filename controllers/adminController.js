/**
 * Admin Controller
 * Handles all admin operations: drivers, customers, tickets, invoices, settlements, dashboard
 */

const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { sendInvoiceEmail, sendSettlementEmail } = require('../utils/emailService');
const { generateInvoicePDF, generateSettlementPDF } = require('../utils/pdfGenerator');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

/**
 * Helper function to ensure customer columns exist
 * Automatically adds missing columns if they don't exist
 */
const ensureCustomerColumns = async () => {
  try {
    const columnsToAdd = [
      { name: 'contact_person', sql: 'ALTER TABLE customers ADD COLUMN contact_person VARCHAR(255) NULL AFTER name' },
      { name: 'phone', sql: 'ALTER TABLE customers ADD COLUMN phone VARCHAR(20) NULL AFTER contact_person' },
      { name: 'email', sql: 'ALTER TABLE customers ADD COLUMN email VARCHAR(255) NULL AFTER phone' },
      { name: 'gst_number', sql: 'ALTER TABLE customers ADD COLUMN gst_number VARCHAR(50) NULL AFTER email' },
      { name: 'billing_enabled', sql: 'ALTER TABLE customers ADD COLUMN billing_enabled BOOLEAN DEFAULT TRUE AFTER gst_number' },
      { name: 'status', sql: 'ALTER TABLE customers ADD COLUMN status ENUM(\'Active\', \'Inactive\') DEFAULT \'Active\' AFTER billing_enabled' }
    ];

    const [columns] = await pool.execute(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() 
       AND TABLE_NAME = 'customers'`
    );
    const existingColumns = columns.map(col => col.COLUMN_NAME);

    for (const col of columnsToAdd) {
      if (!existingColumns.includes(col.name)) {
        try {
          await pool.execute(col.sql);
          console.log(`✅ Added missing column: customers.${col.name}`);

          // Set default values for new columns
          if (col.name === 'billing_enabled') {
            await pool.execute('UPDATE customers SET billing_enabled = TRUE WHERE billing_enabled IS NULL');
          } else if (col.name === 'status') {
            await pool.execute('UPDATE customers SET status = \'Active\' WHERE status IS NULL');
          } else if (col.name === 'contact_person') {
            await pool.execute('UPDATE customers SET contact_person = name WHERE contact_person IS NULL');
          }
        } catch (err) {
          console.error(`Error adding column ${col.name}:`, err.message);
        }
      }
    }
  } catch (error) {
    console.error('Error ensuring customer columns:', error.message);
  }
};

/**
 * Helper function to ensure tickets table has subcontractor column
 * Automatically adds missing column if it doesn't exist
 */
const ensureTicketColumns = async () => {
  try {
    const [columns] = await pool.execute(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() 
       AND TABLE_NAME = 'tickets'`
    );
    const existingColumns = columns.map(col => col.COLUMN_NAME);

    // Add subcontractor column if it doesn't exist
    if (!existingColumns.includes('subcontractor')) {
      try {
        await pool.execute('ALTER TABLE tickets ADD COLUMN subcontractor VARCHAR(255) NULL AFTER driver_id');
        console.log('✅ Added missing column: tickets.subcontractor');
      } catch (err) {
        console.error('Error adding subcontractor column:', err.message);
      }
    }
  } catch (error) {
    console.error('Error ensuring ticket columns:', error.message);
  }
};
/**
 * Get all drivers
 */
const getAllDrivers = async (req, res) => {
  try {
    const [drivers] = await pool.execute(
      `SELECT d.id, d.user_id, d.user_id_code, d.name, d.phone, d.default_pay_rate, d.pay_mode, d.gst_number, u.email, u.created_at
       FROM drivers d
       JOIN users u ON d.user_id = u.id
       WHERE d.deleted_at IS NULL AND u.deleted_at IS NULL
       ORDER BY d.created_at DESC`
    );

    return res.json({
      success: true,
      data: drivers
    });
  } catch (error) {
    console.error('Error fetching drivers:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch drivers',
      error: error.message
    });
  }
};

/**
 * Get driver by ID
 */
const getDriverById = async (req, res) => {
  try {
    const { id } = req.params;
    const [drivers] = await pool.execute(
      `SELECT d.id, d.user_id, d.user_id_code, d.name, d.phone, d.default_pay_rate, d.pay_mode, d.gst_number, u.email, u.created_at
       FROM drivers d
       JOIN users u ON d.user_id = u.id
       WHERE d.id = ? AND d.deleted_at IS NULL AND u.deleted_at IS NULL`,
      [id]
    );

    if (drivers.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found'
      });
    }

    return res.json({
      success: true,
      data: drivers[0]
    });
  } catch (error) {
    console.error('Error fetching driver by ID:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch driver',
      error: error.message
    });
  }
};

/**
 * Create a new driver
 */
const createDriver = async (req, res) => {
  try {
    const { user_id_code, name, email, phone, default_pay_rate, pin, pay_mode, gst_number } = req.body;

    // Validate required fields
    if (!user_id_code || !name || !email || !default_pay_rate || !pin) {
      return res.status(400).json({
        success: false,
        message: 'User ID code, name, email, default pay rate, and PIN are required'
      });
    }

    // Validate PIN is 4 digits
    if (!/^\d{4}$/.test(pin)) {
      return res.status(400).json({
        success: false,
        message: 'PIN must be exactly 4 digits'
      });
    }

    // Check if user_id_code already exists
    const [existing] = await pool.execute(
      'SELECT id FROM drivers WHERE user_id_code = ?',
      [user_id_code]
    );

    if (existing.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'User ID code already exists'
      });
    }

    // Check if email already exists in users table
    const [existingEmail] = await pool.execute(
      'SELECT id FROM users WHERE email = ?',
      [email]
    );

    if (existingEmail.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Email address already exists'
      });
    }

    // Hash PIN
    const hashedPin = await bcrypt.hash(pin, 10);

    // Start transaction
    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      // Check which columns exist in users table
      const [userColumns] = await connection.execute(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
         WHERE TABLE_SCHEMA = DATABASE() 
         AND TABLE_NAME = 'users'`
      );
      const userExistingColumns = userColumns.map(col => col.COLUMN_NAME);

      // Check which columns exist in drivers table
      const [driverColumns] = await connection.execute(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
         WHERE TABLE_SCHEMA = DATABASE() 
         AND TABLE_NAME = 'drivers'`
      );
      const driverExistingColumns = driverColumns.map(col => col.COLUMN_NAME);
      console.log('--- DB Columns Check ---');
      console.log('Existing columns in drivers table:', driverExistingColumns);
      console.log('Received gst_number:', gst_number);
      console.log('--- End Check ---');

      // Build user INSERT query dynamically
      const userInsertCols = ['email', 'password', 'role'];
      const userInsertVals = [email, hashedPin, 'driver'];

      if (userExistingColumns.includes('company_id')) {
        userInsertCols.push('company_id');
        userInsertVals.push(1); // Default company_id if column exists
      }

      // Create user account for driver
      const [userResult] = await connection.execute(
        `INSERT INTO users (${userInsertCols.join(', ')}) VALUES (${userInsertVals.map(() => '?').join(', ')})`,
        userInsertVals
      );

      const userId = userResult.insertId;

      // Build driver INSERT query dynamically
      const driverInsertCols = ['user_id', 'user_id_code', 'name', 'phone', 'default_pay_rate', 'pin'];
      const driverInsertVals = [userId, user_id_code, name, phone || null, default_pay_rate, hashedPin];

      if (driverExistingColumns.includes('company_id')) {
        driverInsertCols.splice(1, 0, 'company_id'); // Insert after user_id
        driverInsertVals.splice(1, 0, 1); // Default company_id if column exists
      }

      if (pay_mode && driverExistingColumns.includes('pay_mode')) {
        driverInsertCols.push('pay_mode');
        driverInsertVals.push(pay_mode);
      }

      if (gst_number !== undefined && driverExistingColumns.includes('gst_number')) {
        driverInsertCols.push('gst_number');
        driverInsertVals.push(gst_number || null);
      }

      // Create driver record
      await connection.execute(
        `INSERT INTO drivers (${driverInsertCols.join(', ')}) VALUES (${driverInsertVals.map(() => '?').join(', ')})`,
        driverInsertVals
      );

      await connection.commit();

      return res.status(201).json({
        success: true,
        message: 'Driver created successfully'
      });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error creating driver:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create driver',
      error: error.message
    });
  }
};

/**
 * Update a driver
 */
const updateDriver = async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id_code, name, email, phone, default_pay_rate, pin, pay_mode, gst_number } = req.body;

    // Check if driver exists
    const [drivers] = await pool.execute(
      'SELECT id, user_id FROM drivers WHERE id = ?',
      [id]
    );

    if (drivers.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found'
      });
    }

    const updates = [];
    const values = [];

    if (user_id_code) {
      // Check if user_id_code already exists for another driver
      const [existing] = await pool.execute(
        'SELECT id FROM drivers WHERE user_id_code = ? AND id != ?',
        [user_id_code, id]
      );
      if (existing.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'User ID code already exists'
        });
      }
      updates.push('user_id_code = ?');
      values.push(user_id_code);
    }

    if (name) {
      updates.push('name = ?');
      values.push(name);
    }

    if (phone !== undefined) {
      updates.push('phone = ?');
      values.push(phone || null);
    }

    if (default_pay_rate !== undefined) {
      updates.push('default_pay_rate = ?');
      values.push(default_pay_rate);
    }

    if (pay_mode) {
      updates.push('pay_mode = ?');
      values.push(pay_mode);
    }

    if (gst_number !== undefined) {
      updates.push('gst_number = ?');
      values.push(gst_number || null);
    }

    if (email) {
      // Check if email already exists for another user
      const [existingEmail] = await pool.execute(
        'SELECT id FROM users WHERE email = ? AND id != ?',
        [email, drivers[0].user_id]
      );
      if (existingEmail.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Email address already exists'
        });
      }
      // Update user email
      await pool.execute(
        'UPDATE users SET email = ? WHERE id = ?',
        [email, drivers[0].user_id]
      );
    }

    if (pin) {
      if (!/^\d{4}$/.test(pin)) {
        return res.status(400).json({
          success: false,
          message: 'PIN must be exactly 4 digits'
        });
      }
      const hashedPin = await bcrypt.hash(pin, 10);
      updates.push('pin = ?');
      values.push(hashedPin);

      // Also update user password
      await pool.execute(
        'UPDATE users SET password = ? WHERE id = ?',
        [hashedPin, drivers[0].user_id]
      );
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update'
      });
    }

    values.push(id);
    await pool.execute(
      `UPDATE drivers SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`,
      values
    );

    return res.json({
      success: true,
      message: 'Driver updated successfully'
    });
  } catch (error) {
    console.error('Error updating driver:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update driver',
      error: error.message
    });
  }
};

/**
 * Delete a driver
 */
const deleteDriver = async (req, res) => {
  try {
    const { id } = req.params;

    const [drivers] = await pool.execute(
      'SELECT user_id FROM drivers WHERE id = ? AND deleted_at IS NULL',
      [id]
    );

    if (drivers.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found'
      });
    }

    // Check if driver has active tickets before allowing delete
    const [activeTickets] = await pool.execute(
      `SELECT COUNT(*) as cnt FROM tickets WHERE driver_id = ? AND deleted_at IS NULL AND status != 'Rejected'`,
      [id]
    );
    if (parseInt(activeTickets[0].cnt) > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete driver — they have ${activeTickets[0].cnt} active ticket(s). Archive tickets first.`
      });
    }

    const userId = drivers[0].user_id;
    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      // SOFT DELETE driver and linked user — NO hard DELETE
      await connection.execute(
        'UPDATE drivers SET deleted_at = NOW(), updated_at = NOW() WHERE id = ?', [id]
      );
      await connection.execute(
        'UPDATE users SET deleted_at = NOW(), updated_at = NOW() WHERE id = ?', [userId]
      );

      await connection.commit();

      return res.json({
        success: true,
        message: 'Driver deleted successfully'
      });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error deleting driver:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete driver',
      error: error.message
    });
  }
};

/**
 * Get all customers
 */
const getAllCustomers = async (req, res) => {
  try {
    // AUTO-FIX: Ensure all required columns exist
    await ensureCustomerColumns();

    const [customers] = await pool.execute(
      `SELECT id, name, contact_person, 
              IFNULL(phone, '') as phone, 
              IFNULL(email, '') as email, 
              IFNULL(gst_number, '') as gst_number, 
              billing_enabled, status, default_bill_rate, 
              created_at, updated_at
       FROM customers WHERE deleted_at IS NULL ORDER BY name ASC`
    );

    return res.json({
      success: true,
      data: customers
    });
  } catch (error) {
    console.error('Error fetching customers:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch customers',
      error: error.message
    });
  }
};

/**
 * Create a new customer
 */
const createCustomer = async (req, res) => {
  try {
    // AUTO-FIX: Ensure all required columns exist
    await ensureCustomerColumns();

    const { name, contact_person, phone, email, gst_number, billing_enabled, status, default_bill_rate } = req.body;

    if (!name || !contact_person || !phone || !email || default_bill_rate === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Name, contact person, phone, email, and default bill rate are required'
      });
    }

    // Check which columns exist
    const [columns] = await pool.execute(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() 
       AND TABLE_NAME = 'customers'`
    );
    const existingColumns = columns.map(col => col.COLUMN_NAME);

    // Build dynamic INSERT query
    const insertCols = ['name', 'contact_person', 'phone', 'email'];
    const insertVals = [name, contact_person, phone, email];

    if (existingColumns.includes('gst_number')) {
      insertCols.push('gst_number');
      insertVals.push(gst_number || '');
    }

    insertCols.push('billing_enabled', 'status', 'default_bill_rate');
    insertVals.push(
      billing_enabled !== undefined ? billing_enabled : true,
      status || 'Active',
      default_bill_rate
    );

    const [result] = await pool.execute(
      `INSERT INTO customers (${insertCols.join(', ')}) 
       VALUES (${insertVals.map(() => '?').join(', ')})`,
      insertVals
    );

    return res.status(201).json({
      success: true,
      message: 'Customer created successfully',
      data: {
        id: result.insertId,
        name,
        contact_person,
        phone: phone || '',
        email: email || '',
        gst_number: gst_number || '',
        billing_enabled: billing_enabled !== undefined ? billing_enabled : true,
        status: status || 'Active',
        default_bill_rate
      }
    });
  } catch (error) {
    console.error('Error creating customer:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create customer',
      error: error.message
    });
  }
};

/**
 * Update a customer
 */
const updateCustomer = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, contact_person, phone, email, gst_number, billing_enabled, status, default_bill_rate } = req.body;

    // AUTO-FIX: Ensure all required columns exist FIRST
    await ensureCustomerColumns();

    // Verify customer exists
    const [existing] = await pool.execute(
      'SELECT id FROM customers WHERE id = ?',
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }

    // Check which columns exist
    const [columns] = await pool.execute(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() 
       AND TABLE_NAME = 'customers'`
    );
    const existingColumns = columns.map(col => col.COLUMN_NAME);

    // Build update query dynamically - only include fields that are provided
    const updates = [];
    const values = [];

    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }
    if (contact_person !== undefined) {
      updates.push('contact_person = ?');
      values.push(contact_person || '');
    }
    if (phone !== undefined) {
      updates.push('phone = ?');
      values.push(phone || '');
    }
    if (email !== undefined) {
      updates.push('email = ?');
      values.push(email || '');
    }
    if (gst_number !== undefined && existingColumns.includes('gst_number')) {
      updates.push('gst_number = ?');
      values.push(gst_number || '');
    }
    if (billing_enabled !== undefined) {
      updates.push('billing_enabled = ?');
      values.push(billing_enabled ? 1 : 0);
    }
    if (status !== undefined) {
      updates.push('status = ?');
      values.push(status);
    }
    if (default_bill_rate !== undefined) {
      updates.push('default_bill_rate = ?');
      values.push(default_bill_rate);
    }

    // Must have at least one field to update
    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields provided to update'
      });
    }

    // Add updated_at and id
    updates.push('updated_at = NOW()');
    values.push(id);

    // Execute update
    await pool.execute(
      `UPDATE customers SET ${updates.join(', ')} WHERE id = ?`,
      values
    );

    return res.json({
      success: true,
      message: 'Customer updated successfully'
    });
  } catch (error) {
    console.error('Error updating customer:', error);
    // If column doesn't exist error, try to add it and retry
    if (error.message.includes('Unknown column')) {
      try {
        await ensureCustomerColumns();
        // Retry the update
        return updateCustomer(req, res);
      } catch (retryError) {
        return res.status(500).json({
          success: false,
          message: 'Failed to update customer. Please run ADD_CUSTOMER_COLUMNS.sql migration.',
          error: error.message
        });
      }
    }
    return res.status(500).json({
      success: false,
      message: 'Failed to update customer',
      error: error.message
    });
  }
};

/**
 * Delete a customer
 */
const deleteCustomer = async (req, res) => {
  try {
    const { id } = req.params;

    // Check if customer has active invoices or tickets — RESTRICT if so
    const [tickets] = await pool.execute(
      'SELECT COUNT(*) as cnt FROM tickets WHERE customer_id = ? AND deleted_at IS NULL',
      [id]
    );
    if (parseInt(tickets[0].cnt) > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete customer — they have ${tickets[0].cnt} ticket(s). Deactivate them instead.`
      });
    }

    // SOFT DELETE — never hard delete
    await pool.execute(
      'UPDATE customers SET deleted_at = NOW(), updated_at = NOW() WHERE id = ?',
      [id]
    );

    return res.json({
      success: true,
      message: 'Customer deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting customer:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete customer',
      error: error.message
    });
  }
};

/**
 * Get all tickets with filters
 */
const getAllTickets = async (req, res) => {
  try {
    const { startDate, endDate, customer, driver, status, search } = req.query;

    let query = `
      SELECT t.*, d.name as driver_name, d.user_id_code, d.pay_mode as driver_pay_mode,
             c.name as customer_name, c.id as customer_id_fk
      FROM tickets t
      LEFT JOIN drivers d ON t.driver_id = d.id AND d.deleted_at IS NULL
      LEFT JOIN customers c ON t.customer_id = c.id AND c.deleted_at IS NULL
      WHERE t.deleted_at IS NULL
    `;
    const params = [];

    // 1. Date Range
    if (startDate && endDate) {
      query += ` AND (t.date BETWEEN ? AND ?)`;
      params.push(startDate, endDate);
    }

    // 2. Customer Filter
    if (customer && customer !== 'All') {
      query += ` AND c.name = ?`;
      params.push(customer);
    }

    // 3. Driver Filter
    if (driver && driver !== 'All') {
      query += ` AND d.name = ?`;
      params.push(driver);
    }

    // 4. Status Filter
    if (status && status !== 'All') {
      query += ` AND t.status = ?`;
      params.push(status);
    }

    // 5. Search Filter
    if (search && search.trim() !== '') {
      query += ` AND (t.ticket_number LIKE ? OR c.name LIKE ? OR d.name LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    query += ` ORDER BY t.date DESC, t.created_at DESC`;

    // Validate params - ensure no undefined values
    const validParams = params.filter(param => param !== undefined && param !== null);
    if (validParams.length !== params.length) {
      console.error('[getAllTickets] Invalid parameters detected:', { params, validParams });
      return res.status(400).json({
        success: false,
        message: 'Invalid filter parameters provided',
        error: 'Some filter parameters contain invalid values'
      });
    }

    console.log('[getAllTickets] Executing query with params:', { query, params: validParams });
    const [tickets] = await pool.execute(query, validParams);

    // Clean up null values for a perfect API response
    const cleanTickets = tickets.map(ticket => {
      const cleanTicket = {};
      for (const key in ticket) {
        cleanTicket[key] = ticket[key] === null ? "" : ticket[key];
      }
      return cleanTicket;
    });

    return res.json({
      success: true,
      data: cleanTickets
    });
  } catch (error) {
    console.error('Error fetching tickets:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch tickets',
      error: error.message
    });
  }
};

/**
 * Get ticket by ID
 */
const getTicketById = async (req, res) => {
  try {
    const { id } = req.params;

    const [tickets] = await pool.execute(
      `SELECT t.*, d.name as driver_name, d.user_id_code,
              c.name as customer_name, c.id as customer_id_fk
       FROM tickets t
       LEFT JOIN drivers d ON t.driver_id = d.id AND d.deleted_at IS NULL
       LEFT JOIN customers c ON t.customer_id = c.id AND c.deleted_at IS NULL
       WHERE t.id = ? AND t.deleted_at IS NULL`,
      [id]
    );

    if (tickets.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    const ticket = tickets[0];
    const cleanTicket = {};
    for (const key in ticket) {
      cleanTicket[key] = ticket[key] === null ? "" : ticket[key];
    }

    return res.json({
      success: true,
      data: cleanTicket
    });
  } catch (error) {
    console.error('Error fetching ticket:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch ticket',
      error: error.message
    });
  }
};

/**
 * Update ticket
 */
const updateTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      date,
      truck_number,
      customer,
      equipment_type,
      ticket_number,
      quantity,
      bill_rate,
      pay_rate,
      total_bill,
      total_pay,
      status,
      pay_quantity,
      extra_hours,
      gst_amount
    } = req.body;

    const updates = [];
    const values = [];

    if (date !== undefined) {
      // Extract only YYYY-MM-DD part in case frontend sends ISO string
      const sanitizedDate = date && date.toString().includes('T') ? date.toString().split('T')[0] : date;
      updates.push('date = ?');
      values.push(sanitizedDate);
    }

    if (truck_number !== undefined) {
      updates.push('truck_number = ?');
      values.push(truck_number);
    }

    if (customer !== undefined) {
      updates.push('customer = ?');
      values.push(customer);
    }

    if (equipment_type !== undefined) {
      updates.push('equipment_type = ?');
      values.push(equipment_type);
    }

    if (ticket_number !== undefined) {
      updates.push('ticket_number = ?');
      values.push(ticket_number);
    }

    if (bill_rate !== undefined) {
      updates.push('bill_rate = ?');
      values.push(bill_rate);
    }

    if (pay_rate !== undefined) {
      updates.push('pay_rate = ?');
      values.push(pay_rate);
    }

    if (status !== undefined) {
      updates.push('status = ?');
      values.push(status);
    }

    if (quantity !== undefined) {
      updates.push('quantity = ?');
      values.push(quantity);
    }

    if (pay_quantity !== undefined) {
      updates.push('pay_quantity = ?');
      values.push(pay_quantity);
    }

    if (extra_hours !== undefined) {
      updates.push('extra_hours = ?');
      values.push(extra_hours);
    }

    if (gst_amount !== undefined) {
      updates.push('gst_amount = ?');
      values.push(gst_amount);
    }

    if (total_bill !== undefined) {
      updates.push('total_bill = ?');
      values.push(total_bill);
    }

    if (total_pay !== undefined) {
      updates.push('total_pay = ?');
      values.push(total_pay);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update'
      });
    }

    // Get current ticket to recalculate totals
    const [tickets] = await pool.execute(
      `SELECT t.quantity, t.pay_quantity, t.extra_hours, t.bill_rate, t.pay_rate, d.pay_mode 
       FROM tickets t 
       LEFT JOIN drivers d ON t.driver_id = d.id 
       WHERE t.id = ?`,
      [id]
    );

    if (tickets.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    const currentTicket = tickets[0];
    const finalQty = quantity !== undefined ? quantity : currentTicket.quantity;
    const finalPayQty = pay_quantity !== undefined ? pay_quantity : currentTicket.pay_quantity;
    const finalExtraHours = extra_hours !== undefined ? extra_hours : currentTicket.extra_hours;
    const finalBillRate = bill_rate !== undefined ? bill_rate : currentTicket.bill_rate;
    const finalPayRate = pay_rate !== undefined ? pay_rate : currentTicket.pay_rate;

    // Calculate totals only if not manually provided
    if (total_bill === undefined) {
      updates.push('total_bill = ?');
      values.push(finalQty * finalBillRate);
    }

    if (total_pay === undefined) {
      const parsedPayQty = parseFloat(finalPayQty);
      const pQtyForCalc = (parsedPayQty > 0) ? parsedPayQty : parseFloat(finalQty || 0);
      const calculatedPay = (pQtyForCalc + parseFloat(finalExtraHours || 0)) * finalPayRate;
      updates.push('total_pay = ?');
      values.push(calculatedPay);

      // Handle GST for sub-contractors if total_pay is re-calculated
      if (gst_amount === undefined && currentTicket.pay_mode === 'Sub-contractor') {
        const calculatedGst = calculatedPay * 0.05;
        updates.push('gst_amount = ?');
        values.push(calculatedGst);
      }
    }

    values.push(id);
    await pool.execute(
      `UPDATE tickets SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`,
      values
    );

    return res.json({
      success: true,
      message: 'Ticket updated successfully'
    });
  } catch (error) {
    console.error('Error updating ticket:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update ticket',
      error: error.message
    });
  }
};

/**
 * Delete ticket
 */
const deleteTicket = async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await pool.execute(
      'DELETE FROM tickets WHERE id = ?',
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    return res.json({
      success: true,
      message: 'Ticket deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting ticket:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete ticket',
      error: error.message
    });
  }
};

/**
 * Update ticket status
 */
const updateTicketStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || !['Pending', 'Approved', 'Rejected'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Valid status is required (Pending, Approved, or Rejected)'
      });
    }

    await pool.execute(
      'UPDATE tickets SET status = ?, updated_at = NOW() WHERE id = ?',
      [status, id]
    );

    return res.json({
      success: true,
      message: 'Ticket status updated successfully'
    });
  } catch (error) {
    console.error('Error updating ticket status:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update ticket status',
      error: error.message
    });
  }
};

/**
 * Get dashboard statistics
 */
const getDashboardStats = async (req, res) => {
  try {
    const currentDate = new Date();
    const currentMonth = currentDate.getMonth() + 1;
    const currentYear = currentDate.getFullYear();

    // Re-fetch ticket stats — filter soft-deleted
    const [unbilledResult] = await pool.execute(
      `SELECT COUNT(*) as count FROM tickets WHERE status = ? AND deleted_at IS NULL`,
      ['Pending']
    );
    const unbilledTickets = unbilledResult[0].count;

    // Revenue stats
    const [revenueStats] = await pool.execute(
      `SELECT 
        COALESCE(SUM(CASE WHEN MONTH(date) = ? AND YEAR(date) = ? THEN total_bill ELSE 0 END), 0) as monthlyRevenue,
        COALESCE(SUM(total_bill), 0) as totalRevenue,
        COALESCE(SUM(CASE WHEN MONTH(date) = ? AND YEAR(date) = ? THEN total_pay ELSE 0 END), 0) as monthlyPay,
        COALESCE(SUM(total_pay), 0) as totalPay
       FROM tickets
       WHERE status = 'Approved'
       AND deleted_at IS NULL`,
      [currentMonth, currentYear, currentMonth, currentYear]
    );

    const { monthlyRevenue, totalRevenue, monthlyPay, totalPay } = revenueStats[0];

    // Convert to floats
    const revenue = parseFloat(monthlyRevenue);
    const totalRev = parseFloat(totalRevenue);
    const driverPay = parseFloat(monthlyPay);
    const totalP = parseFloat(totalPay);

    // Estimated profit
    const estimatedProfit = revenue - driverPay;
    const totalProfit = totalRev - totalP;

    // Weekly breakdown for chart
    const [weeklyData] = await pool.execute(
      `SELECT 
        WEEK(date, 1) as week,
        COALESCE(SUM(total_bill), 0) as revenue,
        COALESCE(SUM(total_pay), 0) as pay
       FROM tickets
       WHERE status = 'Approved'
       AND MONTH(date) = ? AND YEAR(date) = ?
       AND deleted_at IS NULL
       GROUP BY WEEK(date, 1)
       ORDER BY week`,
      [currentMonth, currentYear]
    );

    return res.json({
      success: true,
      data: {
        unbilledTickets,
        revenue,
        driverPay,
        estimatedProfit,
        totalRevenue: totalRev,
        totalDriverPay: totalP,
        totalEstimatedProfit: totalProfit,
        weeklyData
      }
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch dashboard statistics',
      error: error.message
    });
  }
};

/**
 * Generate invoice for customer
 */
const generateInvoice = async (req, res) => {
  try {
    const { customerId, startDate, endDate } = req.query;

    if (!customerId || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'Customer ID, start date, and end date are required'
      });
    }

    // Get customer details including GST number
    const [customers] = await pool.execute(
      'SELECT name, gst_number, email FROM customers WHERE id = ?',
      [customerId]
    );

    if (customers.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }

    const customerName = customers[0].name;
    const customerGstNumber = customers[0].gst_number || null;
    const customerEmail = customers[0].email || null;

    // Ensure tickets table has required columns
    await ensureTicketColumns();

    // Get approved tickets for customer in date range using customer_id FK
    const [tickets] = await pool.execute(
      `SELECT t.*, DATE(t.date) as date, d.name as driver_name, d.user_id_code
       FROM tickets t
       LEFT JOIN drivers d ON t.driver_id = d.id
       WHERE t.customer_id = ?
       AND t.status = 'Approved'
       AND t.date >= ? AND t.date <= ?
       AND t.deleted_at IS NULL
       ORDER BY t.date ASC`,
      [customerId, startDate, endDate]
    );

    // Get company settings for invoice header/GST logic
    const [compSettings] = await pool.execute('SELECT * FROM company_settings LIMIT 1');
    const companyProfile = compSettings[0] || { company_name: 'Noor Trucking Inc.', email: 'accounting@noortruckinginc.com' };

    const subtotal = tickets.reduce((sum, ticket) => sum + parseFloat(ticket.total_bill || 0), 0);
    const gst = subtotal * 0.05; // 5% GST for everyone
    const total = subtotal + gst;

    const isNoorTrucking = companyProfile.company_name === 'Noor Trucking Inc.';

    return res.json({
      success: true,
      data: {
        customer: customerName,
        customerGstNumber: customerGstNumber,
        customerEmail: customerEmail,
        startDate,
        endDate,
        tickets: tickets,
        subtotal,
        gst,
        total,
        company: companyProfile,
        isNoorTrucking // Pass this flag to frontend
      }
    });
  } catch (error) {
    console.error('Error generating invoice:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to generate invoice',
      error: error.message
    });
  }
};

/**
 * Download invoice as PDF
 * Route: GET /admin/invoices/download/:customerId?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * Returns: PDF binary data (application/pdf)
 */
const downloadInvoice = async (req, res) => {
  try {
    const { customerId } = req.params;
    const { startDate, endDate } = req.query;

    console.log(`[PDF Download] Request received: customerId=${customerId}, startDate=${startDate}, endDate=${endDate}`);

    if (!customerId || !startDate || !endDate) {
      console.error('[PDF Download] Missing required parameters');
      return res.status(400).json({ success: false, message: 'Customer ID, start date, and end date are required' });
    }

    const [customers] = await pool.execute('SELECT name, gst_number, email, phone FROM customers WHERE id = ?', [customerId]);
    if (customers.length === 0) {
      console.error(`[PDF Download] Customer not found: id=${customerId}`);
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    const customer = customers[0];
    console.log(`[PDF Download] Customer found: ${customer.name}`);

    const [tickets] = await pool.execute(
      `SELECT t.*, DATE(t.date) as date, d.name as driver_name, d.user_id_code
       FROM tickets t
       LEFT JOIN drivers d ON t.driver_id = d.id
       WHERE t.customer_id = ? AND t.status = 'Approved' AND t.date >= ? AND t.date <= ? AND t.deleted_at IS NULL
       ORDER BY t.date ASC`,
      [customerId, startDate, endDate]
    );

    if (tickets.length === 0) {
      console.warn(`[PDF Download] No approved tickets found for customer ${customer.name} in range ${startDate} to ${endDate}`);
      return res.status(404).json({ success: false, message: 'No approved tickets found for this period' });
    }

    console.log(`[PDF Download] Found ${tickets.length} tickets. Generating PDF...`);
    const processedTickets = tickets;

    const [compSettings] = await pool.execute('SELECT * FROM company_settings LIMIT 1');
    const companyProfile = compSettings[0] || { company_name: 'Noor Trucking Inc.', email: 'accounting@noortruckinginc.com' };

    const { pdfBytes, filename } = await generateInvoicePDF({
      customerName: customer.name,
      customerGstNumber: customer.gst_number || '818440612RT0001',
      customerEmail: customer.email,
      customerPhone: customer.phone,
      startDate,
      endDate,
      tickets: processedTickets,
      companyProfile,
      isNoorTrucking: false // Always show GST logic now
    });

    if (!pdfBytes || pdfBytes.length === 0) {
      throw new Error('PDF generation failed: result is empty');
    }

    const headerHex = Buffer.from(pdfBytes.slice(0, 4)).toString('hex');
    const isPDF = Buffer.from(pdfBytes.slice(0, 4)).toString() === '%PDF';
    console.log(`[PDF Download] PDF generated: ${pdfBytes.length} bytes. Header: ${isPDF ? 'Valid (%PDF)' : 'INVALID (' + headerHex + ')'}`);

    if (!isPDF) {
      throw new Error('PDF generation produced invalid header');
    }

    // Set robust headers for binary download
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBytes.length);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    console.log(`[PDF Download] Sending PDF response: ${filename} (${pdfBytes.length} bytes)`);
    return res.end(Buffer.from(pdfBytes));
  } catch (error) {
    console.error('[PDF Download] ERROR:', error);
    return res.status(500).json({ success: false, message: 'PDF Error: ' + error.message });
  }
};

/**
 * Send invoice via email
 * Route: POST /admin/invoices/send
 */
const sendInvoiceEmailHandler = async (req, res) => {
  try {
    const { customerId, startDate, endDate, email } = req.body;

    if (!customerId || !startDate || !endDate) {
      return res.status(400).json({ success: false, message: 'Missing parameters' });
    }

    const [customers] = await pool.execute('SELECT name, gst_number, email, phone FROM customers WHERE id = ?', [customerId]);
    if (customers.length === 0) return res.status(404).json({ success: false, message: 'Customer not found' });

    const customer = customers[0];
    const recipientEmail = email || customer.email;

    if (!recipientEmail) {
      return res.status(400).json({ success: false, message: 'Recipient email is missing' });
    }

    const [tickets] = await pool.execute(
      `SELECT t.*, DATE(t.date) as date, d.name as driver_name, d.user_id_code
       FROM tickets t
       LEFT JOIN drivers d ON t.driver_id = d.id
       WHERE t.customer_id = ? AND t.status = 'Approved' AND t.date >= ? AND t.date <= ? AND t.deleted_at IS NULL
       ORDER BY t.date ASC`,
      [customerId, startDate, endDate]
    );

    if (tickets.length === 0) return res.status(404).json({ success: false, message: 'No tickets found' });

    const processedTickets = tickets;

    const [compSettings] = await pool.execute('SELECT * FROM company_settings LIMIT 1');
    const companyProfile = compSettings[0] || { company_name: 'Noor Trucking Inc.', email: 'accounting@noortruckinginc.com' };

    const isNoorTrucking = companyProfile.company_name === 'Noor Trucking Inc.';

    const { pdfBytes, filename } = await generateInvoicePDF({
      customerName: customer.name,
      customerGstNumber: customer.gst_number || (isNoorTrucking ? null : '818440612RT0001'),
      customerEmail: customer.email,
      customerPhone: customer.phone,
      startDate,
      endDate,
      tickets: processedTickets,
      companyProfile,
      isNoorTrucking
    });

    const subtotal = tickets.reduce((sum, t) => sum + parseFloat(t.total_bill || 0), 0);
    const gstAmount = subtotal * 0.05;
    const total = subtotal + gstAmount;

    const emailResult = await sendInvoiceEmail({
      to: recipientEmail,
      customerName: customer.name,
      invoiceNumber: `INV-${customerId}-${startDate.replace(/-/g, '')}`,
      startDate,
      endDate,
      total,
      pdfBuffer: pdfBytes,
      filename,
      companyInfo: companyProfile
    });

    if (!emailResult.success) throw new Error(emailResult.message);

    return res.json({ success: true, message: `Email sent to ${recipientEmail}` });
  } catch (error) {
    console.error('[sendInvoiceEmailHandler]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Generate settlement for driver
 */
const generateSettlement = async (req, res) => {
  try {
    const { driverId, startDate, endDate } = req.query;

    // Validate all required parameters with specific error messages
    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: 'Driver ID is required',
        missing: 'driverId'
      });
    }

    if (!startDate) {
      return res.status(400).json({
        success: false,
        message: 'Start date is required (format: YYYY-MM-DD)',
        missing: 'startDate'
      });
    }

    if (!endDate) {
      return res.status(400).json({
        success: false,
        message: 'End date is required (format: YYYY-MM-DD)',
        missing: 'endDate'
      });
    }

    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(startDate)) {
      return res.status(400).json({
        success: false,
        message: 'Start date must be in YYYY-MM-DD format',
        received: startDate
      });
    }

    if (!dateRegex.test(endDate)) {
      return res.status(400).json({
        success: false,
        message: 'End date must be in YYYY-MM-DD format',
        received: endDate
      });
    }

    // Get driver info
    const [drivers] = await pool.execute(
      'SELECT id, name, user_id_code, pay_mode, gst_number FROM drivers WHERE id = ?',
      [driverId]
    );

    if (drivers.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found'
      });
    }

    const driver = drivers[0];

    // Get tickets for driver in date range (with deleted_at filter)
    const [tickets] = await pool.execute(
      `SELECT t.*, c.name as customer_name
       FROM tickets t
       LEFT JOIN customers c ON t.customer_id = c.id AND c.deleted_at IS NULL
       WHERE t.driver_id = ?
       AND t.date >= ? AND t.date <= ?
       AND t.deleted_at IS NULL
       ORDER BY t.date ASC`,
      [driverId, startDate, endDate]
    );

    const isSubContractor = driver.pay_mode === 'Sub-contractor';
    const totalPay = tickets.reduce((sum, ticket) => sum + parseFloat(ticket.total_pay || 0), 0);
    const totalGst = tickets.reduce((sum, ticket) => {
      let gst = parseFloat(ticket.gst_amount || 0);
      if (isSubContractor && gst === 0) {
        gst = parseFloat(ticket.total_pay || 0) * 0.05;
      }
      return sum + gst;
    }, 0);
    const grandTotal = totalPay + totalGst;

    const processedTickets = tickets.map(t => {
      let gst = parseFloat(t.gst_amount || 0);
      if (isSubContractor && gst === 0) {
        gst = parseFloat(t.total_pay || 0) * 0.05;
      }
      return { ...t, gst_amount: gst };
    });

    return res.json({
      success: true,
      data: {
        driver: {
          id: driver.id,
          name: driver.name,
          user_id_code: driver.user_id_code,
          pay_mode: driver.pay_mode,
          gst_number: driver.gst_number
        },
        startDate,
        endDate,
        tickets: processedTickets,
        totalPay,
        totalGst,
        grandTotal
      }
    });
  } catch (error) {
    console.error('Error generating settlement:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to generate settlement',
      error: error.message
    });
  }
};

/**
 * Download settlement as PDF (placeholder)
 * 
 * Route: GET /admin/settlements/download/:driverId?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * 
 * Parameters:
 * - driverId (URL param): Driver ID
 * - startDate (query param): Start date in YYYY-MM-DD format (required)
 * - endDate (query param): End date in YYYY-MM-DD format (required)
 * 
 * Note: Settlements are generated dynamically from tickets. This endpoint requires
 * all three parameters to generate the settlement PDF.
 */
/**
 * Download settlement as PDF
 */
const downloadSettlement = async (req, res) => {
  try {
    const { driverId } = req.params;
    const { startDate, endDate } = req.query;

    console.log(`[Settlement Download] Request received: driverId=${driverId}, range=${startDate} to ${endDate}`);

    if (!driverId || !startDate || !endDate) {
      console.error('[Settlement Download] Missing required parameters');
      return res.status(400).json({ success: false, message: 'Driver ID, start date, and end date are required' });
    }

    const [drivers] = await pool.execute('SELECT name, user_id_code, pay_mode, gst_number FROM drivers WHERE id = ?', [driverId]);
    if (drivers.length === 0) {
      console.error(`[Settlement Download] Driver not found: id=${driverId}`);
      return res.status(404).json({ success: false, message: 'Driver not found' });
    }

    const driver = drivers[0];
    console.log(`[Settlement Download] Driver found: ${driver.name}`);

    const [tickets] = await pool.execute(
      `SELECT t.*, c.name as customer_name
       FROM tickets t
       LEFT JOIN customers c ON t.customer_id = c.id AND c.deleted_at IS NULL
       WHERE t.driver_id = ? AND t.date >= ? AND t.date <= ? AND t.deleted_at IS NULL
       ORDER BY t.date ASC`,
      [driverId, startDate, endDate]
    );

    if (tickets.length === 0) {
      console.warn(`[Settlement Download] No tickets found for driver ${driver.name} in range ${startDate} to ${endDate}`);
      return res.status(404).json({ success: false, message: 'No tickets found for this period' });
    }

    console.log(`[Settlement Download] Found ${tickets.length} tickets. Processing GST...`);

    const isSubContractor = driver.pay_mode === 'Sub-contractor';
    const processedTickets = tickets.map(t => {
      let gst = parseFloat(t.gst_amount || 0);
      if (isSubContractor && gst === 0) {
        gst = parseFloat(t.total_pay || 0) * 0.05;
      }
      return { ...t, gst_amount: gst };
    });

    console.log(`[Settlement Download] Generating PDF...`);

    const [compSettings] = await pool.execute('SELECT * FROM company_settings LIMIT 1');
    const companyProfile = compSettings[0] || { company_name: 'Noor Trucking Inc.', email: 'accounting@noortruckinginc.com' };

    const { pdfBytes, filename } = await generateSettlementPDF({
      driverName: driver.name,
      userIdCode: driver.user_id_code,
      driverGstNumber: driver.gst_number,
      startDate,
      endDate,
      tickets: processedTickets,
      companyProfile
    });

    if (!pdfBytes || pdfBytes.length === 0) {
      throw new Error('PDF generation failed: result is empty');
    }

    const isPDF = Buffer.from(pdfBytes.slice(0, 4)).toString() === '%PDF';
    console.log(`[Settlement Download] PDF generated: ${pdfBytes.length} bytes. Header: ${isPDF ? 'Valid (%PDF)' : 'INVALID'}`);

    if (!isPDF) {
      throw new Error('PDF generation produced invalid header');
    }

    // Set robust headers for binary download
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBytes.length);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    console.log(`[Settlement Download] Sending PDF response: ${filename} (${pdfBytes.length} bytes)`);
    return res.end(Buffer.from(pdfBytes));
  } catch (error) {
    console.error('[Settlement Download] ERROR:', error);
    return res.status(500).json({ success: false, message: 'Settlement PDF Error: ' + error.message });
  }
};

/**
 * Send settlement via email
 * Route: POST /admin/settlements/send
 */
const sendSettlementEmailHandler = async (req, res) => {
  try {
    const { driverId, startDate, endDate, email } = req.body;

    if (!driverId || !startDate || !endDate) {
      return res.status(400).json({ success: false, message: 'Missing parameters' });
    }

    const [drivers] = await pool.execute(
      'SELECT d.name, d.user_id_code, d.pay_mode, d.gst_number, u.email as user_email FROM drivers d JOIN users u ON d.user_id = u.id WHERE d.id = ?',
      [driverId]
    );
    if (drivers.length === 0) return res.status(404).json({ success: false, message: 'Driver not found' });

    const driver = drivers[0];
    const recipientEmail = email || driver.user_email;

    if (!recipientEmail) {
      return res.status(400).json({ success: false, message: 'Recipient email is missing' });
    }

    const [tickets] = await pool.execute(
      `SELECT t.*, c.name as customer_name
       FROM tickets t
       LEFT JOIN customers c ON t.customer_id = c.id AND c.deleted_at IS NULL
       WHERE t.driver_id = ? AND t.date >= ? AND t.date <= ? AND t.deleted_at IS NULL
       ORDER BY t.date ASC`,
      [driverId, startDate, endDate]
    );

    if (tickets.length === 0) return res.status(404).json({ success: false, message: 'No tickets found' });

    const [compSettings] = await pool.execute('SELECT * FROM company_settings LIMIT 1');
    const companyProfile = compSettings[0] || { company_name: 'Noor Trucking Inc.', email: 'accounting@noortruckinginc.com' };

    const isSubContractor = driver.pay_mode === 'Sub-contractor';
    const processedTickets = tickets.map(t => {
      let gst = parseFloat(t.gst_amount || 0);
      if (isSubContractor && gst === 0) {
        gst = parseFloat(t.total_pay || 0) * 0.05;
      }
      return { ...t, gst_amount: gst };
    });

    const { pdfBytes, filename } = await generateSettlementPDF({
      driverName: driver.name,
      userIdCode: driver.user_id_code,
      driverGstNumber: driver.gst_number,
      startDate,
      endDate,
      tickets: processedTickets,
      companyProfile
    });

    const totalPay = processedTickets.reduce((sum, t) => sum + parseFloat(t.total_pay || 0) + parseFloat(t.gst_amount || 0), 0);

    const emailResult = await sendSettlementEmail({
      to: recipientEmail,
      driverName: driver.name,
      period: `${startDate} to ${endDate}`,
      startDate,
      endDate,
      totalPay,
      pdfBuffer: pdfBytes,
      filename,
      companyInfo: companyProfile
    });

    if (!emailResult.success) throw new Error(emailResult.message);

    return res.json({ success: true, message: `Email sent to ${recipientEmail}` });
  } catch (error) {
    console.error('[sendSettlementEmailHandler]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Get bill rates (default customer bill rates)
 */
const getBillRates = async (req, res) => {
  try {
    const [customers] = await pool.execute(
      'SELECT id, name, default_bill_rate FROM customers ORDER BY name ASC'
    );

    return res.json({
      success: true,
      data: customers
    });
  } catch (error) {
    console.error('Error fetching bill rates:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch bill rates',
      error: error.message
    });
  }
};

/**
 * Update bill rates
 */
const updateBillRates = async (req, res) => {
  try {
    const { rates } = req.body; // Array of {id, default_bill_rate}

    if (!Array.isArray(rates)) {
      return res.status(400).json({
        success: false,
        message: 'Rates must be an array'
      });
    }

    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      for (const rate of rates) {
        await connection.execute(
          'UPDATE customers SET default_bill_rate = ?, updated_at = NOW() WHERE id = ?',
          [rate.default_bill_rate, rate.id]
        );
      }

      await connection.commit();

      return res.json({
        success: true,
        message: 'Bill rates updated successfully'
      });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error updating bill rates:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update bill rates',
      error: error.message
    });
  }
};

/**
 * Get all trucks
 */
const getAllTrucks = async (req, res) => {
  try {
    // First try with all columns
    try {
      const [trucks] = await pool.execute(
        `SELECT id, truck_number, truck_type, assigned_customer_id, status, notes, created_at, updated_at 
         FROM trucks ORDER BY truck_number ASC`
      );

      return res.json({
        success: true,
        data: trucks
      });
    } catch (columnError) {
      // If columns don't exist, try with basic columns only
      if (columnError.code === 'ER_BAD_FIELD_ERROR' || columnError.message.includes('Unknown column')) {
        console.log('Some columns missing, fetching with basic columns only');
        const [trucks] = await pool.execute(
          `SELECT id, truck_number, created_at, updated_at 
           FROM trucks ORDER BY truck_number ASC`
        );

        // Add default values for missing columns
        const trucksWithDefaults = trucks.map(truck => ({
          ...truck,
          truck_type: null,
          assigned_customer_id: null,
          status: 'Active',
          notes: null
        }));

        return res.json({
          success: true,
          data: trucksWithDefaults,
          message: 'Some columns are missing. Please run ADD_TRUCK_COLUMNS.sql migration.'
        });
      }
      throw columnError;
    }
  } catch (error) {
    console.error('Error fetching trucks:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch trucks',
      error: error.message
    });
  }
};

/**
 * Create a new truck
 */
const createTruck = async (req, res) => {
  try {
    const { truck_number, truck_type, assigned_customer_id, status, notes } = req.body;

    if (!truck_number || truck_number.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Truck number is required'
      });
    }

    // Check which columns exist in the database
    const [columns] = await pool.execute(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() 
       AND TABLE_NAME = 'trucks'`
    );
    const existingColumns = columns.map(col => col.COLUMN_NAME);

    // Only require truck_type if the column exists
    if (existingColumns.includes('truck_type') && !truck_type) {
      return res.status(400).json({
        success: false,
        message: 'Truck type is required'
      });
    }

    // Check if truck number already exists
    const [existing] = await pool.execute(
      'SELECT id FROM trucks WHERE truck_number = ?',
      [truck_number.trim()]
    );

    if (existing.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Truck number already exists'
      });
    }

    // Verify customer exists if assigned
    if (assigned_customer_id) {
      const [customer] = await pool.execute(
        'SELECT id FROM customers WHERE id = ?',
        [assigned_customer_id]
      );
      if (customer.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid customer assignment'
        });
      }
    }

    // Build INSERT query dynamically based on existing columns
    const insertColumns = ['truck_number'];
    const insertValues = [truck_number.trim()];

    if (existingColumns.includes('truck_type')) {
      insertColumns.push('truck_type');
      insertValues.push(truck_type || null);
    }

    if (existingColumns.includes('assigned_customer_id')) {
      insertColumns.push('assigned_customer_id');
      insertValues.push(assigned_customer_id || null);
    }

    if (existingColumns.includes('status')) {
      insertColumns.push('status');
      insertValues.push(status || 'Active');
    }

    if (existingColumns.includes('notes')) {
      insertColumns.push('notes');
      insertValues.push(notes || null);
    }

    const placeholders = insertValues.map(() => '?').join(', ');
    const [result] = await pool.execute(
      `INSERT INTO trucks (${insertColumns.join(', ')}) VALUES (${placeholders})`,
      insertValues
    );

    return res.status(201).json({
      success: true,
      message: 'Truck added successfully',
      data: {
        id: result.insertId,
        truck_number: truck_number.trim(),
        truck_type: existingColumns.includes('truck_type') ? truck_type : null,
        assigned_customer_id: existingColumns.includes('assigned_customer_id') ? (assigned_customer_id || null) : null,
        status: existingColumns.includes('status') ? (status || 'Active') : 'Active',
        notes: existingColumns.includes('notes') ? (notes || null) : null
      }
    });
  } catch (error) {
    console.error('Error creating truck:', error);
    // If column doesn't exist error, try to add it and retry
    if (error.message.includes('Unknown column')) {
      try {
        // Try to add missing columns
        const columnsToAdd = [
          { name: 'truck_type', sql: 'ALTER TABLE trucks ADD COLUMN truck_type ENUM(\'Box Truck\', \'Semi\', \'Pickup\') NULL AFTER truck_number' },
          { name: 'assigned_customer_id', sql: 'ALTER TABLE trucks ADD COLUMN assigned_customer_id INT NULL AFTER truck_type' },
          { name: 'status', sql: 'ALTER TABLE trucks ADD COLUMN status ENUM(\'Active\', \'Inactive\') DEFAULT \'Active\' AFTER assigned_customer_id' },
          { name: 'notes', sql: 'ALTER TABLE trucks ADD COLUMN notes TEXT NULL AFTER status' }
        ];

        const [columns] = await pool.execute(
          `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
           WHERE TABLE_SCHEMA = DATABASE() 
           AND TABLE_NAME = 'trucks'`
        );
        const existingCols = columns.map(col => col.COLUMN_NAME);

        for (const col of columnsToAdd) {
          if (!existingCols.includes(col.name)) {
            try {
              await pool.execute(col.sql);
              console.log(`✅ Added missing column: trucks.${col.name}`);
            } catch (addError) {
              console.error(`Error adding column ${col.name}:`, addError.message);
            }
          }
        }

        // Retry the insert
        return createTruck(req, res);
      } catch (retryError) {
        return res.status(500).json({
          success: false,
          message: 'Failed to create truck. Please run ADD_TRUCK_COLUMNS.sql migration.',
          error: error.message
        });
      }
    }
    return res.status(500).json({
      success: false,
      message: 'Failed to create truck',
      error: error.message
    });
  }
};

/**
 * Update a truck
 */
const updateTruck = async (req, res) => {
  try {
    const { id } = req.params;
    const { truck_number, truck_type, assigned_customer_id, status, notes } = req.body;
    // Verify truck exists
    const [existing] = await pool.execute(
      'SELECT id FROM trucks WHERE id = ?',
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Truck not found'
      });
    }

    // Check if truck number already exists for another truck
    if (truck_number) {
      const [duplicate] = await pool.execute(
        'SELECT id FROM trucks WHERE truck_number = ? AND id != ?',
        [truck_number.trim(), id]
      );
      if (duplicate.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Truck number already exists'
        });
      }
    }

    // Verify customer exists if assigned
    if (assigned_customer_id) {
      const [customer] = await pool.execute(
        'SELECT id FROM customers WHERE id = ?',
        [assigned_customer_id]
      );
      if (customer.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid customer assignment'
        });
      }
    }

    const updates = [];
    const values = [];

    if (truck_number !== undefined) {
      updates.push('truck_number = ?');
      values.push(truck_number.trim());
    }

    if (truck_type !== undefined) {
      updates.push('truck_type = ?');
      values.push(truck_type);
    }

    if (assigned_customer_id !== undefined) {
      updates.push('assigned_customer_id = ?');
      values.push(assigned_customer_id || null);
    }

    if (status !== undefined) {
      updates.push('status = ?');
      values.push(status);
    }

    if (notes !== undefined) {
      updates.push('notes = ?');
      values.push(notes || null);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update'
      });
    }

    values.push(id);
    await pool.execute(
      `UPDATE trucks SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`,
      values
    );

    return res.json({
      success: true,
      message: 'Truck updated successfully'
    });
  } catch (error) {
    console.error('Error updating truck:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update truck',
      error: error.message
    });
  }
};

/**
 * Delete a truck
 */
const deleteTruck = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ success: false, message: 'Truck ID is required' });
    }

    const [truck] = await pool.execute(
      'SELECT id, truck_number FROM trucks WHERE id = ? AND deleted_at IS NULL', [id]
    );

    if (truck.length === 0) {
      return res.status(404).json({ success: false, message: 'Truck not found' });
    }

    // SOFT DELETE — never hard delete
    await pool.execute(
      'UPDATE trucks SET deleted_at = NOW(), updated_at = NOW() WHERE id = ?', [id]
    );

    return res.json({ success: true, message: 'Truck deleted successfully' });
  } catch (error) {
    console.error('Error deleting truck:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete truck', error: error.message });
  }
};

/**
 * Get all trailers (fleet master)
 */
const getAllTrailers = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, trailer_number, trailer_type, status, notes, created_at, updated_at
       FROM trailers WHERE deleted_at IS NULL ORDER BY trailer_number ASC`
    );
    return res.json({ success: true, data: rows });
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE') {
      return res.json({ success: true, data: [], message: 'Trailers table missing — run DB migration.' });
    }
    console.error('Error fetching trailers:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch trailers', error: error.message });
  }
};

/**
 * Create trailer
 */
const createTrailer = async (req, res) => {
  try {
    const { trailer_number, trailer_type, status, notes } = req.body;

    if (!trailer_number || String(trailer_number).trim() === '') {
      return res.status(400).json({ success: false, message: 'Trailer number is required' });
    }

    const [existing] = await pool.execute(
      'SELECT id FROM trailers WHERE trailer_number = ? AND deleted_at IS NULL',
      [String(trailer_number).trim()]
    );
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: 'Trailer number already exists' });
    }

    const [result] = await pool.execute(
      `INSERT INTO trailers (trailer_number, trailer_type, status, notes)
       VALUES (?, ?, ?, ?)`,
      [
        String(trailer_number).trim(),
        trailer_type || null,
        status || 'Active',
        notes || null
      ]
    );

    return res.status(201).json({
      success: true,
      message: 'Trailer added successfully',
      data: { id: result.insertId, trailer_number: String(trailer_number).trim(), trailer_type: trailer_type || null, status: status || 'Active', notes: notes || null }
    });
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE') {
      return res.status(503).json({ success: false, message: 'Trailers table missing — run DB migration.' });
    }
    console.error('Error creating trailer:', error);
    return res.status(500).json({ success: false, message: 'Failed to create trailer', error: error.message });
  }
};

/**
 * Update trailer
 */
const updateTrailer = async (req, res) => {
  try {
    const { id } = req.params;
    const { trailer_number, trailer_type, status, notes } = req.body;

    const [found] = await pool.execute(
      'SELECT id FROM trailers WHERE id = ? AND deleted_at IS NULL',
      [id]
    );
    if (found.length === 0) {
      return res.status(404).json({ success: false, message: 'Trailer not found' });
    }

    if (trailer_number) {
      const [dup] = await pool.execute(
        'SELECT id FROM trailers WHERE trailer_number = ? AND id != ? AND deleted_at IS NULL',
        [String(trailer_number).trim(), id]
      );
      if (dup.length > 0) {
        return res.status(400).json({ success: false, message: 'Trailer number already exists' });
      }
    }

    const updates = [];
    const values = [];
    if (trailer_number !== undefined) {
      updates.push('trailer_number = ?');
      values.push(String(trailer_number).trim());
    }
    if (trailer_type !== undefined) {
      updates.push('trailer_type = ?');
      values.push(trailer_type || null);
    }
    if (status !== undefined) {
      updates.push('status = ?');
      values.push(status);
    }
    if (notes !== undefined) {
      updates.push('notes = ?');
      values.push(notes || null);
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    values.push(id);
    await pool.execute(
      `UPDATE trailers SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`,
      values
    );

    return res.json({ success: true, message: 'Trailer updated successfully' });
  } catch (error) {
    console.error('Error updating trailer:', error);
    return res.status(500).json({ success: false, message: 'Failed to update trailer', error: error.message });
  }
};

/**
 * Delete trailer (soft)
 */
const deleteTrailer = async (req, res) => {
  try {
    const { id } = req.params;
    const [row] = await pool.execute(
      'SELECT id FROM trailers WHERE id = ? AND deleted_at IS NULL',
      [id]
    );
    if (row.length === 0) {
      return res.status(404).json({ success: false, message: 'Trailer not found' });
    }
    await pool.execute(
      'UPDATE trailers SET deleted_at = NOW(), updated_at = NOW() WHERE id = ?',
      [id]
    );
    return res.json({ success: true, message: 'Trailer deleted successfully' });
  } catch (error) {
    console.error('Error deleting trailer:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete trailer', error: error.message });
  }
};

/**
 * Get all companies
 */
const getAllCompanies = async (req, res) => {
  try {
    const [companies] = await pool.execute(
      'SELECT id, name, created_at, updated_at FROM companies ORDER BY name ASC'
    );

    return res.json({
      success: true,
      data: companies
    });
  } catch (error) {
    console.error('Error fetching companies:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch companies',
      error: error.message
    });
  }
};

/**
 * Create a new company
 */
const createCompany = async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Company name is required'
      });
    }

    // Check if company name already exists
    const [existing] = await pool.execute(
      'SELECT id FROM companies WHERE name = ?',
      [name.trim()]
    );

    if (existing.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Company name already exists'
      });
    }

    const [result] = await pool.execute(
      'INSERT INTO companies (name) VALUES (?)',
      [name.trim()]
    );

    return res.status(201).json({
      success: true,
      message: 'Company created successfully',
      data: { id: result.insertId, name: name.trim() }
    });
  } catch (error) {
    console.error('Error creating company:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create company',
      error: error.message
    });
  }
};

/**
 * Update a company
 */
const updateCompany = async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Company name is required'
      });
    }

    // Check if company exists
    const [existing] = await pool.execute(
      'SELECT id FROM companies WHERE id = ?',
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Company not found'
      });
    }

    // Check if name already exists for another company
    const [nameExists] = await pool.execute(
      'SELECT id FROM companies WHERE name = ? AND id != ?',
      [name.trim(), id]
    );

    if (nameExists.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Company name already exists'
      });
    }

    await pool.execute(
      'UPDATE companies SET name = ?, updated_at = NOW() WHERE id = ?',
      [name.trim(), id]
    );

    return res.json({
      success: true,
      message: 'Company updated successfully'
    });
  } catch (error) {
    console.error('Error updating company:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update company',
      error: error.message
    });
  }
};

/**
 * Delete a company
 */
const deleteCompany = async (req, res) => {
  try {
    const { id } = req.params;

    // Check if company exists
    const [company] = await pool.execute(
      'SELECT id, name FROM companies WHERE id = ?',
      [id]
    );

    if (company.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Company not found'
      });
    }

    // Check if company has any users/drivers/customers/trucks/tickets
    const [users] = await pool.execute('SELECT COUNT(*) as count FROM users', []);
    const [drivers] = await pool.execute('SELECT COUNT(*) as count FROM drivers', []);
    const [customers] = await pool.execute('SELECT COUNT(*) as count FROM customers', []);
    const [trucks] = await pool.execute('SELECT COUNT(*) as count FROM trucks', []);
    const [tickets] = await pool.execute('SELECT COUNT(*) as count FROM tickets', []);

    const totalRecords = parseInt(users[0].count) + parseInt(drivers[0].count) + parseInt(customers[0].count) + parseInt(trucks[0].count) + parseInt(tickets[0].count);

    if (totalRecords > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete company. It has associated users, drivers, customers, trucks, or tickets. Please delete all associated data first.',
        details: {
          users: parseInt(users[0].count),
          drivers: parseInt(drivers[0].count),
          customers: parseInt(customers[0].count),
          trucks: parseInt(trucks[0].count),
          tickets: parseInt(tickets[0].count)
        }
      });
    }

    await pool.execute('DELETE FROM companies WHERE id = ?', [id]);

    return res.json({
      success: true,
      message: 'Company deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting company:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete company',
      error: error.message
    });
  }
};

/**
 * Upload and process company logo with compression
 */
const uploadLogo = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file received' });
    }

    const { filename, path: tempPath } = req.file;
    const targetDir = 'uploads/logos';
    const targetPath = path.join(targetDir, 'company_logo.webp'); // Standardize as webp

    // Ensure dir exists
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Process image with sharp: resize and compress
    await sharp(tempPath)
      .resize(800, null, { withoutEnlargement: true }) // reasonable max width
      .webp({ quality: 80 })
      .toFile(targetPath);

    // Delete temp file
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);

    const logoUrl = `/uploads/logos/company_logo.webp?v=${Date.now()}`;

    // Update DB
    await pool.execute('UPDATE company_settings SET company_logo = ? WHERE id > 0', [logoUrl]);

    return res.json({
      success: true,
      message: 'Logo uploaded and compressed successfully',
      data: { logo_url: logoUrl }
    });
  } catch (error) {
    console.error('[uploadLogo]', error);
    return res.status(500).json({ success: false, message: 'Logo processing failed', error: error.message });
  }
};

/**
 * Get distinct months available in tickets for filtering
 */
const getAvailableMonths = async (req, res) => {
  try {
    const [months] = await pool.execute(
      `SELECT DISTINCT DATE_FORMAT(date, '%Y-%m') as month_val, 
              DATE_FORMAT(date, '%b %Y') as month_label 
       FROM tickets 
       WHERE deleted_at IS NULL
       ORDER BY month_val DESC`
    );
    // Write debug log to file
    fs.appendFileSync('debug_months.log', `[${new Date().toISOString()}] Months found: ${JSON.stringify(months)}\n`);
    return res.json({
      success: true,
      data: months
    });
  } catch (error) {
    console.error('Error fetching available months:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch available months',
      error: error.message
    });
  }
};

module.exports = {
  getAllDrivers,
  getDriverById,
  createDriver,
  updateDriver,
  deleteDriver,
  getAllCustomers,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  getAllTickets,
  getTicketById,
  updateTicket,
  updateTicketStatus,
  deleteTicket,
  getDashboardStats,
  generateInvoice,
  downloadInvoice,
  sendInvoiceEmailHandler,
  sendSettlementEmailHandler,
  generateSettlement,
  downloadSettlement,
  getBillRates,
  updateBillRates,
  getAllTrucks,
  createTruck,
  updateTruck,
  deleteTruck,
  getAllTrailers,
  createTrailer,
  updateTrailer,
  deleteTrailer,
  getAllCompanies,
  createCompany,
  updateCompany,
  deleteCompany,
  uploadLogo,
  getAvailableMonths
};
