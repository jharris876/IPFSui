document.title = 'VaultFlow - Evidence & Media Catalog';
// ---------- helpers ----------
function humanBytes(n) {
  const u = ['B','KB','MB','GB','TB']; let i = 0;
  n = Number(n || 0);
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${u[i]}`;
}

// turn "2025/09/05/image.png" -> "image.png"
function itemKeyOnly(key) {
  if (!key) return '';
  const parts = key.split('/');
  return parts[parts.length - 1];
}

// "2025-09-04T22:44:21.000Z" -> "9/4/2025 22:44:21"
function niceDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso; // fallback
  const mm = d.getMonth() + 1;
  const dd = d.getDate();
  const yyyy = d.getFullYear();
  const hh = d.getHours().toString().padStart(2, '0');
  const mi = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  return `${mm}/${dd}/${yyyy} ${hh}:${mi}:${ss}`;
}

// New: ISO → "M/D/YYYY HH:MM:SS" in the user's local time
function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d)) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ---------- direct-to-Filebase uploader ----------
const directForm     = document.getElementById('directUploadForm');
const directFile     = document.getElementById('directFile');
const uploadTokenEl  = document.getElementById('uploadToken');
const overallBar     = document.getElementById('overallProgress');
const directResult   = document.getElementById('directResult');
const newFilenameEl  = document.getElementById('newFilename');

directForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  directResult.textContent = '';

  const file  = directFile?.files?.[0];
  const token = (uploadTokenEl?.value || '').trim();
  if (!file || !token) return;

  overallBar.value = 0;
  overallBar.style.display = 'block';

  // prefer the user-provided name if valid, else fallback to file.name
  let desired = (newFilenameEl?.value || '').trim();
  if(!desired || desired.includes('/')) desired = file.name;

  try {
    // 1) create multipart
    const createRes = await fetch('/api/multipart/create', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      
      body: JSON.stringify({
        filename: desired,
        contentType: file.type || 'application/octet-stream',
        fileSize: file.size
      })
    });
    if (!createRes.ok) throw new Error(`create failed: ${await createRes.text()}`);
    const { uploadId, key, partSize } = await createRes.json();

    // 2) upload parts (sequential for simplicity; parallel is easy later)
    const parts = [];
    const total = file.size;
    let uploadedBytes = 0;
    const updateOverall = (delta) => {
      uploadedBytes += delta;
      overallBar.value = Math.floor((uploadedBytes / total) * 100);
    };

    let partNumber = 1;
    for (let start = 0; start < total; start += partSize, partNumber++) {
      const end  = Math.min(start + partSize, total);
      const blob = file.slice(start, end);

      // sign this part
      const signUrl = new URL('/api/multipart/sign', window.location.origin);
      signUrl.searchParams.set('key', key);
      signUrl.searchParams.set('uploadId', uploadId);
      signUrl.searchParams.set('partNumber', String(partNumber));

      const signRes = await fetch(signUrl, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!signRes.ok) throw new Error(`sign failed (part ${partNumber}): ${await signRes.text()}`);
      const { url } = await signRes.json();

      // PUT blob with progress
      const etag = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', url);

        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) updateOverall(ev.loaded - (xhr._last || 0));
          xhr._last = ev.loaded;
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            const tag = xhr.getResponseHeader('ETag');
            if (!tag) return reject(new Error(`missing ETag (part ${partNumber})`));
            resolve(tag);
          } else {
            reject(new Error(`PUT failed (part ${partNumber}): ${xhr.status} ${xhr.statusText}`));
          }
        };
        xhr.onerror = () => reject(new Error(`network error on part ${partNumber}`));
        xhr.send(blob);
      });

      parts.push({ ETag: etag, PartNumber: partNumber });
    }

    // 3) complete
    const completeRes = await fetch('/api/multipart/complete', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ 
        key,
        uploadId,
        parts,
        //temp: use the token field as who uploaded
        uploader: (uploadTokenEl.value || '').trim() || 'web-user'
      })
    });

    if (!completeRes.ok) throw new Error(`complete failed: ${await completeRes.text()}`);
    const { cid, url } = await completeRes.json();

    overallBar.value = 100;
    
    const msg = [];
    msg.push(`<div><strong>Upload complete:</strong> ${file.name} (${humanBytes(file.size)})</div>`);
    if (cid) msg.push(`<div><strong>CID:</strong> ${cid}</div>`);
    if (url) msg.push(`<div><a href="${url}" target="_blank" rel="noopener">View on gateway</a></div>`);
    directResult.innerHTML = msg.join('');

    if (typeof catalogForm !== 'undefined' && catalogForm) {
      if (catalogTable) catalogTable.innerHTML = '';
      nextToken = null;
      catalogForm.dispatchEvent(new Event('submit'));
    }

  } catch (err) {
    console.error(err);
    directResult.textContent = `Error: ${err.message}`;
  } finally {
    setTimeout(() => { overallBar.style.display = 'none'; }, 1500);
  }
});

// ---------- catalog (list + item details + helpers) ----------
const catalogForm    = document.getElementById('catalogForm');
const catalogPrefix  = document.getElementById('catalogPrefix');
const catalogMeta    = document.getElementById('catalogMeta');

// Get <tbody> safely to avoid null errors
const catalogTableEl = document.getElementById('catalogTable');
const catalogTable   = catalogTableEl ? catalogTableEl.querySelector('tbody') : null;

const catalogMore    = document.getElementById('catalogMore');

// ---------- modal helpers ----------
const detailOverlay = document.getElementById('detailModal');   // <div id="detailModal" class="vf-modal" hidden>
const detailTitle   = document.getElementById('detailTitle');
const detailBody    = document.getElementById('detailBody');
const detailClose   = document.getElementById('detailClose');   // the “✕” button in header
const detailRename  = document.getElementById('detailRename');  // the header Rename button

function openDetailModal() {
  if (!detailOverlay) return;
  // show via attribute (single source of truth)
  detailOverlay.removeAttribute('hidden');
  // lock background scroll
  document.body.style.overflow = 'hidden';
}

function closeDetailModal() {
  if (!detailOverlay) return;
  // hide via attribute
  detailOverlay.setAttribute('hidden', '');
  // restore scroll
  document.body.style.overflow = '';
}

// close with X
detailClose?.addEventListener('click', closeDetailModal);

// close when clicking on the dark backdrop ONLY (not inside the card)
detailOverlay?.addEventListener('click', (e) => {
  // if the click started on the overlay itself (not inside the card), close
  if (e.target === detailOverlay) closeDetailModal();
});

// close with Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && detailOverlay && !detailOverlay.hasAttribute('hidden')) {
    closeDetailModal();
  }
});
//end view button
let nextToken = null;
let currentPrefix = '';
let detailCurrentKey = null;
let renameBusy = false;
let renameInFlight = false;

async function loadDetailsForKey(key) {
  detailCurrentKey = key;

  if (detailTitle) detailTitle.textContent = itemKeyOnly(key) || key;
  if (detailBody) detailBody.textContent = 'Loading…';

  try {
    const itemUrl = new URL('/api/catalog/item', window.location.origin);
    itemUrl.searchParams.set('key', key);

    const histUrl = new URL('/api/catalog/history', window.location.origin);
    histUrl.searchParams.set('key', key);

    const [itemRes, histRes] = await Promise.all([
      fetch(itemUrl),
      fetch(histUrl)
    ]);

    if (!itemRes.ok) throw new Error(`item failed: ${await itemRes.text()}`);
    if (!histRes.ok) throw new Error(`history failed: ${await histRes.text()}`);

    const item = await itemRes.json();
    const history = await histRes.json();

    const gwLink = item.url
      ? `<a href="${item.url}" target="_blank" rel="noopener">${item.cid || 'Open on gateway'}</a>`
      : '(no CID yet)';
    const uploadedBy = item.uploader || '(unknown)';
    const sizeStr = item.size != null ? humanBytes(item.size) : '(unknown)';
    const lmStr   = item.lastModified ? niceDate(item.lastModified) : '(unknown)';

    let historyHtml = '';
    const events = Array.isArray(history.events) ? history.events : [];
    if (!events.length) {
      historyHtml = '<p style="color:#9ca3af;">No history recorded yet.</p>';
    } else {
      historyHtml = '<div class="history-list"><ul>';
      for (const ev of events) {
        const when = ev.ts ? niceDate(ev.ts) : '(unknown time)';
        let desc = ev.action || 'event';

        if (ev.action === 'upload') {
          desc = 'Uploaded';
        } else if (ev.action === 'replace') {
          desc = 'Re-uploaded (replaced existing file)';
        } else if (ev.action === 'rename') {
          desc = ev.fromKey
            ? `Renamed from "${ev.fromKey}" to "${ev.key}"`
            : `Renamed to "${ev.key}"`;
        } else if (ev.action === 'delete') {
          desc = 'Deleted';
        }

        const who = ev.user || 'unknown';
        historyHtml += `<li><strong>${when}</strong> – ${desc} by <span style="color:#9ca3af;">${who}</span></li>`;
      }
      historyHtml += '</ul></div>';
    }

    if (detailBody) {
      detailBody.innerHTML = `
        <dl>
          <dt>Current name</dt>
          <dd>${itemKeyOnly(item.key) || item.key}</dd>

          <dt>Full key</dt>
          <dd data-field="fullKey">${item.key}</dd>

          <dt>Uploader</dt>
          <dd>${uploadedBy}</dd>

          <dt>Size</dt>
          <dd>${sizeStr}</dd>

          <dt>Last modified</dt>
          <dd data-field="lastModified">${lmStr}</dd>

          <dt>CID / Gateway</dt>
          <dd>${gwLink}</dd>
        </dl>

        <h3 style="font-size:0.9rem;margin:0.5rem 0;">Change history</h3>
        ${historyHtml}
      `;
    }
  } catch (err) {
    console.error(err);
    if (detailBody) {
      detailBody.innerHTML = `<p style="color:#fca5a5;">Error: ${err.message}</p>`;
    }
  }
}

async function fetchList(prefix, token = null) {
  const url = new URL('/api/catalog/list', window.location.origin);
  if (prefix) url.searchParams.set('prefix', prefix);
  url.searchParams.set('max', '50');
  if (token) url.searchParams.set('token', token);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`list failed: ${await res.text()}`);
  const data = await res.json();

  if (!catalogTable) return;

  (data.items || []).forEach(item => {
    const name = itemKeyOnly(item.key);
    const size = humanBytes(item.size);
    const mod  = niceDate(item.lastModified);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="word-break:break-all">${itemKeyOnly(item.key) || item.key}</td>
      <td class="uploader-cell" style="color:#9ca3af;">(unknown)</td>
      <td class="vf-right">${humanBytes(item.size)}</td>
      <td class="vf-nowrap">${niceDate(item.lastModified)}</td>
      <td class="vf-nowrap">
        <button class="vf-btn vf-btn-primary view-file" data-key="${item.key}">View</button>
      </td>
    `;
    catalogTable.appendChild(tr);
  });

  nextToken = data.nextToken || null;
  if (catalogMore) catalogMore.style.display = nextToken ? 'inline-block' : 'none';

  const count = catalogTable.querySelectorAll('tr').length;
  if (catalogMeta){ 
    catalogMeta.textContent = `Showing ${count} item(s)${prefix ? ` for prefix "${prefix}"` : ''}.`;
  }
}

catalogForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  currentPrefix = (catalogPrefix?.value || '').trim();
  if (catalogTable) catalogTable.innerHTML = '';
  nextToken = null;
  if (catalogMeta) catalogMeta.textContent = 'Loading…';
  try {
    await fetchList(currentPrefix, null);
  } catch (err) {
    console.error(err);
    if (catalogMeta) catalogMeta.textContent = `Error: ${err.message}`;
  }
});

catalogMore?.addEventListener('click', async () => {
  if (!nextToken) return;
  try {
    await fetchList(currentPrefix, nextToken);
  } catch (err) {
    console.error(err);
    if (catalogMeta) catalogMeta.textContent = `Error: ${err.message}`;
  }
});

// Delegate "Get CID"
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button.get-cid');
  if (!btn) return;
  btn.disabled = true;

  const key = btn.dataset.key;
  const slot = btn.parentElement.querySelector('.cid-slot');
  if (slot) slot.textContent = '…';

  try {
    const url = new URL('/api/catalog/item', window.location.origin);
    url.searchParams.set('key', key);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`item failed: ${await res.text()}`);

    const { cid, url: gw, uploader } = await res.json();

    // 1) show CID / link like before
    if (slot) {
      if (gw) {
        slot.innerHTML = `<a href="${gw}" target="_blank" rel="noopener">${cid || 'open'}</a>`;
      } else if (cid) {
        slot.textContent = cid;
      } else {
        slot.textContent = 'CID not available yet';
      }
    }

    // 2) update uploader cell in the same row
    const row = btn.closest('tr');
    if (row) {
      const upCell = row.querySelector('.uploader-cell');
      if (upCell) {
        upCell.textContent = uploader || '(unknown)';
      }
    }
  } catch (err) {
    console.error(err);
    if (slot) slot.textContent = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// --- Delegate "Rename" inside the View modal (robust against Cancel / no-change) ---
if (typeof detailCurrentKey === 'undefined') {
  // make sure the symbol exists; your code should set it when opening the modal
  window.detailCurrentKey = undefined;
}

detailRename?.addEventListener('click', async (e) => {
  // guard against double-clicks or stuck states
  if (renameBusy) return;
  renameBusy = true;

  try {
    const fromKey = detailCurrentKey;
    if (!fromKey) return; // nothing to rename

    const base = (fromKey.split('/').pop() || '').trim();

    // Synchronous prompt – may return null on cancel
    const raw = window.prompt(`Rename\n\n${base}\n\nto:`, base);

    const canceled  = (raw === null);
    const next      = canceled ? '' : String(raw).trim();
    const noChange  = !canceled && next === base;
    const invalid   = !canceled && (next.length === 0 || next.includes('/'));

    // If user cancels, or no change, or invalid -> just exit gracefully.
    // The finally below will ALWAYS clear renameBusy so the button works again.
    if (canceled || noChange || invalid) {
      if (invalid) alert('New name must be non-empty and contain no slashes.');
      return;
    }

    // Perform rename
    const res = await fetch('/api/catalog/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromKey, newName: next })
    });
    if (!res.ok) throw new Error(await res.text());

    const { key: toKey, lastModified } = await res.json();

    // Update current key for subsequent actions
    detailCurrentKey = toKey;

    // Refresh the modal details so UI shows the new name + history
    await loadDetailsForKey(toKey);

    // Update the row in the table (name cell, data-key attributes, last-modified)
    const selector = (window.CSS && CSS.escape)
      ? `button.view-file[data-key="${CSS.escape(fromKey)}"]`
      : 'button.view-file';
    let viewBtn = document.querySelector(selector);
    if (!viewBtn || (viewBtn.dataset && viewBtn.dataset.key !== fromKey)) {
      // fallback linear search
      viewBtn = Array.from(document.querySelectorAll('button.view-file'))
        .find(b => b.dataset.key === fromKey);
    }
    if (viewBtn) {
      const tr = viewBtn.closest('tr');
      if (tr) {
        const nameCell = tr.querySelector('td'); // first cell = name/key
        if (nameCell) nameCell.textContent = (toKey.split('/').pop() || toKey);

        tr.querySelectorAll('button.view-file, button.get-cid, button.rename-file')
          .forEach(b => b.dataset.key = toKey);

        const lmCell = tr.querySelector('td:nth-child(4)'); // "Last Modified" col
        if (lmCell && lastModified) lmCell.textContent = typeof niceDate === 'function'
          ? niceDate(lastModified)
          : lastModified;
      }
    }
  } catch (err) {
    console.error(err);
    alert(`Rename failed: ${err.message || err}`);
  } finally {
    // ALWAYS release the lock so the button becomes usable again
    renameBusy = false;
  }
});

