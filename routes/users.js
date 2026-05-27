const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Competition = require('../models/Competition');
const Submission = require('../models/Submission');
const SubmissionAssignment = require('../models/SubmissionAssignment');
const { protect, authorize } = require('../middleware/auth');
const { logger } = require('../utils/logger');
const { assignUnassignedSubmissionsToJudge } = require('../utils/judgeAssignment');
const {
  buildUserQueryForAdmin,
  canAdminAccessSubmission,
  canAdminAccessUser,
  adminCanRegisterStakeholder,
  getAdminScope
} = require('../utils/adminScope');

const router = express.Router();

// All routes require authentication and admin/superadmin role
router.use(protect);
router.use(authorize('admin', 'superadmin'));

const isDuplicateKeyError = (error) => Boolean(error && (error.code === 11000 || error?.cause?.code === 11000));

const getDuplicateUserMessage = (error) => {
  const field = Object.keys(error?.keyPattern || error?.keyValue || {})[0];
  if (field === 'username') return 'User with this username already exists';
  if (field === 'email') return 'User with this email already exists';
  return 'User with this username or email already exists';
};

const serializeAssignment = (assignment) => ({
  assignmentId: assignment._id,
  id: assignment._id,
  submissionId: assignment.submissionId?._id || assignment.submissionId,
  judge: assignment.judgeId ? {
    id: assignment.judgeId._id || assignment.judgeId,
    name: assignment.judgeId.name,
    email: assignment.judgeId.email,
    username: assignment.judgeId.username,
    assignedLevel: assignment.judgeId.assignedLevel,
    assignedRegion: assignment.judgeId.assignedRegion,
    assignedCouncil: assignment.judgeId.assignedCouncil
  } : null,
  round: assignment.roundId ? {
    id: assignment.roundId._id || assignment.roundId,
    year: assignment.roundId.year,
    level: assignment.roundId.level,
    status: assignment.roundId.status,
    region: assignment.roundId.region,
    council: assignment.roundId.council,
    endTime: assignment.roundId.endTime
  } : null,
  level: assignment.level,
  region: assignment.region,
  council: assignment.council,
  assignedAt: assignment.assignedAt,
  judgeNotified: assignment.judgeNotified,
  createdAt: assignment.createdAt,
  updatedAt: assignment.updatedAt
});

const sortByYearDesc = (a, b) => {
  if (a.year === null) return 1;
  if (b.year === null) return -1;
  return b.year - a.year;
};

const groupSubmissionsByYear = (submissions) => {
  const groups = new Map();

  for (const submission of submissions) {
    const yearKey = String(submission.year || 'Unknown');
    if (!groups.has(yearKey)) {
      groups.set(yearKey, {
        year: submission.year || null,
        count: 0,
        submissions: []
      });
    }

    const yearGroup = groups.get(yearKey);
    yearGroup.count += 1;
    yearGroup.submissions.push(submission);
  }

  return [...groups.values()].sort(sortByYearDesc);
};

const buildCompetitionSummaries = async (submissions) => {
  const years = [...new Set(
    submissions
      .map((submission) => submission.year)
      .filter((year) => Number.isFinite(Number(year)))
      .map((year) => Number(year))
  )].sort((a, b) => b - a);

  if (years.length === 0) {
    return [];
  }

  const competitionDocs = await Competition.find({ year: { $in: years } })
    .sort({ year: -1 })
    .lean();

  const competitionMap = new Map(competitionDocs.map((competition) => [competition.year, competition]));

  return years.map((year) => {
    const matchingSubmissions = submissions.filter((submission) => Number(submission.year) === year);
    const competition = competitionMap.get(year);

    return {
      year,
      competitionId: competition?._id || null,
      isActive: typeof competition?.isActive === 'boolean' ? competition.isActive : null,
      existsInCompetitionConfig: !!competition,
      submissionCount: matchingSubmissions.length,
      levels: [...new Set(matchingSubmissions.map((submission) => submission.level).filter(Boolean))].sort(),
      categories: [...new Set(matchingSubmissions.map((submission) => submission.category).filter(Boolean))].sort(),
      classes: [...new Set(matchingSubmissions.map((submission) => submission.class).filter(Boolean))].sort(),
      subjects: [...new Set(matchingSubmissions.map((submission) => submission.subject).filter(Boolean))].sort(),
      areasOfFocus: [...new Set(matchingSubmissions.map((submission) => submission.areaOfFocus).filter(Boolean))].sort()
    };
  }).sort(sortByYearDesc);
};

