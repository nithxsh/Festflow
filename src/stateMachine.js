import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractUTRFromImage } from './ocrVerifier.js';
import { generateEventPass } from './passGenerator.js';
import { addParticipantToEventGroup } from './groupManager.js';
import {
  saveRegistration,
  checkUTRDuplicate,
  getEventRegistrationCount,
  checkDuplicateRoll,
  getRegistrationByRoll,
} from './supabase.js';
import { renderTemplate } from './templateManager.js';
import { sessionStore, getSession, resetSession } from './sessionStore.js';
import { generateDelegateId, executeFraudInspection, generateUpiPaymentUri, generateUpiQrCode } from './fraudDetector.js';

export { sessionStore, getSession, resetSession };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to dynamic events configuration
const configPath = path.join(__dirname, '..', 'config', 'events.json');

/**
 * Returns latest events configuration dynamically from disk.
 * @returns {object}
 */
export function getEventsConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.error('[STATE MACHINE] Could not read events.json:', err.message);
    return { events: [], faq: {}, hostCollege: { name: '' }, payment: {} };
  }
}

/**
 * Simulates human typing jitter (1200ms - 2200ms) with composing status before sending.
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} jid
 * @param {object} content - Baileys message payload
 */
export async function sendWithJitter(sock, jid, content) {
  try {
    if (sock.sendPresenceUpdate) {
      await sock.sendPresenceUpdate('composing', jid);
    }
  } catch (_) {}

  const jitterDelay = Math.floor(Math.random() * (2200 - 1200 + 1)) + 1200;
  await new Promise((resolve) => setTimeout(resolve, jitterDelay));

  try {
    const sent = await sock.sendMessage(jid, content);
    if (sock.sendPresenceUpdate) {
      await sock.sendPresenceUpdate('paused', jid);
    }
    return sent;
  } catch (err) {
    console.error(`[SOCKET ERROR] Failed to send message to ${jid}:`, err.message);
    throw err;
  }
}

/**
 * Generates the events menu list text with slot limit checks and team track indicators.
 * @param {boolean} isHost
 * @returns {Promise<string>}
 */
export async function getEventsMenuText(isHost = false) {
  const eventsConfig = getEventsConfig();
  if (!eventsConfig.events || eventsConfig.events.length === 0) {
    return `*No events are currently published.*\nPlease check back later or contact the event administrators.`;
  }

  let eventList = '';
  for (let idx = 0; idx < eventsConfig.events.length; idx++) {
    const evt = eventsConfig.events[idx];
    const feeText = isHost ? 'FREE (Host Pass)' : `INR ${evt.fee}`;
    const regCount = await getEventRegistrationCount(evt.id);
    const isPaused = evt.status === 'PAUSED' || evt.status === 'CLOSED';
    const isSoldOut = evt.slot_limit && evt.slot_limit > 0 && regCount >= evt.slot_limit;

    if (isPaused) {
      eventList += `*${idx + 1}.* ${evt.name} (${feeText}) — ${evt.status}\n`;
      eventList += `   Registrations are temporarily on hold for this track.\n`;
    } else if (isSoldOut) {
      eventList += `*${idx + 1}.* ${evt.name} (${feeText}) — SOLD OUT\n`;
      eventList += `   Capacity reached (${regCount}/${evt.slot_limit} participants)\n`;
    } else {
      eventList += `*${idx + 1}.* ${evt.name} (${feeText})\n`;
      if (evt.slot_limit && evt.slot_limit > 0) {
        eventList += `   • ${evt.slot_limit - regCount} slots remaining\n`;
      }
    }

    if (evt.max_team_size && evt.max_team_size > 1) {
      eventList += `   • Team Track (Up to ${evt.max_team_size} members)\n`;
    }
    if (evt.venue) eventList += `   📍 Venue: ${evt.venue}\n`;
    if (evt.schedule) eventList += `   🕒 Schedule: ${evt.schedule}\n`;
    if (evt.description) eventList += `   ℹ️ ${evt.description}\n`;
    eventList += '\n';
  }

  return renderTemplate('select_event', { event_list: eventList.trim() });
}

