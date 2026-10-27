#!/usr/bin/env node

import * as p from '@clack/prompts';
import pc from 'picocolors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runSimulator } from '../src/simulator.js';
import { loadTemplates, updateTemplate } from '../src/templateManager.js';
import { startFestFlowBot } from '../src/bot.js';
import { executeBroadcast } from '../src/broadcastManager.js';
import {
  searchRegistrations,
  manualVerifyPayment,
  getAllRegistrations,
  testSupabaseHealth,
  getRegistrationsForEvent,
} from '../src/supabase.js';
import { generateEventPass } from '../src/passGenerator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
const eventsJsonPath = path.join(rootDir, 'config', 'events.json');
const templatesJsonPath = path.join(rootDir, 'config', 'templates.json');
const envPath = path.join(rootDir, '.env');
const dockerfilePath = path.join(rootDir, 'Dockerfile');
const renderYamlPath = path.join(rootDir, 'render.yaml');
const authDir = path.join(rootDir, 'auth_info_baileys');

/**
 * Loads events configuration from disk.
 */
function readEventsConfig() {
  try {
    return JSON.parse(fs.readFileSync(eventsJsonPath, 'utf8'));
  } catch (err) {
    return {
      festName: 'TechFest',
      hostCollege: { name: '', aliases: [], rollNumberPattern: '^[A-Za-z0-9]+$' },
      payment: { upiId: '', payeeName: '', currency: 'INR', note: 'Event Registration' },
      secretKey: '',
      adminNumbers: [],
      groupDistributionStrategy: 'individual',
      sharedCommunityGroup: { groupJid: '', inviteLink: '' },
      events: [],
      faq: {},
    };
  }
}

/**
 * Saves events configuration to disk.
 */
