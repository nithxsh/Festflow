import { createCanvas, loadImage } from './canvasAdapter.js';
import QRCode from 'qrcode';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SECRET_KEY = process.env.PASS_SIGNING_SECRET || 'festflow_fallback_signing_secret_key_2025';

/**
 * Computes an HMAC-SHA256 signature for ticket validation to prevent tampering.
 * @param {string} payload - Serialized ticket payload
 * @returns {string} Truncated hex signature
 */
export function generateTicketSignature(payload) {
  return crypto
    .createHmac('sha256', SECRET_KEY)
    .update(payload)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Constructs a compact, tamper-proof ticket token:
 * Format: <roll>.<event_id>.<timestamp>.<hmac_signature>
 * Eliminates plaintext JSON so arbitrary online tools cannot forge admission passes.
 * @param {string} roll
 * @param {string} eventId
 * @param {number} [timestamp]
 * @returns {string} Compact token
 */
export function createCompactToken(roll, eventId, timestamp = Date.now()) {
  const cleanRoll = String(roll).trim().toUpperCase();
  const cleanEvt = String(eventId).trim().toUpperCase();
  const rawBody = `${cleanRoll}.${cleanEvt}.${timestamp}`;
  const sig = generateTicketSignature(rawBody);
  return `${rawBody}.${sig}`;
}

/**
 * Verifies a scanned QR payload against the secret HMAC key.
 * Supports compact token format (<roll>.<event_id>.<timestamp>.<sig>)
 * as well as legacy JSON payloads.
 * @param {string} rawPayload - Data string scanned from QR
 * @returns {{valid: boolean, roll?: string, eventId?: string, timestamp?: number, error?: string, data?: object}}
 */
export function verifyTicketPayload(rawPayload) {
  if (!rawPayload || typeof rawPayload !== 'string') {
    return { valid: false, error: 'Empty payload' };
  }

  const trimmed = rawPayload.trim();

  // 1. Check Compact Token format: <roll>.<event_id>.<timestamp>.<sig>
  if (trimmed.includes('.')) {
    const parts = trimmed.split('.');
    if (parts.length === 4) {
      const [roll, eventId, tsStr, signature] = parts;
      const rawBody = `${roll}.${eventId}.${tsStr}`;
      const expectedSig = generateTicketSignature(rawBody);

      if (signature === expectedSig) {
        return {
          valid: true,
          roll,
          eventId,
          timestamp: parseInt(tsStr, 10),
          data: { roll, evt: eventId, ts: parseInt(tsStr, 10) },
        };
      }
      return { valid: false, error: 'Tampered signature' };
    }
  }

  // 2. Legacy JSON fallback
  try {
    const parsed = JSON.parse(trimmed);
    const { sig, ...data } = parsed;
    const expectedSig = generateTicketSignature(JSON.stringify(data));
    return {
      valid: sig === expectedSig,
      roll: data.roll,
      eventId: data.evt,
      timestamp: data.ts,
      data,
    };
  } catch (_) {
    return { valid: false, error: 'Invalid QR format' };
  }
}

/**
 * Draws a subtle 24px engineering CAD/grid pattern onto the canvas.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 */
function drawCadGrid(ctx, width, height) {
  const gridSize = 24;
  ctx.save();
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;

  for (let x = 0; x < width; x += gridSize) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  for (let y = 0; y < height; y += gridSize) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Generates a high-resolution, production-grade event entry pass.
 * Follows strict technical industrial styling: neutral palette, CAD grid, sharp micro-radii.
 *
 * @param {object} attendee
 * @param {string} attendee.fullName
 * @param {string} attendee.rollNumber
 * @param {string} attendee.collegeName
 * @param {string} attendee.eventName
 * @param {string} attendee.eventId
 * @param {string} [attendee.venue]
 * @param {string} [attendee.schedule]
 * @param {string} [attendee.odStatus]
 * @param {string} [attendee.utrNumber]
 * @param {string} [attendee.teamName]
 * @param {Array} [attendee.teamMembers]
 * @returns {Promise<Buffer>} PNG image buffer
 */
export async function generateEventPass(attendee) {
  const width = 800;
  const height = 480;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Compact signed token: <roll>.<event_id>.<timestamp>.<hmac_signature>
  const fullPayload = createCompactToken(attendee.rollNumber, attendee.eventId);
  const signature = fullPayload.split('.')[3];

  // Render QR code to buffer
  const qrBuffer = await QRCode.toBuffer(fullPayload, {
    errorCorrectionLevel: 'H',
    margin: 1,
    width: 170,
    color: {
      dark: '#0f172a',
      light: '#ffffff',
    },
  });
  const qrImage = await loadImage(qrBuffer);

  // Background: Solid neutral technical background #f8fafc
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, width, height);

  // Subtle 24px CAD / graph-paper grid
  drawCadGrid(ctx, width, height);

  // Outer pass card border (sharp 6px engineering micro-radius)
  ctx.save();
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 3;
  ctx.strokeRect(20, 20, width - 40, height - 40);
  ctx.restore();

  // Header Bar
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(20, 20, width - 40, 56);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 20px "Liberation Sans", "Helvetica", Arial, sans-serif';
  ctx.fillText('FESTFLOW // OFFICIAL ENTRY PASS', 42, 55);

  // Header Subtitle / Event ID Chip
  ctx.fillStyle = '#334155';
  ctx.fillRect(width - 150, 32, 110, 30);
  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 13px monospace';
  ctx.fillText(attendee.eventId || 'PASS', width - 138, 52);

  // Left Content Column: Attendee Information
  ctx.fillStyle = '#64748b';
  ctx.font = '12px "Liberation Sans", "Helvetica", Arial, sans-serif';
  ctx.fillText('PARTICIPANT NAME', 44, 115);

  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 24px "Liberation Sans", "Helvetica", Arial, sans-serif';
  const displayName = attendee.fullName.length > 24 ? attendee.fullName.slice(0, 24) + '...' : attendee.fullName;
  ctx.fillText(displayName.toUpperCase(), 44, 145);

  // Roll Number & College
  ctx.fillStyle = '#64748b';
  ctx.font = '12px "Liberation Sans", "Helvetica", Arial, sans-serif';
  ctx.fillText('ROLL NUMBER', 44, 190);
  ctx.fillText('INSTITUTION', 260, 190);

  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 16px monospace';
  ctx.fillText(attendee.rollNumber.toUpperCase(), 44, 215);

  ctx.font = 'bold 15px "Liberation Sans", "Helvetica", Arial, sans-serif';
  const displayCollege = attendee.collegeName.length > 28 ? attendee.collegeName.slice(0, 28) + '...' : attendee.collegeName;
  ctx.fillText(displayCollege, 260, 215);

  // Event Details Box
  ctx.fillStyle = '#f1f5f9';
  ctx.fillRect(44, 245, 480, 75);
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1;
  ctx.strokeRect(44, 245, 480, 75);

  ctx.fillStyle = '#475569';
  ctx.font = '11px "Liberation Sans", "Helvetica", Arial, sans-serif';
  ctx.fillText('REGISTERED EVENT', 58, 266);

  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 17px "Liberation Sans", "Helvetica", Arial, sans-serif';
  ctx.fillText(attendee.eventName, 58, 288);

  ctx.fillStyle = '#64748b';
  ctx.font = '12px monospace';
  const venueText = attendee.venue ? `Venue: ${attendee.venue}` : 'Venue: Check Information Desk';
  const scheduleText = attendee.schedule ? ` | ${attendee.schedule}` : '';
  ctx.fillText(`${venueText}${scheduleText}`, 58, 308);

  // Check for Team Members (Alteration 2)
  const hasTeam = attendee.teamName || (attendee.teamMembers && attendee.teamMembers.length > 0);
  let statusY = 345;

  if (hasTeam) {
    // Render Team Track Card
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(44, 330, 480, 52);
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1;
    ctx.strokeRect(44, 330, 480, 52);

    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 11px monospace';
    const teamTitle = `TEAM: ${(attendee.teamName || 'SQUAD').toUpperCase()}`;
    ctx.fillText(teamTitle, 56, 348);

    // List all team members with roll numbers
    const membersList = (attendee.teamMembers || [])
      .map((m) => (m.roll ? `${m.name} (${m.roll})` : m.name))
      .join(' • ');

    ctx.fillStyle = '#334155';
    ctx.font = '11px "Liberation Sans", Arial, sans-serif';
    const displayMembers = membersList.length > 58 ? membersList.slice(0, 58) + '...' : membersList;
    ctx.fillText(displayMembers, 56, 368);

    statusY = 398;
  }

  // Status Chip & Verification Note
  const isApproved = attendee.odStatus === 'APPROVED';
  ctx.fillStyle = isApproved ? '#166534' : '#0369a1';
  ctx.fillRect(44, statusY, 10, 10); // Square indicator dot

  ctx.fillStyle = '#334155';
  ctx.font = 'bold 12px "Liberation Sans", Arial, sans-serif';
  const statusLabel = isApproved ? 'OD APPROVED' : 'REGISTRATION CONFIRMED';
  ctx.fillText(statusLabel, 62, statusY + 9);

  if (attendee.utrNumber) {
    ctx.fillStyle = '#64748b';
    ctx.font = '11px monospace';
    ctx.fillText(`UTR: ${attendee.utrNumber}`, 240, statusY + 9);
  }

  // Security Notice Footer
  ctx.fillStyle = '#94a3b8';
  ctx.font = '11px monospace';
  ctx.fillText('SCAN AT GATE ENTRY // TAMPER PROTECTION ENABLED (HMAC-SHA256)', 44, 440);

  // Vertical Divider line before QR section
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(560, 20);
  ctx.lineTo(560, height - 20);
  ctx.stroke();
  ctx.restore();

  // Right Column: QR Code Container
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(585, 110, 175, 175);
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 2;
  ctx.strokeRect(585, 110, 175, 175);

  // Draw QR code
  ctx.drawImage(qrImage, 587, 112, 171, 171);

  // QR Instruction & Signature hash snippet
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 12px "Liberation Sans", Arial, sans-serif';
  ctx.fillText('GATE ADMISSION QR', 598, 310);

  ctx.fillStyle = '#64748b';
  ctx.font = '10px monospace';
  ctx.fillText(`SIG: ${signature}`, 598, 330);
  ctx.fillText(`TIME: ${new Date().toLocaleTimeString('en-US', { hour12: false })}`, 598, 346);

  return canvas.toBuffer('image/png');
}

/**
 * Ensures fallback template image exists in assets directory.
 */
export async function initializePassAsset() {
  const assetsDir = path.join(__dirname, '..', 'assets');
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
  }

  const samplePassPath = path.join(assetsDir, 'pass_template.png');
  if (!fs.existsSync(samplePassPath)) {
    const templateBuffer = await generateEventPass({
      fullName: 'ATTENDEE NAME',
      rollNumber: 'ROLL NUMBER',
      collegeName: 'INSTITUTION',
      eventName: 'EVENT NAME',
      eventId: 'PASS',
      venue: 'CAMPUS VENUE',
      schedule: 'SCHEDULE',
      odStatus: 'PENDING_APPROVAL',
      utrNumber: '',
    });
    fs.writeFileSync(samplePassPath, templateBuffer);
  }
}
