/**
 * Inspection Controller
 * Handles Driver's Daily Vehicle Inspection Reports
 */

const pool = require('../config/db');

const INSPECTION_INSERT_FIELDS = [
  'trip_no', 'driver_id', 'co_driver_name', 'from_location', 'to_location',
  'inspection_date', 'inspection_time', 'trip_type', 'vehicle_make', 'truck_id', 'trailer_id', 'trailer_no',
  'km_start', 'km_end', 'km_driven',
  'engine_compartment', 'inside_cab', 'steering_mechanism', 'windshield_wipers', 'windshield_windows',
  'rear_vision_mirrors', 'lights_reflectors', 'parking_service_brakes', 'airbrake_adjustment', 'driver_seatbelt',
  'hydraulic_brake_fluid', 'unit_condition', 'horns', 'air_light_lines', 'coupling_device', 'tires', 'wheels_rims',
  'emergency_equipment', 'load_security', 'fuel_system', 'exhaust_system', 'suspension_system', 'landing_gear', 'other_items',
  'remarks', 'condition_okay', 'no_correction_needed', 'defects_corrected', 'driver_signature'
];

/**
 * Get all inspections (Admin only)
 */
const getAllInspections = async (req, res) => {
  try {
    const { startDate, endDate, truckId, driverId } = req.query;

    let query = `
      SELECT di.*, d.name as driver_name, t.truck_number as truck_no, tr.trailer_number as trailer_ref_number
      FROM daily_inspections di
      LEFT JOIN drivers d ON di.driver_id = d.id
      LEFT JOIN trucks t ON di.truck_id = t.id
      LEFT JOIN trailers tr ON di.trailer_id = tr.id
      WHERE di.deleted_at IS NULL
    `;
    const params = [];

    if (startDate) {
      query += ' AND di.inspection_date >= ?';
      params.push(startDate);
    }
    if (endDate) {
      query += ' AND di.inspection_date <= ?';
      params.push(endDate);
    }
    if (truckId) {
      query += ' AND di.truck_id = ?';
      params.push(truckId);
    }
    if (driverId) {
      query += ' AND di.driver_id = ?';
      params.push(driverId);
    }

    query += ' ORDER BY di.inspection_date DESC, di.inspection_time DESC';

    const [rows] = await pool.execute(query, params);
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('[getAllInspections]', error);
    res.status(500).json({ success: false, message: 'Failed to fetch inspections', error: error.message });
  }
};

/**
 * Get inspection by ID
 */
const getInspectionById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute(
      `SELECT di.*, d.name as driver_name, t.truck_number as truck_no, tr.trailer_number as trailer_ref_number
       FROM daily_inspections di
       LEFT JOIN drivers d ON di.driver_id = d.id
       LEFT JOIN trucks t ON di.truck_id = t.id
       LEFT JOIN trailers tr ON di.trailer_id = tr.id
       WHERE di.id = ? AND di.deleted_at IS NULL`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Inspection report not found' });
    }

    const report = rows[0];
    const userRole = req.user.role;

    // If driver, allow only their own report
    if (userRole === 'driver') {
      const driverId = req.user.driverId;
      if (report.driver_id !== driverId) {
        return res.status(403).json({ success: false, message: 'Access denied. You can only view your own reports.' });
      }
    }

    res.json({ success: true, data: report });
  } catch (error) {
    console.error('[getInspectionById]', error);
    res.status(500).json({ success: false, message: 'Failed to fetch inspection details', error: error.message });
  }
};

/**
 * Create new inspection (Driver only)
 */
const createInspection = async (req, res) => {
  try {
    const raw = req.body || {};
    const data = {};

    for (const key of INSPECTION_INSERT_FIELDS) {
      if (!(key in raw)) continue;
      let v = raw[key];
      if (key === 'trailer_id') {
        data[key] = v === '' || v === null || v === undefined ? null : parseInt(v, 10);
        continue;
      }
      if (key === 'driver_id' || key === 'truck_id') {
        data[key] = parseInt(v, 10);
        continue;
      }
      if (['km_start', 'km_end', 'km_driven'].includes(key)) {
        data[key] = v === '' || v === null || v === undefined ? 0 : parseInt(v, 10);
        continue;
      }
      data[key] = v;
    }

    // Calculate km_driven if both start and end are provided
    if (data.km_start != null && data.km_end != null) {
      const start = parseInt(data.km_start, 10) || 0;
      const end = parseInt(data.km_end, 10) || 0;
      data.km_driven = end >= start ? end - start : 0;
    }

    const fields = Object.keys(data);
    const placeholders = fields.map(() => '?').join(', ');
    const values = Object.values(data);

    const query = `INSERT INTO daily_inspections (${fields.join(', ')}) VALUES (${placeholders})`;

    const [result] = await pool.execute(query, values);

    res.status(201).json({
      success: true,
      message: 'Inspection report submitted successfully',
      id: result.insertId
    });
  } catch (error) {
    console.error('[createInspection]', error);
    res.status(500).json({ success: false, message: 'Failed to submit inspection report', error: error.message });
  }
};

