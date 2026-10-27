import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  Browsers,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { handleIncomingMessage } from './stateMachine.js';
import { handleMentorResponse } from './mentorListener.js';
import { handleSpotRegistration } from './spotRegistrar.js';
import { handleWhatsAppBroadcast } from './broadcastManager.js';
import { terminateOCRWorker } from './ocrVerifier.js';
import { initializePassAsset } from './passGenerator.js';
import { renderTemplate } from './templateManager.js';
import QRCode from 'qrcode';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUTH_FOLDER = process.env.AUTH_FOLDER || path.join(__dirname, '..', 'auth_info_baileys');

// Ensure auth directory exists
if (!fs.existsSync(AUTH_FOLDER)) {
  fs.mkdirSync(AUTH_FOLDER, { recursive: true });
}

let sock = null;
let reconnectAttempts = 0;

/**
 * Initializes and starts the Baileys WhatsApp bot lifecycle.
 * @param {object} [options]
 * @param {boolean} [options.usePairingCode] - Prefer 8-digit pairing code over QR scan
 * @param {string} [options.pairingPhone] - Phone number for pairing code
 * @param {boolean} [options.freshSession] - Purge incomplete session on fresh initial launch
 * @param {boolean} [options.isReconnect] - Internal flag indicating automated stream reconnect
 */
