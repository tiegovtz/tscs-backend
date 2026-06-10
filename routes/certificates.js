const express = require('express');
const Submission = require('../models/Submission');
const { protect } = require('../middleware/auth');
const { canAdminAccessSubmission } = require('../utils/adminScope');
const {
  generateCertificatePdf,
  resolveCertificateType,
  getCertificateTemplateConfig
} = require('../utils/certificateService');

const router = express.Router();

router.use(protect);

const canAccessSubmissionCertificate = (user, submission) => {
  if (!user || !submission) return false;
  if (user.role === 'teacher') {
    return String(submission.teacherId?._id || submission.teacherId) === String(user._id);
  }
  if (user.role === 'superadmin') return true;
  if (user.role === 'admin') return canAdminAccessSubmission(user, submission);
  return false;
};

const mapCertificateSubmission = (submission) => {
  const certificateType = resolveCertificateType(submission);
  const template = getCertificateTemplateConfig(certificateType);
  return {
    submissionId: submission._id,
    teacherName: submission.teacherName,
    year: submission.year,
    category: submission.category,
    class: submission.class,
    subject: submission.subject,
    areaOfFocus: submission.areaOfFocus,
    level: submission.level,
    school: submission.school,
    certificateType,
    certificateLabel: template.label
  };
};

router.get('/my', async (req, res) => {
  try {
    if (req.user.role !== 'teacher') {
      return res.status(403).json({
        success: false,
        message: 'Only teachers can view their own certificates from this endpoint'
      });
    }

    const submissions = await Submission.find({
      teacherId: req.user._id,
      isDeleted: { $ne: true }
    }).sort({ createdAt: -1 });

    res.json({
      success: true,
      count: submissions.length,
      certificates: submissions.map(mapCertificateSubmission)
    });
  } catch (error) {
    console.error('Get my certificates error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

router.get('/submissions/:submissionId/download', async (req, res) => {
  try {
    const submission = await Submission.findOne({
      _id: req.params.submissionId,
      isDeleted: { $ne: true }
    }).populate('teacherId', 'name email');

    if (!submission) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found'
      });
    }

    if (!canAccessSubmissionCertificate(req.user, submission)) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to download this certificate'
      });
    }

    const teacherName = submission.teacherName || submission.teacherId?.name || req.user.name;
    const certificate = await generateCertificatePdf({ submission, teacherName });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${certificate.fileName}"`);
    res.setHeader('Content-Length', certificate.pdfBytes.length);
    res.send(certificate.pdfBytes);
  } catch (error) {
    console.error('Download certificate error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

module.exports = router;
