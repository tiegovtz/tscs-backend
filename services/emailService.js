const nodemailer = require('nodemailer');
const https = require('https');
const { randomUUID } = require('crypto');
const EmailLog = require('../models/EmailLog');
const smsService = require('./smsService');

const escapeHTML = (value) => String(value || '').replace(/[&<>'"]/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  "'": '&#39;',
  '"': '&quot;'
})[character]);

const findDivByClass = (html, className) => {
  const divTags = /<\/?div\b[^>]*>/gi;
  let tagMatch;

  while ((tagMatch = divTags.exec(html))) {
    if (/^<\//.test(tagMatch[0])) continue;
    const classes = tagMatch[0].match(/\bclass\s*=\s*["']([^"']+)["']/i)?.[1]?.split(/\s+/) || [];
    if (!classes.includes(className)) continue;

    let depth = 1;
    let nestedMatch;
    while ((nestedMatch = divTags.exec(html))) {
      if (/^<\//.test(nestedMatch[0])) depth -= 1;
      else if (!/\/\s*>$/.test(nestedMatch[0])) depth += 1;
      if (depth === 0) {
        const end = nestedMatch.index + nestedMatch[0].length;
        return {
          start: tagMatch.index,
          end,
          inner: html.slice(tagMatch.index + tagMatch[0].length, nestedMatch.index)
        };
      }
    }
    return null;
  }

  return null;
};

const unwrapDivClass = (html, className) => {
  const block = findDivByClass(html, className);
  return block ? `${html.slice(0, block.start)}${block.inner}${html.slice(block.end)}` : html;
};

const removeDivClass = (html, className) => {
  let output = html;
  let block = findDivByClass(output, className);
  while (block) {
    output = `${output.slice(0, block.start)}${output.slice(block.end)}`;
    block = findDivByClass(output, className);
  }
  return output;
};

const getEmailAssetBaseUrl = () => (
  process.env.EMAIL_PUBLIC_BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  process.env.CLIENT_URL ||
  ''
).replace(/\/$/, '');

/**
 * Email Service
 *
 * Handles email sending through an SMTP server using Nodemailer
 * - Asynchronous, non-blocking email sending
 * - Comprehensive email logging
 * - Template support
 * - Error handling and retries
 */
class EmailService {
  constructor() {
    this.transporter = null;
    this.easymailApiUrl = null;
    this.easymailApiKey = null;
    this.senderEmail = null;
    this.senderName = process.env.SMTP_FROM_NAME || process.env.EMAIL_FROM_NAME || 'TSCS';
    this.brevoApiKey = null;
    this.brevoSenderEmail = null;
    this.brevoSenderName = null;
    this.isInitialized = false;
  }

  getDailyEmailHero() {
    const weekday = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      timeZone: 'Africa/Dar_es_Salaam'
    }).format(new Date()).toLowerCase();
    const publicBaseUrl = getEmailAssetBaseUrl();

    return {
      weekday,
      imageUrl: publicBaseUrl ? `${publicBaseUrl}/email-assets/${weekday}.jpg` : null
    };
  }

  extractEmailMainContent(html) {
    const body = String(html).match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] || String(html);
    let content = unwrapDivClass(body, 'container');
    content = unwrapDivClass(content, 'email-wrapper');
    content = removeDivClass(content, 'footer');
    ['warning-icon', 'admin-icon', 'critical-icon', 'success-icon', 'notification-icon'].forEach((className) => {
      content = removeDivClass(content, className);
    });
    return content.trim();
  }

  applyEmailBrandLayout(html, type) {
    if (!html || html.includes('data-tscs-email-layout')) return html;

    const { weekday, imageUrl } = this.getDailyEmailHero();
    const year = new Date().getFullYear();
    const assetBaseUrl = getEmailAssetBaseUrl();
    const baseUrl = (process.env.CLIENT_URL || assetBaseUrl).replace(/\/$/, '');
    const ctaLabels = {
      submission_successful: 'View your dashboard',
      submission_promoted: 'View your dashboard',
      submission_eliminated: 'View your results',
      submission_disqualified: 'Review your submission',
      evaluation_reminder: 'Continue evaluation',
      evaluation_pending: 'Review pending evaluations',
      judge_assigned: 'View assigned submission',
      admin_notification: 'Open admin dashboard',
      system_critical: 'Open admin dashboard'
    };
    const ctaLabel = ctaLabels[type];
    const cta = ctaLabel && baseUrl
      ? `<tr><td align="center" style="padding:8px 24px 28px;"><a class="tscs-email-cta" href="${baseUrl}/login" style="display:inline-block;padding:14px 24px;border-radius:8px;background:#54afe4;color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:700;line-height:1.2;text-decoration:none;">${ctaLabel}</a></td></tr>`
      : '';
    const logoUrl = assetBaseUrl ? `${assetBaseUrl}/email-assets/tielogo.png` : null;
    const brand = logoUrl
      ? `<tr><td class="tscs-email-brand" style="padding:14px 28px;background:#ffffff;border-bottom:1px solid #e2e8f0;"><img src="${logoUrl}" width="42" height="52" alt="TIE" style="display:block;width:42px;height:52px;object-fit:contain;border:0;background:#ffffff;" /></td></tr>`
      : `<tr><td height="8" class="tscs-email-brand" style="height:8px;background:#ffffff;border-bottom:1px solid #e2e8f0;font-size:0;line-height:0;">&nbsp;</td></tr>`;
    const hero = imageUrl
      ? `<tr><td style="padding:0;"><img src="${imageUrl}" width="680" alt="A TSCS classroom moment for ${weekday}" style="display:block;width:100%;max-width:680px;height:auto;border:0;" /></td></tr>`
      : `<tr><td height="12" style="height:12px;background:#54afe4;font-size:0;line-height:0;">&nbsp;</td></tr>`;
    const header = `<table class="tscs-email-canvas" data-tscs-email-layout="true" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#eef3f7;"><tr><td class="tscs-email-canvas-cell" align="center" style="padding:24px 12px;background:#eef3f7;"><table class="tscs-email-frame" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:680px;border-collapse:separate;border-spacing:0;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">${brand}${hero}<tr><td class="tscs-email-body" style="padding:0 10px;vertical-align:top;background:#ffffff;color:#1f2937;">`;
    const footer = `</td></tr>${cta}<tr><td class="tscs-email-signoff" style="padding:0 28px 24px;background:#ffffff;color:#475569;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;">Regards,<br /><strong style="color:#102b40;">The TSCS Team</strong></td></tr><tr><td class="tscs-email-footer" style="padding:17px 24px;background:#f6f8fa;border-top:1px solid #e2e8f0;color:#64748b;font-family:Arial,sans-serif;font-size:12px;line-height:1.5;text-align:center;">© ${year} Teaching Skills Competition System. All rights reserved.</td></tr></table></td></tr></table>`;
    const layoutStyles = `
      <style data-tscs-email-layout="true">
        :root { color-scheme: light dark; supported-color-schemes: light dark; }
        body { margin: 0 !important; padding: 0 !important; background: #eef3f7 !important; }
        table { border-collapse: collapse; }
        img { max-width: 100%; }
        .tscs-email-frame, .tscs-email-body, .tscs-email-signoff { background-color: #ffffff !important; color: #1f2937 !important; }
        .tscs-email-brand { background-color: #ffffff !important; color: #102b40 !important; border-bottom: 1px solid #e2e8f0; }
        .tscs-email-brand a { color: #475569 !important; }
        .tscs-email-footer { background-color: #f6f8fa !important; color: #64748b !important; }
        .tscs-email-cta { background-color: #54afe4 !important; color: #ffffff !important; }
        .tscs-email-copy { padding: 34px 36px 18px; font-family: Arial, sans-serif; font-size: 16px; line-height: 1.65; }
        .tscs-email-copy .header { margin: 0 0 24px; color: #1f2937; text-align: left; }
        .tscs-email-copy h1 { margin: 0 0 12px; color: #102b40; font-size: 28px; line-height: 1.25; }
        .tscs-email-copy h2 { margin: 24px 0 10px; color: #102b40; font-size: 20px; line-height: 1.35; }
        .tscs-email-copy h3 { color: #102b40; font-size: 17px; }
        .tscs-email-copy p { margin: 0 0 16px; color: #334155; }
        .tscs-email-copy a { color: #2676a3; }
        .tscs-email-copy .otp-code { margin: 24px 0; padding: 18px; border: 2px dashed #54afe4; border-radius: 10px; background: #f1f8fc; color: #102b40; font-size: 32px; font-weight: 700; letter-spacing: 8px; text-align: center; }
        .tscs-email-copy .warning, .tscs-email-copy .message, .tscs-email-copy .metadata,
        .tscs-email-copy .content, .tscs-email-copy .deadline, .tscs-email-copy .results-box,
        .tscs-email-copy .reason-box, .tscs-email-copy .details-box, .tscs-email-copy .instructions {
          margin: 18px 0;
          padding: 16px 18px;
          border: 1px solid #dce6ee;
          border-radius: 10px;
          background: #f6f9fb;
          color: #334155;
        }
        .tscs-email-copy .severity { display: inline-block; padding: 7px 14px; border-radius: 20px; background: #b42318; color: #ffffff; font-size: 12px; font-weight: 700; text-transform: uppercase; }

        @media only screen and (max-width: 600px) {
          .tscs-email-canvas-cell { padding: 0 !important; }
          .tscs-email-frame { border-radius: 0 !important; }
          .tscs-email-body { padding: 0 !important; }
          .tscs-email-copy { padding: 28px 22px 14px !important; font-size: 15px !important; }
          .tscs-email-body .container, .tscs-email-body .email-wrapper {
            box-sizing: border-box !important;
            width: 100% !important;
            max-width: 100% !important;
            margin: 0 !important;
            padding: 24px 20px !important;
            border-radius: 0 !important;
            box-shadow: none !important;
          }
        }

        @media (prefers-color-scheme: dark) {
          body, .tscs-email-canvas, .tscs-email-canvas-cell {
            background-color: #101820 !important;
            color: #e8edf4 !important;
          }
          .tscs-email-frame { background-color: #151c24 !important; border-color: #2b3642 !important; }
          .tscs-email-brand { background-color: #111820 !important; color: #f5f8fb !important; border-color: #2b3642 !important; }
          .tscs-email-brand a { color: #cbd5df !important; }
          .tscs-email-body, .tscs-email-body .container, .tscs-email-body .email-wrapper,
          .tscs-email-body .content, .tscs-email-body .warning, .tscs-email-body .results-box,
          .tscs-email-body .reason-box, .tscs-email-body .deadline, .tscs-email-body .assignment-section,
          .tscs-email-body .instructions, .tscs-email-body [style*="background:#fff"],
          .tscs-email-body [style*="background: white"] {
            background-color: #151c24 !important;
            border-color: #2b3642 !important;
            color: #e8edf4 !important;
            box-shadow: none !important;
          }
          .tscs-email-body p, .tscs-email-body h1, .tscs-email-body h2, .tscs-email-body h3,
          .tscs-email-body li, .tscs-email-body .greeting { color: #e8edf4 !important; }
          .tscs-email-copy .header, .tscs-email-copy h1, .tscs-email-copy h2, .tscs-email-copy h3,
          .tscs-email-copy p { color: #e8edf4 !important; }
          .tscs-email-body a { color: #7bc4ed !important; }
          .tscs-email-body .otp-code, .tscs-email-body .message, .tscs-email-body .metadata,
          .tscs-email-body .details-box {
            background-color: #202a35 !important;
            border-color: #3a4856 !important;
            color: #e8edf4 !important;
          }
          .tscs-email-copy .otp-code, .tscs-email-copy .warning, .tscs-email-copy .message,
          .tscs-email-copy .metadata, .tscs-email-copy .content, .tscs-email-copy .deadline,
          .tscs-email-copy .results-box, .tscs-email-copy .reason-box, .tscs-email-copy .details-box,
          .tscs-email-copy .instructions { background-color: #202a35 !important; border-color: #3a4856 !important; color: #e8edf4 !important; }
          .tscs-email-body .footer { border-color: #2b3642 !important; color: #aab6c2 !important; }
          .tscs-email-signoff { background-color: #151c24 !important; color: #cbd5df !important; }
          .tscs-email-signoff strong { color: #f5f8fb !important; }
          .tscs-email-footer { background-color: #111820 !important; border-color: #2b3642 !important; color: #aab6c2 !important; }
        }

        [data-ogsc] .tscs-email-frame, [data-ogsc] .tscs-email-body, [data-ogsc] .tscs-email-signoff {
          background-color: #151c24 !important;
          color: #e8edf4 !important;
        }
        [data-ogsc] .tscs-email-footer { background-color: #111820 !important; color: #aab6c2 !important; }
      </style>`;

    const content = this.extractEmailMainContent(html);
    let output = String(html).replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
    output = output.replace(
      /<body\b[^>]*>[\s\S]*?<\/body>/i,
      `<body style="margin:0;padding:0;background:#eef3f7;">${header}<div class="tscs-email-copy">${content}</div>${footer}</body>`
    );
    if (output === html) return html;
    output = output.replace(/<\/head>/i, `<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">${layoutStyles}</head>`);
    return output;
  }

  appendEmailTextFooter(text) {
    if (!text || text.includes('All rights reserved.')) return text;
    const year = new Date().getFullYear();
    return `${String(text).trim()}\n\nRegards,\nThe TSCS Team\n\n© ${year} Teaching Skills Competition System. All rights reserved.`;
  }

  /**
   * Initialize Nodemailer SMTP transport
   */
  initialize() {
    if (this.isInitialized) return;

    if (process.env.NODE_ENV === 'development') {
      console.log('Initializing email service...');
    }

    try {
      const smtpUser = process.env.SMTP_USER || process.env.GMAIL_USER;
      const smtpPass = process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD;
      const smtpHost = process.env.SMTP_HOST || (process.env.GMAIL_USER ? 'smtp.gmail.com' : null);
      const smtpPort = Number(process.env.SMTP_PORT || 587);
      const smtpEnabled = process.env.SMTP_ENABLED !== 'false';
      this.easymailApiUrl = (process.env.EASYMAIL_API_URL || 'https://easymail-nu.vercel.app/api/v1/emails').replace(/\/$/, '');
      this.easymailApiKey = process.env.EASYMAIL_API_KEY || null;
      this.brevoApiKey = process.env.BREVO_API_KEY || null;
      this.brevoSenderEmail = process.env.BREVO_SENDER_EMAIL || null;
      this.brevoSenderName = process.env.BREVO_SENDER_NAME || process.env.EMAIL_FROM_NAME || 'TSCS';

      if (smtpEnabled && smtpHost && smtpUser && smtpPass) {
        this.senderEmail = process.env.SMTP_FROM_EMAIL || smtpUser;
        this.senderName = process.env.SMTP_FROM_NAME || process.env.EMAIL_FROM_NAME || 'TSCS';
        this.transporter = nodemailer.createTransport({
          host: smtpHost,
          port: smtpPort,
          secure: process.env.SMTP_SECURE === 'true' || smtpPort === 465,
          auth: {
            user: smtpUser,
            pass: smtpPass
          },
          connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 10000),
          greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 10000),
          socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 20000)
        });
      }

      this.isInitialized = Boolean(
        this.easymailApiKey || this.transporter || (this.brevoApiKey && this.brevoSenderEmail)
      );

      if (!this.isInitialized) {
        console.error('Email configuration incomplete: configure SMTP or the HTTPS email fallback');
        return;
      }

      console.log(`Email service initialized with ${this.easymailApiKey ? 'Easymail' : this.transporter ? 'SMTP' : 'HTTPS fallback'}.`);
    } catch (error) {
      console.error('Email service initialization failed:', error.message);
      this.isInitialized = false;
    }
  }

  /**
   * Send email asynchronously
   * @param {Object} options - Email options
   * @param {string} options.to - Recipient email
   * @param {string} options.subject - Email subject
   * @param {string} options.html - HTML content
   * @param {string} options.text - Plain text fallback
   * @param {string} options.type - Email type for logging
   * @param {Object} options.metadata - Additional metadata
   * @returns {Promise<boolean>} Success status
   */
  async sendEmail(options) {
    if (!this.isInitialized) {
      this.initialize();
    }

    const canUseEasymail = Boolean(this.easymailApiKey && this.easymailApiUrl);
    const canUseSMTP = Boolean(this.transporter && this.senderEmail);
    const canUseFallback = Boolean(this.brevoApiKey && this.brevoSenderEmail);
    const canSendEmail = canUseEasymail || canUseSMTP || canUseFallback;
    if (!canSendEmail) {
      console.error('Email configuration is incomplete');
    }

    options.html = this.applyEmailBrandLayout(options.html, options.type);
    options.text = this.appendEmailTextFooter(options.text);

    let logEntry = null;
    let emailSent = false;

    if (canSendEmail) {
      // Create log entry first
      if (EmailLog.db.readyState === 1) {
        logEntry = await EmailLog.logEmail({
          email: options.to,
          type: options.type || 'system_notification',
          subject: options.subject,
          status: 'pending',
          metadata: options.metadata || {}
        });
      }

      try {
        let providerResponse;
        if (canUseEasymail) {
          const info = await this.sendEasymailRequest({
            to: options.to,
            subject: options.subject,
            html: options.html,
            text: options.text || undefined
          });
          providerResponse = info.messageId || info.id || 'Easymail accepted';
        } else if (canUseSMTP) {
          try {
            const info = await this.transporter.sendMail({
              from: { name: this.senderName, address: this.senderEmail },
              to: options.to,
              subject: options.subject,
              html: options.html,
              text: options.text || undefined
            });
            providerResponse = info.response || info.messageId || 'SMTP accepted';
          } catch (smtpError) {
            if (!canUseFallback) throw smtpError;
            console.warn('SMTP delivery unavailable; using configured HTTPS email fallback.');
          }
        }

        if (!providerResponse) {
          const info = await this.sendBrevoRequest('/v3/smtp/email', 'POST', {
            sender: { name: this.brevoSenderName, email: this.brevoSenderEmail },
            to: [{ email: options.to }],
            subject: options.subject,
            htmlContent: options.html,
            textContent: options.text || undefined
          });
          providerResponse = info.messageId || 'HTTPS email provider accepted';
        }

        // Update log on success
        if (logEntry) {
          await EmailLog.updateStatus(logEntry._id, 'sent', null, providerResponse);
        }

        if (process.env.NODE_ENV === 'development') {
          console.log(`Email sent to ${options.to}`);
        }
        emailSent = true;
      } catch (error) {
        const errorMessage = error.response || error.message;

        if (logEntry) {
          await EmailLog.updateStatus(logEntry._id, 'failed', errorMessage);
        }

        console.error(`Email sending failed to ${options.to}:`, errorMessage);
      }
    }

    if (options.phone && options.smsText) {
      const smsResult = await smsService.sendSMS(options.phone, options.smsText);
      if (!smsResult.success) {
        console.error(`SMS sending failed to ${options.phone}:`, smsResult.message);
      } else if (process.env.NODE_ENV === 'development') {
        console.log(`SMS sent to ${options.phone}`);
      }
    }

    return emailSent;
  }

  /**
   * Send OTP verification email
   * @param {string} email - Recipient email
   * @param {string} otp - OTP code
   * @param {string} userName - User name
   * @returns {Promise<boolean>} Success status
   */
  async sendOTPVerification(email, otp, userName, phone = null) {
    const subject = 'Verify Your TSCS Account';
    const html = this.generateOTPHTML(otp, userName);
    const text = this.generateOTPText(otp, userName);

    return await this.sendEmail({
      to: email,
      subject,
      html,
      text,
      type: 'email_verification_otp',
      phone,
      smsText: `TSCS verification code: ${otp}. Expires in 10 minutes.`
    });
  }

  /**
   * Send a privileged-login MFA code.
   */
  async sendMFAOTP(email, otp, userName) {
    return await this.sendEmail({
      to: email,
      subject: 'Your TSCS login authentication code',
      html: this.generateMFAOTPHTML(otp, userName),
      text: this.generateMFAOTPText(otp, userName),
      type: 'login_mfa_otp',
      metadata: { purpose: 'privileged_login_mfa' }
    });
  }

  /**
   * Send password reset OTP email
   * @param {string} email - Recipient email
   * @param {string} otp - OTP code
   * @param {string} userName - User name
   * @returns {Promise<boolean>} Success status
   */
  async sendPasswordResetOTP(email, otp, userName, phone = null) {
    const subject = 'Password Reset - TSCS';
    const html = this.generatePasswordResetOTPHTML(otp, userName);
    const text = this.generatePasswordResetOTPText(otp, userName);

    return await this.sendEmail({
      to: email,
      subject,
      html,
      text,
      type: 'password_reset_otp',
      phone,
      smsText: `TSCS password reset code: ${otp}. Expires in 10 minutes.`
    });
  }

  /**
   * Send system notification email
   * @param {string} email - Recipient email
   * @param {string} subject - Email subject
   * @param {string} message - Notification message
   * @param {string} userName - User name
   * @param {Object} metadata - Additional metadata
   * @returns {Promise<boolean>} Success status
   */
  async sendSystemNotification(email, subject, message, userName, metadata = {}, phone = null) {
    const html = this.generateSystemNotificationHTML(message, userName, metadata);
    const text = this.generateSystemNotificationText(message, userName, metadata);

    return await this.sendEmail({
      to: email,
      subject,
      html,
      text,
      type: 'system_notification',
      metadata,
      phone,
      smsText: `TSCS: ${subject}. ${message}`
    });
  }

  /**
   * Send submission successful email (Teacher)
   * @param {string} email - Recipient email
   * @param {string} userName - User name
   * @param {Object} metadata - Submission metadata
   * @returns {Promise<boolean>} Success status
   */
  async sendSubmissionSuccessfulEmail(email, userName, metadata, phone = null) {
    const { roundName, subject, submissionId } = metadata;
    const subjectLine = `Submission Received - ${roundName}`;
    const html = this.generateSubmissionSuccessfulHTML(userName, metadata);
    const text = this.generateSubmissionSuccessfulText(userName, metadata);

    return await this.sendEmail({
      to: email,
      subject: subjectLine,
      html,
      text,
      type: 'submission_successful',
      metadata: { submissionId, roundName, subject },
      phone,
      smsText: `TSCS: Submission received for ${roundName}. Subject: ${subject}.`
    });
  }

  /**
   * Send submission result email (Teacher)
   * @param {string} email - Recipient email
   * @param {string} userName - User name
   * @param {string} result - 'promoted' or 'eliminated'
   * @param {Object} metadata - Submission metadata
   * @returns {Promise<boolean>} Success status
   */
  async sendSubmissionResultEmail(email, userName, result, metadata, phone = null) {
    const { roundName, nextRound, rank, averageScore, totalSubmissions } = metadata;
    const subjectLine = result === 'promoted'
      ? `Congratulations! Submission Promoted - ${roundName}`
      : `Submission Results - ${roundName}`;

    const html = this.generateSubmissionResultHTML(userName, result, metadata);
    const text = this.generateSubmissionResultText(userName, result, metadata);

    return await this.sendEmail({
      to: email,
      subject: subjectLine,
      html,
      text,
      type: `submission_${result}`,
      metadata: { roundName, result, nextRound, rank, averageScore, totalSubmissions },
      phone,
      smsText: result === 'promoted'
        ? `TSCS: Congratulations. Your submission was promoted from ${roundName}.`
        : `TSCS: Your submission result for ${roundName} is available.`
    });
  }

  /**
   * Send disqualification email (Teacher)
   * @param {string} email - Recipient email
   * @param {string} userName - User name
   * @param {Object} metadata - Disqualification metadata
   * @returns {Promise<boolean>} Success status
   */
  async sendSubmissionDisqualifiedEmail(email, userName, metadata, phone = null) {
    const { roundName, reason, subject, category, areaOfFocus } = metadata;
    const subjectLine = `Submission Disqualified - ${roundName || 'Current Round'}`;
    const html = this.generateSubmissionDisqualifiedHTML(userName, metadata);
    const text = this.generateSubmissionDisqualifiedText(userName, metadata);

    return await this.sendEmail({
      to: email,
      subject: subjectLine,
      html,
      text,
      type: 'submission_disqualified',
      metadata: { roundName, reason, subject, category, areaOfFocus },
      phone,
      smsText: `TSCS: Your submission has been disqualified. Reason: ${reason || 'Not provided'}.`
    });
  }

  /**
   * Send evaluation reminder email (Judge)
   * @param {string} email - Recipient email
   * @param {string} userName - User name
   * @param {Object} metadata - Evaluation metadata
   * @returns {Promise<boolean>} Success status
   */
  async sendEvaluationReminderEmail(email, userName, metadata, phone = null) {
    const { roundName, deadline, hoursLeft } = metadata;
    const subjectLine = `Evaluation Reminder - ${hoursLeft} Hours Remaining`;
    const html = this.generateEvaluationReminderHTML(userName, metadata);
    const text = this.generateEvaluationReminderText(userName, metadata);

    return await this.sendEmail({
      to: email,
      subject: subjectLine,
      html,
      text,
      type: 'evaluation_reminder',
      metadata: { roundName, deadline, hoursLeft },
      phone,
      smsText: `TSCS reminder: ${hoursLeft} hours left to complete evaluations for ${roundName}.`
    });
  }

  /**
   * Send evaluation pending email (Judge)
   * @param {string} email - Recipient email
   * @param {string} userName - User name
   * @param {Object} metadata - Evaluation metadata
   * @returns {Promise<boolean>} Success status
   */
  async sendEvaluationPendingEmail(email, userName, metadata, phone = null) {
    const { roundName, submissionCount, deadline } = metadata;
    const subjectLine = `New Evaluations Available - ${roundName}`;
    const html = this.generateEvaluationPendingHTML(userName, metadata);
    const text = this.generateEvaluationPendingText(userName, metadata);

    return await this.sendEmail({
      to: email,
      subject: subjectLine,
      html,
      text,
      type: 'evaluation_pending',
      metadata: { roundName, submissionCount, deadline },
      phone,
      smsText: `TSCS: New evaluations available for ${roundName}. Submissions: ${submissionCount}.`
    });
  }

  /**
   * Send judge assignment email (Judge)
   * @param {string} email - Recipient email
   * @param {string} userName - User name
   * @param {Object} metadata - Assignment metadata
   *   For submission assignment: { submissionId, teacherName, subject, areaOfFocus, level, region, council }
   *   For round assignment (legacy): { roundName, level }
   * @returns {Promise<boolean>} Success status
   */
  async sendJudgeAssignmentEmail(email, userName, metadata, phone = null) {
    // Check if this is a submission assignment (new format) or round assignment (legacy)
    const isSubmissionAssignment = metadata.submissionId !== undefined;
    
    let subjectLine;
    if (isSubmissionAssignment) {
      const { level, region, council } = metadata;
      const location = level === 'Council' ? `${region} - ${council}` : region;
      subjectLine = `Submission Assignment - ${level} Level (${location})`;
    } else {
      const { roundName } = metadata;
      subjectLine = `Judge Assignment - ${roundName}`;
    }
    
    const html = this.generateJudgeAssignmentHTML(userName, metadata);
    const text = this.generateJudgeAssignmentText(userName, metadata);

    return await this.sendEmail({
      to: email,
      subject: subjectLine,
      html,
      text,
      type: 'judge_assigned',
      metadata,
      phone,
      smsText: `TSCS: You have a new judge assignment. ${subjectLine}.`
    });
  }

  /**
   * Send admin notification email
   * @param {string} email - Recipient email
   * @param {string} userName - User name
   * @param {string} title - Notification title
   * @param {string} message - Notification message
   * @param {Object} metadata - Additional metadata
   * @returns {Promise<boolean>} Success status
   */
  async sendAdminNotificationEmail(email, userName, title, message, metadata, phone = null) {
    const html = this.generateAdminNotificationHTML(userName, title, message, metadata);
    const text = this.generateAdminNotificationText(userName, title, message, metadata);

    return await this.sendEmail({
      to: email,
      subject: title,
      html,
      text,
      type: 'admin_notification',
      metadata,
      phone,
      smsText: `TSCS admin notice: ${title}. ${message}`
    });
  }

  /**
   * Send system critical email (Admin)
   * @param {string} email - Recipient email
   * @param {string} userName - User name
   * @param {string} title - Critical issue title
   * @param {string} message - Critical issue message
   * @param {Object} metadata - Additional metadata
   * @returns {Promise<boolean>} Success status
   */
  async sendSystemCriticalEmail(email, userName, title, message, metadata, phone = null) {
    const html = this.generateSystemCriticalHTML(userName, title, message, metadata);
    const text = this.generateSystemCriticalText(userName, title, message, metadata);

    return await this.sendEmail({
      to: email,
      subject: title,
      html,
      text,
      type: 'system_critical',
      metadata,
      phone,
      smsText: `TSCS critical alert: ${title}. ${message}`
    });
  }

  /**
   * Generate OTP verification HTML template
   * @param {string} otp - OTP code
   * @param {string} userName - User name
   * @returns {string} HTML content
   */
  generateOTPHTML(otp, userName) {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Verify Your TSCS Account</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
          .header { text-align: center; margin-bottom: 30px; }
          .otp-code { font-size: 32px; font-weight: bold; color: #2c5aa0; text-align: center; margin: 30px 0; padding: 20px; background: #f8f9fa; border: 2px dashed #2c5aa0; border-radius: 8px; letter-spacing: 5px; }
          .warning { background: #fff3cd; border: 1px solid #ffeaa7; color: #856404; padding: 15px; border-radius: 5px; margin: 20px 0; }
          .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #666; font-size: 14px; }
          .support { margin-top: 15px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Welcome to TSCS!</h1>
            <p>Hi ${userName}, please verify your email address to complete your registration.</p>
          </div>

          <p>Your verification code is:</p>

          <div class="otp-code">${otp}</div>

          <div class="warning">
            <strong>Important:</strong> This code will expire in 10 minutes. Do not share this code with anyone.
          </div>

          <p>If you didn't request this verification, please ignore this email.</p>

          <div class="footer">
            <p><strong>Teacher Submission Competition System (TSCS)</strong></p>
            <p>This verification code was sent to complete your account setup.</p>
            <div class="support">
              <p>Need help? Contact our support team.</p>
            </div>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Generate OTP verification text template
   * @param {string} otp - OTP code
   * @param {string} userName - User name
   * @returns {string} Text content
   */
  generateOTPText(otp, userName) {
    return `
TSCS - Email Verification

Hi ${userName},

Welcome to the Teacher Submission Competition System!

Your verification code is: ${otp}

This code will expire in 10 minutes. Please use it to complete your account verification.

If you didn't request this verification, please ignore this email.

---
Teacher Submission Competition System (TSCS)
This verification code was sent to complete your account setup.
    `.trim();
  }

  generateMFAOTPHTML(otp, userName) {
    const safeUserName = escapeHTML(userName || 'TSCS user');
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>TSCS Login Authentication Code</title>
      </head>
      <body style="margin:0;padding:24px;background:#f4f6f8;font-family:Arial,sans-serif;color:#1f2937;">
        <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;border:1px solid #e5e7eb;">
          <h1 style="margin:0 0 12px;font-size:24px;color:#173b57;">Confirm your TSCS login</h1>
          <p>Hello ${safeUserName},</p>
          <p>Use this one-time code to complete your administrator login:</p>
          <div style="font-size:34px;font-weight:700;letter-spacing:8px;text-align:center;padding:18px;margin:24px 0;background:#eef6fb;border:1px dashed #2676a3;border-radius:8px;color:#173b57;">${otp}</div>
          <p style="font-size:14px;color:#4b5563;">The code expires in 10 minutes and can only be used once. TSCS staff will never ask you to share it.</p>
          <p style="font-size:14px;color:#b42318;">If you did not attempt to sign in, change your password and contact the system administrator immediately.</p>
        </div>
      </body>
      </html>
    `;
  }

  generateMFAOTPText(otp, userName) {
    return `TSCS login authentication\n\nHello ${userName || 'TSCS user'},\n\nYour one-time login code is: ${otp}\n\nThis code expires in 10 minutes and can only be used once. Do not share it.\n\nIf you did not attempt to sign in, change your password and contact the system administrator immediately.`;
  }

  /**
   * Generate system notification HTML template
   * @param {string} message - Notification message
   * @param {string} userName - User name
   * @param {Object} metadata - Additional data
   * @returns {string} HTML content
   */
  generateSystemNotificationHTML(message, userName, metadata = {}) {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>TSCS Notification</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
          .header { text-align: center; margin-bottom: 30px; color: #2c5aa0; }
          .message { background: #f8f9fa; padding: 20px; border-radius: 8px; border-left: 4px solid #2c5aa0; margin: 20px 0; }
          .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #666; font-size: 14px; }
          .metadata { background: #e9ecef; padding: 15px; border-radius: 5px; margin: 15px 0; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>TSCS Notification</h1>
            <p>Hello ${userName},</p>
          </div>

          <div class="message">
            ${message.replace(/\n/g, '<br>')}
          </div>

          ${metadata && Object.keys(metadata).length > 0 ? `
          <div class="metadata">
            <strong>Details:</strong><br>
            ${Object.entries(metadata).map(([key, value]) =>
              `${key}: ${value}`
            ).join('<br>')}
          </div>
          ` : ''}

          <div class="footer">
            <p><strong>Teacher Submission Competition System (TSCS)</strong></p>
            <p>You received this notification because you are registered with our system.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Generate system notification text template
   * @param {string} message - Notification message
   * @param {string} userName - User name
   * @param {Object} metadata - Additional data
   * @returns {string} Text content
   */
  generateSystemNotificationText(message, userName, metadata = {}) {
    let text = `
TSCS - System Notification

Hello ${userName},

${message}

---
Teacher Submission Competition System (TSCS)
You received this notification because you are registered with our system.
    `.trim();

    if (metadata && Object.keys(metadata).length > 0) {
      text += '\n\nDetails:\n' +
        Object.entries(metadata).map(([key, value]) => `${key}: ${value}`).join('\n');
    }

    return text;
  }

  /**
   * Generate submission successful HTML template
   * @param {string} userName - User name
   * @param {Object} metadata - Submission metadata
   * @returns {string} HTML content
   */
  generateSubmissionSuccessfulHTML(userName, metadata) {
    const { roundName, subject } = metadata;

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Submission Received - TSCS</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
          .header { text-align: center; margin-bottom: 30px; }
          .success-icon { font-size: 48px; color: #52c41a; margin-bottom: 16px; }
          .content { background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0; }
          .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="success-icon">✅</div>
            <h1>Submission Received Successfully!</h1>
            <p>Hello ${userName},</p>
          </div>

          <div class="content">
            <h3>Your submission has been received and is now under review.</h3>
            <p><strong>Competition:</strong> ${roundName}</p>
            <p><strong>Subject:</strong> ${subject}</p>
            <p>You will receive an email notification once the evaluation process is complete.</p>
          </div>

          <div class="footer">
            <p><strong>Teacher Submission Competition System (TSCS)</strong></p>
            <p>Thank you for your participation!</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Generate submission successful text template
   * @param {string} userName - User name
   * @param {Object} metadata - Submission metadata
   * @returns {string} Text content
   */
  generateSubmissionSuccessfulText(userName, metadata) {
    const { roundName, subject } = metadata;

    return `
TSCS - Submission Received Successfully

Hello ${userName},

Your submission has been received and is now under review.

Competition: ${roundName}
Subject: ${subject}

You will receive an email notification once the evaluation process is complete.

---
Teacher Submission Competition System (TSCS)
Thank you for your participation!
    `.trim();
  }

  /**
   * Generate submission result HTML template
   * @param {string} userName - User name
   * @param {string} result - 'promoted' or 'eliminated'
   * @param {Object} metadata - Submission metadata
   * @returns {string} HTML content
   */
  generateSubmissionResultHTML(userName, result, metadata) {
    const { roundName, nextRound, rank, averageScore, totalSubmissions } = metadata;
    const isPromoted = result === 'promoted';
    const icon = isPromoted ? '🎉' : '📋';
    const color = isPromoted ? '#52c41a' : '#faad14';
    
    // Format score and position
    const scoreText = averageScore ? averageScore.toFixed(2) : '0.00';
    const rankText = rank && rank !== 'N/A' ? `#${rank}` : 'N/A';
    const positionText = totalSubmissions ? `${rankText} out of ${totalSubmissions}` : rankText;
    const statusText = isPromoted ? `Advanced to ${nextRound || 'the next round'}` : 'Did not advance';

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Submission Results - TSCS</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
          .header { text-align: center; margin-bottom: 30px; }
          .result-icon { font-size: 48px; margin-bottom: 16px; }
          .content { background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid ${color}; }
          .results-box { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border: 2px solid ${color}; }
          .result-item { display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #eee; }
          .result-item:last-child { border-bottom: none; }
          .result-label { font-weight: bold; color: #666; }
          .result-value { color: #333; font-size: 16px; }
          .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="result-icon">${icon}</div>
            <h1>${isPromoted ? 'Congratulations!' : 'Round Results'}</h1>
            <p>Hello ${userName},</p>
          </div>

          <div class="content">
            <h3>${roundName} - Results</h3>
            <p>${isPromoted
              ? `Great news! Your submission has been selected to advance to ${nextRound || 'the next round'}.`
              : 'The evaluation period has ended. Unfortunately, your submission was not selected to advance to the next round.'
            }</p>
            
            <div class="results-box">
              <h4 style="margin-top: 0; color: ${color};">📊 Your Results</h4>
              <div class="result-item">
                <span class="result-label">Score:</span>
                <span class="result-value">${scoreText}/10</span>
              </div>
              <div class="result-item">
                <span class="result-label">Position:</span>
                <span class="result-value">${positionText}</span>
              </div>
              <div class="result-item">
                <span class="result-label">Status:</span>
                <span class="result-value" style="color: ${color}; font-weight: bold;">${statusText}</span>
              </div>
            </div>
            
            ${isPromoted
              ? '<p>Keep up the excellent work and continue participating in future competitions!</p>'
              : '<p>Don\'t be discouraged! We encourage you to participate in future competitions and continue developing your teaching skills.</p>'
            }
          </div>

          <div class="footer">
            <p><strong>Teacher Submission Competition System (TSCS)</strong></p>
            <p>${isPromoted ? 'Congratulations on your success!' : 'Thank you for your participation!'}</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Generate submission result text template
   * @param {string} userName - User name
   * @param {Object} metadata - Submission metadata
   * @returns {string} Text content
   */
  generateSubmissionResultText(userName, result, metadata) {
    const { roundName, nextRound, rank, averageScore, totalSubmissions } = metadata;
    const isPromoted = result === 'promoted';
    
    // Format score and position
    const scoreText = averageScore ? averageScore.toFixed(2) : '0.00';
    const rankText = rank && rank !== 'N/A' ? `#${rank}` : 'N/A';
    const positionText = totalSubmissions ? `${rankText} out of ${totalSubmissions}` : rankText;
    const statusText = isPromoted ? `Advanced to ${nextRound || 'the next round'}` : 'Did not advance';

    return `
TSCS - Submission Results

Hello ${userName},

${roundName} - Results

${isPromoted
  ? `Congratulations! Your submission has been selected to advance to ${nextRound || 'the next round'}.`
  : 'The evaluation period has ended. Unfortunately, your submission was not selected to advance to the next round.'
}

📊 Your Results:
• Score: ${scoreText}/10
• Position: ${positionText}
• Status: ${statusText}

${isPromoted
  ? 'Keep up the excellent work and continue participating in future competitions!'
  : 'Don\'t be discouraged! We encourage you to participate in future competitions and continue developing your teaching skills.'
}

---
Teacher Submission Competition System (TSCS)
${isPromoted ? 'Congratulations on your success!' : 'Thank you for your participation!'}
    `.trim();
  }

  /**
   * Generate submission disqualified HTML template
   * @param {string} userName - User name
   * @param {Object} metadata - Disqualification metadata
   * @returns {string} HTML content
   */
  generateSubmissionDisqualifiedHTML(userName, metadata) {
    const {
      roundName = 'Current Round',
      reason = 'No reason was provided.',
      subject = 'N/A',
      category = 'N/A',
      areaOfFocus = 'N/A'
    } = metadata || {};

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Submission Disqualified - TSCS</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
          .header { text-align: center; margin-bottom: 30px; }
          .warning-icon { font-size: 48px; color: #ff4d4f; margin-bottom: 16px; }
          .content { background: #fff1f0; border: 1px solid #ffccc7; padding: 20px; border-radius: 8px; margin: 20px 0; }
          .reason-box { background: #fff; border-left: 4px solid #ff4d4f; padding: 12px; margin-top: 12px; }
          .meta { font-size: 14px; color: #595959; margin-top: 8px; }
          .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="warning-icon">⚠️</div>
            <h1>Submission Disqualified</h1>
            <p>Hello ${userName},</p>
          </div>

          <div class="content">
            <p>Your submission has been marked as <strong>disqualified</strong> in <strong>${roundName}</strong>.</p>
            <div class="meta">
              <div><strong>Subject:</strong> ${subject}</div>
              <div><strong>Category:</strong> ${category}</div>
              <div><strong>Area of Focus:</strong> ${areaOfFocus}</div>
            </div>
            <div class="reason-box">
              <strong>Reason provided by judge:</strong><br />
              ${reason}
            </div>
          </div>

          <div class="footer">
            <p><strong>Teacher Submission Competition System (TSCS)</strong></p>
            <p>If you need clarification, please contact your competition administrator.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Generate submission disqualified text template
   * @param {string} userName - User name
   * @param {Object} metadata - Disqualification metadata
   * @returns {string} Text content
   */
  generateSubmissionDisqualifiedText(userName, metadata) {
    const {
      roundName = 'Current Round',
      reason = 'No reason was provided.',
      subject = 'N/A',
      category = 'N/A',
      areaOfFocus = 'N/A'
    } = metadata || {};

    return `
TSCS - Submission Disqualified

Hello ${userName},

Your submission has been marked as disqualified in ${roundName}.

Subject: ${subject}
Category: ${category}
Area of Focus: ${areaOfFocus}

Reason provided by judge:
${reason}

---
Teacher Submission Competition System (TSCS)
If you need clarification, please contact your competition administrator.
    `.trim();
  }

  /**
   * Generate evaluation reminder HTML template
   * @param {string} userName - User name
   * @param {Object} metadata - Evaluation metadata
   * @returns {string} HTML content
   */
  generateEvaluationReminderHTML(userName, metadata) {
    const { roundName, deadline, hoursLeft } = metadata;

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Evaluation Reminder - TSCS</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
          .header { text-align: center; margin-bottom: 30px; }
          .warning-icon { font-size: 48px; color: #faad14; margin-bottom: 16px; }
          .content { background: #fff3cd; border: 1px solid #ffeaa7; padding: 20px; border-radius: 8px; margin: 20px 0; }
          .deadline { background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0; font-weight: bold; }
          .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="warning-icon">⏰</div>
            <h1>Evaluation Reminder</h1>
            <p>Hello ${userName},</p>
          </div>

          <div class="content">
            <h3>You have pending evaluations that require your attention.</h3>
            <p><strong>Competition:</strong> ${roundName}</p>
            <p><strong>Time Remaining:</strong> ${hoursLeft} hours</p>

            <div class="deadline">
              📅 Deadline: ${deadline}
            </div>

            <p>Please complete your evaluations before the deadline to ensure fair and timely results for all participants.</p>
          </div>

          <div class="footer">
            <p><strong>Teacher Submission Competition System (TSCS)</strong></p>
            <p>Your evaluations are important for the competition's success.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Generate evaluation reminder text template
   * @param {string} userName - User name
   * @param {Object} metadata - Evaluation metadata
   * @returns {string} Text content
   */
  generateEvaluationReminderText(userName, metadata) {
    const { roundName, deadline, hoursLeft } = metadata;

    return `
TSCS - Evaluation Reminder

Hello ${userName},

You have pending evaluations that require your attention.

Competition: ${roundName}
Time Remaining: ${hoursLeft} hours
Deadline: ${deadline}

Please complete your evaluations before the deadline to ensure fair and timely results for all participants.

---
Teacher Submission Competition System (TSCS)
Your evaluations are important for the competition's success.
    `.trim();
  }

  /**
   * Generate evaluation pending HTML template
   * @param {string} userName - User name
   * @param {Object} metadata - Evaluation metadata
   * @returns {string} Text content
   */
  generateEvaluationPendingHTML(userName, metadata) {
    const { roundName, submissionCount, deadline } = metadata;

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>New Evaluations Available - TSCS</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
          .header { text-align: center; margin-bottom: 30px; }
          .notification-icon { font-size: 48px; color: #1890ff; margin-bottom: 16px; }
          .content { background: #e6f7ff; border: 1px solid #91d5ff; padding: 20px; border-radius: 8px; margin: 20px 0; }
          .stats { background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0; }
          .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="notification-icon">📋</div>
            <h1>New Evaluations Available</h1>
            <p>Hello ${userName},</p>
          </div>

          <div class="content">
            <h3>New submissions are ready for your evaluation.</h3>
            <p><strong>Competition:</strong> ${roundName}</p>

            <div class="stats">
              📊 Submissions to evaluate: ${submissionCount}
            </div>

            <p>Please review and evaluate these submissions at your earliest convenience.</p>
            <p><strong>Deadline:</strong> ${deadline}</p>
          </div>

          <div class="footer">
            <p><strong>Teacher Submission Competition System (TSCS)</strong></p>
            <p>Your expert evaluation helps maintain the quality of our competitions.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Generate evaluation pending text template
   * @param {string} userName - User name
   * @param {Object} metadata - Evaluation metadata
   * @returns {string} Text content
   */
  generateEvaluationPendingText(userName, metadata) {
    const { roundName, submissionCount, deadline } = metadata;

    return `
TSCS - New Evaluations Available

Hello ${userName},

New submissions are ready for your evaluation.

Competition: ${roundName}
Submissions to evaluate: ${submissionCount}
Deadline: ${deadline}

Please review and evaluate these submissions at your earliest convenience.

---
Teacher Submission Competition System (TSCS)
Your expert evaluation helps maintain the quality of our competitions.
    `.trim();
  }

  /**
   * Generate judge assignment HTML template
   * @param {string} userName - User name
   * @param {Object} metadata - Assignment metadata
   *   For submission assignment: { submissionId, teacherName, subject, areaOfFocus, level, region, council }
   *   For round assignment (legacy): { roundName, level }
   * @returns {string} HTML content
   */
  generateJudgeAssignmentHTML(userName, metadata) {
    const isSubmissionAssignment = metadata.submissionId !== undefined;
    
    let assignmentDetails, assignmentTitle, assignmentMessage;
    
    if (isSubmissionAssignment) {
      const { level, region, council, subject, teacherName } = metadata;
      const location = level === 'Council' ? `${region} - ${council}` : region;
      assignmentTitle = 'Submission Assignment Notification';
      assignmentMessage = 'A new submission has been assigned to you for evaluation.';
      assignmentDetails = `
        <div class="detail-row">
          <span class="detail-label">Assignment Level:</span>
          <span class="detail-value">${level}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Geographic Location:</span>
          <span class="detail-value">${location}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Subject Area:</span>
          <span class="detail-value">${subject}</span>
        </div>
        ${teacherName ? `
        <div class="detail-row">
          <span class="detail-label">Teacher:</span>
          <span class="detail-value">${teacherName}</span>
        </div>
        ` : ''}
      `;
    } else {
      const { roundName, level } = metadata;
      assignmentTitle = 'Judge Assignment Notification';
      assignmentMessage = 'You have been assigned as a judge for an upcoming competition round.';
      assignmentDetails = `
        <div class="detail-row">
          <span class="detail-label">Competition Round:</span>
          <span class="detail-value">${roundName}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Level:</span>
          <span class="detail-value">${level}</span>
        </div>
      `;
    }

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Judge Assignment - TSCS</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; 
            line-height: 1.6; 
            color: #1a1a1a; 
            background-color: #f5f5f5; 
            padding: 20px;
          }
          .email-wrapper {
            max-width: 680px; 
            margin: 0 auto; 
            background: #ffffff;
          }
          .header {
            background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%);
            color: #ffffff;
            padding: 40px 30px;
            text-align: center;
          }
          .header h1 {
            font-size: 24px;
            font-weight: 600;
            margin-bottom: 8px;
            letter-spacing: 0.5px;
          }
          .header p {
            font-size: 14px;
            opacity: 0.95;
            margin-top: 8px;
          }
          .content {
            padding: 40px 30px;
          }
          .greeting {
            font-size: 16px;
            color: #1a1a1a;
            margin-bottom: 24px;
            font-weight: 500;
          }
          .assignment-section {
            background: #f8f9fa;
            border-left: 4px solid #3b82f6;
            padding: 24px;
            margin: 24px 0;
            border-radius: 4px;
          }
          .assignment-section h2 {
            font-size: 18px;
            font-weight: 600;
            color: #1a1a1a;
            margin-bottom: 12px;
          }
          .assignment-section p {
            font-size: 15px;
            color: #4a5568;
            margin-bottom: 20px;
            line-height: 1.7;
          }
          .details-box {
            background: #ffffff;
            border: 1px solid #e2e8f0;
            border-radius: 4px;
            padding: 20px;
            margin-top: 20px;
          }
          .detail-row {
            display: flex;
            padding: 12px 0;
            border-bottom: 1px solid #e2e8f0;
          }
          .detail-row:last-child {
            border-bottom: none;
          }
          .detail-label {
            font-weight: 600;
            color: #4a5568;
            width: 180px;
            font-size: 14px;
            flex-shrink: 0;
          }
          .detail-value {
            color: #1a1a1a;
            font-size: 14px;
            flex: 1;
          }
          .instructions {
            background: #fff7ed;
            border-left: 4px solid #f59e0b;
            padding: 20px;
            margin: 24px 0;
            border-radius: 4px;
          }
          .instructions h3 {
            font-size: 16px;
            font-weight: 600;
            color: #92400e;
            margin-bottom: 12px;
          }
          .instructions p {
            font-size: 14px;
            color: #78350f;
            line-height: 1.6;
            margin-bottom: 8px;
          }
          .footer {
            background: #f8f9fa;
            padding: 30px;
            text-align: center;
            border-top: 1px solid #e2e8f0;
          }
          .footer p {
            font-size: 13px;
            color: #6b7280;
            margin: 4px 0;
            line-height: 1.6;
          }
          .footer .system-name {
            font-weight: 600;
            color: #1a1a1a;
            font-size: 14px;
            margin-bottom: 8px;
          }
          .footer .official-note {
            font-size: 12px;
            color: #9ca3af;
            margin-top: 16px;
            font-style: italic;
          }
          @media only screen and (max-width: 600px) {
            .content { padding: 30px 20px; }
            .header { padding: 30px 20px; }
            .detail-row { flex-direction: column; }
            .detail-label { width: 100%; margin-bottom: 4px; }
          }
        </style>
      </head>
      <body>
        <div class="email-wrapper">
          <div class="header">
            <h1>Teacher Submission Competition System</h1>
            <p>Official Assignment Notification</p>
          </div>

          <div class="content">
            <div class="greeting">
              Dear ${userName},
            </div>

            <div class="assignment-section">
              <h2>${assignmentTitle}</h2>
              <p>${assignmentMessage}</p>
              
              <div class="details-box">
                ${assignmentDetails}
              </div>
            </div>

            <div class="instructions">
              <h3>Next Steps</h3>
              <p>Please log in to the TSCS portal to access the assigned submission and begin your evaluation.</p>
              <p>Your professional assessment and fair evaluation are essential to maintaining the integrity and quality of this competition.</p>
            </div>

            <p style="margin-top: 24px; font-size: 14px; color: #4a5568;">
              If you have any questions or require assistance, please contact the system administrator.
            </p>
          </div>

          <div class="footer">
            <p class="system-name">Teacher Submission Competition System (TSCS)</p>
            <p>Ministry of Education</p>
            <p>This is an automated notification. Please do not reply to this email.</p>
            <p class="official-note">This email contains confidential information and is intended solely for the addressee.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Generate judge assignment text template
   * @param {string} userName - User name
   * @param {Object} metadata - Assignment metadata
   *   For submission assignment: { submissionId, teacherName, subject, areaOfFocus, level, region, council }
   *   For round assignment (legacy): { roundName, level }
   * @returns {string} Text content
   */
  generateJudgeAssignmentText(userName, metadata) {
    const isSubmissionAssignment = metadata.submissionId !== undefined;
    
    let assignmentDetails, assignmentTitle, assignmentMessage;
    
    if (isSubmissionAssignment) {
      const { level, region, council, subject, teacherName } = metadata;
      const location = level === 'Council' ? `${region} - ${council}` : region;
      assignmentTitle = 'Submission Assignment Notification';
      assignmentMessage = 'A new submission has been assigned to you for evaluation.';
      assignmentDetails = `
Assignment Level: ${level}
Geographic Location: ${location}
Subject Area: ${subject}
${teacherName ? `Teacher: ${teacherName}` : ''}
      `.trim();
    } else {
      const { roundName, level } = metadata;
      assignmentTitle = 'Judge Assignment Notification';
      assignmentMessage = 'You have been assigned as a judge for an upcoming competition round.';
      assignmentDetails = `
Competition Round: ${roundName}
Level: ${level}
      `.trim();
    }

    return `
TEACHER SUBMISSION COMPETITION SYSTEM (TSCS)
Official Assignment Notification

Dear ${userName},

${assignmentTitle}

${assignmentMessage}

ASSIGNMENT DETAILS:
${assignmentDetails}

NEXT STEPS:
Please log in to the TSCS portal to access the assigned submission and begin your evaluation.

Your professional assessment and fair evaluation are essential to maintaining the integrity and quality of this competition.

If you have any questions or require assistance, please contact the system administrator.

---
Teacher Submission Competition System (TSCS)
Ministry of Education

This is an automated notification. Please do not reply to this email.
This email contains confidential information and is intended solely for the addressee.
    `.trim();
  }

  /**
   * Generate admin notification HTML template
   * @param {string} userName - User name
   * @param {string} title - Notification title
   * @param {string} message - Notification message
   * @param {Object} metadata - Additional metadata
   * @returns {string} HTML content
   */
  generateAdminNotificationHTML(userName, title, message, metadata) {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${title} - TSCS Admin</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
          .header { text-align: center; margin-bottom: 30px; }
          .admin-icon { font-size: 48px; color: #fa8c16; margin-bottom: 16px; }
          .content { background: #fff7e6; border: 1px solid #ffd591; padding: 20px; border-radius: 8px; margin: 20px 0; }
          .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="admin-icon">🔔</div>
            <h1>${title}</h1>
            <p>Hello ${userName},</p>
          </div>

          <div class="content">
            ${message.replace(/\n/g, '<br>')}
          </div>

          <div class="footer">
            <p><strong>Teacher Submission Competition System (TSCS)</strong></p>
            <p>This is an official notification from the TSCS administration.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Generate admin notification text template
   * @param {string} userName - User name
   * @param {string} title - Notification title
   * @param {string} message - Notification message
   * @param {Object} metadata - Additional metadata
   * @returns {string} Text content
   */
  generateAdminNotificationText(userName, title, message, metadata) {
    return `
TSCS Admin Notification - ${title}

Hello ${userName},

${message}

---
Teacher Submission Competition System (TSCS)
This is an official notification from the TSCS administration.
    `.trim();
  }

  /**
   * Generate system critical HTML template
   * @param {string} userName - User name
   * @param {string} title - Critical issue title
   * @param {string} message - Critical issue message
   * @param {Object} metadata - Additional metadata
   * @returns {string} HTML content
   */
  generateSystemCriticalHTML(userName, title, message, metadata) {
    const { severity = 'high' } = metadata;
    const severityColor = severity === 'critical' ? '#ff4d4f' : '#faad14';

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${title} - TSCS CRITICAL</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
          .header { text-align: center; margin-bottom: 30px; }
          .critical-icon { font-size: 48px; color: ${severityColor}; margin-bottom: 16px; }
          .content { background: #fff2f0; border: 1px solid #ffccc7; padding: 20px; border-radius: 8px; margin: 20px 0; }
          .severity { background: ${severityColor}; color: white; padding: 8px 16px; border-radius: 20px; display: inline-block; font-weight: bold; text-transform: uppercase; font-size: 12px; }
          .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="critical-icon">🚨</div>
            <h1>CRITICAL SYSTEM ALERT</h1>
            <p>Hello ${userName},</p>
            <span class="severity">${severity} priority</span>
          </div>

          <div class="content">
            <h3>${title}</h3>
            <p>${message.replace(/\n/g, '<br>')}</p>
            <p><strong>This requires immediate attention from system administrators.</strong></p>
          </div>

          <div class="footer">
            <p><strong>Teacher Submission Competition System (TSCS)</strong></p>
            <p>Critical system alerts require immediate action.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Generate system critical text template
   * @param {string} userName - User name
   * @param {string} message - Critical issue message
   * @param {Object} metadata - Additional metadata
   * @returns {string} Text content
   */
  generateSystemCriticalText(userName, title, message, metadata) {
    const { severity = 'high' } = metadata;

    return `
TSCS CRITICAL SYSTEM ALERT - ${severity.toUpperCase()} PRIORITY

Hello ${userName},

${title}

${message}

This requires immediate attention from system administrators.

---
Teacher Submission Competition System (TSCS)
Critical system alerts require immediate action.
    `.trim();
  }

  /**
   * Generate password reset OTP HTML template
   * @param {string} otp - OTP code
   * @param {string} userName - User name
   * @returns {string} HTML content
   */
  generatePasswordResetOTPHTML(otp, userName) {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Password Reset - TSCS</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
          .header { text-align: center; margin-bottom: 30px; }
          .warning-icon { font-size: 48px; color: #fa8c16; margin-bottom: 16px; }
          .otp-code { font-size: 32px; font-weight: bold; color: #1890ff; text-align: center; margin: 30px 0; padding: 20px; background: #f0f8ff; border: 2px dashed #1890ff; border-radius: 8px; letter-spacing: 5px; }
          .warning { background: #fff7e6; border: 1px solid #ffd591; color: #d46b08; padding: 15px; border-radius: 5px; margin: 20px 0; }
          .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #666; font-size: 14px; }
          .support { margin-top: 15px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="warning-icon">🔐</div>
            <h1>Password Reset Request</h1>
            <p>Hi ${userName},</p>
          </div>

          <p>You have requested to reset your password for your TSCS account. Use the verification code below to proceed:</p>

          <div class="otp-code">${otp}</div>

          <div class="warning">
            <strong>Security Notice:</strong> This code will expire in 10 minutes. Do not share this code with anyone. If you didn't request this password reset, please ignore this email.
          </div>

          <p>If you continue with the password reset, you will be able to set a new password for your account.</p>

          <div class="footer">
            <p><strong>Teacher Submission Competition System (TSCS)</strong></p>
            <p>This password reset was requested for your account security.</p>
            <div class="support">
              <p>Need help? Contact our support team.</p>
            </div>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Generate password reset OTP text template
   * @param {string} otp - OTP code
   * @param {string} userName - User name
   * @returns {string} Text content
   */
  generatePasswordResetOTPText(otp, userName) {
    return `
TSCS - Password Reset Request

Hi ${userName},

You have requested to reset your password for your TSCS account.

Your verification code is: ${otp}

This code will expire in 10 minutes. Do not share this code with anyone.

If you didn't request this password reset, please ignore this email.

If you continue with the password reset, you will be able to set a new password for your account.

---
Teacher Submission Competition System (TSCS)
This password reset was requested for your account security.
    `.trim();
  }

  /**
   * Test email configuration
   * @returns {Promise<boolean>} Test result
   */
  async testConnection() {
    if (!this.isInitialized) {
      this.initialize();
    }

    if (!this.easymailApiKey && !this.transporter && !this.brevoApiKey) {
      return false;
    }

    if (this.easymailApiKey) {
      try {
        const response = await fetch('https://easymail-nu.vercel.app/api/health');
        if (response.ok) return true;
      } catch (error) {
        console.error('Easymail connection test failed:', error.message);
      }
    }

    if (this.transporter) {
      try {
        await this.transporter.verify();
        return true;
      } catch (error) {
        console.error('SMTP connection test failed:', error.message);
      }
    }

    if (this.brevoApiKey && this.brevoSenderEmail) {
      try {
        await this.sendBrevoRequest('/v3/account', 'GET');
        return true;
      } catch (error) {
        console.error('HTTPS email fallback connection test failed:', error.message);
      }
    }

    return false;
  }

  async sendEasymailRequest(body) {
    const response = await fetch(this.easymailApiUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.easymailApiKey}`,
        'content-type': 'application/json',
        'idempotency-key': randomUUID()
      },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error?.message || `Easymail request failed (${response.status})`);
    }
    return payload;
  }

  async sendBrevoRequest(path, method, body) {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.brevo.com',
      path,
      method,
      headers: {
        accept: 'application/json',
        'api-key': this.brevoApiKey
      }
    };

    if (payload) {
      options.headers['content-type'] = 'application/json';
      options.headers['content-length'] = Buffer.byteLength(payload);
    }

    return new Promise((resolve, reject) => {
      const request = https.request(options, (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          let parsed = {};
          try {
            parsed = data ? JSON.parse(data) : {};
          } catch {
            parsed = { message: data };
          }

          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(parsed);
            return;
          }

          reject(new Error(parsed.message || `Email provider error (${response.statusCode})`));
        });
      });

      request.on('error', reject);
      if (payload) request.write(payload);
      request.end();
    });
  }
}

// Singleton instance
const emailService = new EmailService();

module.exports = emailService;
