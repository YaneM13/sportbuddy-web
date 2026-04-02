require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3000;
const MESSAGES_FILE = path.join(__dirname, '../data/messages.json');
const resend = new Resend(process.env.RESEND_API_KEY);

// ── Ensure data directory exists ──
const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(MESSAGES_FILE)) fs.writeFileSync(MESSAGES_FILE, '[]');

// ── Trust proxy (Railway) ──
app.set('trust proxy', 1);

// ── Middleware ──
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── Rate limit ──
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { success: false, message: 'Too many messages. Please try again in 1 hour.' }
});

// ── Input validation ──
function validate(body) {
  const errors = [];
  const { name, email, subject, message } = body;
  if (!name || name.trim().length < 2) errors.push('Name must be at least 2 characters.');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Enter a valid email address.');
  if (!subject || subject.trim().length < 3) errors.push('Subject must be at least 3 characters.');
  if (!message || message.trim().length < 10) errors.push('Message must be at least 10 characters.');
  if (message && message.trim().length > 2000) errors.push('Message cannot exceed 2000 characters.');
  return errors;
}

// ── POST /api/contact ──
app.post('/api/contact', limiter, async (req, res) => {
  const errors = validate(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ success: false, message: errors.join(' ') });
  }

  const { name, email, subject, message } = req.body;
  const newMessage = {
    id: Date.now(),
    name: name.trim(),
    email: email.trim(),
    subject: subject.trim(),
    message: message.trim(),
    time: new Date().toISOString(),
    read: false
  };

  // Save to file
  try {
    const messages = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
    messages.unshift(newMessage);
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2));
  } catch (err) {
    console.error('Save error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }

  // Send email via Resend
  try {
    await resend.emails.send({
      from: 'SportBuddy <kontakt@sportbuddy.net>',
      to: 'admin@sportbuddy.net',
      reply_to: email,
      subject: `[SportBuddy] ${subject}`,
      html: `
        <div style="font-family:sans-serif;max-width:580px;margin:0 auto;background:#f5f5f5;padding:20px;border-radius:12px;">
          <div style="background:#1db954;padding:24px 32px;border-radius:10px 10px 0 0;">
            <h2 style="color:#000;margin:0;font-size:20px;">New Contact Message</h2>
            <p style="color:rgba(0,0,0,0.6);margin:4px 0 0;font-size:13px;">sportbuddy.net</p>
          </div>
          <div style="background:#fff;padding:32px;border-radius:0 0 10px 10px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#888;font-size:13px;width:80px;">From:</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:600;">${name}</td></tr>
              <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#888;font-size:13px;">Email:</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;">${email}</td></tr>
              <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#888;font-size:13px;">Subject:</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;">${subject}</td></tr>
              <tr><td style="padding:10px 0;color:#888;font-size:13px;vertical-align:top;">Message:</td><td style="padding:10px 0;line-height:1.7;color:#333;">${message.replace(/\n/g, '<br>')}</td></tr>
            </table>
            <p style="margin:24px 0 0;color:#aaa;font-size:12px;">Hit reply to respond directly to the sender.</p>
          </div>
        </div>
      `
    });

    await resend.emails.send({
      from: 'SportBuddy <kontakt@sportbuddy.net>',
      to: email,
      subject: `We received your message — SportBuddy`,
      html: `
        <div style="font-family:sans-serif;max-width:580px;margin:0 auto;background:#f5f5f5;padding:20px;border-radius:12px;">
          <div style="background:#1db954;padding:24px 32px;border-radius:10px 10px 0 0;">
            <h2 style="color:#000;margin:0;font-size:20px;">Message received!</h2>
          </div>
          <div style="background:#fff;padding:32px;border-radius:0 0 10px 10px;">
            <p style="color:#333;line-height:1.7;margin:0 0 16px;">Hi <strong>${name}</strong>,</p>
            <p style="color:#333;line-height:1.7;margin:0 0 24px;">Thanks for reaching out to SportBuddy! We will get back to you within 24 hours.</p>
            <p style="color:#888;font-size:14px;margin:0;">The SportBuddy Team</p>
          </div>
        </div>
      `
    });

    console.log(`New message from: ${name} <${email}>`);
  } catch (err) {
    console.error('Email error:', err.message);
    // Message is already saved, so still return success
  }

  res.json({ success: true, message: 'Message sent successfully!' });
});

// ── POST /api/reply (Admin reply) ──
app.post('/api/reply', async (req, res) => {
  const adminPass = req.headers['x-admin-pass'];
  if (adminPass !== process.env.ADMIN_PASS) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const { to, subject, message } = req.body;
  if (!to || !message) {
    return res.status(400).json({ success: false, message: 'Missing fields.' });
  }

  try {
    await resend.emails.send({
      from: 'SportBuddy <kontakt@sportbuddy.net>',
      to: to,
      subject: subject || 'Reply from SportBuddy',
      html: `
        <div style="font-family:sans-serif;max-width:580px;margin:0 auto;background:#f5f5f5;padding:20px;border-radius:12px;">
          <div style="background:#1db954;padding:24px 32px;border-radius:10px 10px 0 0;">
            <h2 style="color:#000;margin:0;font-size:20px;">SportBuddy</h2>
          </div>
          <div style="background:#fff;padding:32px;border-radius:0 0 10px 10px;">
            <p style="color:#333;line-height:1.7;white-space:pre-wrap;">${message}</p>
            <p style="color:#888;font-size:14px;margin-top:24px;">The SportBuddy Team</p>
          </div>
        </div>
      `
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Reply error:', err.message);
    res.status(500).json({ success: false, message: 'Could not send reply.' });
  }
});

// ── GET /api/messages (Admin only) ──
app.get('/api/messages', (req, res) => {
  const adminPass = req.headers['x-admin-pass'];
  if (adminPass !== process.env.ADMIN_PASS) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const messages = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
    res.json({ success: true, messages });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error reading messages.' });
  }
});

// ── DELETE /api/messages/:id (Admin only) ──
app.delete('/api/messages/:id', (req, res) => {
  const adminPass = req.headers['x-admin-pass'];
  if (adminPass !== process.env.ADMIN_PASS) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const messages = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
    const filtered = messages.filter(m => m.id !== parseInt(req.params.id));
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(filtered, null, 2));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error deleting message.' });
  }
});

// ── Health check ──
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', site: 'sportbuddy.net', time: new Date().toISOString() });
});

// ── Serve frontend ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 SportBuddy running on: http://localhost:${PORT}\n`);
});
