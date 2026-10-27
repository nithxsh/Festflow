import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { renderTemplate } from './templateManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const eventsConfigPath = path.join(__dirname, '..', 'config', 'events.json');

function getGroupConfig() {
  try {
    return JSON.parse(fs.readFileSync(eventsConfigPath, 'utf8'));
  } catch (_) {
    return {};
  }
}

/**
 * Attempts to add a participant directly to an event or shared community WhatsApp group.
 * If the bot lacks admin rights or user privacy restricts direct adds,
 * provides the fallback invite link message.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock - Active Baileys socket
 * @param {string} userJid - Participant's WhatsApp JID (e.g., '<Phone>@s.whatsapp.net')
 * @param {object} eventData - Event metadata from events.json
 * @returns {Promise<{added: boolean, message: string}>}
 */
export async function addParticipantToEventGroup(sock, userJid, eventData) {
  if (!eventData) {
    return { added: false, message: '' };
  }

  const globalConfig = getGroupConfig();
  const isSharedStrategy =
    globalConfig.groupDistributionStrategy === 'shared' ||
    globalConfig.groupDistributionStrategy === 'community';

  const targetGroupJid = isSharedStrategy && globalConfig.sharedCommunityGroup?.groupJid
    ? globalConfig.sharedCommunityGroup.groupJid
    : eventData.groupJid;

  const targetInviteLink = isSharedStrategy && globalConfig.sharedCommunityGroup?.inviteLink
    ? globalConfig.sharedCommunityGroup.inviteLink
    : eventData.inviteLink;

  const targetGroupName = isSharedStrategy
    ? globalConfig.festName || 'Fest Community'
    : eventData.name || 'Event';

  // If no group configured, return quietly
  if (!targetGroupJid && !targetInviteLink) {
    return { added: false, message: '' };
  }

  const groupJid = targetGroupJid;
  const inviteLink = targetInviteLink;
  const eventName = targetGroupName;

  // Attempt direct participant addition if groupJid is valid
  if (groupJid && sock?.groupParticipantsUpdate) {
    try {
      const response = await sock.groupParticipantsUpdate(groupJid, [userJid], 'add');
      const userResult = Array.isArray(response) ? response[0] : null;

      // Status 200 means successfully added
      if (userResult && (userResult.status === '200' || userResult.status === 200)) {
        return {
          added: true,
          message: `You have been added directly to the official *${eventName}* WhatsApp group!`,
        };
      }
    } catch (err) {
      // Typically fails if bot is not admin or participant has strict privacy settings
      console.warn(`[GROUP MANAGER] Direct add failed for ${userJid} in ${eventName}: ${err.message}`);
    }
  }

  // Fallback: Send invite link template if available
  if (inviteLink) {
    return {
      added: false,
      message: renderTemplate('group_invite', { group_link: inviteLink }),
    };
  }

  return { added: false, message: '' };
}
