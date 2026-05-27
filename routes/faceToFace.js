const express = require('express');
const { protect, authorizeNationalAdminOrSuperadmin } = require('../middleware/auth');
const { invalidateCacheOnChange } = require('../middleware/cache');
const {
  buildFaceToFaceDashboard,
  updateFaceToFaceSelection,
  resolveDashboardYear
} = require('../utils/faceToFaceService');

const router = express.Router();

router.use(protect);
router.use(authorizeNationalAdminOrSuperadmin);

// @route   GET /api/face-to-face/dashboard
// @desc    Get face-to-face stage dashboard data
// @access  Private (National admin, Superadmin)
router.get('/dashboard', async (req, res) => {
  try {
    const year = resolveDashboardYear(req.query.year);
    const dashboard = await buildFaceToFaceDashboard({ year });
    return res.json(dashboard);
  } catch (error) {
    console.error('Get face-to-face dashboard error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   PUT /api/face-to-face/selection
// @desc    Update selected submissions for face-to-face stage
// @access  Private (National admin, Superadmin)
router.put('/selection', invalidateCacheOnChange(['cache:/api/submissions*', 'cache:/api/competition-rounds*', 'cache:/api/leaderboard*']), async (req, res) => {
  try {
    const year = resolveDashboardYear(req.body?.year || req.query?.year);
    const submissionIds = Array.isArray(req.body?.submissionIds) ? req.body.submissionIds : [];

    const result = await updateFaceToFaceSelection({
      year,
      submissionIds,
      updatedBy: req.user?._id || null
    });

    if (!result.success) {
      return res.status(result.status || 400).json({
        success: false,
        message: result.message,
        invalidSubmissionIds: result.invalidSubmissionIds || []
      });
    }

    return res.json(result);
  } catch (error) {
    console.error('Update face-to-face selection error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   GET /api/face-to-face/leaderboard
// @desc    Get weighted face-to-face leaderboard
// @access  Private (National admin, Superadmin)
router.get('/leaderboard', async (req, res) => {
  try {
    const year = resolveDashboardYear(req.query.year);
    const dashboard = await buildFaceToFaceDashboard({ year });
    return res.json({
      success: true,
      year: dashboard.year,
      round: dashboard.round,
      weights: dashboard.weights,
      count: dashboard.leaderboard.length,
      leaderboard: dashboard.leaderboard
    });
  } catch (error) {
    console.error('Get face-to-face leaderboard error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

module.exports = router;
