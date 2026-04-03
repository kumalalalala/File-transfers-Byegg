const escapeHTML = (value) => String(value).replace(/[&<>'"]/g, token => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '\'': '&#39;',
  '"': '&quot;'
}[token]));

const IS_MOBILE_CLIENT = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const CHUNK_SIZE = IS_MOBILE_CLIENT ? 3 * 1024 * 1024 : 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = IS_MOBILE_CLIENT ? 60000 : 45000;
const FILE_CHUNK_CONCURRENCY = IS_MOBILE_CLIENT ? 2 : Math.min(4, Math.max(2, navigator.hardwareConcurrency || 4));
const FOLDER_CHUNK_CONCURRENCY = IS_MOBILE_CLIENT ? 3 : Math.min(8, Math.max(FILE_CHUNK_CONCURRENCY, navigator.hardwareConcurrency || 4));
const MULTI_FILE_CONCURRENCY = IS_MOBILE_CLIENT ? 1 : 2;
const PREPARE_CONCURRENCY = IS_MOBILE_CLIENT ? 2 : 4;
const FOLDER_MERGE_CONCURRENCY = IS_MOBILE_CLIENT ? 1 : 2;
const STATUS_BATCH_SIZE = IS_MOBILE_CLIENT ? 40 : 120;
const HASH_WORKER_POOL_SIZE = typeof Worker === 'undefined'
  ? 0
  : (IS_MOBILE_CLIENT ? 1 : Math.min(2, Math.max(1, Math.floor((navigator.hardwareConcurrency || 4) / 4))));
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];
const FOLDER_ICON_SVG = `
  <svg class="file-title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"></path>
    <path d="M3 10h18"></path>
  </svg>
`;

const textEncoder = new TextEncoder();
let volatileDeviceId = null;
let hashWorkerPool = null;

function safeStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    return false;
  }

  return true;
}

function safeStorageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    return false;
  }

  return true;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function rotr(value, shift) {
  return (value >>> shift) | (value << (32 - shift));
}

function toUint8Array(bufferLike) {
  if (bufferLike instanceof Uint8Array) return bufferLike;
  return new Uint8Array(bufferLike);
}

