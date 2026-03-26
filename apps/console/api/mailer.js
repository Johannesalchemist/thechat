const nodemailer = require('nodemailer');

const _mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.ionos.de',
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendEmail({ to, subject, html, text }) {
  return _mailer.sendMail({
    from: process.env.SMTP_FROM || 'Nyxa <info@future24.eu>',
    to,
    subject,
    html,
    text,
  });
}

module.exports = { sendEmail };