/**
 * Routes user into Track A (Mentor OD) or Track B (UPI payment) after event/team selection.
 */
async function routePostEventSelection(sock, senderJid, session, selectedEvent) {
  const eventsConfig = getEventsConfig();

  if (session.track === 'A') {
    // Track A: Host College -> Free -> Collect Mentor details
    session.data.amountPaid = 0;
    session.data.fee = 0;
    session.step = 'COLLECT_MENTOR_NAME';

    const ackText = renderTemplate('event_selected', {
      event_name: selectedEvent.name,
      fee_display: 'FREE (Host Student)',
    });
    const mentorPrompt = renderTemplate('ask_mentor_name');

    await sendWithJitter(sock, senderJid, {
      text: `${ackText}\n\n${mentorPrompt}`,
    });
  } else {
    // Track B: External -> Fee calculation & UPI Payment flow with Mandatory Unique Delegate ID
    session.data.amountPaid = selectedEvent.fee;
    session.data.fee = selectedEvent.fee;
    session.data.delegateId = generateDelegateId('NX');
    session.step = 'COLLECT_MANUAL_UTR';

    const upiId = eventsConfig.payment?.upiId || process.env.UPI_VPA || '';
    const payeeName = eventsConfig.payment?.payeeName || process.env.UPI_PAYEE_NAME || 'Event Committee';
    const amount = selectedEvent.fee;

    // Generate standard NPCI UPI URI with delegate ID automatically embedded in transaction note
    const upiUri = generateUpiPaymentUri({
      upiId,
      payeeName,
      amount,
      delegateId: session.data.delegateId,
    });
    session.data.upiUri = upiUri;

    const paymentText = renderTemplate('payment_invoice_delegate', {
      event_name: selectedEvent.name,
      student_name: session.data.fullName,
      delegate_id: session.data.delegateId,
      fee: amount,
      upi_id: upiId,
      payee_name: payeeName,
      upi_uri: upiUri,
      upi_link: upiUri,
    });

    try {
      const qrBuffer = await generateUpiQrCode(upiUri);
      await sendWithJitter(sock, senderJid, {
        image: qrBuffer,
        caption: paymentText,
      });
    } catch (_) {
      await sendWithJitter(sock, senderJid, { text: paymentText });
    }
  }
}

/**
 * Dispatches OD verification alert to mentor.
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {object} regData
 */
async function notifyMentorForHostApproval(sock, regData) {
  const eventsConfig = getEventsConfig();
  const cleanMentorPhone = regData.mentorPhone.replace(/\D/g, '');
  const mentorJid = `${cleanMentorPhone}@s.whatsapp.net`;

  const mentorAlert = renderTemplate('mentor_alert', {
    mentor_name: regData.mentorName,
    student_name: regData.fullName,
    reg_no: regData.rollNumber,
    dept: regData.department || 'General',
    event_name: regData.eventName,
    fest_name: eventsConfig.festName || process.env.FEST_NAME || 'Campus Fest',
  });

  try {
    await sendWithJitter(sock, mentorJid, { text: mentorAlert });
  } catch (err) {
    console.warn(`[MENTOR ALERT] Failed to dispatch OD request to mentor ${mentorJid}:`, err.message);
  }
}

/**
 * Dispatches formal OD participation intimation to external faculty.
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {object} regData
 */
async function notifyExternalFacultyIntimation(sock, regData) {
  const eventsConfig = getEventsConfig();
  const cleanMentorPhone = regData.mentorPhone.replace(/\D/g, '');
  const mentorJid = `${cleanMentorPhone}@s.whatsapp.net`;

  const intimation = renderTemplate('external_faculty_intimation', {
    mentor_name: regData.mentorName,
    student_name: regData.fullName,
    reg_no: regData.rollNumber,
    dept: regData.department || 'N/A',
    college_name: regData.collegeName,
    event_name: regData.eventName,
    fest_name: eventsConfig.festName || process.env.FEST_NAME || 'Campus Fest',
    schedule: regData.schedule || 'Scheduled Day',
    venue: regData.venue || 'Campus Venue',
  });

  try {
    await sendWithJitter(sock, mentorJid, { text: intimation });
  } catch (err) {
    console.warn(`[FACULTY INTIMATION] Could not notify external faculty ${mentorJid}:`, err.message);
  }
}