function sha256Fallback(bufferLike) {
  const bytes = toUint8Array(bufferLike);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const data = new Uint8Array(paddedLength);
  const view = new DataView(data.buffer);
  const schedule = new Uint32Array(64);

  data.set(bytes);
  data[bytes.length] = 0x80;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index++) {
      schedule[index] = view.getUint32(offset + (index * 4));
    }

    for (let index = 16; index < 64; index++) {
      const s0 = rotr(schedule[index - 15], 7) ^ rotr(schedule[index - 15], 18) ^ (schedule[index - 15] >>> 3);
      const s1 = rotr(schedule[index - 2], 17) ^ rotr(schedule[index - 2], 19) ^ (schedule[index - 2] >>> 10);
      schedule[index] = (schedule[index - 16] + s0 + schedule[index - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let index = 0; index < 64; index++) {
      const sum1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + ch + SHA256_K[index] + schedule[index]) >>> 0;
      const sum0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map(word => word.toString(16).padStart(8, '0'))
    .join('');
}

async function sha256Hex(bufferLike) {
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', bufferLike);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  return sha256Fallback(bufferLike);
}

async function sha256Text(value) {
  return sha256Hex(textEncoder.encode(value));
}

function createHashWorkerPool() {
  if (HASH_WORKER_POOL_SIZE < 1) {
    return null;
  }

  const workers = Array.from({ length: HASH_WORKER_POOL_SIZE }, () => {
    const worker = new Worker('/hash-worker.js');
    const pending = new Map();

    worker.addEventListener('message', event => {
      const { id, hash, error } = event.data || {};
      const task = pending.get(id);
      if (!task) return;
      pending.delete(id);
      if (error) {
        task.reject(new Error(error));
        return;
      }
      task.resolve(hash);
    });

    worker.addEventListener('error', event => {
      const failure = new Error(event.message || 'Hash worker failed');
      pending.forEach(task => task.reject(failure));
      pending.clear();
    });

    return {
      worker,
      pending
    };
  });

  let nextWorkerIndex = 0;
  let nextTaskId = 0;

  return {
    async hashBuffer(buffer) {
      const slot = workers[nextWorkerIndex];
      nextWorkerIndex = (nextWorkerIndex + 1) % workers.length;
      const taskId = ++nextTaskId;

      return new Promise((resolve, reject) => {
        slot.pending.set(taskId, { resolve, reject });
        slot.worker.postMessage({ id: taskId, buffer }, [buffer]);
      });
    },
    destroy() {
      workers.forEach(slot => {
        slot.pending.forEach(task => task.reject(new Error('Hash worker stopped')));
        slot.pending.clear();
        slot.worker.terminate();
      });
    }
  };
}

async function hashChunkBlob(chunkBlob) {
  if (HASH_WORKER_POOL_SIZE < 1) {
    return sha256Hex(await chunkBlob.arrayBuffer());
  }

  if (!hashWorkerPool) {
    hashWorkerPool = createHashWorkerPool();
  }

  const buffer = await chunkBlob.arrayBuffer();

  if (!hashWorkerPool) {
    return sha256Hex(buffer);
  }

  try {
    return await hashWorkerPool.hashBuffer(buffer);
  } catch {
    hashWorkerPool.destroy();
    hashWorkerPool = null;
    return sha256Hex(await chunkBlob.arrayBuffer());
  }
}

function buildUploadConfig(file) {
  return {
    totalChunks: Math.max(1, Math.ceil(file.size / CHUNK_SIZE)),
    totalSize: file.size,
    chunkSize: CHUNK_SIZE
  };
}

function getDeviceId() {
  if (volatileDeviceId) {
    return volatileDeviceId;
  }

  let deviceId = safeStorageGet('deviceId');
  if (!deviceId) {
    if (globalThis.crypto?.randomUUID) {
      deviceId = crypto.randomUUID();
    } else if (globalThis.crypto?.getRandomValues) {
      const randomBytes = crypto.getRandomValues(new Uint8Array(16));
      deviceId = Array.from(randomBytes, byte => byte.toString(16).padStart(2, '0')).join('');
    } else {
      deviceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    }
    safeStorageSet('deviceId', deviceId);
  }

  volatileDeviceId = deviceId;
  return deviceId;
}

async function createUploadId(file, relativePath) {
  return sha256Text([getDeviceId(), relativePath, file.size, file.lastModified].join('\0'));
}

async function createFolderSessionId(entries, rootName) {
  const manifest = entries
    .map(entry => `${entry.relativePath}\0${entry.file.size}\0${entry.file.lastModified}`)
    .sort()
    .join('\u0001');
  return sha256Text(`${getDeviceId()}\0${rootName}\0${manifest}`);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => ({}))
    : await response.text().catch(() => '');

  if (!response.ok) {
    const message = typeof payload === 'string'
      ? payload
      : payload?.error || `Request failed with status ${response.status}`;
    throw new Error(message || `Request failed with status ${response.status}`);
  }

  return payload;
}

function waitUntilOnline(signal) {
  if (navigator.onLine) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const onOnline = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const cleanup = () => {
      window.removeEventListener('online', onOnline);
      signal?.removeEventListener('abort', onAbort);
    };

    window.addEventListener('online', onOnline, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function withTimeout(parentSignal, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), timeoutMs);

  const abortParent = () => controller.abort(new DOMException('Aborted', 'AbortError'));
  parentSignal?.addEventListener('abort', abortParent, { once: true });

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeoutId);
      parentSignal?.removeEventListener('abort', abortParent);
    }
  };
}

