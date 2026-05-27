const mongoose = require('mongoose');

const faceToFaceSelectionSchema = new mongoose.Schema({
  roundId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CompetitionRound',
    required: true,
    index: true
  },
  year: {
    type: Number,
    required: true,
    index: true
  },
  submissionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Submission',
    required: true,
    index: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, {
  timestamps: true
});

faceToFaceSelectionSchema.index({ roundId: 1, submissionId: 1 }, { unique: true });
faceToFaceSelectionSchema.index({ year: 1, roundId: 1 });

module.exports = mongoose.model('FaceToFaceSelection', faceToFaceSelectionSchema);
