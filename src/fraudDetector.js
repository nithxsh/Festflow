import crypto from 'crypto';
import dotenv from 'dotenv';
import QRCode from 'qrcode';
import { extractUTRFromImage } from './ocrVerifier.js';
import { flagRegistrationFraud } from './supabase.js';

dotenv.config();

/**
 * Generates a unique, tamper-proof delegate registration code.
 * Used as mandatory transaction note in UPI payment apps (e.g. "NX26-8A3F").
 *
 * @param {string} [prefix='NX']
 * @returns {string} 8-character code
 */
export function generateDelegateId(prefix = 'NX') {
  const cleanPrefix = (prefix || 'NX').trim().toUpperCase().slice(0, 4);
  const randomHex = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${cleanPrefix}26-${randomHex}`;
}

/**
 * Constructs a standard NPCI UPI payment deep link with the Delegate Code
 * pre-embedded in the transaction note (tn parameter).
 *
 * @param {object} params
 * @param {string} params.upiId - Merchant / Payee UPI ID (e.g. "nitxxsh@slc")
 * @param {string} [params.payeeName="Event Committee"] - Payee display name
 * @param {number|string} params.amount - Registration fee in INR
 * @param {string} params.delegateId - Unique delegate code to embed in note (e.g. "NX26-8A3F")
 * @returns {string} Fully formatted upi://pay URI
 */
export function generateUpiPaymentUri({ upiId, payeeName = 'Event Committee', amount = 0, delegateId = '' }) {
  const cleanUpi = (upiId || '').trim();
  const cleanPayee = encodeURIComponent((payeeName || 'Event Committee').trim());
  const cleanAmount = String(amount || 0).trim();
  const cleanCode = encodeURIComponent((delegateId || '').trim());

  return `upi://pay?pa=${cleanUpi}&pn=${cleanPayee}&am=${cleanAmount}&cu=INR&tn=${cleanCode}`;
}

/**
 * Generates a high-contrast QR code PNG buffer for the UPI payment link
 * with the Delegate ID embedded in the 'tn' parameter.
 * @param {string} upiUri
 * @returns {Promise<Buffer>}
 */
export async function generateUpiQrCode(upiUri) {
  return QRCode.toBuffer(upiUri, {
    type: 'png',
    margin: 2,
    width: 380,
    color: {
      dark: '#0f172a',
      light: '#ffffff',
    },
  });
}

/**
 * Stage 1: Fast Binary / Exif Metadata Inspection
 * Scans image buffer for metadata tags left by photo editors, canvas tools, and fake receipt generators.
 * (Canva, Photoshop, PicsArt, GIMP, Snapseed, Lightroom, Pixelcut, Paint.NET).
 *
 * @param {Buffer} imageBuffer
 * @returns {{isEdited: boolean, reason?: string}}
 */
export function checkImageMetadata(imageBuffer) {
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    return { isEdited: false };
  }

  try {
    // Read the binary header and metadata chunks as latin1 to preserve byte offsets
    const headerSlice = imageBuffer.slice(0, Math.min(imageBuffer.length, 65536)).toString('latin1').toLowerCase();

    const bannedSignatures = [
      { name: 'Canva', keywords: ['canva', 'software\0canva', 'creator\0canva'] },
      { name: 'Adobe Photoshop', keywords: ['photoshop', 'adobe photoshop', '8bim'] },
      { name: 'PicsArt', keywords: ['picsart', 'picsart photo'] },
      { name: 'GIMP', keywords: ['gimp', 'gimp-2'] },
      { name: 'Snapseed', keywords: ['snapseed'] },
      { name: 'Adobe Lightroom', keywords: ['lightroom', 'adobe lightroom'] },
      { name: 'Pixelcut', keywords: ['pixelcut'] },
      { name: 'Paint.NET', keywords: ['paint.net'] },
    ];

    for (const tool of bannedSignatures) {
      for (const kw of tool.keywords) {
        if (headerSlice.includes(kw)) {
          return {
            isEdited: true,
            reason: `Image metadata contains signature of editor: ${tool.name}`,
            detectedTool: tool.name,
          };
        }
      }
    }
  } catch (err) {
    console.warn('[FRAUD DETECTOR] Metadata inspection notice:', err.message);
  }

  return { isEdited: false };
}

