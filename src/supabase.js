import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;

if (supabaseUrl && supabaseKey && !supabaseUrl.includes('your-project')) {
  supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
} else {
  console.warn('[SUPABASE] Running in offline / unconfigured mock mode. Database queries will return simulated results.');
}

// In-memory mock store for offline testing and simulator
const mockRegistrations = [];

/**
 * Resets in-memory mock database (used for testing).
 */
export function resetMockDatabase() {
  mockRegistrations.length = 0;
}

/**
 * Checks if a UTR number is already recorded in the database.
 * @param {string} utr - 12-digit UTR transaction reference
 * @returns {Promise<{exists: boolean, record?: object}>}
 */
export async function checkUTRDuplicate(utr) {
  const cleanUtr = utr.trim();
  if (!supabase) {
    const found = mockRegistrations.find((r) => r.utr_number === cleanUtr || r.utrNumber === cleanUtr);
    return { exists: !!found, record: found };
  }

  const { data, error } = await supabase
    .from('registrations')
    .select('id, roll_number, full_name, created_at')
    .eq('utr_number', cleanUtr)
    .maybeSingle();

  if (error) {
    console.error('[SUPABASE] Error checking UTR duplicate:', error.message);
    throw error;
  }

  return { exists: !!data, record: data };
}

/**
 * Counts the total number of registrations for a specific event track.
 * Used for hard-capping slot capacities (SOLD OUT trigger).
 * @param {string} eventId
 * @returns {Promise<number>}
 */
export async function getEventRegistrationCount(eventId) {
  const cleanId = eventId.trim();
  if (!supabase) {
    return mockRegistrations.filter((r) => r.event_id === cleanId || r.eventId === cleanId).length;
  }

  try {
    const { count, error } = await supabase
      .from('registrations')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', cleanId);

    if (error) {
      console.warn('[SUPABASE] Count query warning:', error.message);
      return 0;
    }

    return count || 0;
  } catch (err) {
    console.warn('[SUPABASE] Registration count error:', err.message);
    return 0;
  }
}

/**
 * Inserts a new attendee registration record with optional team fields.
 * @param {object} payload - Registration details
 * @returns {Promise<object>} Inserted registration record
 */
export async function saveRegistration(payload) {
  const record = {
    id: 'reg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    phone_number: payload.phoneNumber,
    full_name: payload.fullName,
    college_name: payload.collegeName,
    department: payload.department || null,
    roll_number: payload.rollNumber,
    event_id: payload.eventId,
    event_name: payload.eventName,
    amount_paid: payload.amountPaid || 0,
    utr_number: payload.utrNumber || null,
    mentor_name: payload.mentorName || null,
    mentor_phone: payload.mentorPhone || null,
    od_status: payload.odStatus || 'PENDING_APPROVAL',
    team_name: payload.teamName || null,
    team_members: payload.teamMembers || [],
    checked_in: false,
    pass_url: payload.passUrl || null,
    qr_hash: payload.qrHash || null,
    delegate_id: payload.delegateId || payload.delegate_id || null,
    fraud_reason: payload.fraudReason || payload.fraud_reason || null,
    fraud_details: payload.fraudDetails || payload.fraud_details || null,
    created_at: new Date().toISOString(),
  };

  if (!supabase) {
    mockRegistrations.push(record);
    return record;
  }

  const { data, error } = await supabase
    .from('registrations')
    .insert([record])
    .select()
    .single();

  if (error) {
    console.error('[SUPABASE] Insert failed:', error.message);
    throw error;
  }

  return data;
}

/**
 * Updates OD approval status for a single student by roll number.
 * @param {string} rollNumber - Student roll number
 * @param {'APPROVED' | 'REJECTED'} status - Approval decision
 * @param {string} mentorPhone - Phone of mentor responding
 * @returns {Promise<object>} Updated record
 */
export async function updateODStatus(rollNumber, status, mentorPhone) {
  const cleanRoll = rollNumber.trim().toUpperCase();

  if (!supabase) {
    const found = mockRegistrations.find((r) => (r.roll_number || r.rollNumber || '').toUpperCase() === cleanRoll);
    if (found) {
      found.od_status = status;
      return found;
    }
    return { roll_number: rollNumber, od_status: status };
  }

  const query = supabase
    .from('registrations')
    .update({ od_status: status })
    .ilike('roll_number', cleanRoll);

  if (mentorPhone) {
    const cleanPhone = mentorPhone.replace(/\D/g, '').slice(-10);
    query.ilike('mentor_phone', `%${cleanPhone}%`);
  }

  const { data, error } = await query.select().order('created_at', { ascending: false }).limit(1);

  if (error) {
    console.error('[SUPABASE] Failed to update OD status:', error.message);
    throw error;
  }

  return data && data.length > 0 ? data[0] : null;
}

