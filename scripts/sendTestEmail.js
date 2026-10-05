#!/usr/bin/env node
require('dotenv').config();

const emailService = require('../services/emailService');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    args[key] = value;
  }
  return args;
}

function usage() {
  console.log(`Usage: node scripts/sendTestEmail.js --to user@example.com [--subject "Subject"] [--text "Plain text"] [--html "<p>HTML</p>"]`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.to) {
    console.error('Missing required --to argument');
    usage();
    process.exit(1);
  }

  const subject = args.subject || 'TSCS Easymail Integration Test';
  const textContent = args.text || 'Hello! This is an Easymail integration test from TSCS.';
  const htmlContent = args.html || `<p>Hello!</p><p>This is an <strong>Easymail integration test</strong> from TSCS.</p><p>Message sent at ${new Date().toISOString()}.</p>`;

  const success = await emailService.sendEmail({
    to: args.to,
    subject,
    text: textContent,
    html: htmlContent,
    type: 'manual_test',
    metadata: {
      initiatedBy: 'scripts/sendTestEmail.js',
      requestedTo: args.to,
    }
  });

  if (success) {
    console.log(`Test email sent to ${args.to}`);
    process.exit(0);
  } else {
    console.error('Failed to send test email. Check logs above for details.');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unexpected error while sending test email:', error.message);
  process.exit(1);
});