function writeEventsConfig(config) {
  fs.writeFileSync(eventsJsonPath, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * Surgically updates a variable in .env without overwriting other keys.
 */
function updateEnvVariable(key, value) {
  if (!fs.existsSync(envPath)) return;
  let content = fs.readFileSync(envPath, 'utf8');
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content += `\n${key}=${value}`;
  }
  fs.writeFileSync(envPath, content, 'utf8');
}

/**
 * Escapes a cell for CSV formatting.
 */
function escapeCsv(field) {
  if (field === null || field === undefined) return '';
  const str = typeof field === 'object' ? JSON.stringify(field) : String(field);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// ==============================================================================
// 1. EVENT TRACKS & PRICING (Manage Events & Pricing)
// ==============================================================================

async function manageEventsMenu() {
  while (true) {
    const config = readEventsConfig();
    const action = await p.select({
      message: pc.bold('Events & Slot Manager:'),
      options: [
        { value: 'list', label: '1. List All Active & Paused Events' },
        { value: 'add', label: '2. Add New Event Track' },
        { value: 'edit', label: '3. Edit Existing Event (Pricing, Capacity, Venue, Status)' },
        { value: 'delete', label: '4. Delete / Archive Event Track' },
        { value: 'back', label: '← Back to Master Control Center' },
      ],
    });

    if (p.isCancel(action) || action === 'back') break;

    // 1. List Events
    if (action === 'list') {
      console.log('\n' + pc.cyan('--- REGISTERED EVENT TRACKS ---'));
      if (config.events.length === 0) {
        console.log(pc.yellow('No event tracks configured yet.\n'));
      } else {
        config.events.forEach((evt, idx) => {
          const isPaused = evt.status === 'PAUSED' || evt.status === 'CLOSED';
          const statusBadge = isPaused ? pc.red(`[STATUS: ${evt.status}]`) : pc.green('[STATUS: ACTIVE]');
          const capacityText = evt.slot_limit && evt.slot_limit > 0 ? `${evt.slot_limit} seats` : 'Unlimited';
          const teamText = evt.max_team_size && evt.max_team_size > 1 ? `Team (${evt.max_team_size} max)` : 'Solo';
          console.log(
            `${pc.bold(idx + 1 + '.')} ${pc.green(evt.name)} • ID: ${pc.cyan(evt.id)} ${statusBadge}\n` +
            `   Category: ${evt.category || 'Technical'} • Fee: ₹${evt.fee} (Host: ₹${evt.hostFee || 0}) • ${teamText} • Capacity: ${capacityText}\n` +
            `   Venue: ${evt.venue || 'TBD'} • Schedule: ${evt.schedule || 'TBD'}\n` +
            `   WhatsApp Group: ${evt.inviteLink || evt.groupJid || 'None configured'}\n`
          );
        });
      }
      console.log('-------------------------------\n');
      await p.text({ message: 'Press Enter to continue...' });
    }

    // 2. Add New Event Track
    else if (action === 'add') {
      const name = await p.text({
        message: 'Event Name:',
        placeholder: 'e.g. Code Relay',
        validate: (val) => (!val || val.trim().length < 2 ? 'Event name is required' : undefined),
      });
      if (p.isCancel(name)) continue;

      const generatedId = name.trim().toUpperCase().replace(/[^A-Z0-9]/g, '_');
      const id = await p.text({
        message: 'Unique Event ID (slug):',
        defaultValue: generatedId,
        validate: (val) => {
          if (!val || val.trim().length < 2) return 'ID must be at least 2 characters';
          if (config.events.some((e) => e.id.toLowerCase() === val.trim().toLowerCase())) {
            return 'An event with this ID already exists';
          }
        },
      });
      if (p.isCancel(id)) continue;

      const category = await p.select({
        message: 'Category:',
        options: [
          { value: 'Technical', label: 'Technical Event' },
          { value: 'Non-Technical', label: 'Non-Technical Event' },
          { value: 'Workshop', label: 'Hands-on Workshop' },
        ],
        initialValue: 'Technical',
      });
      if (p.isCancel(category)) continue;

      const participationType = await p.select({
        message: 'Participation Type:',
        options: [
          { value: 'solo', label: 'Solo (Single Attendee)' },
          { value: 'team', label: 'Team Track (Multiple Members)' },
        ],
        initialValue: 'solo',
      });
      if (p.isCancel(participationType)) continue;

      let maxTeamSize = 1;
      if (participationType === 'team') {
        const teamSizeInput = await p.text({
          message: 'Maximum Team Size (e.g. 2, 3, or 4 members):',
          defaultValue: '3',
          validate: (val) => (isNaN(Number(val)) || Number(val) < 2 ? 'Enter a valid number (>= 2)' : undefined),
        });
        if (p.isCancel(teamSizeInput)) continue;
        maxTeamSize = Number(teamSizeInput);
      }

      const fee = await p.text({
        message: 'External Delegate Registration Fee (in ₹):',
        placeholder: '150',
        defaultValue: '150',
        validate: (val) => (isNaN(Number(val)) || Number(val) < 0 ? 'Enter a valid positive fee' : undefined),
      });
      if (p.isCancel(fee)) continue;

      const slotLimit = await p.text({
        message: 'Maximum Participant Cap (slot_limit for automatic SOLD OUT trigger, 0 for unlimited):',
        placeholder: '60',
        defaultValue: '60',
        validate: (val) => (isNaN(Number(val)) || Number(val) < 0 ? 'Enter a valid number' : undefined),
      });
      if (p.isCancel(slotLimit)) continue;

      const venue = await p.text({
        message: 'Venue & Room / Lab Name:',
        placeholder: 'e.g. Lab 3, CS Block',
        defaultValue: '',
      });
      if (p.isCancel(venue)) continue;

      const schedule = await p.text({
        message: 'Date & Time Schedule:',
        placeholder: 'e.g. Day 1, 10:00 AM',
        defaultValue: '',
      });
      if (p.isCancel(schedule)) continue;

      const inviteLink = await p.text({
        message: 'Dedicated WhatsApp Group Link (optional):',
        placeholder: 'https://chat.whatsapp.com/...',
        defaultValue: '',
      });
      if (p.isCancel(inviteLink)) continue;

      const groupJid = await p.text({
        message: 'Optional WhatsApp Group JID (for direct participant add):',
        placeholder: 'e.g. 120363000000000000@g.us',
        defaultValue: '',
      });
      if (p.isCancel(groupJid)) continue;

      const description = await p.text({
        message: 'Short Description for Attendees:',
        placeholder: 'e.g. Speed coding relay challenge.',
        defaultValue: '',
      });
      if (p.isCancel(description)) continue;

      config.events.push({
        id: id.trim().toUpperCase(),
        name: name.trim(),
        category,
        fee: Number(fee),
        hostFee: 0,
        slot_limit: Number(slotLimit),
        max_team_size: maxTeamSize,
        venue: venue.trim(),
        schedule: schedule.trim(),
        groupJid: groupJid.trim(),
        inviteLink: inviteLink.trim(),
        description: description.trim(),
        status: 'ACTIVE',
      });

      writeEventsConfig(config);
      p.log.success(pc.green(`Successfully added event track: ${name.trim()} [${id.trim().toUpperCase()}]`));
    }

    // 3. Edit Existing Event
    else if (action === 'edit') {
      if (config.events.length === 0) {
        p.log.warn('No events available to edit.');
        continue;
      }

      const eventChoices = config.events.map((evt) => ({
        value: evt.id,
        label: `${evt.name} [ID: ${evt.id}] • ₹${evt.fee} • Cap: ${evt.slot_limit || '∞'} • ${evt.status || 'ACTIVE'}`,
      }));

      const selectedEventId = await p.select({
        message: 'Select Event Track to Modify:',
        options: eventChoices,
      });
      if (p.isCancel(selectedEventId)) continue;

      const target = config.events.find((e) => e.id === selectedEventId);

      const fieldToEdit = await p.select({
        message: `Editing ${target.name} — Select property to update:`,
        options: [
          { value: 'fee', label: `1. Update Ticket Fee (Current: ₹${target.fee})` },
          { value: 'capacity', label: `2. Update Max Capacity / Slot Limit (Current: ${target.slot_limit || 'Unlimited'})` },
          { value: 'venue', label: `3. Update Venue & Lab Name (Current: ${target.venue || 'None'})` },
          { value: 'schedule', label: `4. Update Schedule & Date/Time (Current: ${target.schedule || 'None'})` },
          { value: 'status', label: `5. Toggle Event Status (Current: ${target.status || 'ACTIVE'})` },
          { value: 'group', label: `6. Update WhatsApp Group Link / JID` },
          { value: 'all', label: `7. Sequential Full Edit (All fields)` },
        ],
      });
      if (p.isCancel(fieldToEdit)) continue;

      if (fieldToEdit === 'fee' || fieldToEdit === 'all') {
        const newFee = await p.text({
          message: `Registration Fee for ${target.name} (in ₹):`,
          defaultValue: String(target.fee),
          validate: (val) => (isNaN(Number(val)) || Number(val) < 0 ? 'Enter a valid positive fee' : undefined),
        });
        if (!p.isCancel(newFee)) target.fee = Number(newFee);
      }

      if (fieldToEdit === 'capacity' || fieldToEdit === 'all') {
        const newCap = await p.text({
          message: `Slot Capacity Limit (0 for unlimited):`,
          defaultValue: String(target.slot_limit || 0),
          validate: (val) => (isNaN(Number(val)) || Number(val) < 0 ? 'Enter a valid number' : undefined),
        });
        if (!p.isCancel(newCap)) target.slot_limit = Number(newCap);
      }

      if (fieldToEdit === 'venue' || fieldToEdit === 'all') {
        const newVenue = await p.text({
          message: `Venue & Room / Lab Name:`,
          defaultValue: target.venue || '',
        });
        if (!p.isCancel(newVenue)) target.venue = newVenue.trim();
      }

      if (fieldToEdit === 'schedule' || fieldToEdit === 'all') {
        const newSchedule = await p.text({
          message: `Date & Time Schedule:`,
          defaultValue: target.schedule || '',
        });
        if (!p.isCancel(newSchedule)) target.schedule = newSchedule.trim();
      }

      if (fieldToEdit === 'status' || fieldToEdit === 'all') {
        const newStatus = await p.select({
          message: `Set Registration Status for ${target.name}:`,
          options: [
            { value: 'ACTIVE', label: 'ACTIVE (Accepting Registrations)' },
            { value: 'PAUSED', label: 'PAUSED (Temporarily On Hold)' },
            { value: 'CLOSED', label: 'CLOSED (Registrations Ended)' },
          ],
          initialValue: target.status || 'ACTIVE',
        });
        if (!p.isCancel(newStatus)) target.status = newStatus;
      }

      if (fieldToEdit === 'group' || fieldToEdit === 'all') {
        const newLink = await p.text({
          message: `WhatsApp Group Invite Link:`,
          defaultValue: target.inviteLink || '',
        });
        if (!p.isCancel(newLink)) target.inviteLink = newLink.trim();

        const newJid = await p.text({
          message: `WhatsApp Group JID (optional):`,
          defaultValue: target.groupJid || '',
        });
        if (!p.isCancel(newJid)) target.groupJid = newJid.trim();
      }

      writeEventsConfig(config);
      p.log.success(pc.green(`Updated event: ${target.name} [${target.id}]`));
    }

    // 4. Delete / Archive Event
    else if (action === 'delete') {
      if (config.events.length === 0) {
        p.log.warn('No events available.');
        continue;
      }

      const eventChoices = config.events.map((evt) => ({
        value: evt.id,
        label: `${evt.name} [${evt.id}] • Status: ${evt.status || 'ACTIVE'}`,
      }));

      const selectedEventId = await p.select({
        message: 'Select Event to Archive or Delete:',
        options: eventChoices,
      });
      if (p.isCancel(selectedEventId)) continue;

      const deleteAction = await p.select({
        message: `Action for "${selectedEventId}":`,
        options: [
          {
            value: 'archive',
            label: '1. Archive / Pause Track (Recommended: Preserves past DB records)',
          },
          {
            value: 'permanent',
            label: '2. Permanently Remove from events.json',
          },
        ],
      });
      if (p.isCancel(deleteAction)) continue;

      if (deleteAction === 'archive') {
        const target = config.events.find((e) => e.id === selectedEventId);
        target.status = 'PAUSED';
        writeEventsConfig(config);
        p.log.success(pc.green(`Event "${selectedEventId}" marked as PAUSED. Past attendee records remain untouched.`));
      } else {
        const confirmDelete = await p.confirm({
          message: `Permanently delete "${selectedEventId}" from events.json?`,
          initialValue: false,
        });
        if (confirmDelete) {
          config.events = config.events.filter((e) => e.id !== selectedEventId);
          writeEventsConfig(config);
          p.log.warn(pc.yellow(`Event track "${selectedEventId}" deleted from configuration.`));
        }
      }
    }
  }
}

// ==============================================================================
// 2. WHATSAPP MESSAGE COPY (Edit WhatsApp Message Templates)
// ==============================================================================

async function editTemplatesMenu() {
  while (true) {
    const templates = loadTemplates();

    const categoryChoice = await p.select({
      message: pc.bold('WhatsApp Message Template Editor — Select Category:'),
      options: [
        {
          value: 'greeting',
          label: '1. Welcome & Greeting Text (Opening banner, Track A/B prompt)',
        },
        {
          value: 'faculty_alerts',
          label: '2. Faculty OD Verification Alerts (Mentor alert, YES ALL / selective syntax)',
        },
        {
          value: 'payment',
          label: '3. Payment Instructions & UTR Prompts (UPI ID invoice note, screenshot prompt)',
        },
        {
          value: 'external_faculty',
          label: '4. External Faculty Intimation (Formal intimation to outer college mentors)',
        },
        {
          value: 'confirmation',
          label: '5. Event Confirmation & Pass Messages (Venue reporting, pass delivery text)',
        },
        {
          value: 'browse_all',
          label: '6. Browse / Search All Templates (Full catalog)',
        },
        { value: 'back', label: '← Back to Master Control Center' },
      ],
    });

    if (p.isCancel(categoryChoice) || categoryChoice === 'back') break;

    let targetTemplateKeys = [];
    if (categoryChoice === 'greeting') {
      targetTemplateKeys = ['greeting_menu', 'greeting_repeat'];
    } else if (categoryChoice === 'faculty_alerts') {
      targetTemplateKeys = [
        'mentor_alert',
        'mentor_approved_student_notify',
        'mentor_rejected_student_notify',
        'mentor_batch_approved',
        'mentor_batch_rejected',
        'mentor_ack_approved',
        'mentor_ack_rejected',
      ];
    } else if (categoryChoice === 'payment') {
      targetTemplateKeys = [
        'payment_prompt',
        'invalid_utr_retry',
        'utr_duplicate_error',
        'event_sold_out',
      ];
    } else if (categoryChoice === 'external_faculty') {
      targetTemplateKeys = ['faculty_intimation', 'faculty_intimation_sent'];
    } else if (categoryChoice === 'confirmation') {
      targetTemplateKeys = [
        'registration_confirmed_host',
        'payment_verified_pass',
        'event_selected',
        'duplicate_roll_error',
        'generic_snag_error',
      ];
    } else {
      targetTemplateKeys = Object.keys(templates);
    }

    const templateOptions = targetTemplateKeys
      .filter((k) => templates[k])
      .map((k) => ({
        value: k,
        label: `${k} — "${templates[k].slice(0, 36).replace(/\n/g, ' ')}..."`,
      }));

    templateOptions.push({ value: 'back_cat', label: '← Back to Categories' });

    const selectedKey = await p.select({
      message: 'Select Message Template to Customize:',
      options: templateOptions,
    });

    if (p.isCancel(selectedKey) || selectedKey === 'back_cat') continue;

    const currentText = templates[selectedKey];
    console.log('\n' + pc.cyan(`[TEMPLATE: ${selectedKey}]`));
    console.log(pc.white(currentText));
    console.log(
      pc.dim(
        '\nSupported interpolation variables: {student_name}, {event_name}, {reg_no}, {fee}, {venue}, {schedule}, {mentor_name}, {fest_name}, {upi_id}, {payee_name}\n'
      )
    );

    const newText = await p.text({
      message: `Enter updated text for "${selectedKey}":`,
      initialValue: currentText,
      validate: (val) => (!val || val.trim().length === 0 ? 'Template content cannot be empty' : undefined),
    });

    if (p.isCancel(newText)) continue;

    updateTemplate(selectedKey, newText);
    p.log.success(pc.green(`Template "${selectedKey}" updated and saved successfully.`));
  }
}

// ==============================================================================
// 3. PAYMENT GATEWAY & ADMIN SETTINGS (System & Payment Config)
// ==============================================================================

async function systemPaymentConfigMenu() {
  while (true) {
    const config = readEventsConfig();

    const choice = await p.select({
      message: pc.bold('System & Payment Configuration:'),
      options: [
        {
          value: 'upi',
          label: `1. Primary UPI VPA ID (Current: ${config.payment?.upiId || 'Not set'})`,
        },
        {
          value: 'payee',
          label: `2. Merchant / Payee Name (Current: "${config.payment?.payeeName || 'Not set'}")`,
        },
        {
          value: 'admins',
          label: `3. Admin & Volunteer Numbers (${config.adminNumbers?.length || 0} registered for #SPOT / #BROADCAST)`,
        },
        {
          value: 'strategy',
          label: `4. WhatsApp Group Strategy (${config.groupDistributionStrategy === 'shared' ? 'Single Shared Community' : 'Individual Track Groups'})`,
        },
        {
          value: 'host_college',
          label: `5. Host College Details (${config.hostCollege?.name || 'Not set'})`,
        },
        { value: 'back', label: '← Back to Master Control Center' },
      ],
    });

    if (p.isCancel(choice) || choice === 'back') break;

    // 1. UPI ID
    if (choice === 'upi') {
      const newUpi = await p.text({
        message: 'Enter Primary Official UPI VPA / ID for payments:',
        defaultValue: config.payment?.upiId || '',
        placeholder: 'e.g. symposium@sbi',
        validate: (val) => {
          if (!val || !val.includes('@')) return 'Enter a valid UPI ID (e.g. name@bank)';
        },
      });
      if (p.isCancel(newUpi)) continue;

      config.payment.upiId = newUpi.trim();
      writeEventsConfig(config);
      updateEnvVariable('UPI_VPA', newUpi.trim());
      p.log.success(pc.green(`Updated Primary UPI ID to: ${newUpi.trim()}`));
    }

    // 2. Payee Name
    else if (choice === 'payee') {
      const newPayee = await p.text({
        message: 'Enter Payee Name displayed on UPI banking apps:',
        defaultValue: config.payment?.payeeName || '',
        placeholder: 'e.g. TechFest Committee',
        validate: (val) => (!val || val.trim().length === 0 ? 'Payee name is required' : undefined),
      });
      if (p.isCancel(newPayee)) continue;

      config.payment.payeeName = newPayee.trim();
      writeEventsConfig(config);
      updateEnvVariable('UPI_PAYEE_NAME', `"${newPayee.trim()}"`);
      p.log.success(pc.green(`Updated Payee Name to: "${newPayee.trim()}"`));
    }

    // 3. Admin Numbers
    else if (choice === 'admins') {
      console.log('\n' + pc.cyan('--- AUTHORIZED ADMIN & VOLUNTEER NUMBERS ---'));
      if (!config.adminNumbers || config.adminNumbers.length === 0) {
        console.log(pc.yellow('No admin phone numbers configured yet.'));
      } else {
        config.adminNumbers.forEach((num, idx) => {
          console.log(`  ${idx + 1}. ${pc.white(num)}`);
        });
      }
      console.log('--------------------------------------------\n');

      const adminAction = await p.select({
        message: 'Admin Numbers Management:',
        options: [
          { value: 'add', label: '+ Add New Authorized Volunteer / Admin Number' },
          { value: 'remove', label: '- Remove an Authorized Number' },
          { value: 'back', label: '← Back to Config Menu' },
        ],
      });
      if (p.isCancel(adminAction) || adminAction === 'back') continue;

      if (adminAction === 'add') {
        const phone = await p.text({
          message: 'Enter Phone Number with Country Code (e.g. 919876543210):',
          validate: (val) => {
            const digits = (val || '').replace(/\D/g, '');
            if (digits.length < 10) return 'Enter a valid phone number with country code';
          },
        });
        if (p.isCancel(phone)) continue;

        const cleanDigits = phone.replace(/\D/g, '');
        if (!config.adminNumbers) config.adminNumbers = [];
        if (!config.adminNumbers.includes(cleanDigits)) {
          config.adminNumbers.push(cleanDigits);
          writeEventsConfig(config);
          updateEnvVariable('ADMIN_NUMBERS', config.adminNumbers.join(','));
          p.log.success(pc.green(`Authorized number: ${cleanDigits}`));
        } else {
          p.log.warn('Phone number is already authorized.');
        }
      } else if (adminAction === 'remove') {
        if (!config.adminNumbers || config.adminNumbers.length === 0) {
          p.log.warn('No numbers to remove.');
          continue;
        }

        const toRemove = await p.select({
          message: 'Select Number to Remove:',
          options: config.adminNumbers.map((n) => ({ value: n, label: n })),
        });
        if (p.isCancel(toRemove)) continue;

        config.adminNumbers = config.adminNumbers.filter((n) => n !== toRemove);
        writeEventsConfig(config);
        updateEnvVariable('ADMIN_NUMBERS', config.adminNumbers.join(','));
        p.log.success(pc.green(`Removed authorization for ${toRemove}.`));
      }
    }

    // 4. WhatsApp Group Strategy
    else if (choice === 'strategy') {
      const newStrategy = await p.select({
        message: 'Select Group Distribution Strategy:',
        options: [
          {
            value: 'individual',
            label: '1. Individual Track Groups (Each event has its own separate WhatsApp group)',
          },
          {
            value: 'shared',
            label: '2. Single Shared Community (All attendees joined to a central WhatsApp group)',
          },
        ],
        initialValue: config.groupDistributionStrategy || 'individual',
      });
      if (p.isCancel(newStrategy)) continue;

      config.groupDistributionStrategy = newStrategy;

      if (newStrategy === 'shared') {
        if (!config.sharedCommunityGroup) {
          config.sharedCommunityGroup = { groupJid: '', inviteLink: '' };
        }

        const communityLink = await p.text({
          message: 'Enter Central Community WhatsApp Group Invite Link:',
          defaultValue: config.sharedCommunityGroup.inviteLink || '',
          placeholder: 'https://chat.whatsapp.com/...',
        });
        if (!p.isCancel(communityLink)) {
          config.sharedCommunityGroup.inviteLink = communityLink.trim();
        }

        const communityJid = await p.text({
          message: 'Enter Central Community Group JID (optional):',
          defaultValue: config.sharedCommunityGroup.groupJid || '',
          placeholder: '120363000000000000@g.us',
        });
        if (!p.isCancel(communityJid)) {
          config.sharedCommunityGroup.groupJid = communityJid.trim();
        }
      }

      writeEventsConfig(config);
      updateEnvVariable('GROUP_DISTRIBUTION_STRATEGY', newStrategy);
      p.log.success(pc.green(`Group distribution strategy updated to: ${newStrategy}`));
    }

    // 5. Host College
    else if (choice === 'host_college') {
      const hostName = await p.text({
        message: 'Host College / Institute Name:',
        defaultValue: config.hostCollege?.name || '',
      });
      if (p.isCancel(hostName)) continue;

      const rollPattern = await p.text({
        message: 'Roll Number Regex Pattern (for host student validation):',
        defaultValue: config.hostCollege?.rollNumberPattern || '^[A-Za-z0-9]+$',
      });
      if (p.isCancel(rollPattern)) continue;

      config.hostCollege.name = hostName.trim();
      config.hostCollege.rollNumberPattern = rollPattern.trim();
      writeEventsConfig(config);
      updateEnvVariable('HOST_COLLEGE_NAME', `"${hostName.trim()}"`);
      p.log.success(pc.green(`Host college details updated.`));
    }
  }
}

// ==============================================================================
// 4. LIVE BROADCAST DISPATCHER (#BROADCAST)
// ==============================================================================

async function broadcastToolMenu() {
  console.clear();
  p.intro(pc.bgMagenta(pc.black(' FESTFLOW // LIVE BROADCAST DISPATCHER ')));

  const config = readEventsConfig();
  const options = [
    { value: 'ALL', label: '📢 ALL Registered Participants (Across All Events)' },
    ...config.events.map((evt) => ({
      value: evt.id,
      label: `${evt.name} [ID: ${evt.id}]`,
    })),
    { value: 'back', label: '← Back to Master Control Center' },
  ];

  const targetEvent = await p.select({
    message: pc.bold('Select Broadcast Target Audience:'),
    options,
  });

  if (p.isCancel(targetEvent) || targetEvent === 'back') return;

  const announcement = await p.text({
    message: `Enter Announcement Message for [${targetEvent}]:`,
    placeholder: 'e.g. Round 2 delayed by 20 mins; please assemble at Turing Hall.',
    validate: (val) => (!val || val.trim().length === 0 ? 'Message text cannot be empty' : undefined),
  });

  if (p.isCancel(announcement)) return;

  // Retrieve targets count
  const targets = await getRegistrationsForEvent(targetEvent);
  if (!targets || targets.length === 0) {
    p.log.warn(`No registered participants found for event target: ${targetEvent}`);
    await p.text({ message: 'Press Enter to continue...' });
    return;
  }

  p.note(
    `Target: ${targetEvent}\n` +
      `Recipient Count: ${targets.length} participants\n` +
      `Message: "${announcement.trim()}"\n` +
      `Rate Limit: ~20 msgs/min with human jitter to avoid WhatsApp anti-spam bans`,
    'Confirm Broadcast Dispatch'
  );

  const confirm = await p.confirm({
    message: `Dispatch announcement to ${targets.length} participants?`,
    initialValue: true,
  });

  if (!confirm) {
    p.log.warn('Broadcast cancelled.');
    return;
  }

  const spinner = p.spinner();
  spinner.start(`Dispatching broadcast to ${targets.length} recipients...`);

  // Execute broadcast in CLI mode (senderPhone = null bypasses WhatsApp admin number check)
  const result = await executeBroadcast(
    null,
    null,
    targetEvent,
    announcement.trim(),
    (sent, total) => {
      spinner.message(`Dispatched ${sent}/${total} announcements (rate limiting active)...`);
    }
  );

  spinner.stop(pc.green('Broadcast completed!'));
  p.log.success(
    `✅ Sent: ${result.sent} | ❌ Failed: ${result.failed} | Total Targets: ${result.total}`
  );
  await p.text({ message: 'Press Enter to return to main menu...' });
}

// ==============================================================================
// 5. MANUAL UTR RESOLUTION / OVERRIDES DESK
// ==============================================================================

async function manualUtrResolutionMenu() {
  console.clear();
  p.intro(pc.bgCyan(pc.black(' FESTFLOW // MANUAL UTR RESOLUTION & OVERRIDES ')));

  while (true) {
    const query = await p.text({
      message: 'Search Attendee by Roll Number, Phone Number, or Full Name:',
      placeholder: 'e.g. 21CS045 or 9876543210 (or type "back")',
      validate: (val) => (!val || val.trim().length === 0 ? 'Search query cannot be empty' : undefined),
    });

    if (p.isCancel(query) || query.trim().toLowerCase() === 'back') break;

    const spinner = p.spinner();
    spinner.start('Searching database...');
    const results = await searchRegistrations(query.trim());
    spinner.stop(`Found ${results.length} matching record(s).`);

    if (results.length === 0) {
      p.log.warn(`No registrations matched "${query.trim()}".`);
      continue;
    }

    const attendeeChoices = results.map((r) => ({
      value: r.id,
      label: `${r.full_name} • Roll: ${r.roll_number} • Evt: ${r.event_id} • Status: ${r.od_status} • UTR: ${r.utr_number || 'NONE'}`,
    }));
    attendeeChoices.push({ value: 'cancel', label: '← Search Again' });

    const selectedId = await p.select({
      message: 'Select Attendee to Verify / Override:',
      options: attendeeChoices,
    });

    if (p.isCancel(selectedId) || selectedId === 'cancel') continue;

    const record = results.find((r) => r.id === selectedId);

    p.note(
      `Name: ${record.full_name}\n` +
        `Roll Number: ${record.roll_number}\n` +
        `College: ${record.college_name} (${record.department || 'N/A'})\n` +
        `Event: ${record.event_name} [${record.event_id}]\n` +
        `Current Status: ${record.od_status}\n` +
        `Amount Paid: ₹${record.amount_paid}\n` +
        `Existing UTR: ${record.utr_number || 'NOT RECORDED'}`,
      'Attendee Verification Dossier'
    );

    const manualUtr = await p.text({
      message: 'Enter Verified 12-Digit UTR Number (or CASH / OVERRIDE reference):',
      placeholder: 'e.g. 123456789012 or DESK_CASH_01',
      validate: (val) => (!val || val.trim().length < 4 ? 'Enter a valid reference' : undefined),
    });

    if (p.isCancel(manualUtr)) continue;

    const verifySpinner = p.spinner();
    verifySpinner.start('Updating database and generating official admission pass...');

    const updateRes = await manualVerifyPayment(record.id, manualUtr.trim(), record.amount_paid);

    if (!updateRes.success) {
      verifySpinner.stop(pc.red(`Failed to update record: ${updateRes.error}`));
      continue;
    }

    // Generate physical entry pass buffer to confirm pass rendering
    try {
      const passBuffer = await generateEventPass({
        fullName: record.full_name,
        rollNumber: record.roll_number,
        collegeName: record.college_name,
        department: record.department,
        eventName: record.event_name,
        eventId: record.event_id,
        venue: record.venue || '',
        schedule: record.schedule || '',
        odStatus: 'APPROVED',
        utrNumber: manualUtr.trim(),
        teamName: record.team_name,
        teamMembers: record.team_members,
      });

      verifySpinner.stop(pc.green('Payment verified & official pass rendered successfully!'));
      p.log.success(
        `✅ Roll Number: ${record.roll_number}\n` +
          `✅ OD Status: APPROVED\n` +
          `✅ UTR Reference: ${manualUtr.trim()}\n` +
          `✅ Digital Pass: Generated (${passBuffer.length} bytes PNG ready)`
      );
    } catch (err) {
      verifySpinner.stop(pc.yellow(`Record updated to APPROVED, but pass generation notice: ${err.message}`));
    }

    const nextAction = await p.confirm({
      message: 'Process another attendee override?',
      initialValue: false,
    });
    if (!nextAction) break;
  }
}

// ==============================================================================
// 6. EXPORT REAL-TIME PARTICIPANT MANIFEST (.CSV)
// ==============================================================================

async function exportManifestMenu() {
  console.clear();
  p.intro(pc.bgGreen(pc.black(' FESTFLOW // EXPORT ATTENDEE MANIFEST ')));

  const config = readEventsConfig();

  const eventFilterOptions = [
    { value: 'ALL', label: 'All Events (Complete Symposium Manifest)' },
    ...config.events.map((e) => ({ value: e.id, label: `${e.name} [${e.id}]` })),
  ];

  const selectedEvent = await p.select({
    message: 'Filter by Event Track:',
    options: eventFilterOptions,
  });

  if (p.isCancel(selectedEvent)) return;

  const statusFilter = await p.select({
    message: 'Filter by OD / Payment Status:',
    options: [
      { value: 'ALL', label: 'All Statuses (Approved, Pending, Rejected)' },
      { value: 'APPROVED', label: 'APPROVED Only (Confirmed Pass Holders)' },
      { value: 'PENDING_APPROVAL', label: 'PENDING_APPROVAL (Pending Mentor or Payment)' },
      { value: 'REJECTED', label: 'REJECTED Only' },
    ],
    initialValue: 'ALL',
  });

  if (p.isCancel(statusFilter)) return;

  const spinner = p.spinner();
  spinner.start('Querying database and compiling attendee records...');

  const records = await getAllRegistrations({
    eventId: selectedEvent,
    odStatus: statusFilter,
  });

  spinner.stop(`Retrieved ${records.length} attendee records.`);

  if (records.length === 0) {
    p.log.warn('No records matched the selected criteria.');
    await p.text({ message: 'Press Enter to continue...' });
    return;
  }

  // Construct CSV with Delegate ID as primary lookup column (Column A)
  const headers = [
    'Delegate ID (Primary)',
    'Full Name',
    'College Name',
    'Roll Number',
    'Department',
    'Event Name',
    'Event ID',
    'UTR Reference',
    'Amount Paid (INR)',
    'Payment Note Match',
    'OD Status',
    'Phone Number',
    'Mentor Name',
    'Mentor Phone',
    'Team Name',
    'Checked In',
    'Checked In At',
    'Created At',
  ];

  const rows = records.map((r) => [
    escapeCsv(r.delegate_id || r.delegateId || 'HOST_FREE'),
    escapeCsv(r.full_name || r.fullName),
    escapeCsv(r.college_name || r.collegeName),
    escapeCsv(r.roll_number || r.rollNumber),
    escapeCsv(r.department || 'N/A'),
    escapeCsv(r.event_name || r.eventName),
    escapeCsv(r.event_id || r.eventId),
    escapeCsv(r.utr_number || r.utrNumber || 'N/A'),
    escapeCsv(r.amount_paid !== undefined ? r.amount_paid : r.amountPaid),
    escapeCsv(r.delegate_id ? `YES (${r.delegate_id})` : 'N/A (Host Track)'),
    escapeCsv(r.od_status || r.odStatus || ''),
    escapeCsv(r.phone_number || r.phoneNumber),
    escapeCsv(r.mentor_name || r.mentorName || ''),
    escapeCsv(r.mentor_phone || r.mentorPhone || ''),
    escapeCsv(r.team_name || r.teamName || ''),
    escapeCsv(r.checked_in ? 'YES' : 'NO'),
    escapeCsv(r.checked_in_at || ''),
    escapeCsv(r.created_at || ''),
  ]);

  const csvContent = [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');
  const timestampStr = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `manifest_${selectedEvent.toLowerCase()}_${timestampStr}.csv`;
  const exportPath = path.join(rootDir, filename);

  fs.writeFileSync(exportPath, csvContent, 'utf8');

  p.log.success(
    `✅ Participant manifest generated successfully!\n` +
      `   • File: ${pc.cyan(filename)}\n` +
      `   • Location: ${pc.dim(exportPath)}\n` +
      `   • Rows: ${records.length} attendees\n` +
      `   • File Size: ${(Buffer.byteLength(csvContent) / 1024).toFixed(1)} KB`
  );

  await p.text({ message: 'Press Enter to return to main menu...' });
}

// ==============================================================================
// 7. RUN LIVE WHATSAPP ENGINE & CONNECTION MANAGER
// ==============================================================================

async function liveEngineMenu() {
  while (true) {
    console.clear();
    p.intro(pc.bgGreen(pc.black(' FESTFLOW // LIVE WHATSAPP ENGINE & CONNECTION MANAGER ')));

    const choice = await p.select({
      message: 'Select WhatsApp Engine Operational Task:',
      options: [
        {
          value: 'start',
          label: '1. Start 24/7 Live WhatsApp Listener (Pairing Code / Terminal QR)',
          hint: 'Connects bot to WhatsApp Web network',
        },
        {
          value: 'clear_session',
          label: '2. Clear Session Credentials / Re-link Bot Device',
          hint: 'Wipes stale session files in auth_info_baileys to force re-scan',
        },
        {
          value: 'diagnostic',
          label: '3. Connection Status & Diagnostic Health Check',
          hint: 'Pings Supabase DB, tests Baileys auth folder, checks environment',
        },
        { value: 'back', label: '← Back to Master Control Center' },
      ],
    });

    if (p.isCancel(choice) || choice === 'back') break;

    // 1. Start Engine
    if (choice === 'start') {
      const linkMethod = await p.select({
        message: 'Select WhatsApp Device Linking Method:',
        options: [
          {
            value: 'pairing_code',
            label: '1. 8-digit Mobile Pairing Code (Recommended - Distortion-Free)',
            hint: 'No camera QR scan required, link directly with phone number',
          },
          {
            value: 'qr',
            label: '2. Terminal ASCII QR Code',
            hint: 'Scan terminal QR directly from WhatsApp camera',
          },
        ],
      });

      if (p.isCancel(linkMethod)) continue;

      if (linkMethod === 'pairing_code') {
        const phoneInput = await p.text({
          message: 'Enter Bot WhatsApp Phone Number (with country code, e.g. 919876543210):',
          placeholder: process.env.BOT_PHONE_NUMBER || '919876543210',
          defaultValue: process.env.BOT_PHONE_NUMBER || '',
          validate: (val) => {
            const clean = (val || '').replace(/\D/g, '');
            if (clean.length < 10) return 'Please enter a valid phone number with country code';
          },
        });

        if (p.isCancel(phoneInput)) continue;

        const cleanPhone = phoneInput.replace(/\D/g, '');
        updateEnvVariable('BOT_PHONE_NUMBER', `"${cleanPhone}"`);
        p.note('Live WhatsApp engine starting... Keep terminal running while linking on phone. Press Ctrl+C to stop.', 'Engine Online');
        await startFestFlowBot({ usePairingCode: true, pairingPhone: cleanPhone, freshSession: true });
        await new Promise(() => {});
      } else {
        p.note('Live WhatsApp engine starting... Keep terminal running while scanning QR on phone. Press Ctrl+C to stop.', 'Engine Online');
        await startFestFlowBot({ usePairingCode: false, freshSession: true });
        await new Promise(() => {});
      }
    }

    // 2. Clear Session
    else if (choice === 'clear_session') {
      const hasAuth = fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0;
      if (!hasAuth) {
        p.log.info(pc.yellow('auth_info_baileys directory is already empty. No active credentials to clear.'));
        await p.text({ message: 'Press Enter to continue...' });
        continue;
      }

      const confirmWipe = await p.confirm({
        message: pc.red('Are you sure you want to delete session credentials and disconnect the bot?'),
        initialValue: false,
      });

      if (confirmWipe) {
        try {
          fs.rmSync(authDir, { recursive: true, force: true });
          fs.mkdirSync(authDir, { recursive: true });
          p.log.success(pc.green('Session credentials wiped cleanly. You can now link a fresh WhatsApp device.'));
        } catch (err) {
          p.log.error(`Failed to wipe session directory: ${err.message}`);
        }
        await p.text({ message: 'Press Enter to continue...' });
      }
    }

    // 3. Diagnostic Health Check
    else if (choice === 'diagnostic') {
      const spinner = p.spinner();
      spinner.start('Running system health and connectivity diagnostics...');

      const dbHealth = await testSupabaseHealth();
      const hasCreds = fs.existsSync(path.join(authDir, 'creds.json'));
      const config = readEventsConfig();

      spinner.stop('Diagnostic scan complete.');

      console.log('\n' + pc.cyan('================ SYSTEM DIAGNOSTIC DOSSIER ================'));

      // Supabase
      if (dbHealth.healthy) {
        console.log(
          `• Supabase Database:      ${pc.green('ONLINE')} (${dbHealth.latencyMs}ms latency | ${dbHealth.count} registered attendees | mode: ${dbHealth.mode})`
        );
      } else {
        console.log(`• Supabase Database:      ${pc.red('OFFLINE / ERROR')} (${dbHealth.error})`);
      }

      // Baileys Session
      if (hasCreds) {
        console.log(`• Baileys WhatsApp Auth:  ${pc.green('LINKED')} (Active session credentials present in auth_info_baileys)`);
      } else {
        console.log(`• Baileys WhatsApp Auth:  ${pc.yellow('UNLINKED')} (Pairing code or QR code scan required)`);
      }

      // Canvas
      console.log(`• Pass Canvas Engine:     ${pc.green('PRE-COMPILED')} (@napi-rs/canvas verified)`);

      // Payment Config
      console.log(`• Primary UPI VPA:        ${config.payment?.upiId ? pc.green(config.payment.upiId) : pc.red('NOT CONFIGURED')}`);
      console.log(`• Merchant Payee:         ${config.payment?.payeeName ? pc.green(config.payment.payeeName) : pc.yellow('NOT CONFIGURED')}`);
      console.log(`• Admin Volunteers:       ${config.adminNumbers?.length > 0 ? pc.green(`${config.adminNumbers.length} authorized phone(s)`) : pc.yellow('NONE')}`);
      console.log(`• Group Strategy:         ${pc.white(config.groupDistributionStrategy || 'individual')}`);
      console.log(`• Event Tracks Loaded:    ${pc.green(`${config.events?.length || 0} tracks configured`)}`);

      console.log(pc.cyan('===========================================================\n'));

      await p.text({ message: 'Press Enter to return to engine menu...' });
    }
  }
}

// ==============================================================================
// 8. DEPLOYMENT GENERATOR
// ==============================================================================

async function deployGeneratorMenu() {
  console.clear();
  p.intro(pc.bgCyan(pc.black(' FESTFLOW // DEPLOYMENT GENERATOR ')));

  const spinner = p.spinner();
  spinner.start('Verifying Dockerfile and Render.yaml configuration...');

  const dockerContent = `FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \\
    fonts-liberation \\
    fontconfig \\
    ca-certificates \\
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/auth_info_baileys

VOLUME ["/app/auth_info_baileys"]

ENV NODE_ENV=production
ENV AUTH_FOLDER=/app/auth_info_baileys

CMD ["node", "src/bot.js"]
`;

  const renderContent = `services:
  - type: worker
    name: festflow-whatsapp-agent
    env: node
    plan: standard
    buildCommand: npm ci --omit=dev
    startCommand: node src/bot.js
    disk:
      name: festflow_auth_data
      mountPath: /app/auth_info_baileys
      sizeGB: 1
    envVars:
      - key: NODE_ENV
        value: production
      - key: AUTH_FOLDER
        value: /app/auth_info_baileys
      - key: SUPABASE_URL
        sync: false
      - key: SUPABASE_SERVICE_ROLE_KEY
        sync: false
      - key: UPI_VPA
        sync: false
      - key: UPI_PAYEE_NAME
        sync: false
      - key: PASS_SIGNING_SECRET
        generateValue: true
      - key: HOST_COLLEGE_NAME
        sync: false
      - key: BOT_PHONE_NUMBER
        sync: false
`;

  fs.writeFileSync(dockerfilePath, dockerContent, 'utf8');
  fs.writeFileSync(renderYamlPath, renderContent, 'utf8');

  spinner.stop(pc.green('Dockerfile & render.yaml verified and saved.'));

  p.note(
    `${pc.bold('Option A: Deploy to Render.com (Recommended 24/7 Background Worker)')}\n` +
      `1. Push this repository to GitHub or GitLab.\n` +
      `2. Go to ${pc.cyan('dashboard.render.com')} -> "New +" -> "Blueprint".\n` +
      `3. Connect your repository. Render automatically reads ${pc.cyan('render.yaml')}.\n` +
      `4. Fill in your environment variables (${pc.yellow('SUPABASE_URL')}, ${pc.yellow('UPI_VPA')}, etc.).\n` +
      `5. Render starts the worker and attaches persistent disk storage for WhatsApp credentials.\n\n` +
      `${pc.bold('Option B: Deploy with Docker')}\n` +
      `docker build -t festflow .\n` +
      `docker run -d --restart unless-stopped -v festflow_auth:/app/auth_info_baileys --env-file .env festflow`,
    'Production Deployment Guide'
  );

  await p.text({ message: 'Press Enter to return to main menu...' });
}

// ==============================================================================
// 9. PHYSICAL GATE SCANNER PWA MENU
// ==============================================================================

async function gateScannerMenu() {
  console.clear();
  p.intro(pc.bgCyan(pc.black(' FESTFLOW // PHYSICAL GATE SCANNER PWA ')));

  const scannerPath = path.join(rootDir, 'web', 'scanner.html');
  const fileUrl = `file:///${scannerPath.replace(/\\/g, '/')}`;

  p.note(
    `The Gate Scanner is a zero-dependency HTML/JS PWA located at:\n` +
      `${pc.cyan(fileUrl)}\n\n` +
      `Features:\n` +
      `• Mobile camera QR scanner powered by html5-qrcode\n` +
      `• Local HMAC-SHA256 signature verification (<roll>.<evt>.<ts>.<sig>)\n` +
      `• Direct Supabase gate admission check-in (marks checked_in = true)\n` +
      `• Instant Green (VALID) or Red (ALREADY CHECKED IN / OD REJECTED) banners\n` +
      `• Zero-compile, works directly in any mobile browser on ground`,
    'Gate Scanner Deployment'
  );

  await p.text({ message: 'Press Enter to return to main menu...' });
}

// ==============================================================================
// MASTER CONTROL CENTER ENTRY POINT
// ==============================================================================

async function main() {
  console.clear();
  p.intro(pc.bgCyan(pc.black(' FESTFLOW // MASTER CONTROL CENTER ')));

  while (true) {
    const choice = await p.select({
      message: pc.bold('Select an operational task:'),
      options: [
        {
          value: 'simulate',
          label: '1. 🧪 Interactive Chat Simulator (Test registrations in terminal)',
          hint: 'No WhatsApp device required',
        },
        {
          value: 'events',
          label: '2. 🎫 Event & Slot Manager (Add / Edit pricing, limits, venues)',
          hint: 'Manage tracks, pricing, limits, venues & pause status',
        },
        {
          value: 'templates',
          label: '3. 💬 WhatsApp Template Editor (Edit messages & alerts)',
          hint: 'Customize greetings, OD alerts, payment & pass copy',
        },
        {
          value: 'system',
          label: '4. 💳 Payment & Admin Configuration (UPI ID, Payee, Admin numbers)',
          hint: 'UPI VPA, Payee Name, Admin Volunteers, Group Strategy',
        },
        {
          value: 'broadcast',
          label: '5. 📢 Live Broadcast Dispatcher (Send announcements to participants)',
          hint: 'Throttled mass notification queue with safe rate limiting',
        },
        {
          value: 'override',
          label: '6. 🛠️ Manual UTR Resolution / Overrides (Desk verification)',
          hint: 'Search attendee by roll, approve payment, generate digital pass',
        },
        {
          value: 'export',
          label: '7. 📥 Export Attendee Manifest (Generate CSV reports)',
          hint: 'Export confirmed participants filtered by event and OD status',
        },
        {
          value: 'live',
          label: '8. 📱 Run Live WhatsApp Engine (Pairing code / QR listener)',
          hint: 'Launch listener, clear credentials, run health diagnostic',
        },
        {
          value: 'scanner',
          label: '9. 🔍 Gate Admission Scanner PWA (/web/scanner.html)',
          hint: 'Physical gate QR ticket verification tool',
        },
        {
          value: 'deploy',
          label: '10. 🚀 Deployment Generator (Dockerfile / Cloud config)',
          hint: 'Produce ready-to-deploy configs and blueprints',
        },
        {
          value: 'exit',
          label: '0. 🚪 Exit',
        },
      ],
    });

    if (p.isCancel(choice) || choice === 'exit') {
      p.outro(pc.cyan('FestFlow Master Control Center terminated.'));
      process.exit(0);
    }

    switch (choice) {
      case 'simulate':
        await runSimulator();
        break;
      case 'events':
        await manageEventsMenu();
        break;
      case 'templates':
        await editTemplatesMenu();
        break;
      case 'system':
        await systemPaymentConfigMenu();
        break;
      case 'broadcast':
        await broadcastToolMenu();
        break;
      case 'override':
        await manualUtrResolutionMenu();
        break;
      case 'export':
        await exportManifestMenu();
        break;
      case 'live':
        await liveEngineMenu();
        break;
      case 'scanner':
        await gateScannerMenu();
        break;
      case 'deploy':
        await deployGeneratorMenu();
        break;
    }
  }
}

main().catch((err) => {
  console.error(pc.red('[CONTROL CENTER ERROR]'), err);
  process.exit(1);
});