/**
 * Batch updates all pending OD registrations for a given mentor phone number ("YES ALL").
 * @param {string} mentorPhone - 10-digit mentor phone
 * @param {'APPROVED' | 'REJECTED'} status - Bulk decision
 * @returns {Promise<Array<object>>} List of updated registration rows
 */
export async function updateBulkODStatus(mentorPhone, status) {
  const cleanPhone = mentorPhone.replace(/\D/g, '').slice(-10);

  if (!supabase) {
    const matched = mockRegistrations.filter(
      (r) =>
        (r.mentor_phone || '').includes(cleanPhone) &&
        r.od_status === 'PENDING_APPROVAL'
    );

    if (matched.length > 0) {
      matched.forEach((r) => {
        r.od_status = status;
      });
      return matched;
    }

    // Default simulated batch response for testing if empty
    return [
      {
        full_name: 'Simulated Student',
        roll_number: 'SIM_001',
        phone_number: '919876543210',
        event_name: 'Technical Event',
        od_status: status,
      },
    ];
  }

  const { data, error } = await supabase
    .from('registrations')
    .update({ od_status: status })
    .ilike('mentor_phone', `%${cleanPhone}%`)
    .eq('od_status', 'PENDING_APPROVAL')
    .select();

  if (error) {
    console.error('[SUPABASE] Bulk OD update failed:', error.message);
    throw error;
  }

  return data || [];
}

/**
 * Fetches the latest registration by roll number.
 * @param {string} rollNumber
 */
export async function getRegistrationByRoll(rollNumber) {
  if (!supabase) {
    return null;
  }

  const { data, error } = await supabase
    .from('registrations')
    .select('*')
    .ilike('roll_number', rollNumber.trim())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[SUPABASE] Query failed:', error.message);
    return null;
  }

  return data;
}

/**
 * Checks if a student roll number is already registered for an event track.
 * Used by Live Duplicate Roll Number Interceptor (Part 2, Item 2).
 * @param {string} rollNumber
 * @param {string} eventId
 * @returns {Promise<{exists: boolean, record?: object}>}
 */
export async function checkDuplicateRoll(rollNumber, eventId) {
  const cleanRoll = String(rollNumber).trim().toUpperCase();
  const cleanId = String(eventId).trim();

  if (!supabase) {
    const found = mockRegistrations.find(
      (r) =>
        (r.roll_number || r.rollNumber || '').toUpperCase() === cleanRoll &&
        (r.event_id === cleanId || r.eventId === cleanId)
    );
    return { exists: !!found, record: found };
  }

  try {
    const { data, error } = await supabase
      .from('registrations')
      .select('id, full_name, event_name, od_status, pass_url')
      .ilike('roll_number', cleanRoll)
      .eq('event_id', cleanId)
      .maybeSingle();

    if (error) {
      console.warn('[SUPABASE DUPLICATE ROLL WARNING]', error.message);
      return { exists: false };
    }

    return { exists: !!data, record: data };
  } catch (err) {
    console.warn('[SUPABASE DUPLICATE ROLL ERROR]', err.message);
    return { exists: false };
  }
}

/**
 * Fetches all confirmed/registered attendees for a specific event (or ALL events).
 * Used by #BROADCAST admin dispatch (Part 2, Item 3).
 * @param {string} eventId - Target event ID or 'ALL'
 * @returns {Promise<Array<object>>}
 */
export async function getRegistrationsForEvent(eventId) {
  const target = (eventId || '').trim().toUpperCase();

  if (!supabase) {
    if (target === 'ALL') {
      return [...mockRegistrations];
    }
    return mockRegistrations.filter(
      (r) => (r.event_id || r.eventId || '').toUpperCase() === target
    );
  }

  try {
    let query = supabase
      .from('registrations')
      .select('id, phone_number, full_name, roll_number, event_id, event_name, od_status');

    if (target !== 'ALL') {
      query = query.eq('event_id', target);
    }

    const { data, error } = await query;
    if (error) {
      console.error('[SUPABASE BROADCAST QUERY ERROR]', error.message);
      return [];
    }
    return data || [];
  } catch (err) {
    console.error('[SUPABASE BROADCAST ERROR]', err.message);
    return [];
  }
}

/**
 * Marks an attendee registration as checked-in at the physical entry gate.
 * Used by Real-Time Physical Gate Scanner PWA (Part 2, Item 4).
 * @param {string} rollNumber
 * @param {string} eventId
 * @returns {Promise<{success: boolean, record?: object, alreadyCheckedIn?: boolean, error?: string}>}
 */
