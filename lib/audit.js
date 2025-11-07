// lib/audit.js
import fs from 'fs';
import path from 'path';

const AUDIT_DIR  = process.env.AUDIT_DIR || '/var/lib/ipfsui';
const AUDIT_FILE = path.join(AUDIT_DIR, 'audit.log');

// make sure directory exists
function ensureDir() {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
  } catch (e) {
    // ignore
  }
}

/**
 * Append one audit entry.
 * shape:
 * {
 *   ts: ISO string,
 *   action: 'upload' | 'rename' | 'replace' | 'delete',
 *   key: 'MyFile.mp4',
 *   fromKey?: 'OldName',
 *   user?: 'jake',
 *   meta?: {...}
 * }
 */
export function writeAudit(entry) {
  ensureDir();
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...entry
  });
  fs.appendFile(AUDIT_FILE, line + '\n', (err) => {
    if (err) {
      console.error('[audit] write failed:', err);
    }
  });
}

/**
 * Read all audit rows for a single key (most recent first).
 * This is fine for now because file won’t be huge yet.
 */
export function readAuditForKey(key) {
  ensureDir();
  if (!fs.existsSync(AUDIT_FILE)) return [];

  const lines = fs.readFileSync(AUDIT_FILE, 'utf8')
    .split('\n')
    .filter(Boolean);

  const rows = lines
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);

  // --- follow the whole rename chain ---
  // Start from the current key and walk backwards/sideways through
  // any events that reference this key OR previous names.
  const related = new Set([key]);
  let changed;

  do {
    changed = false;
    for (const r of rows) {
      const k  = r.key;
      const fk = r.fromKey;

      // If this row involves any key we already care about,
      // pull in both key and fromKey.
      if (related.has(k) || (fk && related.has(fk))) {
        if (!related.has(k)) {
          related.add(k);
          changed = true;
        }
        if (fk && !related.has(fk)) {
          related.add(fk);
          changed = true;
        }
      }
    }
  } while (changed);

  // Keep only rows that involve any of the related keys
  const result = rows
    .filter((r) => related.has(r.key) || (r.fromKey && related.has(r.fromKey)))
    // newest first
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));

  return result;
}
