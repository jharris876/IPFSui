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

// ===== Rename sub-dialog wiring =====
const renamePanel   = document.getElementById('renamePanel');
const renameInput   = document.getElementById('renameInput');
const renameCancel  = document.getElementById('renameCancel');
const renameConfirm = document.getElementById('renameConfirm');

function showRenamePanel(suggestedName) {
  if (!renamePanel) return;
  renameInput.value = suggestedName || '';
  renamePanel.hidden = false;
  // small timeout so focus doesn’t get swallowed by click transitions
  setTimeout(() => renameInput?.focus(), 0);
}
function hideRenamePanel() {
  if (renamePanel) renamePanel.hidden = true;
}

renameCancel?.addEventListener('click', () => {
  hideRenamePanel();               // user cancel — nothing else to do
});

// ===== Modal Rename button =====
let renameBusy = false;

detailRename?.addEventListener('click', () => {
  if (renameBusy) return;
  // derive just the filename (no prefix) from the current key
  const fromKey = window.detailCurrentKey;
  if (!fromKey) return;

  const base = (fromKey.split('/').pop() || '').trim();
  showRenamePanel(base);
});

// ===== Confirm rename =====
renameConfirm?.addEventListener('click', async () => {
  if (renameBusy) return;
  const fromKey = window.detailCurrentKey;
  if (!fromKey) return;

  const oldBase = (fromKey.split('/').pop() || '').trim();
  const next    = (renameInput?.value || '').trim();

  // Validate (no slashes, not empty)
  if (!next || next.includes('/')) {
    alert('New name must be non-empty and contain no slashes.');
    return; // remain open so user can fix it
  }
  // No change -> just close the panel (button remains usable)
  if (next === oldBase) {
    hideRenamePanel();
    return;
  }

  renameBusy = true;
  try {
    const res = await fetch('/api/catalog/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromKey, newName: next })
    });
    if (!res.ok) throw new Error(await res.text());

    const { key: toKey, lastModified } = await res.json();

    // Update global key for subsequent actions
    window.detailCurrentKey = toKey;

    // Refresh the modal details
    await loadDetailsForKey(toKey);

    // Update the table row: name cell + data-key + modified
    const selector = (window.CSS && CSS.escape)
      ? `button.view-file[data-key="${CSS.escape(fromKey)}"]`
      : 'button.view-file';
    let viewBtn = document.querySelector(selector);
    if (!viewBtn || viewBtn.dataset.key !== fromKey) {
      viewBtn = Array.from(document.querySelectorAll('button.view-file'))
        .find(b => b.dataset.key === fromKey);
    }
    if (viewBtn) {
      const tr = viewBtn.closest('tr');
      if (tr) {
        const keyCell = tr.querySelector('td'); // first cell = name/key
        if (keyCell) keyCell.textContent = (toKey.split('/').pop() || toKey);

        tr.querySelectorAll('button.view-file, button.get-cid, button.rename-file')
          .forEach(b => b.dataset.key = toKey);

        const lmCell = tr.querySelector('td:nth-child(4)');
        if (lmCell && typeof niceDate === 'function' && lastModified) {
          lmCell.textContent = niceDate(lastModified);
        }
      }
    }
  } catch (err) {
    console.error(err);
    alert(`Rename failed: ${err.message || err}`);
  } finally {
    hideRenamePanel();             // ALWAYS close the panel
    renameBusy = false;            // ALWAYS release guard
  }
});