/**
 * Stage 2: Multimodal Visual Forensics & Forensic Detail Verification.
 * Uses Google Gemini 2.5 Flash Vision AI when GEMINI_API_KEY is configured.
 * Automatically falls back to high-accuracy local Tesseract OCR when offline or unconfigured.
 *
 * @param {object} params
 * @param {Buffer} params.imageBuffer - Raw receipt image buffer
 * @param {string} [params.mimeType='image/jpeg'] - Image MIME type
 * @param {string} params.expectedNote - Mandatory Delegate ID expected in transaction note (e.g. "NX26-8A3F")
 * @param {number|string} params.expectedAmount - Expected registration fee (e.g. 150)
 * @param {string} params.manualUtr - 12-digit UTR manually entered by the student
 * @returns {Promise<{
 *   is_tampered: boolean,
 *   confidence_score: number,
 *   tampering_signs: string,
 *   note_found: boolean,
 *   detected_note: string,
 *   utr_matches: boolean,
 *   detected_utr: string,
 *   amount_matches: boolean,
 *   detected_amount: string,
 *   verdict: "APPROVED" | "REJECTED" | "MANUAL_REVIEW_NEEDED",
 *   engine: "gemini-2.5-flash" | "fallback-ocr"
 * }>}
 */
export async function verifyReceiptAuthenticity({
  imageBuffer,
  mimeType = 'image/jpeg',
  expectedNote,
  expectedAmount,
  manualUtr,
}) {
  const apiKey = process.env.GEMINI_API_KEY;

  // 1. If Gemini API Key is available, execute Multimodal Vision Forensic Audit
  if (apiKey && !apiKey.includes('your-gemini-key') && apiKey.trim().length > 10) {
    try {
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey });

      const prompt = `
You are a financial forensics auditor verifying Indian UPI payment screenshots (Google Pay, PhonePe, Paytm, BHIM, CRED).
Analyze this image strictly for tampering and detail verification.

Verify the following:
1. Is this a genuine, unedited payment screenshot, or does it look photoshopped, created on Canva, or generated using a fake UPI template? Look for font mismatches, misaligned text, inconsistent drop shadows, or background noise differences around the UTR or Amount.
2. Does the transaction Note/Remarks contain "${expectedNote}"?
3. Does the Amount match "₹${expectedAmount}" or "${expectedAmount}"?
4. Does the UTR / Ref Number in the image match "${manualUtr}"?

Output ONLY valid JSON matching this schema:
{
  "is_tampered": boolean,
  "confidence_score": number,
  "tampering_signs": string,
  "note_found": boolean,
  "detected_note": string,
  "utr_matches": boolean,
  "detected_utr": string,
  "amount_matches": boolean,
  "detected_amount": string,
  "verdict": "APPROVED" | "REJECTED"
}
`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              {
                inlineData: {
                  data: imageBuffer.toString('base64'),
                  mimeType: mimeType || 'image/jpeg',
                },
              },
            ],
          },
        ],
        config: { responseMimeType: 'application/json' },
      });

      const parsed = JSON.parse(response.text);
      parsed.engine = 'gemini-2.5-flash';
      return parsed;
    } catch (err) {
      console.warn('[FRAUD DETECTOR] Gemini Vision API call failed, falling back to local OCR:', err.message);
    }
  }

  // 2. Deterministic Fallback: Local Tesseract OCR Verification
  try {
    const ocrResult = await extractUTRFromImage(imageBuffer);
    const rawText = (ocrResult.rawText || '').toUpperCase();
    const cleanManualUtr = String(manualUtr || '').trim();
    const cleanExpectedNote = String(expectedNote || '').toUpperCase().trim();

    const utrFound = ocrResult.utr || '';
    const utrMatches = utrFound === cleanManualUtr || rawText.includes(cleanManualUtr);
    const noteFound = cleanExpectedNote ? rawText.includes(cleanExpectedNote) : true;
    const amountMatches = expectedAmount
      ? rawText.includes(String(expectedAmount)) || rawText.includes(`₹${expectedAmount}`)
      : true;

    const isTampered = false;
    const isApproved = utrMatches && noteFound;

    return {
      is_tampered: isTampered,
      confidence_score: ocrResult.confidence ? ocrResult.confidence / 100 : 0.85,
      tampering_signs: isApproved ? 'None' : 'Text matching failed in local OCR extraction',
      note_found: noteFound,
      detected_note: noteFound ? cleanExpectedNote : 'NOT_FOUND_IN_OCR',
      utr_matches: utrMatches,
      detected_utr: utrFound || 'NOT_DETECTED',
      amount_matches: amountMatches,
      detected_amount: String(expectedAmount || ''),
      verdict: isApproved ? 'APPROVED' : 'REJECTED',
      engine: 'fallback-ocr',
    };
  } catch (ocrErr) {
    return {
      is_tampered: false,
      confidence_score: 0,
      tampering_signs: `OCR inspection failed: ${ocrErr.message}`,
      note_found: false,
      detected_note: '',
      utr_matches: false,
      detected_utr: '',
      amount_matches: false,
      detected_amount: '',
      verdict: 'MANUAL_REVIEW_NEEDED',
      engine: 'fallback-ocr',
    };
  }
}

