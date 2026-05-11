const express = require("express");
const adminController = require("../controllers/adminController");

const router = express.Router();

// Admin dashboard: academic performance aggregates from MongoDB
router.get("/academic-performance", adminController.getAcademicPerformance);

module.exports = router;