// Delegate "View"  — modal details + inline rename panel (no prompt)
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button.view-file');
  if (!btn) return;

  // Modal bits
  const modal        = document.getElementById('detailModal');
  const titleEl      = document.getElementById('detailTitle');
  const bodyEl       = document.getElementById('detailBody');
  const renameBtn    = document.getElementById('detailRename');

  // Inline rename sub-panel
  const renamePanel  = document.getElementById('renamePanel');
  const renameInput  = document.getElementById('renameInput');
  let   renameCancel = document.getElementById('renameCancel');
  let   renameConfirm= document.getElementById('renameConfirm');

  // global you said you’re using
  window.detailCurrentKey = null;

  const openModal = () => {
    if (!modal) return;
    modal.removeAttribute('hidden');
    document.body.style.overflow = 'hidden';
  };
  const setTitle = (txt) => { if (titleEl) titleEl.textContent = txt || 'Item'; };
  const setBody  = (html) => { if (bodyEl)  bodyEl.innerHTML = html; };

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
        else if (ev.action === 'rename')   desc = ev.fromKey ? `Renamed from "${ev.fromKey}" to "${ev.key}"` : `Renamed to "${ev.key}"`;
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

  // Wire the inline rename panel for the current item (no stacked listeners)
  const wireRenameForItem = (item) => {
    if (!renameBtn || !renamePanel || !renameInput) return;

    // Reset/close panel each time we (re)load an item
    renamePanel.hidden = true;

    // Replace the buttons with clones to drop any old listeners
    const newRenameBtn = renameBtn.cloneNode(true);
    renameBtn.replaceWith(newRenameBtn);

    // Also reset the inner panel buttons so cancel/confirm don’t accumulate
    const newCancel  = renameCancel.cloneNode(true);
    const newConfirm = renameConfirm.cloneNode(true);
    renameCancel.replaceWith(newCancel);
    renameConfirm.replaceWith(newConfirm);
    renameCancel  = newCancel;
    renameConfirm = newConfirm;

    newRenameBtn.addEventListener('click', () => {
      const base = item.key.split('/').pop();
      renameInput.value = base;
      renamePanel.hidden = false;
      renameInput.focus();
      renameInput.select();
    });

    renameCancel.addEventListener('click', () => {
      renamePanel.hidden = true; // nothing sticky after cancel
    });

    renameConfirm.addEventListener('click', async () => {
      const base    = item.key.split('/').pop();
      const newName = (renameInput.value || '').trim();

      if (!newName) { renamePanel.hidden = true; return; }
      if (newName === base) { renamePanel.hidden = true; return; }
      if (newName.includes('/')) { alert('New name must be a plain filename (no slashes).'); return; }

      // lock UI while renaming
      renameConfirm.disabled = true;
      renameCancel.disabled  = true;

      try {
        const res = await fetch('/api/catalog/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fromKey: item.key, newName })
        });
        if (!res.ok) {
          const msg = await res.text().catch(()=>'');
          throw new Error(msg || `HTTP ${res.status}`);
        }
        const { key: toKey, lastModified } = await res.json();

        // Update current row so future clicks use the new key
        const tr = btn.closest('tr');
        if (tr) {
          const keyCell = tr.querySelector('td');
          if (keyCell) keyCell.textContent = toKey;
          tr.querySelectorAll('button.view-file, button.get-cid, button.rename-file')
            .forEach(b => b.dataset.key = toKey);
          // also patch the date cell in this row if we have it
          const dateCell = tr.querySelector('td:nth-child(4)');
          if (dateCell && lastModified) dateCell.textContent = niceDate(lastModified);
        }

        // Close panel and reload modal for new key
        renamePanel.hidden = true;
        window.detailCurrentKey = toKey;
        await loadForKey(toKey, false);
      } catch (err) {
        alert(`Rename failed: ${err.message}`);
      } finally {
        renameConfirm.disabled = false;
        renameCancel.disabled  = false;
      }
    });
  };

  // Load details + history for a key (follow if it was renamed elsewhere)
  const loadForKey = async (key, updateRowIfChanged = false) => {
    window.detailCurrentKey = key;
    openModal();
    setTitle(key);
    setBody('<p style="color:#9ca3af;">Loading…</p>');

    try {
      const itemUrl = new URL('/api/catalog/item', window.location.origin);
      itemUrl.searchParams.set('key', key);
      const histUrl = new URL('/api/catalog/history', window.location.origin);
      histUrl.searchParams.set('key', key);

      const [itemRes, histRes] = await Promise.all([ fetch(itemUrl), fetch(histUrl) ]);

      if (itemRes.status === 404) {
        const histJson   = await histRes.json().catch(() => ({ events: [] }));
        const events     = Array.isArray(histJson.events) ? histJson.events : [];
        const lastRename = events.find(ev => ev.action === 'rename' && ev.key && ev.ts);
        if (lastRename && lastRename.key && lastRename.key !== key) {
          if (updateRowIfChanged) {
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
      wireRenameForItem(item);   // <— hook up inline rename for THIS item
    } catch (err) {
      console.error(err);
      setBody(`<p style="color:#fca5a5;">Error: ${err.message}</p>`);
    }
  };

  const clickedKey = btn.dataset.key;
  if (clickedKey) await loadForKey(clickedKey, true);
});

// Inline rename for the modal (no prompt)
(() => {
  const detailTitle   = document.getElementById('detailTitle');
  const detailBody    = document.getElementById('detailBody');
  let   detailRename  = document.getElementById('detailRename');

  const panel         = document.getElementById('renamePanel');
  const input         = document.getElementById('renameInput');
  let   btnCancel     = document.getElementById('renameCancel');
  let   btnConfirm    = document.getElementById('renameConfirm');

  if (!detailRename || !panel || !input || !btnCancel || !btnConfirm) return;

  // Rebind everything with fresh nodes so listeners never stack
  function rebindRenameUI() {
    // fresh outer Rename button
    const freshRename = detailRename.cloneNode(true);
    detailRename.replaceWith(freshRename);
    detailRename = freshRename;

    // fresh inner panel buttons
    const freshCancel  = btnCancel.cloneNode(true);
    const freshConfirm = btnConfirm.cloneNode(true);
    btnCancel.replaceWith(freshCancel);
    btnConfirm.replaceWith(freshConfirm);
    btnCancel  = freshCancel;
    btnConfirm = freshConfirm;

    panel.hidden = true;

    // Open the panel
    detailRename.addEventListener('click', () => {
      const base = (detailCurrentKey || '').split('/').pop() || detailCurrentKey || '';
      input.value = base;
      panel.hidden = false;
      input.focus();
      input.select();
    });

    // Cancel simply hides the panel (no sticky state)
    btnCancel.addEventListener('click', () => {
      panel.hidden = true;
    });

    // Confirm rename
    btnConfirm.addEventListener('click', async () => {
      if (!window.detailCurrentKey) return;

      const oldKey  = window.detailCurrentKey;
      const base    = oldKey.split('/').pop();
      const newName = (input.value || '').trim();

      // Allow cancel or “no change” without breaking the button
      if (!newName || newName === base) { panel.hidden = true; return; }
      if (newName.includes('/')) { alert('New name must be a plain filename (no slashes).'); return; }

      if (window.renameBusy) return;
      window.renameBusy = true;

      btnConfirm.disabled   = true;
      btnCancel.disabled    = true;
      detailRename.disabled = true;

      try {
        const res = await fetch('/api/catalog/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fromKey: oldKey, newName })
        });
        if (!res.ok) throw new Error(await res.text());

        const { key: toKey, lastModified } = await res.json();

        // Update global + modal header
        window.detailCurrentKey = toKey;
        if (detailTitle) detailTitle.textContent = (toKey.split('/').pop()) || toKey;

        // Update fields inside the modal body if present
        if (detailBody) {
          const fullKeyDd = detailBody.querySelector('[data-field="fullKey"]');
          if (fullKeyDd) fullKeyDd.textContent = toKey;

          const lmDd = detailBody.querySelector('[data-field="lastModified"]');
          if (lmDd && lastModified) lmDd.textContent = niceDate(lastModified);
        }

        // Update the table row (first cell name + data-key on buttons + last modified)
        const rows = document.querySelectorAll('#catalogTable tbody tr');
        let   found = null;
        rows.forEach(r => {
          const viewBtn = r.querySelector('button.view-file');
          if (viewBtn && viewBtn.dataset.key === oldKey) found = r;
        });
        if (found) {
          const keyCell = found.querySelector('td');
          if (keyCell) keyCell.textContent = (toKey.split('/').pop()) || toKey;
          found.querySelectorAll('button.view-file, button.get-cid, button.rename-file')
            .forEach(b => b.dataset.key = toKey);
          const cells = found.querySelectorAll('td');
          // columns: [name, uploader, size, lastModified, action]
          if (cells && cells[3] && lastModified) cells[3].textContent = niceDate(lastModified);
        }

        panel.hidden = true;
      } catch (err) {
        alert(`Rename failed: ${err.message}`);
      } finally {
        window.renameBusy = false;
        btnConfirm.disabled   = false;
        btnCancel.disabled    = false;
        detailRename.disabled = false;
        // Make sure the button is usable again even after cancel/no-change
        rebindRenameUI();
      }
    });
  }

  rebindRenameUI();
})();

// Auto-load first page on initial load
window.addEventListener('DOMContentLoaded', () => {
  catalogForm?.dispatchEvent(new Event('submit'));
});
