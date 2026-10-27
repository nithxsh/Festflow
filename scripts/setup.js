import * as p from '@clack/prompts';
import pc from 'picocolors';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
const envPath = path.join(rootDir, '.env');
const eventsJsonPath = path.join(rootDir, 'config', 'events.json');

async function main() {
  console.clear();
  p.intro(pc.bgCyan(pc.black(' FESTFLOW // INITIALIZATION WIZARD ')));

  // Load existing config if available
  let defaultHost = process.env.HOST_COLLEGE_NAME || '';
  let defaultUpi = process.env.UPI_VPA || '';
  let defaultPayee = process.env.UPI_PAYEE_NAME || '';

  if (fs.existsSync(eventsJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(eventsJsonPath, 'utf8'));
      if (parsed.hostCollege?.name) defaultHost = parsed.hostCollege.name;
      if (parsed.payment?.upiId) defaultUpi = parsed.payment.upiId;
      if (parsed.payment?.payeeName) defaultPayee = parsed.payment.payeeName;
    } catch (_) {}
  }

  const projectConfig = await p.group(
    {
      hostCollege: () =>
        p.text({
          message: 'What is the Host College / Institute name?',
          placeholder: 'e.g. Institute of Technology',
          defaultValue: defaultHost,
        }),

      upiVpa: () =>
        p.text({
          message: 'Enter Official UPI VPA / ID for ticket fee collection:',
          placeholder: 'e.g. committee@upi',
          defaultValue: defaultUpi,
          validate: (val) => {
            if (!val.includes('@')) return 'Please enter a valid UPI ID (e.g. name@upi)';
          },
        }),

      upiPayee: () =>
        p.text({
          message: 'Enter Payee Name displayed on UPI payment apps:',
          placeholder: 'e.g. Event Committee',
          defaultValue: defaultPayee,
        }),

      supabaseUrl: () =>
        p.text({
          message: 'Enter your Supabase Project URL (optional for mock mode):',
          placeholder: 'https://xyzcompany.supabase.co',
          defaultValue: '',
        }),

      supabaseKey: () =>
        p.password({
          message: 'Enter your Supabase Service Role Key (secret):',
          mask: '•',
        }),

      geminiApiKey: () =>
        p.password({
          message: 'Enter Google Gemini API Key for Visual Anti-Fraud AI (optional, press Enter to skip):',
          mask: '•',
        }),

      generateSecret: () =>
        p.confirm({
          message: 'Generate a high-entropy 32-byte secret for QR ticket signing?',
          initialValue: true,
        }),

      authMethod: () =>
        p.select({
          message: 'How would you like to link the WhatsApp Bot?',
          options: [
            { value: 'qr', label: 'Scan Visual QR Code in Terminal (Standard)' },
            { value: 'pairing', label: '8-digit Pairing Code via Mobile Number' },
          ],
          initialValue: 'qr',
        }),

      botPhone: ({ results }) => {
        if (results.authMethod === 'pairing') {
          return p.text({
            message: 'Enter the Bot\'s WhatsApp Mobile Number (with country code):',
            placeholder: 'e.g. 91XXXXXXXXXX',
            validate: (val) => {
              const digits = val.replace(/\D/g, '');
              if (digits.length < 10) return 'Please enter a valid phone number with country code';
            },
          });
        }
      },

      groupStrategy: () =>
        p.select({
          message: 'Select WhatsApp Group Distribution Strategy:',
          options: [
            {
              value: 'individual',
              label: '1. Individual Track Groups (Each event has its own dedicated group)',
            },
            {
              value: 'shared',
              label: '2. Single Shared Community (All participants join one central group)',
            },
          ],
          initialValue: 'individual',
        }),

      communityLink: ({ results }) => {
        if (results.groupStrategy === 'shared') {
          return p.text({
            message: 'Enter Central Community WhatsApp Group Invite Link (optional):',
            placeholder: 'https://chat.whatsapp.com/...',
            defaultValue: '',
          });
        }
      },

      adminNumbers: () =>
        p.text({
          message: 'Enter Admin & Volunteer Phone Numbers for #SPOT desk & #BROADCAST (comma-separated):',
          placeholder: 'e.g. 919876543210, 919876543211',
          defaultValue: '',
        }),
    },
    {
      onCancel: () => {
        p.cancel('Setup wizard cancelled.');
        process.exit(0);
      },
    }
  );

  const spinner = p.spinner();

  const generatedSecret = projectConfig.generateSecret
    ? crypto.randomBytes(32).toString('hex')
    : 'festflow_standard_ticket_signing_secret_key_2025';

  const cleanAdminNumbers = (projectConfig.adminNumbers || '')
    .split(',')
    .map((s) => s.replace(/\D/g, '').trim())
    .filter(Boolean);

  // Test Supabase connection if provided
  if (projectConfig.supabaseUrl && projectConfig.supabaseKey) {
    spinner.start('Verifying connection to Supabase database...');
    try {
      const client = createClient(projectConfig.supabaseUrl, projectConfig.supabaseKey);
      const { data, error } = await client.from('registrations').select('count', { count: 'exact', head: true });
      if (error && !error.message.includes('permission denied')) {
        spinner.stop(pc.yellow(`Connected to Supabase, but "registrations" table was not detected. Make sure to execute supabase/schema.sql.`));
      } else {
        spinner.stop(pc.green('Supabase database connection verified successfully.'));
      }
    } catch (e) {
      spinner.stop(pc.yellow(`Supabase connection test notice: ${e.message}`));
    }
  }

  // Write .env file
  spinner.start('Saving configuration to .env...');
  const envContent = `# FestFlow Generated Environment Configuration
# Generated at: ${new Date().toISOString()}

# Supabase Credentials
SUPABASE_URL=${projectConfig.supabaseUrl || ''}
SUPABASE_SERVICE_ROLE_KEY=${projectConfig.supabaseKey || ''}
SUPABASE_STORAGE_BUCKET=fest-passes

# Payment Gateway / UPI details
UPI_VPA=${projectConfig.upiVpa}
UPI_PAYEE_NAME="${projectConfig.upiPayee}"

# Security & Dynamic QR Signing
PASS_SIGNING_SECRET=${generatedSecret}

# Anti-Fraud Visual Forensics (Optional - fallback OCR used if unconfigured)
GEMINI_API_KEY="${projectConfig.geminiApiKey || ''}"

# Institution Configuration
HOST_COLLEGE_NAME="${projectConfig.hostCollege}"
ADMIN_PHONE="${cleanAdminNumbers[0] || ''}"
ADMIN_NUMBERS="${cleanAdminNumbers.join(',')}"

# Group Distribution Strategy (individual | shared)
GROUP_DISTRIBUTION_STRATEGY=${projectConfig.groupStrategy || 'individual'}

# WhatsApp Bot Pairing Phone (optional if using 8-digit pairing code)
BOT_PHONE_NUMBER="${projectConfig.botPhone || ''}"

# Baileys Multi-Auth Session Directory
AUTH_FOLDER=./auth_info_baileys
`;

  fs.writeFileSync(envPath, envContent, 'utf8');

  // Update events.json with host college and UPI details if changed
  if (fs.existsSync(eventsJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(eventsJsonPath, 'utf8'));
      parsed.hostCollege.name = projectConfig.hostCollege;
      parsed.payment.upiId = projectConfig.upiVpa;
      parsed.payment.payeeName = projectConfig.upiPayee;
      parsed.secretKey = generatedSecret;
      parsed.adminNumbers = cleanAdminNumbers;
      parsed.groupDistributionStrategy = projectConfig.groupStrategy || 'individual';
      if (!parsed.sharedCommunityGroup) {
        parsed.sharedCommunityGroup = { groupJid: '', inviteLink: '' };
      }
      if (projectConfig.communityLink) {
        parsed.sharedCommunityGroup.inviteLink = projectConfig.communityLink.trim();
      }
      fs.writeFileSync(eventsJsonPath, JSON.stringify(parsed, null, 2), 'utf8');
    } catch (_) {}
  }

  spinner.stop(pc.green('Configuration saved to .env and config/events.json.'));

  p.outro(pc.green('Configuration saved successfully!'));

  const startNow = await p.confirm({
    message: '🚀 Launch the Live WhatsApp Bot now to link your phone?',
    initialValue: true,
  });

  if (startNow) {
    p.intro(pc.bgGreen(pc.black(' FESTFLOW // LAUNCHING LIVE WHATSAPP ENGINE ')));
    const { startFestFlowBot } = await import('../src/bot.js');
    await startFestFlowBot({
      usePairingCode: projectConfig.authMethod === 'pairing',
      pairingPhone: projectConfig.botPhone,
    });
    return;
  }

  p.note(
    `To connect your WhatsApp device later, run:\n` +
      `• ${pc.cyan('npm run bot:live')} (Start Live Engine directly)\n` +
      `• ${pc.cyan('npm start')} (Master Control Center -> Option 8)`,
    'How to Connect Later'
  );
}

main().catch((err) => {
  console.error(pc.red('Setup failed:'), err);
  process.exit(1);
});