// @route   GET /api/users
// @desc    Get all users (with filters)
// @access  Private (Admin/Superadmin)
router.get('/', async (req, res) => {
  try {
    const { role, status, search } = req.query;
    
    let query = { isDeleted: { $ne: true } };

    // Admin scope: filter users by level/region/council
    if (req.user.role === 'admin') {
      const scopeQuery = buildUserQueryForAdmin(req.user);
      if (Object.keys(scopeQuery).length > 0) {
        query.$and = query.$and || [];
        query.$and.push(scopeQuery);
      }
    }
    
    if (role) {
      query.role = role;
    }
    
    if (status) {
      query.status = status;
    }
    
    if (search) {
      const searchClause = {
        $or: [
          { name: { $regex: search, $options: 'i' } },
          { username: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } }
        ]
      };
      if (query.$and) {
        query.$and.push(searchClause);
      } else {
        query.$or = searchClause.$or;
      }
    }

    const users = await User.find(query).select('-password').sort({ createdAt: -1 });

    // Log user list view
    await logger.logAdminAction(
      'Admin viewed users list',
      req.user._id,
      req,
      { 
        filters: { role, status, search },
        count: users.length
      },
      undefined,
      'read'
    );

    res.json({
      success: true,
      count: users.length,
      users
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/users/:id/summary
// @desc    Get user summary with submissions grouped by competition year and assignment details
// @access  Private (Admin/Superadmin)
router.get('/:id/summary', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID'
      });
    }

    const user = await User.findById(req.params.id).select('-password').lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (req.user.role === 'admin' && !canAdminAccessUser(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this user'
      });
    }

    const ownedSubmissions = await Submission.find({ teacherId: user._id })
      .populate('teacherId', 'name email username school region council')
      .sort({ year: -1, createdAt: -1 })
      .lean();

    const scopedOwnedSubmissions = req.user.role === 'admin'
      ? ownedSubmissions.filter((submission) => canAdminAccessSubmission(req.user, submission))
      : ownedSubmissions;

    const ownedSubmissionIds = scopedOwnedSubmissions.map((submission) => submission._id);
    const ownedAssignments = ownedSubmissionIds.length > 0
      ? await SubmissionAssignment.find({ submissionId: { $in: ownedSubmissionIds } })
        .populate('judgeId', 'name email username assignedLevel assignedRegion assignedCouncil')
        .populate('roundId', 'year level status region council endTime')
        .sort({ assignedAt: -1, createdAt: -1 })
        .lean()
      : [];

    const assignmentsBySubmission = new Map();
    for (const assignment of ownedAssignments) {
      const submissionId = String(assignment.submissionId?._id || assignment.submissionId);
      if (!assignmentsBySubmission.has(submissionId)) {
        assignmentsBySubmission.set(submissionId, []);
      }
      assignmentsBySubmission.get(submissionId).push(serializeAssignment(assignment));
    }

    const submissionsWithAssignments = scopedOwnedSubmissions.map((submission) => ({
      ...submission,
      assignmentDetails: assignmentsBySubmission.get(String(submission._id)) || []
    }));

    const competitionYears = groupSubmissionsByYear(submissionsWithAssignments);
    const competitions = await buildCompetitionSummaries(scopedOwnedSubmissions);
    const submissionAssignmentDetails = ownedAssignments.map(serializeAssignment);
    let judgeAssignmentDetails = [];
    let assignedSubmissionsByCompetitionYear = [];

    if (user.role === 'judge') {
      const judgeAssignments = await SubmissionAssignment.find({ judgeId: user._id })
        .populate('submissionId')
        .populate('judgeId', 'name email username assignedLevel assignedRegion assignedCouncil')
        .populate('roundId', 'year level status region council endTime')
        .sort({ assignedAt: -1, createdAt: -1 })
        .lean();

      const scopedJudgeAssignments = req.user.role === 'admin'
        ? judgeAssignments.filter((assignment) => (
          assignment.submissionId && canAdminAccessSubmission(req.user, assignment.submissionId)
        ))
        : judgeAssignments;

      judgeAssignmentDetails = scopedJudgeAssignments.map(serializeAssignment);

      const assignedSubmissionSummaries = scopedJudgeAssignments
        .filter((assignment) => assignment.submissionId)
        .map((assignment) => ({
          ...assignment.submissionId,
          assignmentDetails: [serializeAssignment(assignment)]
        }));

      assignedSubmissionsByCompetitionYear = groupSubmissionsByYear(assignedSubmissionSummaries);
    }

    await logger.logAdminAction(
      'Admin viewed user summary details',
      req.user._id,
      req,
      {
        targetUserId: user._id.toString(),
        targetUserRole: user.role,
        ownedSubmissionCount: scopedOwnedSubmissions.length,
        ownedAssignmentCount: ownedAssignments.length,
        competitionCount: competitions.length,
        judgeAssignmentCount: judgeAssignmentDetails.length
      },
      undefined,
      'read'
    );

    res.json({
      success: true,
      userInfo: user,
      competitions,
      competitionYears,
      submissionAssignmentDetails,
      assignedSubmissionsByCompetitionYear,
      judgeSubmissionAssignmentDetails: judgeAssignmentDetails,
      summary: {
        totalCompetitions: competitions.length,
        totalOwnedSubmissions: scopedOwnedSubmissions.length,
        totalOwnedSubmissionAssignments: ownedAssignments.length,
        totalJudgeAssignments: judgeAssignmentDetails.length,
        competitionYearCount: competitionYears.length
      }
    });
  } catch (error) {
    console.error('Get user summary error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/users/deleted
// @desc    Get soft-deleted users
// @access  Private (Admin/Superadmin)
router.get('/deleted', async (req, res) => {
  try {
    const { role, search } = req.query;
    const query = { isDeleted: true };

    if (req.user.role === 'admin') {
      const scopeQuery = buildUserQueryForAdmin(req.user);
      if (Object.keys(scopeQuery).length > 0) {
        query.$and = query.$and || [];
        query.$and.push(scopeQuery);
      }
    }

    if (role) {
      query.role = role;
    }

    if (search) {
      const searchClause = {
        $or: [
          { name: { $regex: search, $options: 'i' } },
          { username: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } }
        ]
      };
      if (query.$and) {
        query.$and.push(searchClause);
      } else {
        query.$or = searchClause.$or;
      }
    }

    const users = await User.find(query).select('-password').sort({ deletedAt: -1, createdAt: -1 });

    res.json({
      success: true,
      count: users.length,
      users
    });
  } catch (error) {
    console.error('Get deleted users error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/users/:id
// @desc    Get single user
// @access  Private (Admin/Superadmin)
router.get('/:id', async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.params.id, isDeleted: { $ne: true } }).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Admin scope: only allow viewing users in their scope
    if (req.user.role === 'admin' && !canAdminAccessUser(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this user'
      });
    }

    // Log user detail view
    await logger.logAdminAction(
      'Admin viewed user details',
      req.user._id,
      req,
      { 
        targetUserId: req.params.id,
        targetUserRole: user.role,
        targetUserEmail: user.email
      },
      undefined,
      'read'
    );

    res.json({
      success: true,
      user
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/users
// @desc    Create new user
// @access  Private (Admin/Superadmin)
router.post('/', async (req, res) => {
  try {
    const userData = { ...req.body };

    // Validate required fields
    if (!userData.password || userData.password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password is required and must be at least 6 characters'
      });
    }

    // Only superadmin can create admin users
    if (userData.role === 'admin' && req.user.role !== 'superadmin') {
      return res.status(403).json({
        success: false,
        message: 'Only superadmin can create admin users'
      });
    }

    // Only national admin or superadmin can create stakeholders
    if (userData.role === 'stakeholder' && !adminCanRegisterStakeholder(req.user)) {
      return res.status(403).json({
        success: false,
        message: 'Only national admin can register stakeholders'
      });
    }

    // Apply admin scope: enforce location for teachers and judges created by council/regional admins
    const scope = getAdminScope(req.user);
    if (scope && userData.role === 'teacher') {
      if (scope.level === 'Council') {
        userData.region = scope.region;
        userData.council = scope.council;
      } else if (scope.level === 'Regional') {
        userData.region = scope.region;
        // Council can be set by regional admin (any council in region)
        if (!userData.council) userData.council = null;
      }
    }
    if (scope && userData.role === 'judge') {
      if (scope.level === 'Council') {
        userData.assignedLevel = 'Council';
        userData.assignedRegion = scope.region;
        userData.assignedCouncil = scope.council;
      } else if (scope.level === 'Regional') {
        userData.assignedLevel = 'Regional';
        userData.assignedRegion = scope.region;
        userData.assignedCouncil = null;
      }
    }

    const identityQuery = {
      $or: [
        { username: userData.username?.toLowerCase() },
        { email: userData.email?.toLowerCase() }
      ]
    };

    // Check if user already exists. Include deleted records separately because
    // deployed databases may still have legacy username_1/email_1 indexes.
    const existingUser = await User.findOne({
      isDeleted: { $ne: true },
      ...identityQuery
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User with this username or email already exists'
      });
    }

    const deletedUser = await User.findOne({
      isDeleted: true,
      ...identityQuery
    });

    let user;
    let restoredDeletedUser = false;
    if (deletedUser) {
      if (req.user.role === 'admin' && !canAdminAccessUser(req.user, deletedUser)) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to recreate this user'
        });
      }

      Object.assign(deletedUser, userData, {
        isDeleted: false,
        deletedAt: null,
        deletedBy: null
      });
      user = await deletedUser.save();
      restoredDeletedUser = true;
    } else {
      user = await User.create(userData);
    }

    // If a judge was created, assign unassigned submissions to them (and other judges in the location)
    let assignmentResult = null;
    if (user.role === 'judge' && (user.assignedLevel === 'Council' || user.assignedLevel === 'Regional')) {
      try {
        // Assign unassigned submissions using round-robin
        assignmentResult = await assignUnassignedSubmissionsToJudge(user);
        if (assignmentResult.success && assignmentResult.assignedCount > 0) {
          console.log(`Auto-assigned ${assignmentResult.assignedCount} submission(s) for new judge ${user.name}`);
        }
      } catch (error) {
        console.error('Error auto-assigning submissions to new judge:', error);
        // Don't fail user creation if assignment fails
        assignmentResult = { success: false, assignedCount: 0, error: error.message };
      }
    }

    // Log user creation
    await logger.logAdminAction(
      'Admin created new user account',
      req.user._id,
      req,
      {
        targetUserId: user._id.toString(),
        targetUserRole: user.role,
        targetUserEmail: user.email,
        targetUserName: user.name,
        restoredDeletedUser,
        ...(assignmentResult && { autoAssignedSubmissions: assignmentResult.assignedCount })
      },
      'success',
      'create'
    );

    const response = {
      success: true,
      message: restoredDeletedUser ? 'Deleted user restored and updated successfully' : 'User created successfully',
      user: user.toJSON()
    };

    // Include assignment info if available
    if (assignmentResult) {
      response.assignmentInfo = {
        assignedCount: assignmentResult.assignedCount,
        message: assignmentResult.message || assignmentResult.error
      };
    }

    res.status(201).json(response);
  } catch (error) {
    console.error('Create user error:', error);
    if (error.message && error.message.includes('admin already exists')) {
      return res.status(400).json({
        success: false,
        message: 'An admin already exists for this level and area'
      });
    }
    if (isDuplicateKeyError(error)) {
      return res.status(400).json({
        success: false,
        message: getDuplicateUserMessage(error)
      });
    }
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   PUT /api/users/:id
// @desc    Update user
// @access  Private (Admin/Superadmin)
router.put('/:id', async (req, res) => {
  try {
    // Get original user data before update for logging
    const originalUser = await User.findOne({ _id: req.params.id, isDeleted: { $ne: true } }).select('-password');
    
    if (!originalUser) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Admin scope: only allow updating users in their scope
    if (req.user.role === 'admin' && !canAdminAccessUser(req.user, originalUser)) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this user'
      });
    }

    // Prevent admin from changing user to admin (only superadmin can)
    const updateData = { ...req.body };
    if (req.user.role === 'admin' && updateData.role === 'admin') {
      delete updateData.role;
    }
    if (req.user.role === 'admin' && updateData.role === 'stakeholder' && !adminCanRegisterStakeholder(req.user)) {
      delete updateData.role;
    }

    // Enforce scope when admin updates teacher/judge location (use target role)
    const scope = getAdminScope(req.user);
    const targetRole = updateData.role !== undefined ? updateData.role : originalUser.role;
    if (scope && targetRole === 'teacher') {
      if (scope.level === 'Council') {
        updateData.region = scope.region;
        updateData.council = scope.council;
      } else if (scope.level === 'Regional') {
        updateData.region = scope.region;
      }
    }
    if (scope && targetRole === 'judge') {
      if (scope.level === 'Council') {
        updateData.assignedLevel = 'Council';
        updateData.assignedRegion = scope.region;
        updateData.assignedCouncil = scope.council;
      } else if (scope.level === 'Regional') {
        updateData.assignedLevel = 'Regional';
        updateData.assignedRegion = scope.region;
        updateData.assignedCouncil = null;
      }
    }

    const user = await User.findOneAndUpdate(
      { _id: req.params.id, isDeleted: { $ne: true } },
      updateData,
      { new: true, runValidators: true }
    ).select('-password');

    const updatedFields = Object.keys(req.body);

    // Log user update
    await logger.logAdminAction(
      'Admin updated user account',
      req.user._id,
      req,
      {
        targetUserId: req.params.id,
        targetUserRole: user.role,
        targetUserEmail: user.email,
        updatedFields: updatedFields,
        statusChanged: req.body.status && req.body.status !== originalUser.status,
        roleChanged: req.body.role && req.body.role !== originalUser.role
      },
      undefined,
      'update'
    );

    res.json({
      success: true,
      user
    });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   DELETE /api/users/:id
// @desc    Soft delete user
// @access  Private (Admin/Superadmin)
router.delete('/:id', authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.params.id, isDeleted: { $ne: true } });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (req.user.role === 'admin' && !canAdminAccessUser(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to delete this user'
      });
    }

    // Log user deletion before soft deleting
    await logger.logAdminAction(
      'Admin soft deleted user account',
      req.user._id,
      req,
      {
        targetUserId: req.params.id,
        targetUserRole: user.role,
        targetUserEmail: user.email,
        targetUserName: user.name
      },
      'error',
      'delete'
    );

    user.isDeleted = true;
    user.deletedAt = new Date();
    user.deletedBy = req.user._id;
    await user.save();

    res.json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/users/:id/restore