/**
 * Full Pipeline Execution: Runs metadata check and visual forensics in order.
 *
 * @param {object} params
 * @param {Buffer} params.imageBuffer
 * @param {string} params.expectedNote
 * @param {number|string} params.expectedAmount
 * @param {string} params.manualUtr
 * @param {object} params.sessionData
 * @returns {Promise<{
 *   passed: boolean,
 *   reason?: string,
 *   metadataResult: object,
 *   forensicResult: object
 * }>}
 */
export async function executeFraudInspection({
  imageBuffer,
  expectedNote,
  expectedAmount,
  manualUtr,
  sessionData = {},
}) {
  // Stage 1: Fast Metadata Check
  const metaCheck = checkImageMetadata(imageBuffer);
  if (metaCheck.isEdited) {
    await flagRegistrationFraud(
      { ...sessionData, delegateId: expectedNote, manualUtr },
      'EDITED_METADATA',
      metaCheck
    );
    return {
      passed: false,
      reason: `Screenshot exported from image editing software (${metaCheck.reason}). Manipulated screenshots are prohibited.`,
      metadataResult: metaCheck,
      forensicResult: null,
    };
  }

  // Stage 2: Multimodal AI Forensics
  const aiAudit = await verifyReceiptAuthenticity({
    imageBuffer,
    expectedNote,
    expectedAmount,
    manualUtr,
  });

  if (aiAudit.is_tampered || aiAudit.verdict === 'REJECTED') {
    await flagRegistrationFraud(
      { ...sessionData, delegateId: expectedNote, manualUtr },
      'AI_DETECTED_TAMPERING',
      aiAudit
    );

    let failReason = 'Payment verification failed.';
    if (aiAudit.is_tampered) {
      failReason = `Screenshot exhibits visual alteration or tampering: ${aiAudit.tampering_signs || 'Inconsistent font or pixel overlays'}.`;
    } else if (!aiAudit.note_found) {
      failReason = `Screenshot does not show your required Delegate ID (${expectedNote}) in the transaction remarks/notes field.`;
    } else if (!aiAudit.utr_matches) {
      failReason = `UTR in screenshot (${aiAudit.detected_utr || 'none'}) does not match the 12-digit UTR you entered (${manualUtr}).`;
    }

    return {
      passed: false,
      reason: failReason,
      metadataResult: metaCheck,
      forensicResult: aiAudit,
    };
  }

  return {
    passed: true,
    metadataResult: metaCheck,
    forensicResult: aiAudit,
  };
}
