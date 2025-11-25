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

const detailOverlay = document.getElementById('detailOverlay');
const detailTitle   = document.getElementById('detailTitle');
const detailBody    = document.getElementById('detailBody');
const detailClose   = document.getElementById('detailClose');
const detailRename  = document.getElementById('detailRename');

//For view button
function openDetailModal() {
  if (detailOverlay) detailOverlay.style.display = 'flex';
}
function closeDetailModal() {
  if (detailOverlay) detailOverlay.style.display = 'none';
}

detailClose?.addEventListener('click', () => closeDetailModal());
detailOverlay?.addEventListener('click', (e) => {
  if (e.target === detailOverlay) closeDetailModal();
});
//end view button
let nextToken = null;
let currentPrefix = '';
let detailCurrentKey = null;

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
          <dd>${item.key}</dd>

          <dt>Uploader</dt>
          <dd>${uploadedBy}</dd>

          <dt>Size</dt>
          <dd>${sizeStr}</dd>

          <dt>Last modified</dt>
          <dd>${lmStr}</dd>

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
        <button class="vf-btn vf-btn-view view-file" data-key="${item.key}">View</button>
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

// Delegate "Rename"
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button.rename-file');
  if (!btn) return;

  const fromKey = btn.dataset.key;
  const base = fromKey.split('/').pop();
  const newName = prompt(`Rename\n\n${base}\n\nto:`, base);
  if (!newName || newName === base) return;

  // basic validation
  if (newName.includes('/')) {
    alert('New name must be a plain filename (no slashes).');
    return;
  }

  btn.disabled = true;
  try {
    const res = await fetch('/api/catalog/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromKey, newName })
    });
    if (!res.ok) {
      const msg = await res.text();
      throw new Error(msg || `HTTP ${res.status}`);
    }

    // 👇 we EXPECT the server to send { key, lastModified }
    const payload = await res.json();
    console.log('[rename response]', payload);

    const toKey = payload.key;
    // fallback to *right now* if server didn't send lastModified
    const lmIso = payload.lastModified || new Date().toISOString();

    const tr = btn.closest('tr');
    if (tr) {
      // col 0 = name/key
      const keyCell = tr.querySelector('td');
      if (keyCell) keyCell.textContent = itemKeyOnly(toKey);

      // update buttons to new key
      tr.querySelectorAll('button.get-cid, button.rename-file')
        .forEach(b => b.dataset.key = toKey);

      // col 2 = last modified
      const dateCell = tr.children[2];
      if (dateCell) {
        dateCell.textContent = niceDate(lmIso);
      }

      // clear CID slot
      const slot = tr.querySelector('.cid-slot');
      if (slot) slot.textContent = '';
    }
  } catch (err) {
    alert(`Rename failed: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

//Delegate "View"
document.addEventListener('click', async (e) => {
    const btn = e.target.closest('button.view-file');
  if (!btn) return;

  // helper so we can retry with a different key
  const showForKey = async (key, updateRowIfChanged = false) => {
    openDetailModal();
    if (detailBody) detailBody.innerHTML = '<p style="color:#9ca3af;">Loading…</p>';

    try {
      // fetch item + history in parallel
      const itemUrl = new URL('/api/catalog/item', window.location.origin);
      itemUrl.searchParams.set('key', key);

      const histUrl = new URL('/api/catalog/history', window.location.origin);
      histUrl.searchParams.set('key', key);

      const [itemRes, histRes] = await Promise.all([ fetch(itemUrl), fetch(histUrl) ]);

      // If the key no longer exists (someone renamed it), try to discover the new key
      if (itemRes.status === 404) {
        const histJson = await histRes.json().catch(() => ({ events: [] }));
        const events = Array.isArray(histJson.events) ? histJson.events : [];
        const lastRename = events.find(ev => ev.action === 'rename' && ev.key && ev.ts); // events are newest-first from our API
        if (lastRename && lastRename.key && lastRename.key !== key) {
          // optionally fix the row so future clicks use the new key
          if (updateRowIfChanged) {
            const tr = btn.closest('tr');
            if (tr) {
              const keyCell = tr.querySelector('td');
              if (keyCell) keyCell.textContent = lastRename.key;
              tr.querySelectorAll('button.view-file, button.get-cid, button.rename-file')
                .forEach(b => b.dataset.key = lastRename.key);
            }
          }
          // retry with the new key
          return await showForKey(lastRename.key, false);
        }
        // fallback: refresh the list so the user sees the new row
        if (catalogTable) catalogTable.innerHTML = '';
        nextToken = null;
        await fetchList(currentPrefix || '', null);
        if (detailBody) {
          detailBody.innerHTML = `<p style="color:#fca5a5;">That item was renamed by someone else. I refreshed the list—click the new name to view it.</p>`;
        }
        return;
      }

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
        historyHtml = '<div class="history-list"><ul style="max-height:220px;overflow:auto;margin:0;padding:0 0 0 1rem;">';
        for (const ev of events) {
          const when = ev.ts ? niceDate(ev.ts) : '(unknown time)';
          let desc = ev.action || 'event';
          if (ev.action === 'upload') desc = 'Uploaded';
          else if (ev.action === 'replace') desc = 'Re-uploaded (replaced existing file)';
          else if (ev.action === 'rename') desc = ev.fromKey ? `Renamed from "${ev.fromKey}" to "${ev.key}"` : `Renamed to "${ev.key}"`;
          else if (ev.action === 'delete') desc = 'Deleted';
          const who = ev.user || 'unknown';
          historyHtml += `<li style="margin:0.2rem 0;"><strong>${when}</strong> – ${desc} by <span style="color:#9ca3af;">${who}</span></li>`;
        }
        historyHtml += '</ul></div>';
      }

      if (detailTitle) detailTitle.textContent = itemKeyOnly(item.key) || item.key;
      if (detailBody) {
        detailBody.innerHTML = `
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
        `;
      }
    } catch (err) {
      console.error(err);
      if (detailBody) detailBody.innerHTML = `<p style="color:#fca5a5;">Error: ${err.message}</p>`;
    }
  };

  const initialKey = btn.dataset.key;
  if (initialKey) await showForKey(initialKey, true);
});

//Rename logic for modal
detailRename?.addEventListener('click', async () => {
  if (!detailCurrentKey) return;

  const base = itemKeyOnly(detailCurrentKey) || detailCurrentKey;
  const newName = prompt(`Rename\n\n${base}\n\nto:`, base);
  if (!newName || newName === base) return;

  if (newName.includes('/')) {
    alert('New name must be a plain filename (no slashes).');
    return;
  }

  try {
    const res = await fetch('/api/catalog/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromKey: detailCurrentKey, newName })
    });

    if (!res.ok) {
      const msg = await res.text();
      throw new Error(msg || `HTTP ${res.status}`);
    }

    const { key: toKey } = await res.json();
    detailCurrentKey = toKey;

    // Reload modal details for the new key
    await loadDetailsForKey(toKey);

    // Refresh table so the row shows new name + modified date
    catalogForm?.dispatchEvent(new Event('submit'));
  } catch (err) {
    alert(`Rename failed: ${err.message}`);
  }
});

// Auto-load first page on initial load
window.addEventListener('DOMContentLoaded', () => {
  catalogForm?.dispatchEvent(new Event('submit'));
});