//Delegate "View"
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button.view-file');
  if (!btn) return;

  // --- local refs to modal elements (no external helpers required)
  const modal   = document.getElementById('detailModal');
  const titleEl = document.getElementById('detailTitle');
  const bodyEl  = document.getElementById('detailBody');
  const renameEl= document.getElementById('detailRename');

  const open = () => {
    if (!modal) return;
    modal.removeAttribute('hidden');
    document.body.style.overflow = 'hidden';
  };
  const setBody = (html) => { if (bodyEl) bodyEl.innerHTML = html; };
  const setTitle = (txt) => { if (titleEl) titleEl.textContent = txt || 'Item'; };

  // helper to render the details + history
  const renderDetails = (item, history) => {
    const gwLink = item.url
      ? `<a href="${item.url}" target="_blank" rel="noopener">${item.cid || 'Open on gateway'}</a>`
      : '(no CID yet)';

    const uploadedBy = item.uploader || '(unknown)';
    const sizeStr    = item.size != null ? humanBytes(item.size) : '(unknown)';
    const lmStr      = item.lastModified ? niceDate(item.lastModified) : '(unknown)';

    let historyHtml = '';
    const events = Array.isArray(history?.events) ? history.events : [];
    if (!events.length) {
      historyHtml = '<p style="color:#9ca3af;">No history recorded yet.</p>';
    } else {
      historyHtml = '<div class="history-list"><ul style="max-height:220px;overflow:auto;margin:0;padding:0 0 0 1rem;">';
      for (const ev of events) {
        const when = ev.ts ? niceDate(ev.ts) : '(unknown time)';
        let desc = ev.action || 'event';
        if (ev.action === 'upload')        desc = 'Uploaded';
        else if (ev.action === 'replace')  desc = 'Re-uploaded (replaced existing file)';
        else if (ev.action === 'rename')   desc = ev.fromKey
              ? `Renamed from "${ev.fromKey}" to "${ev.key}"`
              : `Renamed to "${ev.key}"`;
        else if (ev.action === 'delete')   desc = 'Deleted';
        const who = ev.user || 'unknown';
        historyHtml += `<li style="margin:0.2rem 0;"><strong>${when}</strong> – ${desc} by <span style="color:#9ca3af;">${who}</span></li>`;
      }
      historyHtml += '</ul></div>';
    }

    setTitle(itemKeyOnly(item.key) || item.key);
    setBody(`
      <dl>
        <dt>Current name</dt><dd>${itemKeyOnly(item.key) || item.key}</dd>
        <dt>Full key</dt><dd>${item.key}</dd>
        <dt>Uploader</dt><dd>${uploadedBy}</dd>
        <dt>Size</dt><dd>${sizeStr}</dd>
        <dt>Last modified</dt><dd>${lmStr}</dd>
        <dt>CID / Gateway</dt><dd>${gwLink}</dd>
      </dl>
      <h3 style="font-size:0.9rem;margin:0.5rem 0;">Change history</h3>
      ${historyHtml}
    `);
  };

  // fetch item + history, following a rename if necessary
  const loadForKey = async (key, updateRowIfChanged = false) => {
    open();
    setTitle(key);
    setBody('<p style="color:#9ca3af;">Loading…</p>');

    try {
      const itemUrl = new URL('/api/catalog/item', window.location.origin);
      itemUrl.searchParams.set('key', key);

      const histUrl = new URL('/api/catalog/history', window.location.origin);
      histUrl.searchParams.set('key', key);

      const [itemRes, histRes] = await Promise.all([ fetch(itemUrl), fetch(histUrl) ]);

      // if item 404's, try to discover the newest rename target from history
      if (itemRes.status === 404) {
        const histJson = await histRes.json().catch(() => ({ events: [] }));
        const events   = Array.isArray(histJson.events) ? histJson.events : [];
        const lastRename = events.find(ev => ev.action === 'rename' && ev.key && ev.ts);
        if (lastRename && lastRename.key && lastRename.key !== key) {
          if (updateRowIfChanged) {
            // update the row so future clicks use the new key
            const tr = btn.closest('tr');
            if (tr) {
              const keyCell = tr.querySelector('td');
              if (keyCell) keyCell.textContent = lastRename.key;
              tr.querySelectorAll('button.view-file, button.get-cid, button.rename-file')
                .forEach(b => b.dataset.key = lastRename.key);
            }
          }
          return await loadForKey(lastRename.key, false);
        }
        // fallback: refresh the list so user sees the current state
        if (typeof fetchList === 'function') {
          if (typeof catalogTable !== 'undefined' && catalogTable) catalogTable.innerHTML = '';
          if (typeof nextToken !== 'undefined') nextToken = null;
          await fetchList((typeof currentPrefix !== 'undefined' ? currentPrefix : '') || '', null);
        }
        setBody('<p style="color:#fca5a5;">That item was renamed by someone else. I refreshed the list—click the new name to view it.</p>');
        return;
      }

      if (!itemRes.ok)  throw new Error(`item failed: ${await itemRes.text()}`);
      if (!histRes.ok)  throw new Error(`history failed: ${await histRes.text()}`);

      const item = await itemRes.json();
      const hist = await histRes.json();
      renderDetails(item, hist);

      // wire up Rename inside the modal (one-time per open)
      if (renameEl) {
        const renameHandler = async () => {
          const base = item.key.split('/').pop();
          const newName = prompt(`Rename\n\n${base}\n\nto:`, base);
          if (!newName || newName === base) return;
          if (newName.includes('/')) { alert('New name must be a plain filename (no slashes).'); return; }

          const res = await fetch('/api/catalog/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fromKey: item.key, newName })
          });
          if (!res.ok) { alert(`Rename failed: ${await res.text()}`); return; }

          const { key: toKey } = await res.json();
          // update table row immediately
          const tr = btn.closest('tr');
          if (tr) {
            const keyCell = tr.querySelector('td');
            if (keyCell) keyCell.textContent = toKey;
            tr.querySelectorAll('button.view-file, button.get-cid, button.rename-file')
              .forEach(b => b.dataset.key = toKey);
          }
          // reload modal for new key
          await loadForKey(toKey, false);
        };
        // ensure we don't stack multiple listeners across opens
        renameEl.replaceWith(renameEl.cloneNode(true));
        const freshRenameBtn = document.getElementById('detailRename');
        freshRenameBtn?.addEventListener('click', renameHandler, { once: true });
      }

    } catch (err) {
      console.error(err);
      setBody(`<p style="color:#fca5a5;">Error: ${err.message}</p>`);
    }
  };

  const clickedKey = btn.dataset.key;
  if (clickedKey) await loadForKey(clickedKey, true);
});

