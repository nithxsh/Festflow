import * as p from '@clack/prompts';
import pc from 'picocolors';
import { handleIncomingMessage, resetSession, getSession } from './stateMachine.js';
import { handleMentorResponse } from './mentorListener.js';
import { handleSpotRegistration } from './spotRegistrar.js';
import { handleWhatsAppBroadcast } from './broadcastManager.js';
import { createCanvas } from './canvasAdapter.js';

/**
 * Generates an authentic mock UPI payment receipt PNG buffer for simulation testing.
 * @param {string} utr
 * @param {string} note
 * @param {number|string} amount
 * @returns {Buffer}
 */
export function generateMockReceiptBuffer(utr = '123456789012', note = 'NX26-8A3F', amount = 150) {
  const canvas = createCanvas(600, 320);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 600, 320);
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText('UPI Payment Successful', 40, 50);
  ctx.font = '18px sans-serif';
  ctx.fillText('Paid to: Fest Committee', 40, 95);
  ctx.fillText(`Amount: INR ${amount}`, 40, 135);
  ctx.fillText(`UPI Ref No: ${utr}`, 40, 175);
  ctx.fillText(`Note: ${note}`, 40, 215);
  ctx.font = '14px sans-serif';
  ctx.fillStyle = '#64748b';
  ctx.fillText(`Timestamp: ${new Date().toISOString()}`, 40, 265);
  return canvas.toBuffer('image/png');
}

/**
 * Generates a mock Canva/Photoshop tampered receipt buffer for fraud detection simulation.
 * @param {string} [tool='Canva']
 * @returns {Buffer}
 */
export function generateMockTamperedBuffer(tool = 'Canva') {
  const cleanReceipt = generateMockReceiptBuffer('999988887777', 'FAKE-NOTE', 150);
  const fakeHeader = Buffer.from(
    `\xFF\xD8\xFF\xE0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00Software\x00${tool} Web Editor v2.0`
  );
  return Buffer.concat([fakeHeader, cleanReceipt]);
}

/**
 * Runs an in-terminal interactive chat session mocking Baileys WhatsApp socket messages
 * against the live stateMachine, OCR verifier, and Supabase database.
 */
