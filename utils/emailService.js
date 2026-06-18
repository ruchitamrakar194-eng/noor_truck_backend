/**
 * Email Service Utility
 * Sends professional emails via SMTP (Nodemailer)
 * Supports Office 365, Gmail, and other SMTP providers
 */

const nodemailer = require('nodemailer');

// Configure SMTP transport using .env variables
const SMTP_HOST = (process.env.SMTP_HOST || 'outlook.office365.com').trim();
const SMTP_PORT = parseInt((process.env.SMTP_PORT || '587').trim());
const SMTP_USER = (process.env.SMTP_USER || '').trim();
const SMTP_PASS = (process.env.SMTP_PASS || '').trim();

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465, // true for 465, false for other ports
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
  tls: {
    // Office 365 requires STARTTLS
    rejectUnauthorized: false,
    minVersion: 'TLSv1.2'
  },
  family: 4, // Force IPv4 (Helps with cloud network issues)
  debug: true, // Enable debug output in logs
  logger: true, // Log to console
  connectionTimeout: 30000, // 30 seconds
  greetingTimeout: 30000,
  socketTimeout: 45000,
});

const FROM_EMAIL = (process.env.SMTP_FROM || SMTP_USER).trim();

// ─── PROFESSIONAL INVOICE EMAIL HTML ─────────────────────────────────────────
const buildInvoiceEmailHtml = ({
  customerName, invoiceNumber, startDate, endDate, total,
  companyName, companyEmail, companyPhone, companyWebsite, companyLogoUrl,
}) => {
  const primaryColor = '#295b52';
  const bgColor = '#f4f6f4';
  const cardColor = '#ffffff';
  const accentLight = '#e8f0ee';

  const logoHtml = companyLogoUrl
    ? `<img src="${companyLogoUrl}" alt="${companyName} Logo" style="max-height:70px;max-width:200px;object-fit:contain;margin-bottom:8px;" /><br/>`
    : '';

  const totalFormatted = total != null ? `$${parseFloat(total).toFixed(2)}` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>Invoice ${invoiceNumber}</title></head>
<body style="margin:0;padding:0;background-color:${bgColor};font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:${bgColor};padding:30px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background-color:${cardColor};border-radius:10px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
        <tr><td style="background-color:${primaryColor};padding:32px 40px;text-align:center;">
          ${logoHtml}
          <h1 style="margin:0;color:#fff;font-size:26px;font-weight:700;">${companyName}</h1>
          ${companyWebsite ? `<p style="margin:6px 0 0;color:rgba(255,255,255,0.75);font-size:13px;">${companyWebsite}</p>` : ''}
        </td></tr>
        <tr><td style="background-color:${accentLight};padding:16px 40px;border-bottom:1px solid #d4e0dd;">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td><span style="font-size:20px;font-weight:700;color:${primaryColor};">INVOICE</span>
              <span style="font-size:14px;color:#666;margin-left:10px;">${invoiceNumber}</span></td>
            <td align="right"><span style="font-size:13px;color:#888;">Period: <strong style="color:#444;">${startDate} – ${endDate}</strong></span></td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:36px 40px;">
          <p style="margin:0 0 16px;font-size:15px;color:#333;">Dear <strong>${customerName}</strong>,</p>
          <p style="margin:0 0 24px;font-size:15px;color:#555;line-height:1.6;">
            Please find attached your invoice for the billing period <strong>${startDate}</strong> to <strong>${endDate}</strong>.
            The PDF is attached to this email for your records.
          </p>
          ${totalFormatted ? `
          <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fbfa;border:1px solid #d4e0dd;border-radius:8px;margin-bottom:26px;">
            <tr><td style="padding:20px 24px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-size:13px;color:#888;padding-bottom:6px;">Invoice Number</td>
                  <td align="right" style="font-size:13px;color:#888;padding-bottom:6px;">Total Amount</td>
                </tr>
                <tr>
                  <td style="font-size:18px;font-weight:700;color:${primaryColor};">${invoiceNumber}</td>
                  <td align="right" style="font-size:22px;font-weight:700;color:${primaryColor};">${totalFormatted}</td>
                </tr>
              </table>
            </td></tr>
          </table>` : ''}
          <p style="margin:0 0 8px;font-size:14px;color:#555;">If you have any questions about this invoice, please contact us:</p>
          <p style="margin:0 0 28px;font-size:14px;color:#555;">
            📧 <a href="mailto:${companyEmail}" style="color:${primaryColor};text-decoration:none;">${companyEmail}</a>
            ${companyPhone ? `&nbsp;&nbsp;📞 ${companyPhone}` : ''}
          </p>
          <p style="margin:0;font-size:14px;color:#555;">Thank you for your business. We look forward to continuing to serve you.</p>
        </td></tr>
        <tr><td style="background-color:${accentLight};padding:22px 40px;border-top:1px solid #d4e0dd;">
          <p style="margin:0;font-size:13px;color:#666;">Best regards,</p>
          <p style="margin:4px 0 0;font-size:14px;font-weight:700;color:${primaryColor};">${companyName}</p>
          ${companyPhone ? `<p style="margin:3px 0 0;font-size:12px;color:#888;">📞 ${companyPhone}</p>` : ''}
          <p style="margin:3px 0 0;font-size:12px;color:#888;">📧 ${companyEmail}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`.trim();
};

// ─── SETTLEMENT EMAIL HTML ────────────────────────────────────────────────────
const buildSettlementEmailHtml = ({
  driverName, period, startDate, endDate, totalPay,
  companyName, companyEmail, companyLogoUrl,
}) => {
  const primaryColor = '#295b52';
  const bgColor = '#f4f6f4';
  const cardColor = '#ffffff';
  const accentLight = '#e8f0ee';

  const logoHtml = companyLogoUrl
    ? `<img src="${companyLogoUrl}" alt="${companyName} Logo" style="max-height:70px;max-width:200px;object-fit:contain;margin-bottom:8px;" /><br/>`
    : '';

  const totalFormatted = totalPay != null ? `$${parseFloat(totalPay).toFixed(2)}` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>Settlement Statement</title></head>
<body style="margin:0;padding:0;background-color:${bgColor};font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:${bgColor};padding:30px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background-color:${cardColor};border-radius:10px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
        <tr><td style="background-color:${primaryColor};padding:32px 40px;text-align:center;">
          ${logoHtml}
          <h1 style="margin:0;color:#fff;font-size:26px;font-weight:700;">${companyName}</h1>
        </td></tr>
        <tr><td style="background-color:${accentLight};padding:16px 40px;border-bottom:1px solid #d4e0dd;">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td><span style="font-size:20px;font-weight:700;color:${primaryColor};">SETTLEMENT</span></td>
            <td align="right"><span style="font-size:13px;color:#888;">Period: <strong style="color:#444;">${startDate} – ${endDate}</strong></span></td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:36px 40px;">
          <p style="margin:0 0 16px;font-size:15px;color:#333;">Dear <strong>${driverName}</strong>,</p>
          <p style="margin:0 0 24px;font-size:15px;color:#555;line-height:1.6;">
            Please find attached your settlement statement for the period <strong>${startDate}</strong> to <strong>${endDate}</strong>.
          </p>
          ${totalFormatted ? `
          <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fbfa;border:1px solid #d4e0dd;border-radius:8px;margin-bottom:26px;">
            <tr><td style="padding:20px 24px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-size:13px;color:#888;padding-bottom:6px;">Period</td>
                  <td align="right" style="font-size:13px;color:#888;padding-bottom:6px;">Total Pay</td>
                </tr>
                <tr>
                  <td style="font-size:18px;font-weight:700;color:${primaryColor};">${period}</td>
                  <td align="right" style="font-size:22px;font-weight:700;color:${primaryColor};">${totalFormatted}</td>
                </tr>
              </table>
            </td></tr>
          </table>` : ''}
          <p style="margin:0 0 8px;font-size:14px;color:#555;">If you have any questions, please contact us:</p>
          <p style="margin:0 0 28px;font-size:14px;color:#555;">📧 <a href="mailto:${companyEmail}" style="color:${primaryColor};text-decoration:none;">${companyEmail}</a></p>
        </td></tr>
        <tr><td style="background-color:${accentLight};padding:22px 40px;border-top:1px solid #d4e0dd;">
          <p style="margin:0;font-size:13px;color:#666;">Best regards,</p>
          <p style="margin:4px 0 0;font-size:14px;font-weight:700;color:${primaryColor};">${companyName}</p>
          <p style="margin:3px 0 0;font-size:12px;color:#888;">📧 ${companyEmail}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`.trim();
};