//Rename logic for modal
detailRename?.addEventListener('click', async () => {
  if (renameBusy) return;               // don’t allow double-click races
  if (!detailCurrentKey) return;

  const oldKey = detailCurrentKey;
  const base   = (itemKeyOnly(oldKey) || oldKey);

  const newName = prompt(`Rename\n\n${base}\n\nto:`, base);
  if (!newName || newName === base) return;
  if (newName.includes('/')) {
    alert('New name must be a plain filename (no slashes).');
    return;
  }

  renameBusy = true;
  detailRename.disabled = true;

  try {
    const res = await fetch('/api/catalog/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromKey: oldKey, newName })
    });
    if (!res.ok) throw new Error(await res.text());

    const { key: toKey, lastModified } = await res.json();

    // Update modal state
    detailCurrentKey = toKey;
    if (detailTitle) detailTitle.textContent = itemKeyOnly(toKey) || toKey;

    if (detailBody) {
      // These selectors rely on small data hooks; add them once in your modal HTML render
      const fullKeyDd = detailBody.querySelector('[data-field="fullKey"]');
      if (fullKeyDd) fullKeyDd.textContent = toKey;

      const lmDd = detailBody.querySelector('[data-field="lastModified"]');
      if (lmDd && lastModified) lmDd.textContent = niceDate(lastModified);
    }

    // Update the row in the table (so future clicks use the new key)
    // Try to find the exact row by the old data-key first
    const escapedOld = (window.CSS && CSS.escape) ? CSS.escape(oldKey) : oldKey.replace(/"/g, '\\"');
    const rowBtn = document.querySelector(`button.view-file[data-key="${escapedOld}"]`);
    if (rowBtn) {
      const tr = rowBtn.closest('tr');
      // update first cell (name/key)
      const nameCell = tr?.querySelector('td');
      if (nameCell) nameCell.textContent = (itemKeyOnly(toKey) || toKey);
      // update all buttons in the row to new key
      tr?.querySelectorAll('button.view-file, button.get-cid, button.rename-file')
        .forEach(b => b.dataset.key = toKey);
      // update the “Last Modified” cell if we have it
      if (lastModified) {
        const cells = tr?.querySelectorAll('td');
        // Assuming columns: [name, uploader, size, lastModified, action]
        const lastModCell = cells && cells[3];
        if (lastModCell) lastModCell.textContent = niceDate(lastModified);
      }
    }

  } catch (err) {
    alert(`Rename failed: ${err.message}`);
  } finally {
    renameBusy = false;
    detailRename.disabled = false;   // <- ensure button works again without closing modal
  }
});

// Auto-load first page on initial load
window.addEventListener('DOMContentLoaded', () => {
  catalogForm?.dispatchEvent(new Event('submit'));
});
