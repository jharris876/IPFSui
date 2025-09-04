// public/js/app.js

const directForm     = document.getElementById('directUploadForm');
const directFile     = document.getElementById('directFile');
const uploadTokenEl  = document.getElementById('uploadToken');
const overallBar     = document.getElementById('overallProgress');
const directResult   = document.getElementById('directResult');

function fmtBytes(n) {
  const u = ['B','KB','MB','GB','TB']; let i = 0;
  while (n >= 1024 && i < u.length-1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${u[i]}`;
}

directForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  directResult.textContent = '';

  const file  = directFile.files[0];
  const token = uploadTokenEl.value.trim();
  if (!file || !token) return;

  overallBar.value = 0;
  overallBar.style.display = 'block';

  try {
    // 1) Ask server to start multipart; server returns adaptive partSize
    const createRes = await fetch('/api/multipart/create', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        fileSize: file.size
      })
    });
    if (!createRes.ok) throw new Error(`create failed: ${await createRes.text()}`);
    const { uploadId, key, partSize } = await createRes.json();

    // 2) Upload parts sequentially (simple; we can parallelize later)
    const parts = [];
    const total = file.size;
    let uploadedBytes = 0;

    function updateOverall(delta) {
      uploadedBytes += delta;
      overallBar.value = Math.floor((uploadedBytes / total) * 100);
    }

    let partNumber = 1;
    for (let start = 0; start < total; start += partSize, partNumber++) {
      const end  = Math.min(start + partSize, total);
      const blob = file.slice(start, end);

      // Sign this part
      const signUrl = new URL('/api/multipart/sign', window.location.origin);
      signUrl.searchParams.set('key', key);
      signUrl.searchParams.set('uploadId', uploadId);
      signUrl.searchParams.set('partNumber', String(partNumber));

      const signRes = await fetch(signUrl, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!signRes.ok) throw new Error(`sign failed (part ${partNumber}): ${await signRes.text()}`);
      const { url } = await signRes.json();

      // PUT the part directly to Filebase with progress
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
            if (!tag) return reject(new Error(`missing ETag for part ${partNumber}`));
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

    // 3) Complete the multipart upload
    const completeRes = await fetch('/api/multipart/complete', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ key, uploadId, parts })
    });
    if (!completeRes.ok) throw new Error(`complete failed: ${await completeRes.text()}`);
    const { cid, url } = await completeRes.json();

    overallBar.value = 100;

    // 4) Show results
    const link = url ? `<a href="${url}" target="_blank" rel="noopener">${cid || url}</a>` : (cid || key);
    directResult.innerHTML = `
      <div><strong>Uploaded:</strong> ${file.name} (${fmtBytes(file.size)})</div>
      <div><strong>CID:</strong> ${cid || '(pending)'}</div>
      <div><strong>Gateway:</strong> ${url ? link : 'n/a'}</div>
      <div><strong>S3 Key:</strong> ${key}</div>
    `;
  } catch (err) {
    console.error(err);
    directResult.textContent = `Error: ${err.message}`;
  } finally {
    setTimeout(() => { overallBar.style.display = 'none'; }, 1500);
  }
});
// ===== Catalog (list + item details) =====
const catalogForm   = document.getElementById('catalogForm');
const catalogPrefix = document.getElementById('catalogPrefix');
const catalogMeta   = document.getElementById('catalogMeta');
const catalogTable  = document.getElementById('catalogTable').querySelector('tbody');
const catalogMore   = document.getElementById('catalogMore');

let nextToken = null;
let currentPrefix = '';

function fmtBytes(n) {
  const u = ['B','KB','MB','GB','TB']; let i = 0;
  while (n >= 1024 && i < u.length-1) { n/=1024; i++; }
  return `${n.toFixed(1)} ${u[i]}`;
}

async function fetchList(prefix, token=null) {
  const url = new URL('/api/catalog/list', window.location.origin);
  if (prefix) url.searchParams.set('prefix', prefix);
  url.searchParams.set('max', '50');
  if (token) url.searchParams.set('token', token);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`list failed: ${await res.text()}`);
  const data = await res.json();

  // Render rows
  data.items.forEach(item => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="word-break:break-all">${item.key}</td>
      <td style="text-align:right;white-space:nowrap">${fmtBytes(item.size)}</td>
      <td>${item.lastModified || ''}</td>
      <td>
        <button class="get-cid" data-key="${item.key}">Get CID</button>
        <span class="cid-slot" style="margin-left:.5rem;color:#555"></span>
      </td>
    `;
    catalogTable.appendChild(tr);
  });

  nextToken = data.nextToken;
  catalogMore.style.display = nextToken ? 'inline-block' : 'none';

  const count = catalogTable.querySelectorAll('tr').length;
  catalogMeta.textContent = `Showing ${count} item(s)${prefix ? ` for prefix "${prefix}"` : ''}.`;
}

catalogForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  currentPrefix = catalogPrefix.value.trim();
  catalogTable.innerHTML = '';
  nextToken = null;
  catalogMeta.textContent = 'Loading…';
  try {
    await fetchList(currentPrefix, null);
  } catch (err) {
    console.error(err);
    catalogMeta.textContent = `Error: ${err.message}`;
  }
});

catalogMore?.addEventListener('click', async () => {
  if (!nextToken) return;
  try {
    await fetchList(currentPrefix, nextToken);
  } catch (err) {
    console.error(err);
    catalogMeta.textContent = `Error: ${err.message}`;
  }
});

// Delegate clicks for "Get CID"
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button.get-cid');
  if (!btn) return;
  btn.disabled = true;
  const key = btn.dataset.key;
  const slot = btn.parentElement.querySelector('.cid-slot');
  slot.textContent = '…';

  try {
    const url = new URL('/api/catalog/item', window.location.origin);
    url.searchParams.set('key', key);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`item failed: ${await res.text()}`);
    const { cid, url: gw } = await res.json();
    if (gw) {
      slot.innerHTML = `<a href="${gw}" target="_blank" rel="noopener">${cid || 'open'}</a>`;
    } else if (cid) {
      slot.textContent = cid;
    } else {
      slot.textContent = 'CID not available yet';
    }
  } catch (err) {
    console.error(err);
    slot.textContent = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});
