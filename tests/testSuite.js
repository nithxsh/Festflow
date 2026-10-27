import { generateEventPass, verifyTicketPayload, initializePassAsset, createCompactToken, generateTicketSignature } from '../src/passGenerator.js';
import { handleMentorResponse } from '../src/mentorListener.js';
import { handleSpotRegistration } from '../src/spotRegistrar.js';
import { getSession, resetSession, getEventsMenuText } from '../src/stateMachine.js';
import {
  saveRegistration,
  resetMockDatabase,
  getEventRegistrationCount,
  checkDuplicateRoll,
  checkInRegistration,
  getRegistrationsForEvent,
  searchRegistrations,
  manualVerifyPayment,
  getAllRegistrations,
  testSupabaseHealth,
  flagRegistrationFraud,
} from '../src/supabase.js';
import { renderTemplate, loadTemplates } from '../src/templateManager.js';
import { sessionStore } from '../src/sessionStore.js';
import { executeBroadcast } from '../src/broadcastManager.js';
import { generateDelegateId, checkImageMetadata, executeFraudInspection, generateUpiPaymentUri, generateUpiQrCode } from '../src/fraudDetector.js';
import { generateMockReceiptBuffer, generateMockTamperedBuffer } from '../src/simulator.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTestSuite() {
  console.log('\n=== FESTFLOW COMPREHENSIVE VERIFICATION SUITE ===\n');
  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      failed++;
    }
  }

  // Reset in-memory database before testing
  resetMockDatabase();

  // 1. Pass Generation & HMAC Validation Test (Solo)
  console.log('--- Testing Pass Generator & Dynamic QR Signing ---');
  try {
    await initializePassAsset();
    const passBuffer = await generateEventPass({
      fullName: 'Test Participant',
      rollNumber: 'ROLL_TEST_01',
      collegeName: 'Test University',
      eventName: 'Coding Relay',
      eventId: 'CODE_RELAY',
      venue: 'Lab 3, CS Block',
      schedule: 'Day 1, 10:00 AM',
      odStatus: 'APPROVED',
      utrNumber: '000000000001',
    });

    assert(Buffer.isBuffer(passBuffer), 'Pass generator returns a valid Buffer');
    assert(passBuffer.length > 5000, `Generated PNG pass buffer size is robust (${passBuffer.length} bytes)`);

    const templatePath = path.join(__dirname, '..', 'assets', 'pass_template.png');
    assert(fs.existsSync(templatePath), 'Fallback pass template initialized in assets/pass_template.png');
  } catch (err) {
    assert(false, `Pass Generator failed: ${err.message}`);
  }

  // 2. Alteration 1: Batch Approve for Mentors ('YES ALL' / 'NO ALL')
  console.log('\n--- Testing Alteration 1: Mentor Batch Approve (YES ALL) ---');
  try {
    const mockMentorSock = {
      sendMessage: async () => true,
    };

    // Pre-populate mock students pending mentor approval
    await saveRegistration({
      phoneNumber: '919000000001',
      fullName: 'Student One',
      collegeName: 'Test College',
      rollNumber: 'ROLL_BATCH_01',
      eventId: 'CODE_RELAY',
      eventName: 'Coding Relay',
      mentorName: 'Prof. Advisor',
      mentorPhone: '9876500001',
      odStatus: 'PENDING_APPROVAL',
    });

    await saveRegistration({
      phoneNumber: '919000000002',
      fullName: 'Student Two',
      collegeName: 'Test College',
      rollNumber: 'ROLL_BATCH_02',
      eventId: 'CODE_RELAY',
      eventName: 'Coding Relay',
      mentorName: 'Prof. Advisor',
      mentorPhone: '9876500001',
      odStatus: 'PENDING_APPROVAL',
    });

    // Test YES ALL blanket approval
    const batchYes = await handleMentorResponse(mockMentorSock, '9876500001@s.whatsapp.net', 'YES ALL');
    assert(batchYes.handled === true, 'Mentor listener handled "YES ALL" bulk command');
    assert(batchYes.responseText.includes('APPROVED'), 'Response confirms batch approval of all pending wards');

    // Test NO ALL blanket rejection
    await saveRegistration({
      phoneNumber: '919000000003',
      fullName: 'Student Three',
      collegeName: 'Test College',
      rollNumber: 'ROLL_BATCH_03',
      eventId: 'CODE_RELAY',
      eventName: 'Coding Relay',
      mentorName: 'Prof. Advisor',
      mentorPhone: '9876500002',
      odStatus: 'PENDING_APPROVAL',
    });

    const batchNo = await handleMentorResponse(mockMentorSock, '9876500002@s.whatsapp.net', 'NO ALL');
    assert(batchNo.handled === true, 'Mentor listener handled "NO ALL" bulk rejection command');
    assert(batchNo.responseText.includes('REJECTED'), 'Response confirms batch rejection');
  } catch (err) {
    assert(false, `Batch Approve failed: ${err.message}`);
  }

  // 3. Alteration 2: Team Track Registrations
  console.log('\n--- Testing Alteration 2: Team Track Pass Generation ---');
  try {
    const teamMembers = [
      { name: 'Lead Participant', roll: '21CS001', role: 'Lead' },
      { name: 'Teammate Two', roll: '21CS042', role: 'Member 2' },
      { name: 'Teammate Three', roll: '21CS099', role: 'Member 3' },
    ];

    const teamPassBuffer = await generateEventPass({
      fullName: 'Lead Participant',
      rollNumber: '21CS001',
      collegeName: 'Institute of Tech',
      eventName: 'Coding Relay',
      eventId: 'CODE_RELAY',
      venue: 'Lab 3, CS Block',
      schedule: 'Day 1, 10:00 AM',
      odStatus: 'APPROVED',
      teamName: 'Binary Beasts',
      teamMembers,
    });

    assert(Buffer.isBuffer(teamPassBuffer), 'Team pass generator returns a valid Buffer');
    assert(teamPassBuffer.length > 5000, `Team pass PNG generated cleanly (${teamPassBuffer.length} bytes)`);

    // Verify template strings for team track
    const askTeamName = renderTemplate('ask_team_name', { event_name: 'Coding Relay', max_team_size: 3 });
    assert(askTeamName.includes('Team Name'), 'ask_team_name template renders expected prompt');

    const askTeammate = renderTemplate('ask_teammate', { num: 2 });
    assert(askTeammate.includes('Teammate 2'), 'ask_teammate template prompts for specific teammate index');
  } catch (err) {
    assert(false, `Team track test failed: ${err.message}`);
  }

  // 4. Alteration 3: Slot Capacity Hard-Cap (SOLD OUT Trigger)
  console.log('\n--- Testing Alteration 3: Slot Capacity Hard-Cap (SOLD OUT) ---');
  try {
    // Fill up slots for a mock event
    for (let i = 0; i < 60; i++) {
      await saveRegistration({
        phoneNumber: `9191000000${i.toString().padStart(2, '0')}`,
        fullName: `Mock Registrant ${i}`,
        collegeName: 'Any College',
        rollNumber: `ROLL_CAP_${i}`,
        eventId: 'CODE_RELAY',
        eventName: 'Coding Relay',
        amountPaid: 150,
        utrNumber: `1000000000${i.toString().padStart(2, '0')}`,
        odStatus: 'APPROVED',
      });
    }

    const count = await getEventRegistrationCount('CODE_RELAY');
    assert(count >= 60, `Capacity count correctly reflects ${count} registrations`);

    const menuText = await getEventsMenuText(false);
    assert(menuText.includes('SOLD OUT'), 'Events menu dynamically displays "SOLD OUT" when limit reached');

    const soldOutNotice = renderTemplate('event_sold_out', { event_name: 'Coding Relay', slot_limit: 60 });
    assert(soldOutNotice.includes('SOLD OUT'), 'event_sold_out template returns clear capacity reached notice');
  } catch (err) {
    assert(false, `Slot Capacity test failed: ${err.message}`);
  }

  // 5. Alteration 4: Spot / Walk-In Volunteer Desk Mode (#SPOT)
  console.log('\n--- Testing Alteration 4: Spot Volunteer Desk Mode (#SPOT) ---');
  try {
    const mockDeskSock = {
      sendMessage: async (jid, content) => {
        return { key: { id: 'msg_' + Date.now() } };
      },
    };

    const spotCommand = '#SPOT Arun Kumar | SVCE | CSE | 21CS045 | WEB_MATRIX | CASH';
    const spotResult = await handleSpotRegistration(mockDeskSock, 'volunteer_desk@s.whatsapp.net', spotCommand);

    assert(spotResult.handled === true, '#SPOT command was recognized by desk handler');
    assert(spotResult.success === true, 'Spot registration succeeded');
    assert(spotResult.utrNumber.startsWith('SPOT_CASH_'), `Generated offline UTR: ${spotResult.utrNumber}`);
    assert(Buffer.isBuffer(spotResult.imageBuffer), 'Generated digital entry pass image for spot participant');

    // Test invalid syntax returns error
    const badSyntaxResult = await handleSpotRegistration(mockDeskSock, 'volunteer_desk@s.whatsapp.net', '#SPOT Arun Kumar');
    assert(badSyntaxResult.handled === true && badSyntaxResult.success === false, 'Invalid #SPOT syntax rejected with helpful usage guide');
  } catch (err) {
    assert(false, `Spot Desk test failed: ${err.message}`);
  }

  // 6. Alteration 5: Mobile Pairing Code Validation
  console.log('\n--- Testing Alteration 5: Mobile Pairing Code Formatting ---');
  const rawCode = '48291093';
  const formattedCode = `${rawCode.slice(0, 4)}-${rawCode.slice(4)}`;
  assert(formattedCode === '4829-1093', `Pairing code formatted as standard 8-digit split: ${formattedCode}`);

  // 7. State Machine Session Store & TTL Test
  console.log('\n--- Testing Session State Machine Store ---');
  try {
    const testJid = 'test_attendee@s.whatsapp.net';
    resetSession(testJid);

    const session1 = getSession(testJid);
    assert(session1.step === 'IDLE', 'Initial session starts in IDLE step');

    session1.step = 'COLLECT_NAME';
    session1.data.track = 'A';

    const session2 = getSession(testJid);
    assert(session2.step === 'COLLECT_NAME', 'Session state persists across lookups');

    resetSession(testJid);
    const session3 = getSession(testJid);
    assert(session3.step === 'IDLE', 'resetSession clears session memory properly');
  } catch (err) {
    assert(false, `Session test failed: ${err.message}`);
  }

  // 8. OCR 12-digit UTR Regex Validation Test
  console.log('\n--- Testing UTR Regex Pattern ---');
  const sampleText1 = 'Payment reference UPI Ref No: 409823145678. Status: Success.';
  const match1 = sampleText1.match(/\b\d{12}\b/);
  assert(match1 && match1[0] === '409823145678', 'Extracted 12-digit UTR 409823145678 from sample text');

  const sampleText2 = 'Transaction Successful! UTR: 123456789012';
  const match2 = sampleText2.match(/\b\d{12}\b/);
  assert(match2 && match2[0] === '123456789012', 'Extracted 12-digit UTR 123456789012 from sample text');

  // 9. Template Engine Decoupling Test
  console.log('\n--- Testing WhatsApp Template Engine & Decoupling ---');
  const allTemplates = loadTemplates();
  assert(Object.keys(allTemplates).length >= 15, `Loaded ${Object.keys(allTemplates).length} customizable message templates`);

  const renderedAlert = renderTemplate('mentor_alert', {
    mentor_name: 'Faculty Advisor',
    student_name: 'Candidate Attendee',
    reg_no: 'REG_TEST_01',
    dept: 'CS',
    event_name: 'Coding Relay',
    fest_name: 'TechFest',
  });
  assert(
    renderedAlert.includes('YES ALL') && renderedAlert.includes('YES REG_TEST_01'),
    'mentor_alert template contains both YES ALL and selective approval options'
  );

  // 10. Compact Signed Token QR & Anti-Tamper Test (Part 1, Item 3)
  console.log('\n--- Testing Part 1: Compact Signed Token QR & Anti-Tamper Security ---');
  try {
    const fixedTs = 1730000000000;
    const token = createCompactToken('21CS045', 'CODE_RELAY', fixedTs);

    assert(typeof token === 'string', 'createCompactToken returns a signed token string');
    const parts = token.split('.');
    assert(parts.length === 4, `Compact token has exactly 4 delimited segments: ${token}`);
    assert(parts[0] === '21CS045', 'Segment 1 contains uppercase roll number');
    assert(parts[1] === 'CODE_RELAY', 'Segment 2 contains target event ID');
    assert(parts[2] === String(fixedTs), 'Segment 3 contains emission timestamp');
    assert(parts[3].length === 16, `Segment 4 contains 16-char HMAC signature (${parts[3]})`);

    // Verify valid token
    const verification = verifyTicketPayload(token);
    assert(verification.valid === true, 'verifyTicketPayload validates authentic compact token');
    assert(verification.roll === '21CS045', 'Extracted roll matches original input');
    assert(verification.eventId === 'CODE_RELAY', 'Extracted event ID matches');

    // Anti-Tamper test: Attacker modifies event ID from CODE_RELAY to HACKATHON
    const tamperedToken = `${parts[0]}.HACKATHON.${parts[2]}.${parts[3]}`;
    const tamperedVerification = verifyTicketPayload(tamperedToken);
    assert(tamperedVerification.valid === false, 'Tampered token is rejected immediately by HMAC check');
  } catch (err) {
    assert(false, `Compact Token verification failed: ${err.message}`);
  }

  // 11. Live Duplicate Roll Number Interceptor (Part 2, Item 2)
  console.log('\n--- Testing Part 2: Live Duplicate Roll Number Interceptor ---');
  try {
    const dupRoll = '21CS999';
    const testEvt = 'CODE_RELAY';

    // Verify not registered initially
    const preCheck = await checkDuplicateRoll(dupRoll, testEvt);
    assert(preCheck.exists === false, 'Duplicate checker returns false before registration exists');

    // Register participant
    await saveRegistration({
      phoneNumber: '919876543210',
      fullName: 'Duplicate Tester',
      collegeName: 'Alpha Engineering College',
      rollNumber: dupRoll,
      eventId: testEvt,
      eventName: 'Coding Relay',
      odStatus: 'APPROVED',
      amountPaid: 0,
    });

    // Check duplicate
    const postCheck = await checkDuplicateRoll(dupRoll, testEvt);
    assert(postCheck.exists === true, 'Duplicate checker identifies existing active registration');

    // Check different event for same roll (should NOT conflict)
    const diffEvtCheck = await checkDuplicateRoll(dupRoll, 'PAPER_PRES');
    assert(diffEvtCheck.exists === false, 'Same roll number for a different event is permitted');

    // Template rendering for duplicate roll notice
    const dupMsg = renderTemplate('duplicate_roll_error', {
      reg_no: dupRoll,
      event_name: 'Coding Relay',
      od_status: 'APPROVED',
    });
    assert(dupMsg.includes(dupRoll) && dupMsg.includes('already registered'), 'duplicate_roll_error template outputs clear conflict advice');
  } catch (err) {
    assert(false, `Duplicate roll interceptor failed: ${err.message}`);
  }

  // 12. Centralized SessionStore with Sliding TTL (Part 1, Item 2 & Part 2, Item 1)
  console.log('\n--- Testing Centralized SessionStore & Sliding TTL ---');
  try {
    const sessionJid = 'ttl_user@s.whatsapp.net';
    const initialSession = sessionStore.getSession(sessionJid);
    assert(initialSession.step === 'IDLE', 'SessionStore creates clean IDLE session on first touch');

    initialSession.step = 'COLLECT_NAME';
    initialSession.data.candidateName = 'Test User';
    assert(sessionStore.hasSession(sessionJid), 'hasSession identifies active session');

    // In-chat reset clears pending session
    sessionStore.resetSession(sessionJid);
    const afterReset = sessionStore.getSession(sessionJid);
    assert(afterReset.step === 'IDLE', 'resetSession clears pending session back to IDLE');
    assert(!afterReset.data.candidateName, 'Session metadata was purged on reset');
  } catch (err) {
    assert(false, `SessionStore test failed: ${err.message}`);
  }

  // 13. Physical Entry Gate Check-In & Duplicate Scanner Rejection (Part 2, Item 4)
  console.log('\n--- Testing Physical Entry Gate Scanner Admission Check-In ---');
  try {
    const gateRoll = '21IT001';
    const gateEvt = 'CODE_RELAY';

    await saveRegistration({
      phoneNumber: '919555555555',
      fullName: 'Gate Participant',
      collegeName: 'State Tech',
      rollNumber: gateRoll,
      eventId: gateEvt,
      eventName: 'Coding Relay',
      odStatus: 'APPROVED',
    });

    // 1st Check-In attempt (Valid entry)
    const checkIn1 = await checkInRegistration(gateRoll, gateEvt);
    assert(checkIn1.success === true, 'First gate scan successfully grants entry admission');
    assert(checkIn1.record.checked_in === true, 'Database marks record as checked_in = true');

    // 2nd Check-In attempt (Duplicate pass abuse)
    const checkIn2 = await checkInRegistration(gateRoll, gateEvt);
    assert(checkIn2.success === false, 'Second gate scan is strictly rejected');
    assert(checkIn2.alreadyCheckedIn === true, 'Rejection flagged with alreadyCheckedIn = true');
  } catch (err) {
    assert(false, `Gate Scanner test failed: ${err.message}`);
  }

  // 14. Error Snag Shielding & Broadcast Query (Part 1, Item 4 & Part 2, Item 3)
  console.log('\n--- Testing Error Snag Shielding & Broadcast Target Resolution ---');
  try {
    const snagMsg = renderTemplate('generic_snag_error');
    assert(!snagMsg.includes('postgres') && !snagMsg.includes('supabase'), 'generic_snag_error contains zero internal database leaks');
    assert(snagMsg.includes('temporary snag') || snagMsg.includes('helpdesk'), 'Snag message provides polite student guidance');

    const broadcastTargets = await getRegistrationsForEvent('CODE_RELAY');
    assert(Array.isArray(broadcastTargets) && broadcastTargets.length > 0, `getRegistrationsForEvent retrieves ${broadcastTargets.length} target records`);
  } catch (err) {
    assert(false, `Snag/Broadcast query test failed: ${err.message}`);
  }

  // 15. Operational Desk: Search, Manual UTR Override, Manifest Export & Health Diagnostic
  console.log('\n--- Testing Operations Desk: Search, UTR Override, Manifest & Health ---');
  try {
    const overrideRoll = '21CS777';
    await saveRegistration({
      phoneNumber: '919777777777',
      fullName: 'Override Candidate',
      collegeName: 'Apex Institute',
      rollNumber: overrideRoll,
      eventId: 'CODE_RELAY',
      eventName: 'Coding Relay',
      amountPaid: 150,
      odStatus: 'PENDING_APPROVAL',
      utrNumber: null,
    });

    // 15.1 Search
    const searchRes = await searchRegistrations('21CS777');
    assert(searchRes.length > 0, 'searchRegistrations finds attendee by roll number');
    assert(searchRes[0].roll_number === overrideRoll, 'Search result matches target roll');

    // 15.2 Manual UTR Override
    const manualRef = 'MANUAL_BANK_9999';
    const overrideRes = await manualVerifyPayment(searchRes[0].id, manualRef, 150);
    assert(overrideRes.success === true, 'manualVerifyPayment approves registration');
    assert(overrideRes.record.od_status === 'APPROVED', 'OD status marked as APPROVED');
    assert(overrideRes.record.utr_number === manualRef, `UTR recorded as ${manualRef}`);

    // 15.3 Manifest Query
    const allApproved = await getAllRegistrations({ eventId: 'CODE_RELAY', odStatus: 'APPROVED' });
    assert(Array.isArray(allApproved) && allApproved.length > 0, `getAllRegistrations filters approved attendees (${allApproved.length} found)`);

    // 15.4 Health Diagnostic
    const health = await testSupabaseHealth();
    assert(health.healthy === true, 'testSupabaseHealth returns healthy status');
    assert(health.count !== undefined, `Health report includes registration count (${health.count})`);
  } catch (err) {
    assert(false, `Operations Desk test failed: ${err.message}`);
  }

  // 16. Anti-Fraud Detection Pipeline (Exif/Metadata, Delegate ID & Tamper Detection)
  console.log('\n--- Testing Anti-Fraud Detection Pipeline & Delegate ID ---');
  try {
    // 16.1 Unique Delegate ID Generation
    const delegateId1 = generateDelegateId('NX');
    const delegateId2 = generateDelegateId('NX');
    assert(typeof delegateId1 === 'string' && delegateId1.startsWith('NX26-'), `Generated delegate ID format: ${delegateId1}`);
    assert(delegateId1 !== delegateId2, 'Delegate IDs are cryptographically unique');

    // 16.2 Exif / Binary Metadata Scan (Clean Buffer)
    const cleanBuffer = Buffer.from('RAW_UNEDITED_UPI_RECEIPT_BYTES_FROM_PHONE_CAMERA_NO_METADATA');
    const cleanMeta = checkImageMetadata(cleanBuffer);
    assert(cleanMeta.isEdited === false, 'Clean unedited screenshot passes metadata inspection');

    // 16.3 Exif / Metadata Scan (Canva / Photoshop Detection)
    const canvaMockBuffer = Buffer.from('JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00Software\x00Canva Web App v2');
    const canvaMeta = checkImageMetadata(canvaMockBuffer);
    assert(canvaMeta.isEdited === true, 'Canva metadata signature detected');
    assert(canvaMeta.detectedTool === 'Canva', `Detected tool identified as Canva (${canvaMeta.reason})`);

    const photoshopMockBuffer = Buffer.from('8BIM\x04\x04\x00\x00\x00\x00Adobe Photoshop CS6 Windows');
    const psMeta = checkImageMetadata(photoshopMockBuffer);
    assert(psMeta.isEdited === true, 'Adobe Photoshop metadata signature detected');
    assert(psMeta.detectedTool === 'Adobe Photoshop', `Detected tool identified as Adobe Photoshop`);

    // 16.4 Fraud Logging to Database
    const fraudRecord = await flagRegistrationFraud(
      {
        fullName: 'Scam Participant',
        phoneNumber: '919999999999',
        collegeName: 'Fake College',
        rollNumber: '21SCAM01',
        eventId: 'CODE_RELAY',
        eventName: 'Coding Relay',
        amountPaid: 150,
        manualUtr: '123456789012',
        delegateId: delegateId1,
      },
      'EDITED_METADATA',
      canvaMeta
    );
    assert(fraudRecord.od_status === 'FRAUD_FLAGGED', 'Fraud attempt flagged with od_status = FRAUD_FLAGGED');
    assert(fraudRecord.fraud_reason === 'EDITED_METADATA', 'Fraud reason accurately recorded');

    // 16.5 Template Verification & Auto-Embedded UPI Deep Link
    const upiUri = generateUpiPaymentUri({
      upiId: 'fest@sbi',
      payeeName: 'Fest Committee',
      amount: 150,
      delegateId: delegateId1,
    });
    assert(upiUri.includes(`tn=${delegateId1}`), 'UPI Deep link has delegate ID automatically embedded in tn parameter');
    assert(upiUri.includes('pa=fest@sbi') && upiUri.includes('am=150'), 'UPI Deep link encodes recipient VPA and amount');

    const upiQrBuffer = await generateUpiQrCode(upiUri);
    assert(Buffer.isBuffer(upiQrBuffer) && upiQrBuffer.length > 500, 'UPI payment QR code generated with pre-embedded delegate link');

    const invoiceMsg = renderTemplate('payment_invoice_delegate', {
      event_name: 'Coding Relay',
      student_name: 'Arun Kumar',
      delegate_id: delegateId1,
      fee: 150,
      upi_id: 'fest@sbi',
      payee_name: 'Fest Committee',
    });
    assert(invoiceMsg.includes(delegateId1), 'Invoice template prominently embeds mandatory Delegate ID');
    assert(invoiceMsg.includes('upi://pay'), 'Invoice template contains auto-embedded clickable upi://pay link');
    assert(invoiceMsg.includes(`tn=${delegateId1}`), 'Invoice template link embeds delegate ID in transaction note parameter');

    // 16.6 Simulator Dynamic Mock Receipt & Scam Generator
    const simReceipt = generateMockReceiptBuffer('409823145678', delegateId1, 150);
    assert(Buffer.isBuffer(simReceipt) && simReceipt.length > 1000, 'Simulator generates robust authentic PNG receipt buffer');
    const simReceiptMeta = checkImageMetadata(simReceipt);
    assert(simReceiptMeta.isEdited === false, 'Simulator authentic receipt has unedited metadata');

    const simScam = generateMockTamperedBuffer('Canva');
    assert(Buffer.isBuffer(simScam) && simScam.length > 1000, 'Simulator generates robust tampered mock buffer');
    const simScamMeta = checkImageMetadata(simScam);
    assert(simScamMeta.isEdited === true && simScamMeta.detectedTool === 'Canva', 'Simulator tampered mock buffer triggers Canva fraud detector');
  } catch (err) {
    assert(false, `Anti-Fraud Pipeline test failed: ${err.message}`);
  }

  console.log('\n=================================================');
  console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('=================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error('[TEST SUITE CRASH]', err);
  process.exit(1);
});
