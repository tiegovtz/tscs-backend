const fs = require('fs/promises');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const CERTIFICATE_TEMPLATES_DIR = path.join(__dirname, '..', 'assets', 'certificates');

const TEMPLATE_CONFIG = {
  educate: {
    fileName: 'educate-certificate.pdf',
    label: 'EDUCATE!'
  },
  boost: {
    fileName: 'boost-certificate.pdf',
    label: 'BOOST'
  },
  equip: {
    fileName: 'sequip-certificate.pdf',
    label: 'SEQUIP'
  }
};

const normalizeText = (value) => String(value || '').trim().toLowerCase();

const includesAny = (value, keywords) => {
  const normalized = normalizeText(value);
  return keywords.some((keyword) => normalized.includes(keyword));
};

const isBusinessStudySubmission = (submission) => (
  includesAny(submission?.areaOfFocus, ['business'])
  || includesAny(submission?.subject, ['business'])
  || includesAny(submission?.category, ['business'])
);

const isPrePrimaryOrPrimarySubmission = (submission) => (
  includesAny(submission?.class, ['pre-primary', 'pre primary', 'preprimary', 'primary'])
  || includesAny(submission?.category, ['pre-primary', 'pre primary', 'preprimary', 'primary'])
);

const resolveCertificateType = (submission) => {
  if (isBusinessStudySubmission(submission)) return 'educate';
  if (isPrePrimaryOrPrimarySubmission(submission)) return 'boost';
  return 'equip';
};

const getCertificateTemplateConfig = (type) => TEMPLATE_CONFIG[type] || TEMPLATE_CONFIG.equip;

const fitFontSize = (font, text, maxWidth, preferredSize, minSize = 20) => {
  let size = preferredSize;
  while (size > minSize && font.widthOfTextAtSize(text, size) > maxWidth) {
    size -= 1;
  }
  return size;
};

const buildCertificateFileName = (teacherName, certificateType) => {
  const safeName = String(teacherName || 'teacher')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'teacher';
  return `${safeName}-${certificateType}-certificate.pdf`;
};

const generateCertificatePdf = async ({ submission, teacherName }) => {
  const certificateType = resolveCertificateType(submission);
  const template = getCertificateTemplateConfig(certificateType);
  const templatePath = path.join(CERTIFICATE_TEMPLATES_DIR, template.fileName);
  const templateBytes = await fs.readFile(templatePath);
  const pdfDoc = await PDFDocument.load(templateBytes);
  const page = pdfDoc.getPage(0);
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const displayName = String(teacherName || submission?.teacherName || 'Participant').trim();
  const pageWidth = page.getWidth();

  const maxTextWidth = 560;
  const fontSize = fitFontSize(font, displayName, maxTextWidth, 40, 24);
  const textWidth = font.widthOfTextAtSize(displayName, fontSize);
  const x = (pageWidth - textWidth) / 2;

  page.drawRectangle({
    x: 230,
    y: 326,
    width: 450,
    height: 70,
    color: rgb(1, 1, 1),
    opacity: 1
  });

  page.drawText(displayName, {
    x,
    y: 350,
    size: fontSize,
    font,
    color: rgb(0.05, 0.05, 0.05)
  });

  const pdfBytes = await pdfDoc.save();
  return {
    pdfBytes: Buffer.from(pdfBytes),
    certificateType,
    templateLabel: template.label,
    fileName: buildCertificateFileName(displayName, certificateType)
  };
};

module.exports = {
  resolveCertificateType,
  generateCertificatePdf,
  getCertificateTemplateConfig
};