/**
 * Get inspections for current driver
 */
const getMyInspections = async (req, res) => {
  try {
    const driverId = req.user.driverId;
    if (!driverId) {
      return res.status(400).json({ success: false, message: 'Driver ID not found for this user' });
    }

    const [rows] = await pool.execute(
      `SELECT di.*, t.truck_number as truck_no, tr.trailer_number as trailer_ref_number
       FROM daily_inspections di
       LEFT JOIN trucks t ON di.truck_id = t.id
       LEFT JOIN trailers tr ON di.trailer_id = tr.id
       WHERE di.driver_id = ? AND di.deleted_at IS NULL
       ORDER BY di.inspection_date DESC`,
      [driverId]
    );

    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('[getMyInspections]', error);
    res.status(500).json({ success: false, message: 'Failed to fetch your inspections', error: error.message });
  }
};

/**
 * Update inspection
 */
const updateInspection = async (req, res) => {
  try {
    const { id } = req.params;
    const data = req.body;

    // Check if inspection exists
    const [existing] = await pool.execute('SELECT * FROM daily_inspections WHERE id = ? AND deleted_at IS NULL', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Inspection not found' });
    }

    const report = existing[0];
    const userRole = req.user.role;

    // Driver can only update their own reports
    if (userRole === 'driver' && report.driver_id !== req.user.driverId) {
      return res.status(403).json({ success: false, message: 'Access denied. You can only update your own reports.' });
    }

    // Calculate km_driven if start or end km are provided
    if (data.km_start !== undefined || data.km_end !== undefined) {
      const start = data.km_start !== undefined ? parseInt(data.km_start) : parseInt(report.km_start || 0);
      const end = data.km_end !== undefined ? parseInt(data.km_end) : parseInt(report.km_end || 0);
      data.km_driven = end - start;
    }

    // Filter out restricted fields
    const restrictedFields = ['id', 'driver_id', 'created_at', 'deleted_at'];
    const fields = Object.keys(data).filter(key => !restrictedFields.includes(key));

    if (fields.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    const setClause = fields.map(field => `${field} = ?`).join(', ');
    const values = [...fields.map(field => data[field]), id];

    const query = `UPDATE daily_inspections SET ${setClause} WHERE id = ?`;
    await pool.execute(query, values);

    res.json({ success: true, message: 'Inspection report updated successfully' });
  } catch (error) {
    console.error('[updateInspection]', error);
    res.status(500).json({ success: false, message: 'Failed to update inspection report', error: error.message });
  }
};

/**
 * Delete inspection (Soft delete)
 */
const deleteInspection = async (req, res) => {
  try {
    const { id } = req.params;

    // Check if inspection exists
    const [existing] = await pool.execute('SELECT * FROM daily_inspections WHERE id = ? AND deleted_at IS NULL', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Inspection not found' });
    }

    const report = existing[0];
    const userRole = req.user.role;

    // Driver can only delete their own reports
    if (userRole === 'driver' && report.driver_id !== req.user.driverId) {
      return res.status(403).json({ success: false, message: 'Access denied. You can only delete your own reports.' });
    }

    await pool.execute('UPDATE daily_inspections SET deleted_at = NOW() WHERE id = ?', [id]);

    res.json({ success: true, message: 'Inspection report deleted successfully' });
  } catch (error) {
    console.error('[deleteInspection]', error);
    res.status(500).json({ success: false, message: 'Failed to delete inspection report', error: error.message });
  }
};

module.exports = {
  getAllInspections,
  getInspectionById,
  createInspection,
  getMyInspections,
  updateInspection,
  deleteInspection
};