async function runPool(items, concurrency, worker) {
  let nextIndex = 0;
  const runnerCount = Math.max(1, Math.min(concurrency, items.length || 1));
  const runners = Array.from({ length: runnerCount }, async () => {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) return;
      await worker(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(runners);
}

document.addEventListener('DOMContentLoaded', () => {
  const adminWarning = document.getElementById('adminWarning');
  const storageConfig = document.getElementById('storageConfig');
  const mainContent = document.getElementById('mainContent');
  const notConfigured = document.getElementById('notConfigured');
  const fileTransfer = document.getElementById('fileTransfer');
  const shutdownBtn = document.getElementById('shutdownBtn');
  const storagePathInput = document.getElementById('storagePath');
  const setStorageBtn = document.getElementById('setStorageBtn');
  const uploadArea = document.getElementById('uploadArea');
  const fileInput = document.getElementById('fileInput');
  const folderInput = document.getElementById('folderInput');
  const filesContainer = document.getElementById('filesContainer');
  const fileCount = document.getElementById('fileCount');
  const uploadList = document.getElementById('uploadList');
  const globalMessage = document.getElementById('globalMessage');
  const modal = document.getElementById('preview-modal');
  const modalContent = document.getElementById('preview-content');
  const tokenModal = document.getElementById('tokenModal');
  const tokenModalMessage = document.getElementById('tokenModalMessage');
  const tokenInput = document.getElementById('tokenInput');
  const tokenCancelBtn = document.getElementById('tokenCancelBtn');
  const tokenConfirmBtn = document.getElementById('tokenConfirmBtn');

  let storageConfigured = false;
  let filesList = [];
  let renderQueued = false;
  let resolveTokenRequest = null;
  let pendingTokenPromise = null;

  function showMessage(message, type = 'success') {
    globalMessage.textContent = message;
    globalMessage.className = `message message-${type}`;
    globalMessage.style.display = 'block';
    clearTimeout(showMessage.timer);
    showMessage.timer = setTimeout(() => {
      globalMessage.style.display = 'none';
    }, 5000);
  }

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderFiles();
    });
  }

  function upsertFile(file) {
    const index = filesList.findIndex(item => item.id === file.id);
    if (index >= 0) {
      filesList[index] = file;
    } else {
      filesList.unshift(file);
    }
  }

  function clearAdminToken() {
    safeStorageRemove('adminToken');
  }

  function closeTokenModal(token = '') {
    if (!resolveTokenRequest) return;
    const finalize = resolveTokenRequest;
    resolveTokenRequest = null;
    pendingTokenPromise = null;
    tokenModal.style.display = 'none';
    const trimmed = token.trim();
    if (trimmed) {
      safeStorageSet('adminToken', trimmed);
    }
    finalize(trimmed);
  }

  function openTokenModal(message, preset = '') {
    if (pendingTokenPromise) {
      if (message) {
        tokenModalMessage.textContent = message;
      }
      return pendingTokenPromise;
    }

    tokenModalMessage.textContent = message || 'Enter the token printed in the server console to continue.';
    tokenInput.value = preset;
    tokenModal.style.display = 'flex';

    pendingTokenPromise = new Promise(resolve => {
      resolveTokenRequest = resolve;
    });

    requestAnimationFrame(() => {
      tokenInput.focus();
      tokenInput.select();
    });

    return pendingTokenPromise;
  }

  async function getAdminToken(options = {}) {
    const { forcePrompt = false, message } = options;
    const existingToken = forcePrompt ? '' : (safeStorageGet('adminToken') || '');
    if (existingToken) {
      return existingToken;
    }

    return openTokenModal(
      message || 'Enter the admin access token printed in the server console.',
      ''
    );
  }

  async function fetchAdminJson(url, options = {}, promptMessage = 'Enter the admin access token printed in the server console.') {
    const baseHeaders = {
      ...(options.headers || {})
    };

    let token = await getAdminToken({ message: promptMessage });
    if (!token) {
      throw new Error('Admin token is required');
    }

    try {
      return await fetchJson(url, {
        ...options,
        headers: {
          ...baseHeaders,
          'x-admin-token': encodeURIComponent(token)
        }
      });
    } catch (error) {
      if (!/Unauthorized/i.test(error.message)) {
        throw error;
      }

      clearAdminToken();
      token = await getAdminToken({
        forcePrompt: true,
        message: 'The admin token was rejected. Enter the current token to continue.'
      });

      if (!token) {
        throw new Error('Admin token is required');
      }

      return fetchJson(url, {
        ...options,
        headers: {
          ...baseHeaders,
          'x-admin-token': encodeURIComponent(token)
        }
      });
    }
  }

  function isMedia(name) {
    return /\.(mp4|webm|ogg|mp3|wav|jpg|jpeg|png|gif|webp)$/i.test(name);
  }

  function formatSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
  }

  function renderHeaderTitle(title, iconMarkup = '') {
    return `
      <div class="file-header-content">
        ${iconMarkup || ''}
        <span class="file-header-label">${escapeHTML(title)}</span>
      </div>
    `;
  }

  function updateUI() {
    const isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);

    if (!storageConfigured) {
      if (isLocalHost) {
        storageConfig.style.display = 'block';
        adminWarning.style.display = 'block';
        mainContent.style.display = 'none';
      } else {
        storageConfig.style.display = 'none';
        adminWarning.style.display = 'none';
        mainContent.style.display = 'block';
        notConfigured.style.display = 'block';
        fileTransfer.style.display = 'none';
        shutdownBtn.style.display = 'none';
      }
      return;
    }

    storageConfig.style.display = 'none';
    adminWarning.style.display = 'none';
    mainContent.style.display = 'block';
    notConfigured.style.display = 'none';
    fileTransfer.style.display = 'block';
    shutdownBtn.style.display = isLocalHost ? 'block' : 'none';
    queueRender();
  }

  async function fetchStatus() {
    try {
      const data = await fetchJson('/api/status');
      storageConfigured = Boolean(data.storageConfigured);
      filesList = Array.isArray(data.files) ? data.files : [];
      updateUI();
    } catch (error) {
      console.error(error);
      showMessage(error.message || 'Unable to fetch status', 'error');
    }
  }

  function showPreviewModal(id, name) {
    modal.style.display = 'flex';
    const url = `/files/${encodeURIComponent(id)}?preview=true`;
    if (/\.(mp4|webm|ogg)$/i.test(name)) {
      modalContent.innerHTML = `<video controls autoplay style="max-width:100%; max-height:90vh; border-radius:8px;"><source src="${url}"></video>`;
    } else if (/\.(jpg|jpeg|png|gif|webp)$/i.test(name)) {
      modalContent.innerHTML = `<img src="${url}" style="max-width:100%; max-height:90vh; object-fit:contain; border-radius:8px;">`;
    } else if (/\.(mp3|wav)$/i.test(name)) {
      modalContent.innerHTML = `<audio controls autoplay><source src="${url}"></audio>`;
    }
  }

  function triggerBackgroundDownload(url, frameId) {
    let frame = document.getElementById(frameId);
    if (!frame) {
      frame = document.createElement('iframe');
      frame.id = frameId;
      frame.style.display = 'none';
      document.body.appendChild(frame);
    }
    frame.src = url;
  }

  function downloadFrameId(id) {
    return `download-frame-${String(id).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  }

  function renderFiles() {
    filesContainer.innerHTML = '';
    if (filesList.length === 0) {
      fileCount.textContent = 'No files available';
      return;
    }

    filesList.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    fileCount.textContent = `${filesList.length} file(s) available`;

    filesList.forEach(file => {
      const isFolder = file.type === 'folder';
      const isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
      const fileCard = document.createElement('div');
      fileCard.className = 'file-card';
      const dt = new Date(file.timestamp);
      const timeLabel = `${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${dt.toLocaleDateString()}`;

      fileCard.innerHTML = `
        <div class="file-header" title="${escapeHTML(file.name)}">
          ${renderHeaderTitle(file.name, isFolder ? FOLDER_ICON_SVG : '')}
        </div>
        <div class="file-body">
          <div class="file-info">
            <span class="file-size">${formatSize(file.size)}</span>
            <span class="file-time">${timeLabel}</span>
          </div>
          <div class="file-actions">
            ${/\.zip$/i.test(file.name) && !isFolder ? '<button class="action-btn extract-btn">Extract</button>' : ''}
            ${isMedia(file.name) && !isFolder ? '<button class="action-btn preview-btn">View</button>' : ''}
            <button class="action-btn download-btn">Download</button>
            ${isLocalHost ? '<button class="action-btn delete-btn">Del</button>' : ''}
          </div>
        </div>
      `;

      const extractBtn = fileCard.querySelector('.extract-btn');
      if (extractBtn) {
        extractBtn.addEventListener('click', () => {
          if (file.size > 500 * 1024 * 1024) {
            showMessage('ZIP extract in browser mode is limited to 500MB.', 'error');
            return;
          }
          triggerBackgroundDownload(`/api/extract/${encodeURIComponent(file.id)}`, downloadFrameId(file.id));
        });
      }

      const previewBtn = fileCard.querySelector('.preview-btn');
      if (previewBtn) {
        previewBtn.addEventListener('click', () => showPreviewModal(file.id, file.name));
      }

      const downloadBtn = fileCard.querySelector('.download-btn');
      downloadBtn.addEventListener('click', () => {
        if (isFolder) {
          downloadBtn.disabled = true;
          downloadBtn.textContent = 'Preparing...';
          triggerBackgroundDownload(`/api/extract/${encodeURIComponent(file.id)}`, downloadFrameId(file.id));
          setTimeout(() => {
            downloadBtn.disabled = false;
            downloadBtn.textContent = 'Download';
          }, 30000);
          return;
        }

        triggerBackgroundDownload(`/files/${encodeURIComponent(file.id)}`, downloadFrameId(file.id));
      });

      const deleteBtn = fileCard.querySelector('.delete-btn');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', async () => {
          const targetLabel = isFolder ? 'folder' : 'file';
          if (!confirm(`Delete ${targetLabel} ${file.name} permanently?`)) return;

          try {
            await fetchAdminJson(
              `/api/files/${encodeURIComponent(file.id)}`,
              { method: 'DELETE' },
              `Enter the admin access token to delete this ${targetLabel}.`
            );
          } catch (error) {
            showMessage(error.message || `Could not delete ${targetLabel}`, 'error');
          }
        });
      }

      filesContainer.appendChild(fileCard);
    });
  }

  function createProgressCard(title, size, icon = '') {
    const uploadItem = document.createElement('div');
    uploadItem.className = 'file-card';
    uploadItem.innerHTML = `
      <div class="file-header" title="${escapeHTML(title)}">${renderHeaderTitle(title, icon)}</div>
      <div class="file-body">
        <div class="file-info">
          <span class="file-size">${formatSize(size)}</span>
          <span class="file-time">Queued...</span>
        </div>
        <div class="progress-container">
          <div class="progress-bar" style="width:0%"></div>
        </div>
        <div class="file-actions">
          <button class="action-btn cancel-btn">Cancel</button>
        </div>
      </div>
    `;
    uploadList.prepend(uploadItem);
    return {
      root: uploadItem,
      progressBar: uploadItem.querySelector('.progress-bar'),
      timeEl: uploadItem.querySelector('.file-time'),
      cancelBtn: uploadItem.querySelector('.cancel-btn')
    };
  }

  function chunkByteSize(fileSize, chunkIndex) {
    const start = chunkIndex * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, fileSize);
    return Math.max(0, end - start);
  }

  function updateProgressUi(progressBar, timeEl, uploadedBytes, totalBytes) {
    const percent = totalBytes === 0 ? 100 : Math.min(100, Math.round((uploadedBytes * 100) / totalBytes));
    progressBar.style.width = `${percent}%`;
    timeEl.textContent = `${percent}%`;
    timeEl.style.color = 'var(--text-muted)';
  }

  async function getUploadStatus(fileId, options = {}) {
    const query = new URLSearchParams();
    if (options.folderSessionId) query.set('folderSessionId', options.folderSessionId);
    if (options.fileName) query.set('fileName', options.fileName);
    if (Number.isInteger(options.totalChunks)) query.set('totalChunks', String(options.totalChunks));
    if (Number.isFinite(options.totalSize)) query.set('totalSize', String(options.totalSize));
    if (Number.isInteger(options.chunkSize)) query.set('chunkSize', String(options.chunkSize));
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return fetchJson(`/api/upload/status/${fileId}${suffix}`);
  }

  async function getUploadStatuses(items) {
    if (!items.length) {
      return [];
    }

    const result = await fetchJson('/api/upload/status-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items })
    });

    return Array.isArray(result.items) ? result.items : [];
  }

  async function sendChunk(file, fileId, uploadConfig, chunkIndex, abortSignal, onRetry) {
    const start = chunkIndex * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunkBlob = file.slice(start, end);
    const chunkHash = await hashChunkBlob(chunkBlob);
    let backoff = 1500;

    while (!abortSignal.aborted) {
      await waitUntilOnline(abortSignal);
      const timeout = withTimeout(abortSignal);

      try {
        const formData = new FormData();
        const query = new URLSearchParams({
          fileId,
          chunkIndex: String(chunkIndex),
          chunkHash,
          chunkStart: String(start),
          totalChunks: String(uploadConfig.totalChunks),
          totalSize: String(uploadConfig.totalSize),
          chunkSize: String(uploadConfig.chunkSize)
        });
        formData.append('fileId', fileId);
        formData.append('chunkIndex', String(chunkIndex));
        formData.append('chunkHash', chunkHash);
        formData.append('chunkStart', String(start));
        formData.append('file', chunkBlob, 'chunk.bin');

        const response = await fetch(`/api/upload/chunk?${query.toString()}`, {
          method: 'POST',
          body: formData,
          signal: timeout.signal
        });
        timeout.cleanup();

        if (!response.ok) {
          const contentType = response.headers.get('content-type') || '';
          const payload = contentType.includes('application/json')
            ? await response.json().catch(() => ({}))
            : await response.text().catch(() => '');
          const message = typeof payload === 'string' ? payload : payload?.error || '';
          throw new Error(message || `Chunk upload failed (${response.status})`);
        }

        return chunkBlob.size;
      } catch (error) {
        timeout.cleanup();
        if (abortSignal.aborted) throw error;
        if (/Invalid upload metadata|Chunk file is required|Chunk hash is required|Upload session metadata is required|Upload session metadata mismatch|Invalid upload session chunk placement|Missing chunk/i.test(error.message)) {
          throw error;
        }
        onRetry?.(backoff);
        await delay(backoff, abortSignal);
        backoff = Math.min(backoff * 1.5, 10000);
      }
    }

    throw new DOMException('Aborted', 'AbortError');
  }

  async function mergeUpload(payload, abortSignal) {
    let backoff = 1500;
    while (!abortSignal.aborted) {
      await waitUntilOnline(abortSignal);
      const timeout = withTimeout(abortSignal, REQUEST_TIMEOUT_MS * 2);

      try {
        const result = await fetchJson('/api/upload/merge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: timeout.signal
        });
        timeout.cleanup();
        return result;
      } catch (error) {
        timeout.cleanup();
        if (abortSignal.aborted) throw error;
        if (/Invalid|Chunks not found|Missing chunk|Duplicate source not found|Upload session|Merged file size mismatch|Could not verify uploaded file/i.test(error.message)) {
          throw error;
        }
        await delay(backoff, abortSignal);
        backoff = Math.min(backoff * 1.5, 10000);
      }
    }

    throw new DOMException('Aborted', 'AbortError');
  }

  async function uploadSingleFile(file) {
    const card = createProgressCard(file.name, file.size);
    const abortController = new AbortController();
    let fileId = '';
    const uploadConfig = buildUploadConfig(file);

    let uploadedBytes = 0;
    const setStatus = (text, type) => {
      card.timeEl.textContent = text;
      card.timeEl.style.color = type === 'error' ? 'var(--error)' : type === 'warning' ? '#ffca28' : '#4fc3f7';
    };

    card.cancelBtn.addEventListener('click', async () => {
      abortController.abort();
      setStatus('Cancelled', 'warning');
      if (fileId) {
        await fetch(`/api/upload/cancel/${fileId}`, { method: 'DELETE' }).catch(() => { });
      }
      setTimeout(() => card.root.remove(), 2000);
    });

    try {
      setStatus('Checking resume...', 'info');
      fileId = await createUploadId(file, file.name);
      let status = await getUploadStatus(fileId, uploadConfig);
      if (status.resetRequired) {
        setStatus('Resetting old upload state...', 'warning');
        await fetch(`/api/upload/cancel/${fileId}`, { method: 'DELETE' }).catch(() => { });
        status = { uploadedChunks: [], merged: false, resetRequired: false };
      }

      if (status.merged) {
        setStatus('Uploaded!', 'info');
        card.progressBar.style.width = '100%';
        setTimeout(() => card.root.remove(), 1500);
        return;
      }

      const uploadedChunkSet = new Set(status.uploadedChunks || []);
      uploadedBytes = Array.from(uploadedChunkSet).reduce((sum, index) => sum + chunkByteSize(file.size, index), 0);
      updateProgressUi(card.progressBar, card.timeEl, uploadedBytes, file.size);

      const missingChunks = [];
      for (let index = 0; index < uploadConfig.totalChunks; index++) {
        if (!uploadedChunkSet.has(index)) missingChunks.push(index);
      }

      if (missingChunks.length > 0) {
        setStatus('Hashing first chunk...', 'info');
      }

      await runPool(missingChunks, FILE_CHUNK_CONCURRENCY, async chunkIndex => {
        const bytes = await sendChunk(file, fileId, uploadConfig, chunkIndex, abortController.signal, () => {
          setStatus('Connection issue. Retrying...', 'warning');
        });
        uploadedBytes += bytes;
        updateProgressUi(card.progressBar, card.timeEl, uploadedBytes, file.size);
      });

      setStatus('Merging...', 'info');
      await mergeUpload({
        fileId,
        fileName: file.name,
        totalChunks: uploadConfig.totalChunks
      }, abortController.signal);

      setStatus('Uploaded!', 'info');
      card.progressBar.style.width = '100%';
      setTimeout(() => card.root.remove(), 1500);
    } catch (error) {
      if (abortController.signal.aborted) return;
      console.error(error);
      setStatus(error.message || 'Upload failed', 'error');
      showMessage(error.message || `Upload failed for ${file.name}`, 'error');
    }
  }

  async function uploadFolder(entries, rootName) {
    if (!entries.length) return;

    const totalSize = entries.reduce((sum, entry) => sum + entry.file.size, 0);
    const card = createProgressCard(rootName, totalSize, FOLDER_ICON_SVG);
    const abortController = new AbortController();
    let folderSessionId = '';
    let uploadedBytes = 0;

    const setStatus = (text, type) => {
      card.timeEl.textContent = text;
      card.timeEl.style.color = type === 'error' ? 'var(--error)' : type === 'warning' ? '#ffca28' : '#4fc3f7';
    };

    card.cancelBtn.addEventListener('click', async () => {
      abortController.abort();
      setStatus('Cancelled', 'warning');
      if (folderSessionId) {
        await fetch(`/api/upload/folder/${folderSessionId}`, { method: 'DELETE' }).catch(() => { });
      }
      await Promise.all(entries
        .filter(entry => entry.fileId)
        .map(entry => fetch(`/api/upload/cancel/${entry.fileId}`, { method: 'DELETE' }).catch(() => { })));
      setTimeout(() => card.root.remove(), 2000);
    });

    try {
      setStatus('Checking resume...', 'info');
      folderSessionId = await createFolderSessionId(entries, rootName);
      const preparedEntries = await Promise.all(entries.map(async entry => {
        const uploadConfig = buildUploadConfig(entry.file);
        const fileId = await createUploadId(entry.file, entry.relativePath);
        entry.fileId = fileId;
        return {
          ...entry,
          fileId,
          uploadConfig
        };
      }));

      for (let offset = 0; offset < preparedEntries.length; offset += STATUS_BATCH_SIZE) {
        const batch = preparedEntries.slice(offset, offset + STATUS_BATCH_SIZE);
        const statuses = await getUploadStatuses(batch.map(task => ({
          fileId: task.fileId,
          folderSessionId,
          fileName: task.relativePath,
          totalChunks: task.uploadConfig.totalChunks,
          totalSize: task.uploadConfig.totalSize,
          chunkSize: task.uploadConfig.chunkSize
        })));

        const statusMap = new Map(statuses.map(status => [status.fileId, status]));
        await runPool(batch, PREPARE_CONCURRENCY, async task => {
          let status = statusMap.get(task.fileId) || {
            uploadedChunks: [],
            merged: false,
            resetRequired: false
          };

          if (status.resetRequired) {
            await fetch(`/api/upload/cancel/${task.fileId}`, { method: 'DELETE' }).catch(() => { });
            status = {
              uploadedChunks: [],
              merged: false,
              resetRequired: false
            };
          }

          task.totalChunks = task.uploadConfig.totalChunks;
          task.uploadedChunkSet = new Set(status.uploadedChunks || []);
          task.merged = Boolean(status.merged);

          if (task.merged) {
            uploadedBytes += task.file.size;
            return;
          }

          uploadedBytes += Array.from(task.uploadedChunkSet)
            .reduce((sum, index) => sum + chunkByteSize(task.file.size, index), 0);
        });
      }

      updateProgressUi(card.progressBar, card.timeEl, uploadedBytes, totalSize);

      const chunkQueue = [];
      for (const task of preparedEntries) {
        if (task.merged) continue;
        for (let index = 0; index < task.totalChunks; index++) {
          if (!task.uploadedChunkSet.has(index)) {
            chunkQueue.push({ task, chunkIndex: index });
          }
        }
      }

      if (chunkQueue.length > 0) {
        setStatus('Hashing first chunk...', 'info');
      }

      await runPool(chunkQueue, FOLDER_CHUNK_CONCURRENCY, async item => {
        const bytes = await sendChunk(
          item.task.file,
          item.task.fileId,
          item.task.uploadConfig,
          item.chunkIndex,
          abortController.signal,
          () => {
            setStatus('Connection issue. Retrying...', 'warning');
          }
        );
        uploadedBytes += bytes;
        updateProgressUi(card.progressBar, card.timeEl, uploadedBytes, totalSize);
      });

      setStatus('Merging...', 'info');

      const mergeTasks = preparedEntries.filter(task => !task.merged);
      await runPool(mergeTasks, FOLDER_MERGE_CONCURRENCY, async task => {
        await mergeUpload({
          fileId: task.fileId,
          fileName: task.relativePath,
          folderSessionId,
          totalChunks: task.totalChunks
        }, abortController.signal);
      });

      setStatus('Finalizing folder...', 'info');
      await fetchJson('/api/upload/folder/finalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderSessionId, folderName: rootName }),
        signal: abortController.signal
      });

      card.progressBar.style.width = '100%';
      setStatus('Uploaded!', 'info');
      setTimeout(() => card.root.remove(), 1500);
    } catch (error) {
      if (abortController.signal.aborted) return;
      console.error(error);
      setStatus(error.message || 'Folder upload failed', 'error');
      showMessage(error.message || `Upload failed for ${rootName}`, 'error');
    }
  }

  function readEntryRecursive(entry, parentPath = '') {
    return new Promise(resolve => {
      const currentPath = parentPath ? `${parentPath}${entry.name}` : entry.name;

      if (entry.isFile) {
        entry.file(file => resolve([{ relativePath: currentPath, file }]));
        return;
      }

      if (!entry.isDirectory) {
        resolve([]);
        return;
      }

      const reader = entry.createReader();
      const results = [];

      const readBatch = () => {
        reader.readEntries(async entries => {
          if (!entries.length) {
            resolve(results);
            return;
          }

          const nested = await Promise.all(entries.map(item => readEntryRecursive(
            item,
            `${currentPath}/`
          )));
          nested.forEach(group => results.push(...group));
          readBatch();
        });
      };

      readBatch();
    });
  }

  async function handleFileSelection(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    await runPool(files, MULTI_FILE_CONCURRENCY, uploadSingleFile);
  }

  async function handleFolderSelection(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    const folderMap = new Map();
    files.forEach(file => {
      const rootName = file.webkitRelativePath.split('/')[0];
      if (!folderMap.has(rootName)) folderMap.set(rootName, []);
      folderMap.get(rootName).push({ relativePath: file.webkitRelativePath, file });
    });

    for (const [rootName, entries] of folderMap) {
      await uploadFolder(entries, rootName);
    }
  }

  document.querySelector('.close-modal').addEventListener('click', () => {
    modal.style.display = 'none';
    modalContent.innerHTML = '';
  });

  modal.addEventListener('click', event => {
    if (event.target === modal) {
      modal.style.display = 'none';
      modalContent.innerHTML = '';
    }
  });

  tokenConfirmBtn.addEventListener('click', () => closeTokenModal(tokenInput.value));
  tokenCancelBtn.addEventListener('click', () => closeTokenModal(''));
  tokenModal.addEventListener('click', event => {
    if (event.target === tokenModal) {
      closeTokenModal('');
    }
  });
  tokenInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      closeTokenModal(tokenInput.value);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeTokenModal('');
    }
  });

  setStorageBtn.addEventListener('click', async () => {
    const targetPath = storagePathInput.value.trim();
    if (!targetPath) {
      showMessage('Please enter a valid path', 'error');
      return;
    }

    try {
      await fetchAdminJson('/api/set-storage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ path: targetPath })
      }, 'Enter the admin access token to configure the storage path.');
      showMessage('Storage location configured.');
      await fetchStatus();
    } catch (error) {
      showMessage(error.message || 'Could not configure storage', 'error');
    }
  });

  shutdownBtn.addEventListener('click', async () => {
    if (!confirm('Shut down the server and delete all transferred files?')) return;

    try {
      await fetchAdminJson(
        '/api/shutdown',
        { method: 'POST' },
        'Enter the admin access token to shut down the server.'
      );
      clearAdminToken();
      alert('Server is shutting down.');
    } catch (error) {
      clearAdminToken();
      showMessage(error.message || 'Failed to shut down server', 'error');
    }
  });

  document.getElementById('pickFileBtn').addEventListener('click', event => {
    event.stopPropagation();
    fileInput.click();
  });

  document.getElementById('pickFolderBtn').addEventListener('click', event => {
    event.stopPropagation();
    folderInput.click();
  });

  fileInput.addEventListener('change', async event => {
    await handleFileSelection(event.target.files);
    fileInput.value = '';
  });

  folderInput.addEventListener('change', async event => {
    await handleFolderSelection(event.target.files);
    folderInput.value = '';
  });

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    uploadArea.addEventListener(eventName, event => {
      event.preventDefault();
      event.stopPropagation();
    }, false);
  });

  ['dragenter', 'dragover'].forEach(eventName => {
    uploadArea.addEventListener(eventName, () => uploadArea.classList.add('drag-over'), false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    uploadArea.addEventListener(eventName, () => uploadArea.classList.remove('drag-over'), false);
  });

  uploadArea.addEventListener('drop', async event => {
    const items = Array.from(event.dataTransfer.items || []);
    if (!items.length) return;

    const looseFiles = [];
    const folderEntries = [];

    for (const item of items) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (entry?.isDirectory) {
        folderEntries.push(entry);
      } else {
        const file = item.getAsFile();
        if (file) looseFiles.push(file);
      }
    }

    if (looseFiles.length) {
      await handleFileSelection(looseFiles);
    }

    for (const entry of folderEntries) {
      const nestedEntries = await readEntryRecursive(entry);
      await uploadFolder(nestedEntries, entry.name);
    }
  }, false);

  const socket = io();
  socket.on('file-updated', files => {
    filesList = Array.isArray(files) ? files : [];
    queueRender();
  });
  socket.on('file-added', file => {
    upsertFile(file);
    queueRender();
  });
  socket.on('file-deleted', id => {
    filesList = filesList.filter(item => item.id !== id);
    queueRender();
  });

  window.addEventListener('beforeunload', () => {
    if (hashWorkerPool) {
      hashWorkerPool.destroy();
      hashWorkerPool = null;
    }
  });

  fetchStatus();
});
