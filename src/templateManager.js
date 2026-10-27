import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const templatesPath = path.join(__dirname, '..', 'config', 'templates.json');

/**
 * Loads all templates from disk.
 * @returns {Record<string, string>}
 */
export function loadTemplates() {
  try {
    if (fs.existsSync(templatesPath)) {
      return JSON.parse(fs.readFileSync(templatesPath, 'utf8'));
    }
  } catch (err) {
    console.error('[TEMPLATE MANAGER] Error reading templates.json:', err.message);
  }
  return {};
}

/**
 * Saves updated templates to disk.
 * @param {Record<string, string>} templates
 */
export function saveTemplates(templates) {
  fs.writeFileSync(templatesPath, JSON.stringify(templates, null, 2), 'utf8');
}

/**
 * Retrieves a single template string by key.
 * @param {string} key
 * @returns {string}
 */
export function getTemplate(key) {
  const templates = loadTemplates();
  return templates[key] || '';
}

/**
 * Interpolates variables into a template string using {placeholder} syntax.
 * @param {string} key - Template key from templates.json
 * @param {Record<string, string | number>} variables - Map of values to substitute
 * @returns {string} Interpolated text
 */
export function renderTemplate(key, variables = {}) {
  let template = getTemplate(key);
  if (!template) {
    console.warn(`[TEMPLATE MANAGER] Warning: Template key "${key}" not found.`);
    return '';
  }

  // Auto-generate embedded upi_link and upi_uri if missing
  const vars = { ...variables };
  if (!vars.upi_link && !vars.upi_uri && vars.upi_id) {
    const code = vars.delegate_id || vars.reg_no || '';
    const payee = encodeURIComponent(String(vars.payee_name || 'Event Committee').trim());
    const amount = String(vars.fee || 0).trim();
    const upiUri = `upi://pay?pa=${String(vars.upi_id).trim()}&pn=${payee}&am=${amount}&cu=INR&tn=${encodeURIComponent(code)}`;
    vars.upi_link = upiUri;
    vars.upi_uri = upiUri;
  }

  for (const [varName, value] of Object.entries(vars)) {
    const regex = new RegExp(`\\{${varName}\\}`, 'g');
    template = template.replace(regex, String(value ?? ''));
  }

  return template;
}

/**
 * Updates a specific template and persists to disk.
 * @param {string} key
 * @param {string} text
 */
export function updateTemplate(key, text) {
  const templates = loadTemplates();
  templates[key] = text;
  saveTemplates(templates);
}