// ─── HELPER: Build attachments array ─────────────────────────────────────────
const buildAttachments = (pdfBuffer, filename, company) => {
  const attachments = [{
    content: Buffer.from(pdfBuffer),
    filename,
    contentType: 'application/pdf',
  }];

  if (company?.company_logo && company.company_logo.startsWith('data:image')) {
    const mimeMatch = company.company_logo.match(/^data:(image\/[a-z+]+);base64,/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
    const base64Data = company.company_logo.replace(/^data:image\/[a-z+]+;base64,/, '');
    const ext = mimeType.split('/')[1] || 'png';
    attachments.push({
      content: Buffer.from(base64Data, 'base64'),
      filename: `company_logo.${ext}`,
      contentType: mimeType,
      cid: 'company_logo_cid', // same as in html
    });
  }

  return attachments;
};

// ─── HELPER: Get company info from DB ────────────────────────────────────────
const getCompanyInfo = async (companyInfo) => {
  if (companyInfo) return companyInfo;
  try {
    const pool = require('../config/db');
    const [rows] = await pool.execute(
      'SELECT company_name, company_logo, email, phone, website FROM company_settings LIMIT 1'
    );
    if (rows.length > 0) return rows[0];
  } catch (err) {
    console.error('[Email] DB fetch for company info failed:', err.message);
  }
  return null;
};

// ─── SEND INVOICE EMAIL ───────────────────────────────────────────────────────
const sendInvoiceEmail = async ({
  to, customerName, invoiceNumber, startDate, endDate,
  total = null, pdfBuffer, filename, companyInfo = null,
}) => {
  try {
    const company = await getCompanyInfo(companyInfo);
    const companyName = company?.company_name || 'Noor Trucking Inc.';
    const companyEmail = company?.email || FROM_EMAIL;
    const companyPhone = company?.phone || '';
    const companyWebsite = company?.website || '';

    let companyLogoUrl = '';
    if (company?.company_logo) {
      if (company.company_logo.startsWith('data:image')) {
        companyLogoUrl = 'cid:company_logo_cid';
      } else if (company.company_logo.startsWith('http')) {
        companyLogoUrl = company.company_logo;
      }
    }

    const subject = `Invoice ${invoiceNumber} from ${companyName}`;
    const htmlBody = buildInvoiceEmailHtml({
      customerName, invoiceNumber, startDate, endDate, total,
      companyName, companyEmail, companyPhone, companyWebsite, companyLogoUrl,
    });

    const mailOptions = {
      from: `"${companyName}" <${FROM_EMAIL}>`,
      to,
      subject,
      html: htmlBody,
      text: `Invoice ${invoiceNumber} from ${companyName}. Period: ${startDate} to ${endDate}. Please see attached PDF.`,
      attachments: buildAttachments(pdfBuffer, filename, company),
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`[Email] ✅ Invoice email sent: ${info.messageId}`);
    return { success: true, message: 'Invoice email sent successfully' };

  } catch (error) {
    console.error('[Email] ❌ Failed to send invoice email:', error.message);
    return { success: false, error: error.message, message: `Email sending failed: ${error.message}` };
  }
};

// ─── SEND SETTLEMENT EMAIL ────────────────────────────────────────────────────
const sendSettlementEmail = async ({
  to, driverName, period, startDate, endDate,
  totalPay = null, pdfBuffer, filename, companyInfo = null,
}) => {
  try {
    const company = await getCompanyInfo(companyInfo);
    const companyName = company?.company_name || 'Noor Trucking Inc.';
    const companyEmail = company?.email || FROM_EMAIL;

    let companyLogoUrl = '';
    if (company?.company_logo) {
      if (company.company_logo.startsWith('data:image')) {
        companyLogoUrl = 'cid:company_logo_cid';
      } else if (company.company_logo.startsWith('http')) {
        companyLogoUrl = company.company_logo;
      }
    }

    const subject = `Settlement Statement (${period}) from ${companyName}`;
    const htmlBody = buildSettlementEmailHtml({
      driverName, period, startDate, endDate, totalPay,
      companyName, companyEmail, companyLogoUrl,
    });

    const mailOptions = {
      from: `"${companyName}" <${FROM_EMAIL}>`,
      to,
      subject,
      html: htmlBody,
      text: `Settlement Statement for ${period}. Driver: ${driverName}. Total Pay: $${totalPay?.toFixed(2) || '0.00'}. Please see attached PDF.`,
      attachments: buildAttachments(pdfBuffer, filename, company),
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`[Email] ✅ Settlement email sent: ${info.messageId}`);
    return { success: true, message: 'Settlement email sent successfully' };

  } catch (error) {
    console.error('[Email] ❌ Failed to send settlement email:', error.message);
    return { success: false, error: error.message, message: `Email sending failed: ${error.message}` };
  }
};

// ─── VERIFY CONNECTION ────────────────────────────────────────────────────────
const verifyConnection = async () => {
  try {
    await transporter.verify();
    console.log('[Email] ✅ SMTP connection verified successfully');
    return { success: true, message: 'SMTP connection verified successfully' };
  } catch (error) {
    console.error('[Email] ❌ SMTP connection verification failed:', error.message);
    return { success: false, error: error.message };
  }
};

module.exports = { sendInvoiceEmail, sendSettlementEmail, verifyConnection };
