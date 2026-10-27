import { updateODStatus, updateBulkODStatus, getRegistrationByRoll } from './supabase.js';
import { renderTemplate } from './templateManager.js';

/**
 * Checks if an incoming message is a Mentor OD response:
 * - Selective: "YES <RollNo>" / "NO <RollNo>"
 * - Batch Approval: "YES ALL" / "NO ALL"
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock - Active Baileys socket
 * @param {string} senderJid - WhatsApp JID of the sender (mentor)
 * @param {string} text - Message text
 * @returns {Promise<{handled: boolean, responseText?: string}>}
 */
export async function handleMentorResponse(sock, senderJid, text) {
  const cleanText = text.trim();

  // Pattern matches "YES <RollNo>", "NO <RollNo>", "YES ALL", "NO ALL", or lone "YES" / "NO"
  const match = cleanText.match(/^(YES|NO|APPROVE|REJECT)(?:\s+(ALL|[A-Za-z0-9_-]+))?$/i);
  if (!match) {
    return { handled: false };
  }

  const decisionWord = match[1].toUpperCase();
  const targetToken = (match[2] || 'ALL').trim().toUpperCase();

  const isApproved = decisionWord === 'YES' || decisionWord === 'APPROVE';
  const newStatus = isApproved ? 'APPROVED' : 'REJECTED';
  const mentorPhone = senderJid.replace('@s.whatsapp.net', '');

  try {
    // -------------------------------------------------------------
    // Alteration 1: "Batch Approve" via "YES ALL" / "NO ALL"
    // -------------------------------------------------------------
    if (targetToken === 'ALL') {
      const updatedStudents = await updateBulkODStatus(mentorPhone, newStatus);

      if (!updatedStudents || updatedStudents.length === 0) {
        return {
          handled: true,
          responseText: `No pending On-Duty (OD) approval requests were found matching your contact number.`,
        };
      }

      // Proactively notify each approved/rejected student on WhatsApp
      for (const student of updatedStudents) {
        if (student.phone_number && sock?.sendMessage) {
          const studentJid = `${student.phone_number.replace(/\D/g, '')}@s.whatsapp.net`;
          const studentNotice = isApproved
            ? renderTemplate('student_od_approved', {
                student_name: student.full_name,
                event_name: student.event_name,
              })
            : renderTemplate('student_od_rejected', {
                student_name: student.full_name,
                event_name: student.event_name,
              });

          try {
            await sock.sendMessage(studentJid, { text: studentNotice });
          } catch (_) {}
        }
      }

      let summaryList = updatedStudents
        .map((s, idx) => `• ${s.full_name} (${s.roll_number}) — ${s.event_name}`)
        .join('\n');

      const actionText = isApproved ? 'APPROVED' : 'REJECTED';
      return {
        handled: true,
        responseText: `✅ *Batch Action Complete*\n\nOD permission has been *${actionText}* for all ${updatedStudents.length} student(s):\n${summaryList}`,
      };
    }

    // -------------------------------------------------------------
    // Selective Approval via "YES <RollNo>" / "NO <RollNo>"
    // -------------------------------------------------------------
    const rollNumber = targetToken;
    const student = await getRegistrationByRoll(rollNumber);
    if (!student) {
      return {
        handled: true,
        responseText: `No registration found matching roll number *${rollNumber}*. Please check the roll number and try again.`,
      };
    }

    // Update single database record
    await updateODStatus(rollNumber, newStatus, mentorPhone);

    const mentorConfirmation = isApproved
      ? renderTemplate('mentor_ack_approved', {
          student_name: student.full_name,
          reg_no: rollNumber,
        })
      : renderTemplate('mentor_ack_rejected', {
          student_name: student.full_name,
          reg_no: rollNumber,
        });

    // Proactively notify student on WhatsApp
    if (student.phone_number && sock?.sendMessage) {
      const studentJid = `${student.phone_number.replace(/\D/g, '')}@s.whatsapp.net`;
      const studentNotice = isApproved
        ? renderTemplate('student_od_approved', {
            student_name: student.full_name,
            event_name: student.event_name,
          })
        : renderTemplate('student_od_rejected', {
            student_name: student.full_name,
            event_name: student.event_name,
          });

      try {
        await sock.sendMessage(studentJid, { text: studentNotice });
      } catch (sendErr) {
        console.warn(`[MENTOR LISTENER] Could not forward OD status to student ${studentJid}:`, sendErr.message);
      }
    }

    return {
      handled: true,
      responseText: mentorConfirmation,
    };
  } catch (err) {
    console.error('[MENTOR LISTENER] Error processing mentor decision:', err.message);
    return {
      handled: true,
      responseText: renderTemplate('generic_snag_error') || '⚠️ We hit a temporary snag processing your request. Please try again or visit the helpdesk.',
    };
  }
}
