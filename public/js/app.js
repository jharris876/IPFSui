const form        = document.getElementById('uploadForm');
const resultDiv   = document.getElementById('result');
const progressBar = document.getElementById('uploadProgress');

form.addEventListener('submit', e => {
  e.preventDefault();
  const file = form.file.files[0];
  if (!file) return;

  // Prepare UI
  progressBar.value = 0;
  progressBar.style.display = 'block';
  resultDiv.textContent = 'Uploading…';

  // Build the XHR
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload');

  // Update progress bar
  xhr.upload.onprogress = event => {
    if (event.lengthComputable) {
      const percent = Math.round((event.loaded / event.total) * 100);
      progressBar.value = percent;
    }
  };

  // On success
  xhr.onload = () => {
    progressBar.style.display = 'none';
    if (xhr.status >= 200 && xhr.status < 300) {
      const { cid } = JSON.parse(xhr.responseText);
      resultDiv.innerHTML = 
        `CID: <a href="/ipfs/${cid}" target="_blank" rel="noopener">${cid}</a>`;
    } else {
      resultDiv.textContent = `Upload failed: ${xhr.statusText}`;
    }
  };

  // On error
  xhr.onerror = () => {
    progressBar.style.display = 'none';
    resultDiv.textContent = 'Upload error — please try again.';
  };

  // Send the form
  const formData = new FormData();
  formData.append('file', file);
  xhr.send(formData);
});