/**
 * Inspection Routes
 */

const express = require('express');
const router = express.Router();
const { authenticate, isAdmin, isDriver, isAdminOrCompany } = require('../middleware/auth');
const inspectionController = require('../controllers/inspectionController');

// All routes require authentication
router.use(authenticate);

// Driver routes
router.post('/submit', isDriver, inspectionController.createInspection);
router.get('/my-history', isDriver, inspectionController.getMyInspections);

// Admin / Company routes
router.get('/all', isAdminOrCompany, inspectionController.getAllInspections);

// ✅ This route is accessible by BOTH driver AND admin
// Driver can only view their own reports (enforced in controller)
router.get('/:id', inspectionController.getInspectionById);

// Update inspection (accessible by both driver and admin; driver can only update own)
router.put('/:id', inspectionController.updateInspection);

// Delete inspection (accessible by both driver and admin; driver can only delete own)
router.delete('/:id', inspectionController.deleteInspection);

module.exports = router;