// @desc    Restore soft-deleted user
// @access  Private (Admin/Superadmin)
router.post('/:id/restore', authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.params.id, isDeleted: true }).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Deleted user not found'
      });
    }

    if (req.user.role === 'admin' && !canAdminAccessUser(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to restore this user'
      });
    }

    user.isDeleted = false;
    user.deletedAt = null;
    user.deletedBy = null;
    await user.save();

    await logger.logAdminAction(
      'Admin restored user account',
      req.user._id,
      req,
      {
        targetUserId: user._id.toString(),
        targetUserRole: user.role,
        targetUserEmail: user.email
      },
      'success',
      'update'
    );

    res.json({
      success: true,
      message: 'User restored successfully',
      user
    });
  } catch (error) {
    console.error('Restore user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   DELETE /api/users/:id/permanent
// @desc    Permanently delete a soft-deleted user
// @access  Private (Admin/Superadmin)
router.delete('/:id/permanent', authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (req.user.role === 'admin' && !canAdminAccessUser(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to permanently delete this user'
      });
    }

    if (!user.isDeleted) {
      return res.status(400).json({
        success: false,
        message: 'Only soft-deleted users can be permanently deleted'
      });
    }

    await User.deleteOne({ _id: user._id });

    await logger.logAdminAction(
      'Admin permanently deleted user account',
      req.user._id,
      req,
      {
        targetUserId: user._id.toString(),
        targetUserRole: user.role,
        targetUserEmail: user.email,
        targetUserName: user.name
      },
      'error',
      'delete'
    );

    res.json({
      success: true,
      message: 'User permanently deleted successfully'
    });
  } catch (error) {
    console.error('Permanent delete user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PATCH /api/users/:id/verify-email
// @desc    Manually verify (activate) a user's email — skips email confirmation
// @access  Private (Admin/Superadmin)
router.patch('/:id/verify-email', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID'
      });
    }

    const user = await User.findOne({ _id: req.params.id, isDeleted: { $ne: true } });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Admin scope: only allow accessing users in their scope
    if (req.user.role === 'admin' && !canAdminAccessUser(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to verify this user'
      });
    }

    if (user.emailVerified) {
      return res.status(400).json({
        success: false,
        message: 'User email is already verified'
      });
    }

    user.emailVerified = true;
    await user.save();

    await logger.logAdminAction(
      'Admin manually verified user email',
      req.user._id,
      req,
      {
        targetUserId: user._id.toString(),
        targetUserRole: user.role,
        targetUserEmail: user.email,
        targetUserName: user.name
      },
      'success',
      'update'
    );

    res.json({
      success: true,
      message: `Email for ${user.name} has been verified successfully`,
      user: user.toJSON()
    });
  } catch (error) {
    console.error('Verify email error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;

