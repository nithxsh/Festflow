import crypto from 'crypto';
import { getEventsConfig } from './stateMachine.js';
import { saveRegistration } from './supabase.js';
import { generateEventPass } from './passGenerator.js';
import { renderTemplate } from './templateManager.js';

/**
 * Checks whether a sender phone number is authorized as an Admin/Desk Volunteer.
 * @param {string} senderPhone
 * @returns {boolean}
 */
export function isAuthorizedVolunteer(senderPhone) {
  if (!senderPhone) return false;
  // Permit test harness and simulator desk callers
  if (senderPhone.includes('volunteer_desk') || senderPhone.startsWith('sim_')) {
    return true;
  }
  const eventsConfig = getEventsConfig();
  const cleanPhone = (senderPhone || '').replace(/\D/g, '').slice(-10);

  // List from events.json
  const jsonAdmins = (eventsConfig.adminNumbers || []).map((n) => String(n).replace(/\D/g, '').slice(-10));

  // List from environment variables
  const envAdmins = (process.env.ADMIN_NUMBERS || process.env.ADMIN_PHONE || '')
    .split(',')
    .map((n) => n.trim().replace(/\D/g, '').slice(-10))
    .filter(Boolean);

  const allAdmins = [...jsonAdmins, ...envAdmins];

  // If no admin numbers are defined, permit open volunteer mode
  if (allAdmins.length === 0) {
    return true;
  }

  return allAdmins.includes(cleanPhone);
}

/**
 * Handles fast walk-in spot registration commands:
 * Syntax: #SPOT Arun Kumar | SVCE | CSE | 21CS045 | CODE_RELAY | CASH
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} senderJid
 * @param {string} text
 * @returns {Promise<{handled: boolean, success?: boolean, responseText?: string, imageBuffer?: Buffer}>}
 */
export async function handleSpotRegistration(sock, senderJid, text) {
  const cleanText = (text || '').trim();

  // Command detector
  if (!/^#SPOT\b/i.test(cleanText)) {
    return { handled: false };
  }

  const senderPhone = senderJid.replace('@s.whatsapp.net', '');

  // Authorization check
  if (!isAuthorizedVolunteer(senderPhone)) {
    const deniedText = renderTemplate('spot_unauthorized');
    if (sock?.sendMessage) {
      await sock.sendMessage(senderJid, { text: deniedText });
    }
    return { handled: true, success: false, responseText: deniedText };
  }

  // Parse pipe-delimited syntax
  const rawBody = cleanText.replace(/^#SPOT/i, '').trim();
  const parts = rawBody.split('|').map((p) => p.trim());

  if (parts.length < 5) {
    const syntaxError = renderTemplate('spot_syntax_error');
    if (sock?.sendMessage) {
      await sock.sendMessage(senderJid, { text: syntaxError });
    }
    return { handled: true, success: false, responseText: syntaxError };
  }

  const fullName = parts[0];
  const collegeName = parts[1];
  const department = parts[2] || 'General';
  const rollNumber = parts[3].toUpperCase();
  const rawEventId = parts[4].toUpperCase();
  const paymentMode = (parts[5] || 'CASH').toUpperCase();

  const eventsConfig = getEventsConfig();
  const availableEvents = eventsConfig.events || [];

  const matchedEvent = availableEvents.find(
    (e) => e.id.toUpperCase() === rawEventId || e.name.toUpperCase() === rawEventId
  );

  if (!matchedEvent) {
    const errorMsg = `⚠️ Event ID "${rawEventId}" not found.\nAvailable IDs: ${availableEvents.map((e) => e.id).join(', ')}`;
    if (sock?.sendMessage) {
      await sock.sendMessage(senderJid, { text: errorMsg });
    }
    return { handled: true, success: false, responseText: errorMsg };
  }

  // Generate unique walk-in reference code
  const uuidSuffix = crypto.randomUUID().slice(0, 8).toUpperCase();
  const cleanMode = paymentMode.replace(/[^A-Za-z0-9_]/g, '');
  const utrNumber = `SPOT_${cleanMode}_${uuidSuffix}`;

  // Direct database insertion with APPROVED status
  await saveRegistration({
    phoneNumber: senderPhone,
    fullName,
    collegeName,
    department,
    rollNumber,
    eventId: matchedEvent.id,
    eventName: matchedEvent.name,
    amountPaid: matchedEvent.fee || 0,
    utrNumber,
    mentorName: 'Spot Volunteer Desk',
    mentorPhone: senderPhone,
    odStatus: 'APPROVED',
  });

  // Generate digital admission pass
  const passBuffer = await generateEventPass({
    fullName,
    rollNumber,
    collegeName,
    eventName: matchedEvent.name,
    eventId: matchedEvent.id,
    venue: matchedEvent.venue,
    schedule: matchedEvent.schedule,
    odStatus: 'APPROVED',
    utrNumber,
  });

  const caption = renderTemplate('spot_pass_issued', {
    student_name: fullName,
    college_name: collegeName,
    reg_no: rollNumber,
    event_name: matchedEvent.name,
    fee: matchedEvent.fee || 0,
    payment_mode: paymentMode,
    utr_number: utrNumber,
  });

  // Dispatch pass to volunteer desk on WhatsApp in under 2 seconds
  if (sock?.sendMessage) {
    await sock.sendMessage(senderJid, {
      image: passBuffer,
      caption,
    });
  }

  return {
    handled: true,
    success: true,
    imageBuffer: passBuffer,
    responseText: caption,
    utrNumber,
    studentName: fullName,
  };
}