export async function runSimulator() {
  console.clear();
  p.intro(pc.bgCyan(pc.black(' FESTFLOW // INTERACTIVE TERMINAL SIMULATOR ')));

  p.note(
    `Simulate WhatsApp attendee registrations & mentor OD verifications without a linked phone.\n\n` +
      `Commands:\n` +
      `• Type any text to simulate incoming attendee message\n` +
      `• Type ${pc.cyan('/utr <12_DIGITS>')} to submit manual UTR or receipt upload\n` +
      `• Type ${pc.cyan('/receipt')} to simulate authentic screenshot upload with Delegate ID\n` +
      `• Type ${pc.cyan('/scam')} to simulate Canva/Photoshop fake receipt detection\n` +
      `• Type ${pc.cyan('/fake_note')} to simulate receipt with mismatched Delegate ID\n` +
      `• Type ${pc.cyan('/mentor YES ALL')} or ${pc.cyan('/mentor YES <RollNo>')} to simulate mentor OD reply\n` +
      `• Type ${pc.cyan('#SPOT Name | College | Dept | Roll | EventID | CASH')} to simulate spot desk pass\n` +
      `• Type ${pc.cyan('#BROADCAST <event_id> | <message>')} to test admin announcements\n` +
      `• Type ${pc.cyan('RESET')} or ${pc.cyan('STATUS')} to test escape & inquiry flows\n` +
      `• Type ${pc.cyan('/exit')} to return to main menu`,
    'Simulator Instructions'
  );

  const studentJid = `sim_user_${Date.now()}@s.whatsapp.net`;
  let mentorJid = `sim_mentor_${Date.now()}@s.whatsapp.net`;

  // Mock Baileys socket
  const mockSock = {
    sendPresenceUpdate: async (presence, jid) => {
      // Subtly indicate composing without cluttering terminal
    },

    sendMessage: async (jid, content) => {
      const isStudent = jid === studentJid;
      let targetLabel = pc.green('[BOT -> ATTENDEE]');

      if (!isStudent) {
        mentorJid = jid;
        const phone = jid.replace('@s.whatsapp.net', '');
        targetLabel = pc.yellow(`[BOT -> MENTOR (${phone})]`);
      }

      if (content.text) {
        console.log(`\n${targetLabel}\n${pc.white(content.text)}\n`);
      }

      if (content.image) {
        const byteSize = Buffer.isBuffer(content.image) ? `${Math.round(content.image.length / 1024)} KB` : 'Binary Buffer';
        const isInvoice = content.caption && (content.caption.includes('Invoice') || content.caption.includes('upi://'));
        const bannerLabel = isInvoice ? 'UPI PAYMENT QR GENERATED' : 'DIGITAL PASS GENERATED';
        console.log(`\n${targetLabel} ${pc.bgBlue(pc.white(` ${bannerLabel} (${byteSize} PNG) `))}`);
        if (content.caption) {
          console.log(`${pc.white(content.caption)}\n`);
        }
      }

      return { key: { id: 'sim_' + Date.now(), remoteJid: jid } };
    },

    groupParticipantsUpdate: async (groupJid, participants, action) => {
      console.log(pc.dim(`[WHATSAPP GROUP] Added participant ${participants.join(', ')} to group ${groupJid}`));
      return [{ status: '200', jid: participants[0] }];
    },
  };

  // Trigger initial greeting from bot
  console.log(pc.dim('\n--- Attendee Initiates Conversation ---'));
  const initMsg = {
    key: { remoteJid: studentJid, fromMe: false },
    message: { conversation: 'Hi' },
  };
  await handleIncomingMessage(mockSock, initMsg, 'Hi', null);

  let active = true;

  while (active) {
    const input = await p.text({
      message: pc.cyan('Attendee Input (or /command):'),
      placeholder: 'Type your reply (or /exit)',
    });

    if (p.isCancel(input) || !input) {
      break;
    }

    const trimmed = input.trim();

    if (trimmed.toLowerCase() === '/exit' || trimmed.toLowerCase() === 'exit') {
      active = false;
      break;
    }

    if (trimmed.toLowerCase() === '/reset') {
      resetSession(studentJid);
      p.log.info(pc.yellow('Attendee session state cleared.'));
      continue;
    }

    // Spot Walk-In Registration desk simulation
    if (trimmed.startsWith('#SPOT') || trimmed.startsWith('#spot')) {
      p.log.step(pc.magenta(`[SIMULATING SPOT VOLUNTEER DESK COMMAND]`));
      const spotRes = await handleSpotRegistration(mockSock, studentJid, trimmed);
      if (spotRes.handled) {
        continue;
      }
    }

    // Admin WhatsApp Broadcast simulation
    if (trimmed.startsWith('#BROADCAST') || trimmed.startsWith('#broadcast')) {
      p.log.step(pc.cyan(`[SIMULATING ADMIN #BROADCAST COMMAND]`));
      const bRes = await handleWhatsAppBroadcast(mockSock, studentJid, trimmed);
      if (bRes.handled) {
        continue;
      }
    }

    // Mentor command simulation (explicit /mentor command)
    if (trimmed.startsWith('/mentor')) {
      const mentorCommand = trimmed.replace('/mentor', '').trim() || 'YES ALL';
      const cleanPhone = mentorJid.replace('@s.whatsapp.net', '');
      p.log.step(pc.yellow(`[SIMULATING MENTOR REPLY FROM ${cleanPhone}]: "${mentorCommand}"`));
      const res = await handleMentorResponse(mockSock, mentorJid, mentorCommand);
      if (res.handled && res.responseText) {
        console.log(`\n${pc.yellow(`[BOT -> MENTOR (${cleanPhone})]`)}\n${pc.white(res.responseText)}\n`);
      }
      continue;
    }

    // Direct mentor reply simulation (e.g. attendee types "YES", "YES ALL", "YES 192412600", "NO")
    if (/^(YES|NO|APPROVE|REJECT)(\s+(ALL|[A-Za-z0-9_-]+))?$/i.test(trimmed)) {
      const currentSession = getSession(studentJid);
      if (currentSession.step === 'IDLE' || currentSession.step === 'SELECT_TRACK') {
        const cleanPhone = mentorJid.replace('@s.whatsapp.net', '');
        p.log.step(pc.yellow(`[SIMULATING FACULTY MENTOR REPLY FROM ${cleanPhone}]: "${trimmed.toUpperCase()}"`));
        const res = await handleMentorResponse(mockSock, mentorJid, trimmed);
        if (res.handled && res.responseText) {
          console.log(`\n${pc.yellow(`[BOT -> MENTOR (${cleanPhone})]`)}\n${pc.white(res.responseText)}\n`);
        }
        continue;
      }
    }

    // Simulated fake / tampered receipt (Canva / Photoshop detection test)
    if (trimmed.startsWith('/scam')) {
      p.log.step(pc.red(`[SIMULATING FAKE CANVA RECEIPT UPLOAD]`));
      const scamBuffer = generateMockTamperedBuffer('Canva');
      const fakeImageMsg = {
        key: { remoteJid: studentJid, fromMe: false },
        message: { imageMessage: { caption: 'Canva Edited Receipt' } },
      };

      await handleIncomingMessage(mockSock, fakeImageMsg, 'Paid with Canva receipt', scamBuffer);
      continue;
    }

    // Simulated receipt with missing / mismatched Delegate ID
    if (trimmed.startsWith('/fake_note') || trimmed.startsWith('/wrong_note')) {
      const session = getSession(studentJid);
      p.log.step(pc.yellow(`[SIMULATING RECEIPT WITH WRONG DELEGATE ID NOTE]`));

      const wrongNoteBuffer = generateMockReceiptBuffer(
        session.data?.manualUtr || '123456789012',
        'WRONG_NOTE_999',
        session.data?.fee || 150
      );
      const fakeImageMsg = {
        key: { remoteJid: studentJid, fromMe: false },
        message: { imageMessage: { caption: 'Receipt with invalid note' } },
      };

      await handleIncomingMessage(mockSock, fakeImageMsg, 'Receipt upload', wrongNoteBuffer);
      continue;
    }

    // Simulated authentic payment receipt upload
    if (trimmed.startsWith('/receipt')) {
      const session = getSession(studentJid);
      const utr = session.data?.manualUtr || '123456789012';
      const note = session.data?.delegateId || 'NX26-8A3F';
      const amount = session.data?.fee || 150;

      p.log.step(pc.green(`[SIMULATING AUTHENTIC RECEIPT UPLOAD (UTR: ${utr}, Note: ${note})]`));

      const receiptBuffer = generateMockReceiptBuffer(utr, note, amount);
      const fakeImageMsg = {
        key: { remoteJid: studentJid, fromMe: false },
        message: { imageMessage: { caption: `Payment receipt with Note ${note}` } },
      };

      await handleIncomingMessage(mockSock, fakeImageMsg, 'Paid via UPI', receiptBuffer);
      continue;
    }

    // Simulated payment receipt with 12-digit UTR
    if (trimmed.startsWith('/utr') || trimmed.startsWith('/pay')) {
      const parts = trimmed.split(/\s+/);
      const utr = parts[1];
      if (!utr || !/^\d{12}$/.test(utr)) {
        p.log.error(pc.red('Please specify a 12-digit numeric UTR, e.g. /utr 123456789012'));
        continue;
      }

      const session = getSession(studentJid);

      // If attendee is at step 1 of payment (manual UTR entry)
      if (session.step === 'COLLECT_MANUAL_UTR') {
        p.log.step(pc.cyan(`[SUBMITTING 12-DIGIT MANUAL UTR: ${utr}]`));
        const standardMsg = {
          key: { remoteJid: studentJid, fromMe: false },
          message: { conversation: utr },
        };
        await handleIncomingMessage(mockSock, standardMsg, utr, null);
        continue;
      }

      // If attendee is at screenshot upload step or general verification
      p.log.step(pc.cyan(`[SIMULATING PAYMENT RECEIPT UPLOAD WITH UTR: ${utr}]`));

      const note = session.data?.delegateId || 'NX26-8A3F';
      const amount = session.data?.fee || 150;
      const receiptBuffer = generateMockReceiptBuffer(utr, note, amount);

      const fakeImageMsg = {
        key: { remoteJid: studentJid, fromMe: false },
        message: { imageMessage: { caption: 'Paid via GPay' } },
      };

      await handleIncomingMessage(mockSock, fakeImageMsg, utr, receiptBuffer);
      continue;
    }

    // Standard text message from attendee
    const standardMsg = {
      key: { remoteJid: studentJid, fromMe: false },
      message: { conversation: trimmed },
    };

    await handleIncomingMessage(mockSock, standardMsg, trimmed, null);
  }

  p.outro('Exited simulation mode.');
}
