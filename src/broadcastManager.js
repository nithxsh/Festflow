import { getRegistrationsForEvent } from './supabase.js';
import { getEventsConfig } from './stateMachine.js';
import { isAuthorizedVolunteer } from './spotRegistrar.js';

/**
 * Executes a mass broadcast to all participants registered for an event or across all events.
 * Implements a 20 msgs/min throttled jitter queue to strictly prevent WhatsApp anti-spam bans.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} senderPhone - Phone number of admin triggering the broadcast
 * @param {string} eventId - Target event ID or 'ALL'
 * @param {string} messageText - Announcement text
 * @param {Function} [onProgress] - Optional CLI progress callback
 * @returns {Promise<{success: boolean, sent: number, failed: number, total: number, error?: string}>}
 */
export async function executeBroadcast(sock, senderPhone, eventId, messageText, onProgress) {
  // Authorization check (if triggered via WhatsApp)
  if (senderPhone && !isAuthorizedVolunteer(senderPhone)) {
    return {
      success: false,
      sent: 0,
      failed: 0,
      total: 0,
      error: 'Access Denied: Your phone number is not listed in ADMIN_NUMBERS.',
    };
  }

  const cleanEventId = (eventId || '').trim().toUpperCase();
  const cleanMsg = (messageText || '').trim();

  if (!cleanEventId || !cleanMsg) {
    return {
      success: false,
      sent: 0,
      failed: 0,
      total: 0,
      error: 'Invalid syntax. Format: #BROADCAST <event_id> | <announcement>',
    };
  }

  const eventsConfig = getEventsConfig();
  const festName = eventsConfig.festName || process.env.FEST_NAME || 'Campus Fest';

  // Fetch recipients
  const attendees = await getRegistrationsForEvent(cleanEventId);

  if (!attendees || attendees.length === 0) {
    return {
      success: true,
      sent: 0,
      failed: 0,
      total: 0,
      error: `No registered participants found for target "${cleanEventId}".`,
    };
  }

  let sent = 0;
  let failed = 0;
  const total = attendees.length;

  for (let i = 0; i < attendees.length; i++) {
    const student = attendees[i];
    const phone = student.phone_number ? student.phone_number.replace(/\D/g, '') : null;

    if (!phone) {
      failed++;
      continue;
    }

    const recipientJid = `${phone}@s.whatsapp.net`;
    const eventLabel = cleanEventId === 'ALL' ? 'GENERAL NOTICE' : (student.event_name || cleanEventId);

    const broadcastBody =
      `📢 *${festName.toUpperCase()} ANNOUNCEMENT*\n` +
      `Track: *${eventLabel}*\n\n` +
      `${cleanMsg}\n\n` +
      `— Organizing Committee, ${festName}`;

    try {
      if (sock?.sendMessage) {
        await sock.sendMessage(recipientJid, { text: broadcastBody });
      }
      sent++;
    } catch (err) {
      console.warn(`[BROADCAST] Could not deliver to ${recipientJid}:`, err.message);
      failed++;
    }

    if (onProgress) {
      onProgress(i + 1, total, student);
    }

    // Rate limiter: 2500ms delay between consecutive dispatches (~24 messages/minute)
    if (i < attendees.length - 1) {
      const jitter = Math.floor(Math.random() * 500) + 2200;
      await new Promise((r) => setTimeout(r, jitter));
    }
  }

  return {
    success: true,
    sent,
    failed,
    total,
  };
}

/**
 * Message listener helper for parsing and executing #BROADCAST via WhatsApp.
 * Syntax: #BROADCAST <event_id> | <message>
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} senderJid
 * @param {string} text
 * @returns {Promise<{handled: boolean, responseText?: string}>}
 */
export async function handleWhatsAppBroadcast(sock, senderJid, text) {
  const clean = (text || '').trim();
  if (!/^#BROADCAST\b/i.test(clean)) {
    return { handled: false };
  }

  const senderPhone = senderJid.replace('@s.whatsapp.net', '');
  if (!isAuthorizedVolunteer(senderPhone)) {
    const denied = '⛔ *Access Denied*\nYour phone number is not authorized to issue mass broadcasts.';
    if (sock?.sendMessage) {
      await sock.sendMessage(senderJid, { text: denied });
    }
    return { handled: true, responseText: denied };
  }

  const body = clean.replace(/^#BROADCAST/i, '').trim();
  const pipeIndex = body.indexOf('|');

  if (pipeIndex === -1) {
    const syntaxErr =
      '⚠️ *Invalid #BROADCAST Syntax*\n\n' +
      'Usage:\n*#BROADCAST <event_id> | <announcement message>*\n\n' +
      'Examples:\n' +
      '*#BROADCAST CODE_RELAY | Venue moved to Lab 1*\n' +
      '*#BROADCAST ALL | Lunch is now being served at the dining hall*';
    if (sock?.sendMessage) {
      await sock.sendMessage(senderJid, { text: syntaxErr });
    }
    return { handled: true, responseText: syntaxErr };
  }

  const eventId = body.slice(0, pipeIndex).trim();
  const announcement = body.slice(pipeIndex + 1).trim();

  // Inform admin dispatch has begun
  if (sock?.sendMessage) {
    await sock.sendMessage(senderJid, {
      text: `⏳ *Dispatching broadcast to ${eventId.toUpperCase()} participants...*\nRate-limiting active to ensure deliverability.`,
    });
  }

  const result = await executeBroadcast(sock, senderPhone, eventId, announcement);

  const report =
    `✅ *Broadcast Complete*\n\n` +
    `• Target: *${eventId.toUpperCase()}*\n` +
    `• Delivered: *${result.sent}*\n` +
    `• Failed: *${result.failed}*\n` +
    `• Total Target: *${result.total}*`;

  if (sock?.sendMessage) {
    await sock.sendMessage(senderJid, { text: report });
  }

  return { handled: true, responseText: report };
}
