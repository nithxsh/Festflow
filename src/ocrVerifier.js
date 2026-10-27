import { createWorker } from 'tesseract.js';

let cachedWorker = null;

/**
 * Initializes and caches a local Tesseract worker instance.
 */
async function getWorker() {
  if (!cachedWorker) {
    cachedWorker = await createWorker('eng');
  }
  return cachedWorker;
}

/**
 * Extracts 12-digit UTR / UPI Transaction Reference from a payment screenshot buffer.
 * Uses local Tesseract OCR and regex pattern matching.
 *
 * @param {Buffer} imageBuffer - In-memory image buffer of payment screenshot
 * @returns {Promise<{success: boolean, utr: string | null, rawText: string, confidence: number, error?: string}>}
 */
export async function extractUTRFromImage(imageBuffer) {
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    return {
      success: false,
      utr: null,
      rawText: '',
      confidence: 0,
      error: 'Invalid or empty image buffer received.',
    };
  }

  try {
    const worker = await getWorker();
    const result = await worker.recognize(imageBuffer);

    const rawText = result.data.text || '';
    const confidence = result.data.confidence || 0;

    // Normalize text (replace spaces/dashes between digits often split by OCR)
    const normalizedText = rawText.replace(/(\d)\s*[-:]\s*(\d)/g, '$1$2');

    // Primary target: 12-digit consecutive numeric sequence standard in UPI/IMPS UTRs
    // Also look specifically after keywords like "UPI Ref", "UTR", "Txn ID", "Transaction ID"
    const keywordMatch = normalizedText.match(/(?:UPI\s*(?:Ref|Txn|Reference)?\s*(?:No|ID)?|UTR|Transaction\s*ID)[:\s#]*([0-9]{12})/i);

    let extractedUtr = null;

    if (keywordMatch && keywordMatch[1]) {
      extractedUtr = keywordMatch[1];
    } else {
      // General 12-digit number boundary search
      const generalMatches = normalizedText.match(/\b\d{12}\b/g);
      if (generalMatches && generalMatches.length > 0) {
        // Pick the first valid 12-digit match
        extractedUtr = generalMatches[0];
      }
    }

    if (extractedUtr) {
      return {
        success: true,
        utr: extractedUtr,
        rawText,
        confidence,
      };
    }

    return {
      success: false,
      utr: null,
      rawText,
      confidence,
      error: 'Could not detect a valid 12-digit UPI UTR number in the screenshot.',
    };
  } catch (err) {
    console.error('[OCR VERIFIER] Extraction error:', err.message);
    return {
      success: false,
      utr: null,
      rawText: '',
      confidence: 0,
      error: `OCR processing failed: ${err.message}`,
    };
  }
}

/**
 * Terminates the OCR worker during process shutdown to prevent memory leaks.
 */
export async function terminateOCRWorker() {
  if (cachedWorker) {
    try {
      await cachedWorker.terminate();
    } catch (_) {}
    cachedWorker = null;
  }
}