/**
 * Unified conversation router & step handler.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {object} msg - Incoming WhatsApp message object
 * @param {string} text - Cleaned message text (if any)
 * @param {Buffer|null} imageBuffer - In-memory image buffer (if message is image)
 */
export async function handleIncomingMessage(sock, msg, text, imageBuffer) {
  const eventsConfig = getEventsConfig();
  const senderJid = msg.key.remoteJid;
  const phoneNumber = senderJid.replace('@s.whatsapp.net', '');
  const studentDigits = phoneNumber.replace(/\D/g, '').slice(-10);
  const cleanText = (text || '').trim();

  const session = getSession(senderJid);

  // Global cancel / restart escape (Part 2, Item 1)
  if (/^(cancel|reset|restart)$/i.test(cleanText)) {
    resetSession(senderJid);
    const freshSession = getSession(senderJid);
    freshSession.step = 'SELECT_TRACK';

    const festName = eventsConfig.festName || process.env.FEST_NAME || 'Campus Fest';
    const hostCollege = eventsConfig.hostCollege?.name || process.env.HOST_COLLEGE_NAME || 'Host College';
    const welcome = renderTemplate('welcome', {
      fest_name: festName,
      host_college: hostCollege,
    });

    await sendWithJitter(sock, senderJid, {
      text: `🔄 *Registration session reset.*\n\n${welcome}`,
    });
    return;
  }

  // Real-time status lookup command
  if (/^status$/i.test(cleanText)) {
    const cleanDigits = phoneNumber.replace(/\D/g, '').slice(-10);
    const reg = (await getRegistrationByRoll(cleanDigits)) || (await getRegistrationByRoll(session.data?.rollNumber || ''));
    if (reg) {
      const statusCard =
        `📋 *REGISTRATION STATUS*\n\n` +
        `👤 *Participant:* ${reg.full_name}\n` +
        `🆔 *Roll No:* ${reg.roll_number}\n` +
        `🏫 *College:* ${reg.college_name}\n` +
        `🏆 *Event:* ${reg.event_name}\n` +
        `📋 *OD Status:* ${reg.od_status}\n` +
        `🎟️ *Gate Entry:* ${reg.checked_in ? 'CHECKED IN' : 'NOT YET CHECKED IN'}\n\n` +
        `Type *RESET* to start a fresh registration session.`;
      await sendWithJitter(sock, senderJid, { text: statusCard });
      return;
    }

    await sendWithJitter(sock, senderJid, {
      text: `No active registration found for this number.\nType *REGISTER* to start a registration session.`,
    });
    return;
  }

  // FAQ check
  if (/^(faq|food|accommodation|transport)$/i.test(cleanText)) {
    const key = cleanText.toLowerCase();
    const answer =
      eventsConfig.faq[key] ||
      `*Fest Information:*\n• Food: ${eventsConfig.faq.food || 'Details at desk'}\n• Accommodation: ${eventsConfig.faq.accommodation || 'Details at desk'}\n• OD Policy: ${eventsConfig.faq.od || 'Digital pass upon approval'}\n• Transport: ${eventsConfig.faq.transport || 'Campus shuttle'}`;
    await sendWithJitter(sock, senderJid, { text: answer });
    return;
  }

  // Schedule / Events query
  if (/^(events|schedule|venue)$/i.test(cleanText) && session.step === 'IDLE') {
    const menu = await getEventsMenuText(false);
    await sendWithJitter(sock, senderJid, {
      text: menu + `\n\nType *REGISTER* to begin registration.`,
    });
    return;
  }

  // -------------------------------------------------------------
  // STATE MACHINE STEPS
  // -------------------------------------------------------------
  switch (session.step) {
    case 'IDLE': {
      session.step = 'SELECT_TRACK';
      const festName = eventsConfig.festName || process.env.FEST_NAME || 'Campus Fest';
      const hostCollege = eventsConfig.hostCollege?.name || process.env.HOST_COLLEGE_NAME || 'Host College';
      const welcome = renderTemplate('welcome', {
        fest_name: festName,
        host_college: hostCollege,
      });
      await sendWithJitter(sock, senderJid, { text: welcome });
      break;
    }

    case 'SELECT_TRACK': {
      const hostCollege = eventsConfig.hostCollege?.name || process.env.HOST_COLLEGE_NAME || 'Host College';
      if (cleanText === '1') {
        session.track = 'A'; // Host College (Free + Mentor OD flow)
        session.step = 'COLLECT_NAME';
        session.data = {
          collegeName: hostCollege,
          amountPaid: 0,
          phoneNumber,
        };
        await sendWithJitter(sock, senderJid, {
          text: renderTemplate('ask_name'),
        });
      } else if (cleanText === '2') {
        session.track = 'B'; // External College (Paid + OCR flow)
        session.step = 'COLLECT_NAME';
        session.data = {
          phoneNumber,
        };
        await sendWithJitter(sock, senderJid, {
          text: renderTemplate('ask_name'),
        });
      } else {
        await sendWithJitter(sock, senderJid, {
          text: renderTemplate('invalid_choice'),
        });
      }
      break;
    }

    // Step: Name Collection
    case 'COLLECT_NAME': {
      if (cleanText.length < 2 || /^\d+$/.test(cleanText)) {
        await sendWithJitter(sock, senderJid, { text: renderTemplate('invalid_name') });
        return;
      }
      session.data.fullName = cleanText;

      if (session.track === 'A') {
        session.step = 'COLLECT_ROLL';
        await sendWithJitter(sock, senderJid, {
          text: renderTemplate('ask_roll'),
        });
      } else {
        session.step = 'COLLECT_COLLEGE';
        await sendWithJitter(sock, senderJid, {
          text: renderTemplate('ask_college'),
        });
      }
      break;
    }

    // Track B: College Name
    case 'COLLECT_COLLEGE': {
      if (cleanText.length < 2 || /^\d+$/.test(cleanText)) {
        await sendWithJitter(sock, senderJid, { text: renderTemplate('ask_college') });
        return;
      }
      session.data.collegeName = cleanText;
      session.step = 'COLLECT_DEPT';
      await sendWithJitter(sock, senderJid, {
        text: renderTemplate('ask_dept'),
      });
      break;
    }

    // Track B: Department
    case 'COLLECT_DEPT': {
      session.data.department = cleanText;
      session.step = 'COLLECT_ROLL';
      await sendWithJitter(sock, senderJid, {
        text: renderTemplate('ask_roll'),
      });
      break;
    }

    // Common: Roll Number
    case 'COLLECT_ROLL': {
      if (cleanText.length < 2) {
        await sendWithJitter(sock, senderJid, { text: renderTemplate('invalid_roll') });
        return;
      }
      session.data.rollNumber = cleanText.toUpperCase();
      session.step = 'SELECT_EVENT';

      const isHost = session.track === 'A';
      const menuText = await getEventsMenuText(isHost);
      await sendWithJitter(sock, senderJid, {
        text: menuText,
      });
      break;
    }

    // Common: Event Selection with Capacity Cap & Team Flow
    case 'SELECT_EVENT': {
      const choice = parseInt(cleanText, 10);
      if (isNaN(choice) || choice < 1 || choice > eventsConfig.events.length) {
        await sendWithJitter(sock, senderJid, {
          text: `Invalid selection. Please choose a valid event number (1 to ${eventsConfig.events.length}):`,
        });
        return;
      }

      const selectedEvent = eventsConfig.events[choice - 1];

      // Check event status (ACTIVE vs PAUSED / CLOSED)
      if (selectedEvent.status === 'PAUSED' || selectedEvent.status === 'CLOSED') {
        await sendWithJitter(sock, senderJid, {
          text: `⚠️ Registrations for *${selectedEvent.name}* are currently ${selectedEvent.status}. Please choose an active event.`,
        });
        return;
      }

      // Alteration 3: Slot Capacity Hard-Cap (SOLD OUT Trigger)
      const regCount = await getEventRegistrationCount(selectedEvent.id);
      if (selectedEvent.slot_limit && selectedEvent.slot_limit > 0 && regCount >= selectedEvent.slot_limit) {
        const soldOutNotice = renderTemplate('event_sold_out', {
          event_name: selectedEvent.name,
          slot_limit: selectedEvent.slot_limit,
        });
        await sendWithJitter(sock, senderJid, { text: soldOutNotice });
        return;
      }

      // Part 2, Item 2: Live Duplicate Roll Number Interceptor (Host & External Tracks)
      if (session.data.rollNumber) {
        const dupCheck = await checkDuplicateRoll(session.data.rollNumber, selectedEvent.id);
        if (dupCheck.exists) {
          const existingRec = dupCheck.record;
          const dupMsg = renderTemplate('duplicate_roll_error', {
            reg_no: session.data.rollNumber,
            event_name: existingRec?.event_name || selectedEvent.name,
            od_status: existingRec?.od_status || 'PENDING_APPROVAL',
          });
          await sendWithJitter(sock, senderJid, { text: dupMsg });
          return;
        }
      }

      session.data.eventId = selectedEvent.id;
      session.data.eventName = selectedEvent.name;
      session.data.venue = selectedEvent.venue;
      session.data.schedule = selectedEvent.schedule;
      session.data.eventObj = selectedEvent;
      session.data.maxTeamSize = selectedEvent.max_team_size || 1;
      session.data.teamMembers = [
        { name: session.data.fullName, roll: session.data.rollNumber, role: 'Lead' },
      ];

      // Alteration 2: Team Track Registrations
      if (selectedEvent.max_team_size && selectedEvent.max_team_size > 1) {
        session.step = 'COLLECT_TEAM_NAME';
        const teamPrompt = renderTemplate('ask_team_name', {
          event_name: selectedEvent.name,
          max_team_size: selectedEvent.max_team_size,
        });
        await sendWithJitter(sock, senderJid, { text: teamPrompt });
        return;
      }

      // Solo event -> route to post-selection
      await routePostEventSelection(sock, senderJid, session, selectedEvent);
      break;
    }

    // Alteration 2: Team Name Collection
    case 'COLLECT_TEAM_NAME': {
      if (cleanText.length < 2) {
        await sendWithJitter(sock, senderJid, { text: '⚠️ Please enter a valid Team Name (at least 2 letters):' });
        return;
      }
      session.data.teamName = cleanText;
      session.data.nextTeammateNum = 2;
      session.step = 'COLLECT_TEAM_MEMBER';

      const teammatePrompt = renderTemplate('ask_teammate', { num: 2 });
      await sendWithJitter(sock, senderJid, { text: teammatePrompt });
      break;
    }

    // Alteration 2: Teammate Name & Roll Collection
    case 'COLLECT_TEAM_MEMBER': {
      const isSkip = /^skip$/i.test(cleanText);

      if (!isSkip) {
        let memberName = cleanText;
        let memberRoll = '';

        if (cleanText.includes('|')) {
          const parts = cleanText.split('|').map((s) => s.trim());
          memberName = parts[0];
          memberRoll = (parts[1] || '').toUpperCase();
        } else if (cleanText.includes(',')) {
          const parts = cleanText.split(',').map((s) => s.trim());
          memberName = parts[0];
          memberRoll = (parts[1] || '').toUpperCase();
        } else {
          const parts = cleanText.split(/\s+/);
          if (parts.length >= 2) {
            memberRoll = parts[parts.length - 1].toUpperCase();
            memberName = parts.slice(0, parts.length - 1).join(' ');
          }
        }

        session.data.teamMembers.push({
          name: memberName,
          roll: memberRoll,
          role: `Member ${session.data.nextTeammateNum}`,
        });
      }

      session.data.nextTeammateNum += 1;

      if (!isSkip && session.data.nextTeammateNum <= session.data.maxTeamSize) {
        const nextPrompt = renderTemplate('ask_teammate', { num: session.data.nextTeammateNum });
        await sendWithJitter(sock, senderJid, { text: nextPrompt });
        return;
      }

      // All teammates added or user skipped -> route to post selection
      const selectedEvent = session.data.eventObj;
      await routePostEventSelection(sock, senderJid, session, selectedEvent);
      break;
    }

    // Track A: Mentor Name
    case 'COLLECT_MENTOR_NAME': {
      if (cleanText.length < 2) {
        await sendWithJitter(sock, senderJid, { text: renderTemplate('ask_mentor_name') });
        return;
      }
      session.data.mentorName = cleanText;
      session.step = 'COLLECT_MENTOR_PHONE';
      await sendWithJitter(sock, senderJid, {
        text: renderTemplate('ask_mentor_phone'),
      });
      break;
    }

    // Track A: Mentor Phone & Pass Generation
    case 'COLLECT_MENTOR_PHONE': {
      const cleanPhone = cleanText.replace(/\D/g, '').slice(-10);
      if (cleanPhone.length !== 10) {
        await sendWithJitter(sock, senderJid, {
          text: renderTemplate('invalid_phone'),
        });
        return;
      }

      // Self-mentor prevention check
      if (studentDigits && studentDigits === cleanPhone) {
        await sendWithJitter(sock, senderJid, {
          text: renderTemplate('self_mentor_error'),
        });
        return;
      }

      session.data.mentorPhone = cleanPhone;

      await sendWithJitter(sock, senderJid, {
        text: renderTemplate('generating_pass'),
      });

      // Save registration to Supabase with team data
      await saveRegistration({
        phoneNumber: session.data.phoneNumber,
        fullName: session.data.fullName,
        collegeName: session.data.collegeName,
        department: session.data.department || null,
        rollNumber: session.data.rollNumber,
        eventId: session.data.eventId,
        eventName: session.data.eventName,
        amountPaid: 0,
        utrNumber: null,
        mentorName: session.data.mentorName,
        mentorPhone: cleanPhone,
        odStatus: 'PENDING_APPROVAL',
        teamName: session.data.teamName || null,
        teamMembers: session.data.teamMembers || [],
      });

      // Generate dynamic pass with HMAC signature and team data
      const passBuffer = await generateEventPass({
        fullName: session.data.fullName,
        rollNumber: session.data.rollNumber,
        collegeName: session.data.collegeName,
        eventName: session.data.eventName,
        eventId: session.data.eventId,
        venue: session.data.venue,
        schedule: session.data.schedule,
        odStatus: 'PENDING_APPROVAL',
        teamName: session.data.teamName || null,
        teamMembers: session.data.teamMembers || [],
      });

      // Send pass image to participant
      const passCaption = renderTemplate('registration_confirmed_host', {
        student_name: session.data.fullName,
        reg_no: session.data.rollNumber,
        event_name: session.data.eventName,
        mentor_name: session.data.mentorName,
      });

      await sendWithJitter(sock, senderJid, {
        image: passBuffer,
        caption: passCaption,
      });

      // Dispatch verification alert to mentor on WhatsApp
      await notifyMentorForHostApproval(sock, session.data);

      // Add to event WhatsApp group / fallback invite link
      const groupResult = await addParticipantToEventGroup(sock, senderJid, session.data.eventObj);
      if (groupResult.message) {
        await sendWithJitter(sock, senderJid, { text: groupResult.message });
      }

      // Finish session
      resetSession(senderJid);
      break;
    }

    // Track B, Step 1: Validate 12-digit Manual UTR Entry
    case 'COLLECT_MANUAL_UTR': {
      const cleanUtr = cleanText.replace(/\D/g, '');
      if (cleanUtr.length !== 12) {
        await sendWithJitter(sock, senderJid, {
          text: renderTemplate('invalid_manual_utr'),
        });
        return;
      }

      // Check if UTR was already recorded in Supabase (Anti-Fraud Check 1)
      const dupCheck = await checkUTRDuplicate(cleanUtr);
      if (dupCheck.exists) {
        await sendWithJitter(sock, senderJid, {
          text: renderTemplate('payment_duplicate', {
            utr_number: cleanUtr,
            upi_id: eventsConfig.payment?.upiId || process.env.UPI_VPA || '',
          }),
        });
        return;
      }

      session.data.manualUtr = cleanUtr;
      session.step = 'AWAITING_RECEIPT_SCREENSHOT';

      const promptMsg = renderTemplate('ask_receipt_screenshot', {
        manual_utr: cleanUtr,
        delegate_id: session.data.delegateId || 'NONE',
      });

      await sendWithJitter(sock, senderJid, { text: promptMsg });
      break;
    }

    // Track B, Step 2: Mandatory Screenshot Upload & Multi-Layer Anti-Fraud Engine
    case 'AWAITING_RECEIPT_SCREENSHOT': {
      if (!imageBuffer) {
        await sendWithJitter(sock, senderJid, {
          text: `📸 *Screenshot Mandatory:*\nPlease upload your payment screenshot showing UTR: *${session.data.manualUtr}* and Note: *${session.data.delegateId}*.`,
        });
        return;
      }

      await sendWithJitter(sock, senderJid, {
        text: `🔍 Verifying receipt authenticity & checking transaction note...`,
      });

      // Execute Multi-Layer Anti-Fraud Inspection (Metadata + Multimodal Vision AI)
      const audit = await executeFraudInspection({
        imageBuffer,
        expectedNote: session.data.delegateId,
        expectedAmount: session.data.fee,
        manualUtr: session.data.manualUtr,
        sessionData: session.data,
      });

      if (!audit.passed) {
        const failText = renderTemplate('fraud_tampering_rejected', {
          fail_reason: audit.reason || 'Manipulated screenshot or note mismatch.',
        });
        await sendWithJitter(sock, senderJid, { text: failText });
        return;
      }

      // Passed Anti-Fraud Verification -> Process Verified Payment
      await processVerifiedPayment(sock, senderJid, session, session.data.manualUtr);
      break;
    }

    // Track B Fallback / Direct Ingestion
    case 'AWAITING_PAYMENT_PROOF': {
      if (!imageBuffer) {
        // If user typed UTR manually
        const manualUtrMatch = cleanText.match(/\b\d{12}\b/);
        if (!manualUtrMatch) {
          await sendWithJitter(sock, senderJid, {
            text: `Please upload the *screenshot of your UPI payment receipt* or type the 12-digit UTR number directly.`,
          });
          return;
        }

        const utr = manualUtrMatch[0];
        await processVerifiedPayment(sock, senderJid, session, utr);
        return;
      }

      await sendWithJitter(sock, senderJid, {
        text: `Processing payment screenshot via OCR verification...`,
      });

      const ocrResult = await extractUTRFromImage(imageBuffer);

      if (!ocrResult.success || !ocrResult.utr) {
        await sendWithJitter(sock, senderJid, {
          text: renderTemplate('ocr_notice'),
        });
        return;
      }

      await processVerifiedPayment(sock, senderJid, session, ocrResult.utr);
      break;
    }

    // Track B Post-Payment: OD Loop Prompt
    case 'EXTERNAL_OD_CHOICE': {
      if (cleanText === '1') {
        session.step = 'EXTERNAL_FACULTY_NAME';
        await sendWithJitter(sock, senderJid, {
          text: renderTemplate('ask_mentor_name'),
        });
      } else if (cleanText === '2') {
        await sendWithJitter(sock, senderJid, {
          text: `Registration fully completed. We look forward to seeing you at ${eventsConfig.festName || 'the event'}!`,
        });
        resetSession(senderJid);
      } else {
        await sendWithJitter(sock, senderJid, {
          text: renderTemplate('invalid_choice'),
        });
      }
      break;
    }

    // Track B: External Faculty Name
    case 'EXTERNAL_FACULTY_NAME': {
      if (cleanText.length < 2) {
        await sendWithJitter(sock, senderJid, { text: renderTemplate('ask_mentor_name') });
        return;
      }
      session.data.mentorName = cleanText;
      session.step = 'EXTERNAL_FACULTY_PHONE';
      await sendWithJitter(sock, senderJid, {
        text: renderTemplate('ask_mentor_phone'),
      });
      break;
    }

    // Track B: External Faculty Phone & Intimation Dispatch
    case 'EXTERNAL_FACULTY_PHONE': {
      const cleanPhone = cleanText.replace(/\D/g, '').slice(-10);
      if (cleanPhone.length !== 10) {
        await sendWithJitter(sock, senderJid, {
          text: renderTemplate('invalid_phone'),
        });
        return;
      }

      // Self-mentor prevention check
      if (studentDigits && studentDigits === cleanPhone) {
        await sendWithJitter(sock, senderJid, {
          text: renderTemplate('self_mentor_error'),
        });
        return;
      }

      session.data.mentorPhone = cleanPhone;

      // Update Supabase with mentor info
      try {
        await saveRegistration({
          phoneNumber: session.data.phoneNumber,
          fullName: session.data.fullName,
          collegeName: session.data.collegeName,
          department: session.data.department || null,
          rollNumber: session.data.rollNumber,
          eventId: session.data.eventId,
          eventName: session.data.eventName,
          amountPaid: session.data.amountPaid,
          utrNumber: session.data.utrNumber,
          mentorName: session.data.mentorName,
          mentorPhone: cleanPhone,
          odStatus: 'PENDING_APPROVAL',
          teamName: session.data.teamName || null,
          teamMembers: session.data.teamMembers || [],
        });
      } catch (_) {}

      // Dispatch formal participation intimation to faculty
      await notifyExternalFacultyIntimation(sock, session.data);

      await sendWithJitter(sock, senderJid, {
        text: renderTemplate('faculty_intimation_dispatched', { mentor_name: session.data.mentorName }),
      });

      resetSession(senderJid);
      break;
    }

    default: {
      resetSession(senderJid);
      await sendWithJitter(sock, senderJid, {
        text: renderTemplate('session_default_help'),
      });
      break;
    }
  }
}

