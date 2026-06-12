const fs = require('fs/promises');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const CERTIFICATE_TEMPLATES_DIR = path.join(__dirname, '..', 'assets', 'certificates');

const TEMPLATE_CONFIG = {
  boostEnglish: {
    fileName: 'boost-english-certificate.pdf',
    label: 'BOOST - English',
    eraseSample: false
  },
  boostKufaraguaZana: {
    fileName: 'boost-kufaragua-zana-certificate.pdf',
    label: 'BOOST - Kufaragua Zana',
    eraseSample: false
  },
  boostKusoma: {
    fileName: 'boost-kusoma-certificate.pdf',
    label: 'BOOST - Kusoma',
    eraseSample: false
  },
  educateBusiness: {
    fileName: 'educate-business-certificate.pdf',
    label: 'EDUCATE! - Business',
    eraseSample: false
  },
  sequipComputer: {
    fileName: 'sequip-computer-certificate.pdf',
    label: 'SEQUIP - Computer Science',
    eraseSample: false
  },
  sequipMath: {
    fileName: 'sequip-math-certificate.pdf',
    label: 'SEQUIP - Mathematics',
    eraseSample: false
  },
  sequipPhysics: {
    fileName: 'sequip-physics-certificate.pdf',
    label: 'SEQUIP - Physics',
    eraseSample: false
  }
};

const normalizeText = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/\s+/g, ' ');

const includesAny = (value, keywords) => {
  const normalized = normalizeText(value);
  return keywords.some((keyword) => normalized.includes(keyword));
};

const getCertificateMatchingText = (submission) => ([
  submission?.areaOfFocus,
  submission?.subject,
  submission?.category,
  submission?.class
].map(normalizeText).filter(Boolean).join(' | ')
);

const resolveCertificateType = (submission) => {
  const text = getCertificateMatchingText(submission);
  if (includesAny(text, ['business studies', 'business study', 'business'])) return 'educateBusiness';
  if (includesAny(text, ['computer science', 'computer', 'kompyuta'])) return 'sequipComputer';
  if (includesAny(text, ['mathematics', 'math', 'hisabati'])) return 'sequipMath';
  if (includesAny(text, ['physics', 'fizikia'])) return 'sequipPhysics';
  if (includesAny(text, ['english', 'kiingereza'])) return 'boostEnglish';
  if (includesAny(text, ['ufaraguzi wa zana', 'ufaraguz wa zana', 'ufaraguzi', 'kufaragua zana', 'kufaraguzi zana'])) return 'boostKufaraguaZana';
  if (includesAny(text, ['kusoma', 'reading'])) return 'boostKusoma';
  return 'boostKusoma';
};

const getCertificateTemplateConfig = (type) => TEMPLATE_CONFIG[type] || TEMPLATE_CONFIG.boostKusoma;

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

  if (template.eraseSample !== false) {
    page.drawRectangle({
      x: 230,
      y: 326,
      width: 450,
      height: 70,
      color: rgb(1, 1, 1),
      opacity: 1
    });
  }

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
