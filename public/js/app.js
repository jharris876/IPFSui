// public/js/app.js
const form = document.getElementById('uploadForm');
const resultDiv = document.getElementById('result');

form.addEventListener('submit', async e => {
  e.preventDefault();
  if (!form.file.files.length) return;

  const file = form.file.files[0];
  const data = new FormData();
  data.append('file', file);

  resultDiv.textContent = 'Uploading…';

  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      body: data
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Unknown error');
    }
    const { cid } = await res.json();
    resultDiv.innerHTML = `
      CID:
      <a href="/ipfs/${cid}" target="_blank" rel="noopener">
        ${cid}
      </a>
    `;
  } catch (err) {
    resultDiv.textContent = `Error: ${err.message}`;
  }
});