export async function startFestFlowBot(options = {}) {
  console.log('[FESTFLOW] Booting WhatsApp Event Registration Service...');

  // Ensure asset templates are present
  try {
    await initializePassAsset();
  } catch (err) {
    console.warn('[FESTFLOW ASSET NOTE]', err.message);
  }

  // Safely close any previous lingering socket before initializing a new one
  if (sock) {
    try {
      sock.ev?.removeAllListeners();
      sock.ws?.close?.();
      sock.end?.();
    } catch (_) {}
    sock = null;
  }

  // Purge uncompleted credentials ONLY on fresh explicit initial launch (NEVER on internal 515 stream reconnects!)
  if (options.freshSession && !options.isReconnect && fs.existsSync(AUTH_FOLDER)) {
    try {
      const credsPath = path.join(AUTH_FOLDER, 'creds.json');
      if (fs.existsSync(credsPath)) {
        const raw = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
        if (!raw.registered) {
          fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
          fs.mkdirSync(AUTH_FOLDER, { recursive: true });
        }
      }
    } catch (_) {}
  }

  const logger = pino({ level: 'silent' });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({
    version: [2, 3000, 1015901307],
    isLatest: true,
  }));

  console.log(`[BAILEYS] Using WhatsApp Web version v${version.join('.')}`);

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    browser: Browsers.ubuntu('Chrome'), // Standard Ubuntu/Chrome signature recognized by WhatsApp MD servers
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    markOnlineOnConnect: false,
  });

  // Support WhatsApp 8-digit Pairing Code (Mobile Pairing Code Over Terminal QR)
  const targetPhone = options.pairingPhone || process.env.BOT_PHONE_NUMBER || null;
  const botPhone = targetPhone ? targetPhone.replace(/\D/g, '') : null;
  const isPairingMode = options.usePairingCode !== undefined
    ? Boolean(options.usePairingCode && botPhone && !state.creds.registered)
    : Boolean(botPhone && !state.creds.registered);

  if (isPairingMode && botPhone && !state.creds.registered && !options.isReconnect) {
    setTimeout(async () => {
      try {
        if (!sock || state.creds.registered) return;
        const rawCode = await sock.requestPairingCode(botPhone);
        const code = rawCode && rawCode.length === 8 ? `${rawCode.slice(0, 4)}-${rawCode.slice(4)}` : rawCode;

        console.log('\n' + '━'.repeat(60));
        console.log(`  WHATSAPP MOBILE PAIRING CODE:  ${code}`);
        console.log('━'.repeat(60));
        console.log('  1. Open WhatsApp on phone -> Settings (or 3-dots)');
        console.log('  2. Tap "Linked Devices" -> "Link a Device"');
        console.log('  3. Tap "Link with phone number instead" at the bottom');
        console.log(`  4. Enter the 8-character code: ${code}`);
        console.log('━'.repeat(60));
        console.log('  ⚠️  DO NOT CLOSE THIS TERMINAL — Keep it running while linking!');
        console.log('━'.repeat(60) + '\n');
      } catch (err) {
        console.error('[PAIRING CODE ERROR]', err.message);
      }
    }, 2500);
  }

  // Handle credentials persistence
  sock.ev.on('creds.update', saveCreds);

  // Connection lifecycle management
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Render terminal QR only if pairing code is not active or credentials already exist
    if (qr && !isPairingMode) {
      try {
        const terminalQR = await QRCode.toString(qr, { type: 'terminal', small: true });
        console.log('\n' + terminalQR);
        console.log('[QR CODE] Scan the QR code above with WhatsApp (Linked Devices) to link FestFlow.\n');
      } catch (qrErr) {
        console.log('[QR CODE RAW STRING]:', qr);
      }
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const isRestartRequired = statusCode === DisconnectReason.restartRequired; // Status 515

      console.warn(`[CONNECTION CLOSED] Status Code: ${statusCode} (${isRestartRequired ? 'restartRequired (515)' : isLoggedOut ? 'loggedOut (401)' : 'streamClose'})`);

      if (isLoggedOut) {
        console.warn('[AUTH EXPIRED] Device logged out or unlinked. Clearing credentials for fresh re-pair...');
        try {
          fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
          fs.mkdirSync(AUTH_FOLDER, { recursive: true });
        } catch (_) {}
        setTimeout(() => {
          startFestFlowBot({ ...options, freshSession: true, isReconnect: false }).catch((e) => console.error('[RECONNECT ERROR]', e));
        }, 1500);
      } else if (isRestartRequired) {
        // Status 515 is completely normal on initial pairing / QR sync. Restart WebSocket stream immediately with saved keys!
        console.log('[STREAM RESTART] WhatsApp requested session handshake restart (Status 515). Reconnecting with saved credentials in 500ms...');
        setTimeout(() => {
          startFestFlowBot({ ...options, freshSession: false, isReconnect: true }).catch((e) => console.error('[RECONNECT ERROR]', e));
        }, 500);
      } else {
        reconnectAttempts++;
        const backoffDelay = Math.min(reconnectAttempts * 2000, 10000);
        console.log(`[RECONNECTING] Retrying in ${backoffDelay / 1000}s (Attempt ${reconnectAttempts})...`);
        setTimeout(() => {
          startFestFlowBot({ ...options, freshSession: false, isReconnect: true }).catch((e) => console.error('[RECONNECT ERROR]', e));
        }, backoffDelay);
      }
    } else if (connection === 'open') {
      reconnectAttempts = 0;
      console.log('\n' + '='.repeat(60));
      console.log(' [FESTFLOW] WhatsApp Engine Connected & Online!');
      console.log(' Ready to receive attendee registrations, team tracks, and desk spot passes.');
      console.log('='.repeat(60) + '\n');
    }
  });

  // Incoming message listener
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;

    for (const msg of messages) {
      try {
        if (!msg.message) continue;
        if (msg.key.fromMe) continue; // Ignore bot's own messages

        const remoteJid = msg.key.remoteJid;
        if (!remoteJid) continue;

        // Extract message text content from standard Baileys message types
        const textContent =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          msg.message.videoMessage?.caption ||
          '';

        let imageBuffer = null;

        // If media message, attempt safe buffer download
        if (msg.message.imageMessage) {
          try {
            imageBuffer = await downloadMediaMessage(
              msg,
              'buffer',
              {},
              {
                logger: pino({ level: 'silent' }),
                reuploadRequest: sock.updateMediaMessage,
              }
            );
          } catch (mediaErr) {
            console.warn('[MEDIA DOWNLOAD FAILED] Could not fetch image buffer:', mediaErr.message);
          }
        }

        // 1. Alteration 4: Spot / Walk-In Volunteer Desk Mode (#SPOT)
        const spotCheck = await handleSpotRegistration(sock, remoteJid, textContent);
        if (spotCheck.handled) {
          continue;
        }

        // 2. Part 2, Item 3: Admin Broadcast Dispatch (#BROADCAST)
        const broadcastCheck = await handleWhatsAppBroadcast(sock, remoteJid, textContent);
        if (broadcastCheck.handled) {
          continue;
        }

        // 3. Alteration 1: Mentor OD responses (YES ALL / YES <RollNo>)
        const mentorCheck = await handleMentorResponse(sock, remoteJid, textContent);
        if (mentorCheck.handled) {
          if (mentorCheck.responseText) {
            await sock.sendMessage(remoteJid, { text: mentorCheck.responseText });
          }
          continue;
        }

        // 4. Delegate to Conversational State Machine
        await handleIncomingMessage(sock, msg, textContent, imageBuffer);
      } catch (err) {
        console.error(`[MESSAGE HANDLER ERROR for ${msg.key?.remoteJid}]:`, err);
        try {
          if (msg.key?.remoteJid && sock?.sendMessage) {
            const userErrorNotice =
              renderTemplate('generic_snag_error') ||
              '⚠️ We hit a temporary snag processing your request. Please try again or visit the helpdesk.';
            await sock.sendMessage(msg.key.remoteJid, {
              text: userErrorNotice,
            });
          }
        } catch (_) {}
      }
    }
  });

  return sock;
}

// Graceful process exit handling
process.on('SIGINT', async () => {
  console.log('\n[FESTFLOW] Shutting down cleanly...');
  await terminateOCRWorker();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[FESTFLOW] Shutting down cleanly...');
  await terminateOCRWorker();
  process.exit(0);
});

// Auto-run if executed directly
if (process.argv[1] && process.argv[1].endsWith('bot.js')) {
  startFestFlowBot().catch((err) => {
    console.error('[FATAL BOOT ERROR]', err);
  });
}
