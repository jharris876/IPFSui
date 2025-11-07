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
    .filter((r) =>
      r &&
      (
        r.key === key ||        // events where this is the current key
        r.fromKey === key       // events where this was the old key in a rename
      )
    )
    // oldest → newest (nicer for a history view; if you prefer newest first, flip the sort)
    .sort((a, b) => a.ts.localeCompare(b.ts));

  return rows;
}