/**
 * Handles locked UTR verification, generates ticket, and triggers external OD loop.
 */
async function processVerifiedPayment(sock, senderJid, session, utr) {
  const eventsConfig = getEventsConfig();

  // Check Supabase for unique UTR lock
  try {
    const { exists } = await checkUTRDuplicate(utr);
    if (exists) {
      await sendWithJitter(sock, senderJid, {
        text: renderTemplate('payment_duplicate', {
          utr_number: utr,
          upi_id: eventsConfig.payment?.upiId || process.env.UPI_VPA || '',
        }),
      });
      return;
    }
  } catch (err) {
    console.warn('[UTR CHECK WARNING]', err.message);
  }

  session.data.utrNumber = utr;

  // Save to Supabase with team data
  await saveRegistration({
    phoneNumber: session.data.phoneNumber,
    fullName: session.data.fullName,
    collegeName: session.data.collegeName,
    department: session.data.department || null,
    rollNumber: session.data.rollNumber,
    eventId: session.data.eventId,
    eventName: session.data.eventName,
    amountPaid: session.data.amountPaid,
    utrNumber: utr,
    mentorName: null,
    mentorPhone: null,
    odStatus: 'APPROVED',
    delegateId: session.data.delegateId || null,
    teamName: session.data.teamName || null,
    teamMembers: session.data.teamMembers || [],
  });

  // Generate dynamic pass with team data
  const passBuffer = await generateEventPass({
    fullName: session.data.fullName,
    rollNumber: session.data.rollNumber,
    collegeName: session.data.collegeName,
    eventName: session.data.eventName,
    eventId: session.data.eventId,
    venue: session.data.venue,
    schedule: session.data.schedule,
    odStatus: 'APPROVED',
    utrNumber: utr,
    delegateId: session.data.delegateId || null,
    teamName: session.data.teamName || null,
    teamMembers: session.data.teamMembers || [],
  });

  const passCaption = renderTemplate('payment_verified_pass', {
    utr_number: utr,
    fee: session.data.amountPaid,
    event_name: session.data.eventName,
    venue: session.data.venue,
  });

  await sendWithJitter(sock, senderJid, {
    image: passBuffer,
    caption: passCaption,
  });

  // Add to group / fallback link
  const groupResult = await addParticipantToEventGroup(sock, senderJid, session.data.eventObj);
  if (groupResult.message) {
    await sendWithJitter(sock, senderJid, { text: groupResult.message });
  }

  // Post-Payment OD Loop for External Track
  session.step = 'EXTERNAL_OD_CHOICE';
  await sendWithJitter(sock, senderJid, {
    text: renderTemplate('external_od_choice'),
  });
}