export async function checkInRegistration(rollNumber, eventId) {
  const cleanRoll = String(rollNumber).trim().toUpperCase();
  const cleanId = String(eventId).trim().toUpperCase();

  if (!supabase) {
    const found = mockRegistrations.find(
      (r) =>
        (r.roll_number || r.rollNumber || '').toUpperCase() === cleanRoll &&
        (r.event_id || r.eventId || '').toUpperCase() === cleanId
    );

    if (!found) {
      return { success: false, error: 'Registration not found' };
    }

    if (found.checked_in) {
      return { success: false, alreadyCheckedIn: true, record: found };
    }

    found.checked_in = true;
    found.checked_in_at = new Date().toISOString();
    return { success: true, record: found };
  }

  try {
    const { data: record, error: fetchErr } = await supabase
      .from('registrations')
      .select('*')
      .ilike('roll_number', cleanRoll)
      .eq('event_id', cleanId)
      .maybeSingle();

    if (fetchErr || !record) {
      return { success: false, error: 'Registration record not found' };
    }

    if (record.checked_in) {
      return { success: false, alreadyCheckedIn: true, record };
    }

    const { data: updated, error: updateErr } = await supabase
      .from('registrations')
      .update({ checked_in: true, updated_at: new Date().toISOString() })
      .eq('id', record.id)
      .select()
      .single();

    if (updateErr) {
      return { success: false, error: updateErr.message };
    }

    return { success: true, record: updated };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Uploads generated digital pass to Supabase storage bucket (optional).
 * @param {Buffer} buffer - Image buffer of generated pass
 * @param {string} filename - Target file name
 * @returns {Promise<string|null>} Public URL or null
 */
export async function uploadPassImage(buffer, filename) {
  if (!supabase) return null;

  const bucketName = process.env.SUPABASE_STORAGE_BUCKET || 'fest-passes';

  try {
    const { data, error } = await supabase.storage
      .from(bucketName)
      .upload(filename, buffer, {
        contentType: 'image/png',
        upsert: true,
      });

    if (error) {
      console.warn('[SUPABASE STORAGE] Upload note:', error.message);
      return null;
    }

    const { data: publicUrlData } = supabase.storage
      .from(bucketName)
      .getPublicUrl(filename);

    return publicUrlData?.publicUrl || null;
  } catch (err) {
    console.warn('[SUPABASE STORAGE] Optional pass upload skipped:', err.message);
    return null;
  }
}

/**
 * Searches attendees by roll number, phone number, full name, or UTR number.
 * Used by Manual UTR Resolution / Overrides desk.
 * @param {string} query
 * @returns {Promise<Array<object>>}
 */
export async function searchRegistrations(query) {
  const clean = (query || '').trim();
  if (!clean) return [];

  if (!supabase) {
    const qLower = clean.toLowerCase();
    return mockRegistrations.filter((r) => {
      const delId = (r.delegate_id || r.delegateId || '').toLowerCase();
      const roll = (r.roll_number || r.rollNumber || '').toLowerCase();
      const phone = (r.phone_number || r.phoneNumber || '').toLowerCase();
      const name = (r.full_name || r.fullName || '').toLowerCase();
      const utr = (r.utr_number || r.utrNumber || '').toLowerCase();
      return (
        delId.includes(qLower) ||
        roll.includes(qLower) ||
        phone.includes(qLower) ||
        name.includes(qLower) ||
        utr.includes(qLower)
      );
    });
  }

  try {
    const { data, error } = await supabase
      .from('registrations')
      .select('*')
      .or(
        `delegate_id.ilike.%${clean}%,roll_number.ilike.%${clean}%,phone_number.ilike.%${clean}%,full_name.ilike.%${clean}%,utr_number.ilike.%${clean}%`
      )
      .order('created_at', { ascending: false })
      .limit(25);

    if (error) {
      console.error('[SUPABASE SEARCH ERROR]', error.message);
      return [];
    }
    return data || [];
  } catch (err) {
    console.error('[SUPABASE SEARCH ERROR]', err.message);
    return [];
  }
}

/**
 * Logs a fraudulent or manipulated payment screenshot attempt in the database.
 * @param {object} payload - Attendee session data
 * @param {string} fraudReason - Specific failure reason (e.g. EDITED_METADATA, AI_DETECTED_TAMPERING)
 * @param {object|string} [details] - Technical audit breakdown
 * @returns {Promise<object>}
 */
export async function flagRegistrationFraud(payload, fraudReason, details) {
  const record = {
    id: 'fraud_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    phone_number: payload.phoneNumber || payload.phone_number || '',
    full_name: payload.fullName || payload.full_name || '',
    college_name: payload.collegeName || payload.college_name || '',
    department: payload.department || null,
    roll_number: payload.rollNumber || payload.roll_number || 'UNKNOWN',
    event_id: payload.eventId || payload.event_id || '',
    event_name: payload.eventName || payload.event_name || '',
    amount_paid: payload.amountPaid || payload.amount_paid || 0,
    utr_number: payload.utrNumber || payload.utr_number || payload.manualUtr || null,
    delegate_id: payload.delegateId || payload.delegate_id || null,
    od_status: 'FRAUD_FLAGGED',
    fraud_reason: fraudReason,
    fraud_details: typeof details === 'string' ? { summary: details } : details,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  if (!supabase) {
    mockRegistrations.push(record);
    return record;
  }

  try {
    const { data, error } = await supabase
      .from('registrations')
      .insert([record])
      .select()
      .single();
    if (error) {
      console.warn('[SUPABASE FRAUD LOG ERROR]', error.message);
    }
    return data || record;
  } catch (err) {
    console.warn('[SUPABASE FRAUD LOG ERROR]', err.message);
    return record;
  }
}

/**
 * Manually marks an attendee's payment verified and approves their OD.
 * Used when OCR fails or when payment is verified offline/manually at the desk.
 * @param {string} registrationId
 * @param {string} manualUtr
 * @param {number} [amountPaid]
 * @returns {Promise<{success: boolean, record?: object, error?: string}>}
 */
export async function manualVerifyPayment(registrationId, manualUtr, amountPaid) {
  const cleanId = String(registrationId).trim();
  const cleanUtr = String(manualUtr).trim();

  if (!cleanId || !cleanUtr) {
    return { success: false, error: 'Registration ID and UTR reference are required' };
  }

  if (!supabase) {
    const found = mockRegistrations.find(
      (r) => r.id === cleanId || r.roll_number === cleanId || r.rollNumber === cleanId
    );
    if (!found) {
      return { success: false, error: 'Registration record not found' };
    }
    found.od_status = 'APPROVED';
    found.utr_number = cleanUtr;
    if (amountPaid !== undefined) found.amount_paid = Number(amountPaid);
    found.updated_at = new Date().toISOString();
    return { success: true, record: found };
  }

  try {
    const updatePayload = {
      od_status: 'APPROVED',
      utr_number: cleanUtr,
      updated_at: new Date().toISOString(),
    };
    if (amountPaid !== undefined) {
      updatePayload.amount_paid = Number(amountPaid);
    }

    const { data, error } = await supabase
      .from('registrations')
      .update(updatePayload)
      .eq('id', cleanId)
      .select()
      .single();

    if (error) {
      return { success: false, error: error.message };
    }
    return { success: true, record: data };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Fetches all registrations with multi-dimensional filtering for CSV export.
 * @param {{eventId?: string, department?: string, odStatus?: string}} [filters]
 * @returns {Promise<Array<object>>}
 */
export async function getAllRegistrations(filters = {}) {
  const { eventId, department, odStatus } = filters;

  if (!supabase) {
    return mockRegistrations.filter((r) => {
      if (eventId && eventId !== 'ALL' && (r.event_id || r.eventId) !== eventId) return false;
      if (department && department !== 'ALL' && (r.department || '').toLowerCase() !== department.toLowerCase()) return false;
      if (odStatus && odStatus !== 'ALL' && (r.od_status || r.odStatus) !== odStatus) return false;
      return true;
    });
  }

  try {
    let query = supabase.from('registrations').select('*').order('created_at', { ascending: false });

    if (eventId && eventId !== 'ALL') {
      query = query.eq('event_id', eventId.trim().toUpperCase());
    }
    if (department && department !== 'ALL') {
      query = query.ilike('department', department.trim());
    }
    if (odStatus && odStatus !== 'ALL') {
      query = query.eq('od_status', odStatus.trim().toUpperCase());
    }

    const { data, error } = await query;
    if (error) {
      console.error('[SUPABASE GET ALL ERROR]', error.message);
      return [];
    }
    return data || [];
  } catch (err) {
    console.error('[SUPABASE GET ALL ERROR]', err.message);
    return [];
  }
}

/**
 * Diagnostic health probe for Supabase connectivity and API response time.
 * @returns {Promise<{healthy: boolean, latencyMs: number, error?: string, mode: 'live'|'mock', count?: number}>}
 */
export async function testSupabaseHealth() {
  if (!supabase) {
    return { healthy: true, latencyMs: 0, mode: 'mock', count: mockRegistrations.length };
  }

  const start = Date.now();
  try {
    const { count, error } = await supabase
      .from('registrations')
      .select('id', { count: 'exact', head: true });

    const latencyMs = Date.now() - start;

    if (error) {
      return { healthy: false, latencyMs, error: error.message, mode: 'live' };
    }
    return { healthy: true, latencyMs, count: count || 0, mode: 'live' };
  } catch (err) {
    return { healthy: false, latencyMs: Date.now() - start, error: err.message, mode: 'live' };
  }
}

export { supabase };
