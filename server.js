import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import qrcode from 'qrcode-terminal';
import Fastify from 'fastify';
import indexHtml from './public/index.html' with { type: 'text' };
import appJs from './public/app.js' with { type: 'text' };
import hashWorkerJs from './public/hash-worker.js' with { type: 'text' };
import manifestJson from './public/manifest.json' with { type: 'text' };
import swJs from './public/sw.js' with { type: 'text' };
import fastifyMultipart from '@fastify/multipart';
import fastifySocketIo from 'fastify-socket.io';
import fastifyCors from '@fastify/cors';
import AdmZip from 'adm-zip';

const MAX_FILE_SIZE = 100 * 1024 * 1024 * 1024;
const PORT = 3000;
const STORE_SUBDIR = 'luutam';
const TMP_SUBDIR = '.tmp';
const STAGING_SUBDIR = '.staging';
const COMPLETED_SUBDIR = '.completed';
const DOWNLOAD_CACHE_SUBDIR = 'downloads';
const CLEANUP_AGE_MS = 24 * 60 * 60 * 1000;
const ZIP_CACHE_AGE_MS = 10 * 60 * 1000;
const STREAM_BUFFER_SIZE = 1024 * 1024;
const UPLOAD_SESSION_VERSION = 1;
const UPLOAD_SESSION_META_FILE = 'session.json';
const UPLOAD_SESSION_BITMAP_FILE = 'chunks.bin';
const UPLOAD_SESSION_DATA_FILE = 'payload.bin';

const fileRecordSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    size: { type: 'number' },
    timestamp: { type: 'string' },
    type: { type: 'string' },
    fingerprint: { type: 'string' }
  },
  required: ['id', 'name', 'size', 'timestamp'],
  additionalProperties: true
};

const errorSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' }
  },
  required: ['error']
};

const successSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' }
  },
  required: ['success']
};

const fastify = Fastify({
  logger: false,
  bodyLimit: MAX_FILE_SIZE,
  requestTimeout: 0,
  keepAliveTimeout: 72_000
});

let storagePath = null;
let isStorageConfigured = false;
let filesCache = [];

const folderZipJobs = new Map();
const uploadSessionLocks = new Map();

function getNetworkIp() {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const config of iface || []) {
      if (config.family === 'IPv4' && !config.internal) {
        return config.address;
      }
    }
  }
  return 'localhost';
}

function displayQr(url, description) {
  try {
    qrcode.generate(url, { small: true });
    console.log(`Scan this QR to open: ${url}`);
    console.log(`(${description})`);
  } catch (err) {
    console.error('Failed to generate QR code:', err?.message || err);
  }
}

function storageRoot() {
  return storagePath ? path.join(storagePath, STORE_SUBDIR) : null;
}

function tempRoot() {
  const root = storageRoot();
  return root ? path.join(root, TMP_SUBDIR) : null;
}

function stagingRoot() {
  const root = storageRoot();
  return root ? path.join(root, STAGING_SUBDIR) : null;
}

function completedRoot() {
  const tmp = tempRoot();
  return tmp ? path.join(tmp, COMPLETED_SUBDIR) : null;
}

function downloadCacheRoot() {
  const tmp = tempRoot();
  return tmp ? path.join(tmp, DOWNLOAD_CACHE_SUBDIR) : null;
}

function isValidHexId(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function sanitizeUploadId(value) {
  return isValidHexId(value) ? value.toLowerCase() : null;
}

function sanitizeSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null;
}

function sanitizeDisplaySegment(name) {
  if (typeof name !== 'string') return 'unnamed';
  const cleaned = name
    .replace(/[<>:"\\|?*\u0000-\u001f]/g, '-')
    .trim()
    .replace(/[. ]+$/g, '');
  return cleaned || 'unnamed';
}

function sanitizeFileName(name) {
  return sanitizeDisplaySegment(path.basename(name || 'unnamed'));
}

function sanitizeRelativePath(relativePath) {
  if (typeof relativePath !== 'string') return null;
  const normalized = relativePath.replace(/\\/g, '/');
  const rawSegments = normalized.split('/').filter(Boolean);
  if (rawSegments.length === 0) return null;

  const safeSegments = [];
  for (const rawSegment of rawSegments) {
    if (rawSegment === '.' || rawSegment === '..') return null;
    const safeSegment = sanitizeDisplaySegment(rawSegment);
    if (!safeSegment) return null;
    safeSegments.push(safeSegment);
  }

  return safeSegments.join('/');
}

function buildFileRecord(id, name, size, timestamp, extra = {}) {
  return {
    id,
    name,
    size,
    timestamp,
    ...extra
  };
}

function buildFolderRecord(id, name, size, timestamp) {
  return {
    id,
    name,
    size,
    timestamp,
    type: 'folder'
  };
}

function getUploadSessionDir(fileId) {
  return path.join(tempRoot(), fileId);
}

function getUploadSessionMetaPath(fileId) {
  return path.join(getUploadSessionDir(fileId), UPLOAD_SESSION_META_FILE);
}

function getUploadSessionBitmapPath(fileId) {
  return path.join(getUploadSessionDir(fileId), UPLOAD_SESSION_BITMAP_FILE);
}

function getUploadSessionDataPath(fileId) {
  return path.join(getUploadSessionDir(fileId), UPLOAD_SESSION_DATA_FILE);
}

function getLegacyChunkPath(fileId, chunkIndex) {
  return path.join(getUploadSessionDir(fileId), `chunk_${chunkIndex}`);
}

function getStageDir(folderSessionId) {
  return path.join(stagingRoot(), folderSessionId);
}

function getStageFilePath(folderSessionId, relativePath) {
  return path.join(getStageDir(folderSessionId), relativePath);
}

function getCompletedUploadPath(fileId) {
  return path.join(completedRoot(), `${fileId}.json`);
}

function createStoredFileId(fileName) {
  return `${uuidv4()}_${sanitizeFileName(fileName)}`;
}

function createStoredFolderId(folderName) {
  return `${uuidv4()}_${sanitizeDisplaySegment(folderName)}`;
}

function safeContentDisposition(filename, disposition = 'attachment') {
  let fallback = sanitizeFileName(filename).replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '_').trim();
  fallback = fallback || 'download';
  const encoded = encodeURIComponent(filename)
    .replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function guessMimeType(fileName) {
  if (/\.mp4$/i.test(fileName)) return 'video/mp4';
  if (/\.webm$/i.test(fileName)) return 'video/webm';
  if (/\.ogg$/i.test(fileName)) return 'video/ogg';
  if (/\.mp3$/i.test(fileName)) return 'audio/mpeg';
  if (/\.wav$/i.test(fileName)) return 'audio/wav';
  if (/\.(jpg|jpeg)$/i.test(fileName)) return 'image/jpeg';
  if (/\.png$/i.test(fileName)) return 'image/png';
  if (/\.gif$/i.test(fileName)) return 'image/gif';
  if (/\.webp$/i.test(fileName)) return 'image/webp';
  if (/\.zip$/i.test(fileName)) return 'application/zip';
  return 'application/octet-stream';
}

async function statIfExists(targetPath) {
  return fs.promises.stat(targetPath).catch(() => null);
}

async function openFileWithRetry(filePath, flag = 'r+') {
  let attempt = 0;
  while (true) {
    try {
      return await fs.promises.open(filePath, flag);
    } catch (err) {
      if (err.code === 'ENOENT' && flag === 'r+') {
        await fs.promises.open(filePath, 'a').then(h => h.close()).catch(() => {});
        continue;
      }
      if ((err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') && attempt < 15) {
        attempt++;
        await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
        continue;
      }
      throw err;
    }
  }
}

function parseRangeHeader(rangeHeader, size) {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) return null;
  const [rawStart, rawEnd] = rangeHeader.replace('bytes=', '').split('-');
  let start = rawStart ? parseInt(rawStart, 10) : NaN;
  let end = rawEnd ? parseInt(rawEnd, 10) : NaN;

  if (Number.isNaN(start) && Number.isNaN(end)) return null;
  if (Number.isNaN(start)) {
    const suffixLength = end;
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else if (Number.isNaN(end)) {
    end = size - 1;
  }

  if (start < 0 || end < start || end >= size) return null;
  return { start, end };
}

async function ensureStorageLayout(rootPath) {
  await fs.promises.mkdir(path.join(rootPath, STORE_SUBDIR), { recursive: true });
  await fs.promises.mkdir(path.join(rootPath, STORE_SUBDIR, TMP_SUBDIR), { recursive: true });
  await fs.promises.mkdir(path.join(rootPath, STORE_SUBDIR, STAGING_SUBDIR), { recursive: true });
  await fs.promises.mkdir(path.join(rootPath, STORE_SUBDIR, TMP_SUBDIR, COMPLETED_SUBDIR), { recursive: true });
  await fs.promises.mkdir(path.join(rootPath, STORE_SUBDIR, TMP_SUBDIR, DOWNLOAD_CACHE_SUBDIR), { recursive: true });
}

async function getFolderSize(dirPath) {
  let totalSize = 0;
  const pending = [dirPath];

  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await fs.promises.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile()) {
        const stats = await fs.promises.stat(fullPath).catch(() => null);
        totalSize += stats?.size || 0;
      }
    }
  }

  return totalSize;
}

async function calculateFileFingerprint(filePath, size) {
  let stream;
  try {
    const hash = crypto.createHash('sha256');

    stream = fs.createReadStream(filePath, {
      highWaterMark: STREAM_BUFFER_SIZE
    });

    for await (const chunk of stream) {
      hash.update(chunk);
    }

    return hash.digest('hex');
  } catch {
    return null;
  } finally {
    if (stream) {
      stream.destroy();
    }
  }
}

async function readCompletedUpload(fileId) {
  const completedPath = getCompletedUploadPath(fileId);
  try {
    const raw = await fs.promises.readFile(completedPath, 'utf8');
    const data = JSON.parse(raw);
    if (!data?.storedId) return null;
    const storedPath = path.join(storageRoot(), path.basename(data.storedId));
    const stats = await fs.promises.stat(storedPath).catch(() => null);
    if (!stats?.isFile()) return null;
    return {
      storedId: path.basename(data.storedId),
      fingerprint: data.hashVersion === 2 ? sanitizeSha256(data.fingerprint) : null,
      hashVersion: Number(data.hashVersion) || 0
    };
  } catch {
    return null;
  }
}

async function writeCompletedUpload(fileId, storedId, fingerprint = null) {
  await fs.promises.mkdir(completedRoot(), { recursive: true });
  await fs.promises.writeFile(
    getCompletedUploadPath(fileId),
    JSON.stringify({
      storedId,
      fingerprint: sanitizeSha256(fingerprint),
      hashVersion: 2,
      completedAt: Date.now()
    }),
    'utf8'
  );
}

function parsePositiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeUploadSessionConfig(source) {
  const totalChunks = parsePositiveInteger(source?.totalChunks);
  const totalSize = Number(source?.totalSize);
  const chunkSize = parsePositiveInteger(source?.chunkSize);

  if (!Number.isInteger(totalChunks) || totalChunks < 1) return null;
  if (!Number.isFinite(totalSize) || totalSize < 0) return null;
  if (!Number.isInteger(chunkSize) || chunkSize < 1) return null;

  return {
    totalChunks,
    totalSize,
    chunkSize
  };
}

function uploadSessionMatches(session, config) {
  return Boolean(
    session &&
    config &&
    session.totalChunks === config.totalChunks &&
    session.totalSize === config.totalSize &&
    session.chunkSize === config.chunkSize
  );
}

async function readUploadSession(fileId) {
  try {
    const raw = await fs.promises.readFile(getUploadSessionMetaPath(fileId), 'utf8');
    const data = JSON.parse(raw);
    const config = normalizeUploadSessionConfig(data);
    if (!config || Number(data.version) !== UPLOAD_SESSION_VERSION) {
      return null;
    }

    return {
      fileId,
      dirPath: getUploadSessionDir(fileId),
      metaPath: getUploadSessionMetaPath(fileId),
      bitmapPath: getUploadSessionBitmapPath(fileId),
      dataPath: getUploadSessionDataPath(fileId),
      ...config
    };
  } catch {
    return null;
  }
}

async function ensureUploadSessionBitmap(session) {
  const handle = await openFileWithRetry(session.bitmapPath, 'a+');
  try {
    const stats = await handle.stat();
    if (stats.size !== session.totalChunks) {
      await handle.truncate(session.totalChunks);
    }
  } finally {
    await handle.close().catch(() => { });
  }
}

async function ensureUploadSession(fileId, config) {
  await fs.promises.mkdir(getUploadSessionDir(fileId), { recursive: true });

  const sessionData = JSON.stringify({
    version: UPLOAD_SESSION_VERSION,
    totalChunks: config.totalChunks,
    totalSize: config.totalSize,
    chunkSize: config.chunkSize,
    createdAt: Date.now()
  });

  try {
    await fs.promises.writeFile(getUploadSessionMetaPath(fileId), sessionData, {
      encoding: 'utf8',
      flag: 'wx'
    });
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw error;
    }
  }

  const session = await readUploadSession(fileId);
  if (!uploadSessionMatches(session, config)) {
    throw new Error('Upload session metadata mismatch');
  }

  await ensureUploadSessionBitmap(session);
  const handle = await openFileWithRetry(session.dataPath, 'a');
  await handle.close().catch(() => { });
  return session;
}

async function readLegacyUploadedChunks(fileId) {
  const sessionDir = getUploadSessionDir(fileId);
  const stats = await statIfExists(sessionDir);
  if (!stats?.isDirectory()) {
    return [];
  }

  return (await fs.promises.readdir(sessionDir).catch(() => []))
    .filter(entry => /^chunk_\d+$/.test(entry))
    .map(entry => Number(entry.replace('chunk_', '')))
    .filter(Number.isInteger)
    .sort((a, b) => a - b);
}

async function inspectUploadBitmap(session, options = {}) {
  const includeUploadedChunks = options.includeUploadedChunks !== false;
  const buffer = await fs.promises.readFile(session.bitmapPath).catch(() => Buffer.alloc(0));
  const uploadedChunks = includeUploadedChunks ? [] : null;
  let firstMissingChunk = null;

  for (let index = 0; index < session.totalChunks; index++) {
    const uploaded = buffer[index] === 1;
    if (uploaded) {
      if (includeUploadedChunks) {
        uploadedChunks.push(index);
      }
      continue;
    }

    if (firstMissingChunk === null) {
      firstMissingChunk = index;
      if (!includeUploadedChunks) {
        break;
      }
    }
  }

  return {
    uploadedChunks,
    firstMissingChunk
  };
}

async function markUploadChunkReceived(session, chunkIndex) {
  const handle = await openFileWithRetry(session.bitmapPath, 'r+');
  try {
    await handle.write(Buffer.from([1]), 0, 1, chunkIndex);
  } finally {
    await handle.close().catch(() => { });
  }
}

async function writeReadableChunkToSession(readable, session, chunkStart, options = {}) {
  const expectedHash = options.expectedHash ? sanitizeSha256(options.expectedHash) : null;
  const hash = crypto.createHash('sha256');
  const existingStats = await statIfExists(session.dataPath);
  let handle;

  try {
    handle = await openFileWithRetry(session.dataPath, 'r+');
    let position = chunkStart;

    for await (const chunk of readable) {
      hash.update(chunk);

      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, position);
        offset += bytesWritten;
        position += bytesWritten;
      }
    }

    const actualHash = hash.digest('hex');
    if (expectedHash && actualHash !== expectedHash) {
      throw new Error('Chunk integrity check failed');
    }

    return actualHash;
  } finally {
    if (handle) {
      await handle.close().catch(() => { });
    }
  }
}

async function finalizeUploadSession(fileId, destinationPath) {
  const session = await readUploadSession(fileId);
  if (!session) {
    return null;
  }

  const inspection = await inspectUploadBitmap(session, { includeUploadedChunks: false });
  if (inspection.firstMissingChunk !== null) {
    throw new Error(`Missing chunk ${inspection.firstMissingChunk}`);
  }

  const dataStats = await fs.promises.stat(session.dataPath).catch(() => null);
  if (!dataStats?.isFile()) {
    throw new Error('Upload session data not found');
  }

  if (dataStats.size !== session.totalSize) {
    throw new Error('Upload session size mismatch');
  }

  const fingerprint = await calculateFileFingerprint(session.dataPath, dataStats.size);
  if (!fingerprint) {
    throw new Error('Could not verify uploaded file');
  }

  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.promises.rm(destinationPath, { force: true }).catch(() => { });
  await fs.promises.rename(session.dataPath, destinationPath);
  await fs.promises.rm(session.dirPath, { recursive: true, force: true }).catch(() => { });

  return {
    size: dataStats.size,
    fingerprint
  };
}

async function getUploadStatusState({ fileId, folderSessionId = null, fileName = null, config = null }) {
  const completed = await readCompletedUpload(fileId);
  if (completed) {
    return { uploadedChunks: [], merged: true, resetRequired: false };
  }

  let merged = false;
  if (folderSessionId && fileName) {
    const stagedFilePath = getStageFilePath(folderSessionId, fileName);
    const stagedStats = await fs.promises.stat(stagedFilePath).catch(() => null);
    merged = Boolean(stagedStats?.isFile());
  }

  const session = await readUploadSession(fileId);
  if (session) {
    if (config && !uploadSessionMatches(session, config)) {
      return { uploadedChunks: [], merged, resetRequired: true };
    }

    const inspection = await inspectUploadBitmap(session);
    return {
      uploadedChunks: inspection.uploadedChunks || [],
      merged,
      resetRequired: false
    };
  }

  const uploadedChunks = await readLegacyUploadedChunks(fileId);
  const resetRequired = Boolean(config && uploadedChunks.some(index => index >= config.totalChunks));
  return {
    uploadedChunks: resetRequired ? [] : uploadedChunks,
    merged,
    resetRequired
  };
}

async function loadExistingFiles() {
  filesCache = [];
  if (!storagePath) return;

  const root = storageRoot();
  if (!root || !(await statIfExists(root))) return;

  const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
  const records = await Promise.all(entries.map(async entry => {
    if ([TMP_SUBDIR, STAGING_SUBDIR].includes(entry.name)) return null;

    const fullPath = path.join(root, entry.name);
    const stats = await fs.promises.stat(fullPath).catch(() => null);
    if (!stats) return null;

    if (stats.isFile()) {
      return buildFileRecord(
        entry.name,
        entry.name.split('_').slice(1).join('_') || entry.name,
        stats.size,
        stats.mtime.toISOString(),
        { mtime: stats.mtime.getTime() }
      );
    }

    if (stats.isDirectory()) {
      return {
        ...buildFolderRecord(
          entry.name,
          entry.name.split('_').slice(1).join('_') || entry.name,
          await getFolderSize(fullPath),
          stats.mtime.toISOString()
        ),
        mtime: stats.mtime.getTime()
      };
    }

    return null;
  }));

  filesCache = records
    .filter(Boolean)
    .sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
    .map(({ mtime, ...rest }) => rest);
}

function upsertFileRecord(record) {
  const index = filesCache.findIndex(item => item.id === record.id);
  if (index >= 0) {
    filesCache[index] = record;
  } else {
    filesCache.unshift(record);
  }
}

function findFileRecord(recordId) {
  return filesCache.find(item => item.id === recordId) || null;
}

async function getRecordFingerprint(record) {
  if (!record || record.type === 'folder') return null;
  if (record.fingerprint && record.hashVersion === 2) return record.fingerprint;

  const fullPath = path.join(storageRoot(), record.id);
  const stats = await fs.promises.stat(fullPath).catch(() => null);
  if (!stats?.isFile()) return null;

  const fingerprint = await calculateFileFingerprint(fullPath, stats.size);
  if (fingerprint) {
    record.fingerprint = fingerprint;
    record.hashVersion = 2;
  }
  return fingerprint;
}

async function sendFileResponse(request, reply, filePath, downloadName, options = {}) {
  const stats = await fs.promises.stat(filePath).catch(() => null);
  if (!stats?.isFile()) {
    return reply.status(404).send({ error: 'File not found' });
  }

  const disposition = options.disposition || 'attachment';
  const mimeType = options.mimeType || guessMimeType(downloadName);
  const range = parseRangeHeader(request.headers.range, stats.size);

  reply.header('Accept-Ranges', 'bytes');
  reply.header('Content-Disposition', safeContentDisposition(downloadName, disposition));
  reply.type(mimeType);

  if (request.headers.range && !range) {
    reply.status(416);
    reply.header('Content-Range', `bytes */${stats.size}`);
    return reply.send();
  }

  if (range) {
    const { start, end } = range;
    reply.status(206);
    reply.header('Content-Range', `bytes ${start}-${end}/${stats.size}`);
    reply.header('Content-Length', (end - start) + 1);
    return reply.send(fs.createReadStream(filePath, { start, end, highWaterMark: STREAM_BUFFER_SIZE }));
  }

  reply.header('Content-Length', stats.size);
  return reply.send(fs.createReadStream(filePath, { highWaterMark: STREAM_BUFFER_SIZE }));
}

async function writeReadableToFile(readable, destinationPath, options = {}) {
  const expectedHash = options.expectedHash ? sanitizeSha256(options.expectedHash) : null;
  const hash = crypto.createHash('sha256');
  let handle;
  let shouldRemove = false;

  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.promises.rm(destinationPath, { force: true }).catch(() => { });

  try {
    handle = await fs.promises.open(destinationPath, 'w');

    for await (const chunk of readable) {
      hash.update(chunk);

      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
        offset += bytesWritten;
      }
    }

    const actualHash = hash.digest('hex');
    if (expectedHash && actualHash !== expectedHash) {
      throw new Error('Chunk integrity check failed');
    }

    return actualHash;
  } catch (error) {
    shouldRemove = true;
    throw error;
  } finally {
    if (handle) {
      await handle.close().catch(() => { });
    }
    if (shouldRemove) {
      await fs.promises.rm(destinationPath, { force: true }).catch(() => { });
    }
  }
}

async function mergeChunkDirectory(tmpDir, destinationPath, totalChunks) {
  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.promises.rm(destinationPath, { force: true }).catch(() => { });
  const hash = crypto.createHash('sha256');
  let bytesWritten = 0;
  let handle;
  let shouldRemove = false;

  try {
    handle = await fs.promises.open(destinationPath, 'w');

    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(tmpDir, `chunk_${i}`);
      const stats = await fs.promises.stat(chunkPath).catch(() => null);
      if (!stats?.isFile()) {
        throw new Error(`Missing chunk ${i}`);
      }

      const readStream = fs.createReadStream(chunkPath, {
        highWaterMark: STREAM_BUFFER_SIZE
      });

      try {
        for await (const chunk of readStream) {
          hash.update(chunk);

          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten: chunkBytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
            offset += chunkBytesWritten;
          }

          bytesWritten += chunk.length;
        }
      } finally {
        readStream.destroy();
      }
    }

    return {
      size: bytesWritten,
      fingerprint: hash.digest('hex')
    };
  } catch (error) {
    shouldRemove = true;
    throw error;
  } finally {
    if (handle) {
      await handle.close().catch(() => { });
    }
    if (shouldRemove) {
      await fs.promises.rm(destinationPath, { force: true }).catch(() => { });
    }
  }
}

async function linkFileToPath(sourceId, destinationPath) {
  const safeSourceId = path.basename(sourceId);
  const sourcePath = path.join(storageRoot(), safeSourceId);
  const sourceStats = await fs.promises.stat(sourcePath).catch(() => null);
  if (!sourceStats?.isFile()) {
    throw new Error('Duplicate source not found');
  }

  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.promises.rm(destinationPath, { force: true }).catch(() => { });
  await fs.promises.link(sourcePath, destinationPath);
}

async function getStoredFileFingerprint(sourceId) {
  const safeSourceId = path.basename(sourceId);
  const existingRecord = findFileRecord(safeSourceId);
  if (existingRecord) {
    return getRecordFingerprint(existingRecord);
  }

  const sourcePath = path.join(storageRoot(), safeSourceId);
  const sourceStats = await fs.promises.stat(sourcePath).catch(() => null);
  if (!sourceStats?.isFile()) {
    return null;
  }

  return calculateFileFingerprint(sourcePath, sourceStats.size);
}

function runProcess(command, args, options = {}) {
  const subprocess = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdout: 'ignore',
    stderr: 'pipe'
  });

  return subprocess.exited.then(async code => {
    if (code === 0) return;
    const stderr = await new Response(subprocess.stderr).text();
    throw new Error(stderr.trim() || `${command} exited with code ${code}`);
  });
}

async function createFolderZip(sourceDir, zipPath) {
  await fs.promises.mkdir(path.dirname(zipPath), { recursive: true });
  await fs.promises.rm(zipPath, { force: true }).catch(() => { });

  if (process.platform === 'win32') {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      '$source = $env:FILETRANSFER_SOURCE',
      '$dest = $env:FILETRANSFER_DEST',
      'Compress-Archive -LiteralPath $source -DestinationPath $dest -Force'
    ].join('; ');

    await runProcess('powershell', ['-NoProfile', '-Command', script], {
      env: {
        ...process.env,
        FILETRANSFER_SOURCE: sourceDir,
        FILETRANSFER_DEST: zipPath
      }
    });
    return;
  }

  await runProcess('zip', ['-r', '-q', '-0', zipPath, path.basename(sourceDir)], {
    cwd: path.dirname(sourceDir)
  });
}

async function prepareFolderZip(fileId, folderPath) {
  const existingJob = folderZipJobs.get(fileId);
  if (existingJob?.promise) {
    await existingJob.promise;
    return existingJob;
  }

  if (existingJob?.zipPath && existingJob.expiresAt > Date.now() && await statIfExists(existingJob.zipPath)) {
    return existingJob;
  }

  const zipPath = path.join(downloadCacheRoot(), `${fileId}.zip`);
  const job = {
    zipPath,
    expiresAt: 0,
    promise: null
  };

  job.promise = (async () => {
    await createFolderZip(folderPath, zipPath);
    job.expiresAt = Date.now() + ZIP_CACHE_AGE_MS;
  })().catch((err) => {
    folderZipJobs.delete(fileId);
    throw err;
  }).finally(() => {
    if (folderZipJobs.get(fileId) === job) {
      job.promise = null;
    }
  });

  folderZipJobs.set(fileId, job);
  await job.promise;
  return job;
}

async function cleanupFolderZip(fileId) {
  const job = folderZipJobs.get(fileId);
  if (!job) return;
  folderZipJobs.delete(fileId);
  if (job.zipPath) {
    await fs.promises.rm(job.zipPath, { force: true }).catch(() => { });
  }
}

fastify.setErrorHandler((error, _request, reply) => {
  if (error.validation) {
    return reply.status(400).send({ error: error.message });
  }

  if (reply.sent) {
    return;
  }

  return reply.status(error.statusCode || 500).send({ error: error.message || 'Internal server error' });
});

fastify.decorate('verifyAdmin', async (request, reply) => {
  const ip = request.ip;
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== 'localhost') {
    return reply.status(403).send({ error: 'Admin access is strictly restricted to localhost.' });
  }
});

fastify.register(fastifyCors, { origin: '*' });

fastify.get('/', async (_request, reply) => {
  reply.header('Cache-Control', 'no-store, max-age=0');
  reply.type('text/html');
  return reply.send(indexHtml);
});

fastify.get('/index.html', async (_request, reply) => {
  reply.header('Cache-Control', 'no-store, max-age=0');
  reply.type('text/html');
  return reply.send(indexHtml);
});

fastify.get('/app.js', async (_request, reply) => {
  reply.header('Cache-Control', 'no-store, max-age=0');
  reply.type('application/javascript');
  return reply.send(appJs);
});

fastify.get('/hash-worker.js', async (_request, reply) => {
  reply.header('Cache-Control', 'no-store, max-age=0');
  reply.type('application/javascript');
  return reply.send(hashWorkerJs);
});

fastify.get('/manifest.json', async (_request, reply) => {
  reply.header('Cache-Control', 'no-store, max-age=0');
  reply.type('application/json');
  return reply.send(manifestJson);
});

fastify.get('/sw.js', async (_request, reply) => {
  reply.header('Cache-Control', 'no-store, max-age=0');
  reply.type('application/javascript');
  return reply.send(swJs);
});

fastify.register(fastifyMultipart, {
  limits: {
    fileSize: MAX_FILE_SIZE,
    fields: 20,
    files: 1
  }
});

fastify.register(fastifySocketIo, {
  cors: { origin: '*' }
});

fastify.addHook('onReady', async () => {
  fastify.io.on('connection', socket => {
    socket.emit('file-updated', filesCache);
  });
});

fastify.get('/api/status', {
  schema: {
    response: {
      200: {
        type: 'object',
        properties: {
          storageConfigured: { type: 'boolean' },
          files: { type: 'array', items: fileRecordSchema }
        },
        required: ['storageConfigured', 'files']
      }
    }
  }
}, async () => ({
  storageConfigured: isStorageConfigured,
  files: filesCache
}));

fastify.post('/api/set-storage', {
  preHandler: fastify.verifyAdmin,
  schema: {
    body: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 }
      },
      required: ['path'],
      additionalProperties: false
    },
    response: {
      200: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          files: { type: 'array', items: fileRecordSchema }
        },
        required: ['success', 'files']
      },
      400: errorSchema,
      401: errorSchema
    }
  }
}, async (request, reply) => {
  const body = request.body;
  const requestedPath = typeof body.path === 'string' ? body.path.trim() : '';
  if (!requestedPath) {
    return reply.status(400).send({ error: 'Path is required' });
  }

  const resolvedPath = path.resolve(requestedPath);
  await ensureStorageLayout(resolvedPath);

  storagePath = resolvedPath;
  isStorageConfigured = true;
  await loadExistingFiles();

  return { success: true, files: filesCache };
});

fastify.get('/api/upload/check', {
  schema: {
    querystring: {
      type: 'object',
      properties: {
        fingerprint: { type: 'string' },
        size: { anyOf: [{ type: 'string' }, { type: 'number' }] }
      },
      required: ['fingerprint', 'size'],
      additionalProperties: false
    },
    response: {
      200: {
        type: 'object',
        properties: {
          exists: { type: 'boolean' },
          sourceId: { type: 'string' },
          file: fileRecordSchema
        },
        required: ['exists'],
        additionalProperties: false
      },
      400: errorSchema
    }
  }
}, async (request, reply) => {
  if (!isStorageConfigured) {
    return reply.status(400).send({ error: 'Storage not configured' });
  }

  const fingerprint = sanitizeSha256(request.query.fingerprint);
  const size = Number(request.query.size);
  if (!fingerprint || !Number.isFinite(size) || size < 0) {
    return { exists: false };
  }

  for (const record of filesCache) {
    if (record.type === 'folder' || record.size !== size) continue;
    const existingFingerprint = await getRecordFingerprint(record);
    if (existingFingerprint && existingFingerprint === fingerprint) {
      return {
        exists: true,
        sourceId: record.id,
        file: record
      };
    }
  }

  return { exists: false };
});

fastify.get('/api/upload/status/:fileId', {
  schema: {
    params: {
      type: 'object',
      properties: {
        fileId: { type: 'string', minLength: 1 }
      },
      required: ['fileId'],
      additionalProperties: false
    },
    querystring: {
      type: 'object',
      properties: {
        folderSessionId: { type: 'string' },
        fileName: { type: 'string' },
        totalChunks: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
        totalSize: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        chunkSize: { anyOf: [{ type: 'string' }, { type: 'integer' }] }
      },
      additionalProperties: false
    },
    response: {
      200: {
        type: 'object',
        properties: {
          uploadedChunks: { type: 'array', items: { type: 'integer' } },
          merged: { type: 'boolean' },
          resetRequired: { type: 'boolean' }
        },
        required: ['uploadedChunks', 'merged', 'resetRequired']
      },
      400: errorSchema
    }
  }
}, async (request, reply) => {
  if (!isStorageConfigured) {
    return reply.status(400).send({ error: 'Storage not configured' });
  }

  const fileId = sanitizeUploadId(request.params.fileId);
  if (!fileId) {
    return { uploadedChunks: [], merged: false, resetRequired: false };
  }

  const folderSessionId = sanitizeUploadId(request.query.folderSessionId);
  const safeRelativePath = sanitizeRelativePath(request.query.fileName);
  const config = normalizeUploadSessionConfig(request.query);

  return getUploadStatusState({
    fileId,
    folderSessionId,
    fileName: safeRelativePath,
    config
  });
});

fastify.post('/api/upload/status-batch', {
  schema: {
    body: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 500,
          items: {
            type: 'object',
            properties: {
              fileId: { type: 'string', minLength: 1 },
              folderSessionId: { type: 'string' },
              fileName: { type: 'string' },
              totalChunks: { type: 'integer', minimum: 1 },
              totalSize: { type: 'number', minimum: 0 },
              chunkSize: { type: 'integer', minimum: 1 }
            },
            required: ['fileId', 'totalChunks', 'totalSize', 'chunkSize'],
            additionalProperties: false
          }
        }
      },
      required: ['items'],
      additionalProperties: false
    },
    response: {
      200: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                fileId: { type: 'string' },
                uploadedChunks: { type: 'array', items: { type: 'integer' } },
                merged: { type: 'boolean' },
                resetRequired: { type: 'boolean' }
              },
              required: ['fileId', 'uploadedChunks', 'merged', 'resetRequired'],
              additionalProperties: false
            }
          }
        },
        required: ['items'],
        additionalProperties: false
      },
      400: errorSchema
    }
  }
}, async (request, reply) => {
  if (!isStorageConfigured) {
    return reply.status(400).send({ error: 'Storage not configured' });
  }

  const items = await Promise.all(request.body.items.map(async item => {
    const fileId = sanitizeUploadId(item.fileId);
    const folderSessionId = sanitizeUploadId(item.folderSessionId);
    const fileName = sanitizeRelativePath(item.fileName);
    const config = normalizeUploadSessionConfig(item);

    if (!fileId || !config) {
      return {
        fileId: item.fileId,
        uploadedChunks: [],
        merged: false,
        resetRequired: false
      };
    }

    const status = await getUploadStatusState({
      fileId,
      folderSessionId,
      fileName,
      config
    });

    return {
      fileId,
      uploadedChunks: status.uploadedChunks,
      merged: status.merged,
      resetRequired: status.resetRequired
    };
  }));

  return { items };
});

fastify.post('/api/upload/chunk', {
  schema: {
    querystring: {
      type: 'object',
      properties: {
        fileId: { type: 'string' },
        chunkIndex: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
        chunkHash: { type: 'string' },
        chunkStart: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
        totalChunks: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
        totalSize: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        chunkSize: { anyOf: [{ type: 'string' }, { type: 'integer' }] }
      },
      additionalProperties: false
    },
    response: {
      200: successSchema,
      400: errorSchema,
      409: errorSchema
    }
  }
}, async (request, reply) => {
  if (!isStorageConfigured) {
    return reply.status(400).send({ error: 'Storage not configured' });
  }

  const parts = request.parts();
  let fileId = sanitizeUploadId(request.query?.fileId);
  let chunkIndex = null;
  let chunkHash = sanitizeSha256(request.query?.chunkHash);
  let chunkStart = parsePositiveInteger(request.query?.chunkStart);
  const queryChunkIndex = Number(request.query?.chunkIndex);
  if (Number.isInteger(queryChunkIndex) && queryChunkIndex >= 0) {
    chunkIndex = queryChunkIndex;
  }
  const sessionConfig = normalizeUploadSessionConfig(request.query);
  let chunkHandled = false;

  for await (const part of parts) {
    if (part.type === 'field') {
      if (!fileId && part.fieldname === 'fileId') {
        fileId = sanitizeUploadId(part.value);
      } else if (chunkIndex === null && part.fieldname === 'chunkIndex') {
        const parsed = Number(part.value);
        if (Number.isInteger(parsed) && parsed >= 0) {
          chunkIndex = parsed;
        }
      } else if (chunkStart === null && part.fieldname === 'chunkStart') {
        const parsed = Number(part.value);
        if (Number.isInteger(parsed) && parsed >= 0) {
          chunkStart = parsed;
        }
      } else if (!chunkHash && part.fieldname === 'chunkHash') {
        chunkHash = sanitizeSha256(part.value);
      }
      continue;
    }

    if (part.type !== 'file') {
      continue;
    }

    if (!fileId || chunkIndex === null) {
      part.file.resume();
      return reply.status(400).send({ error: 'Invalid upload metadata' });
    }

    if (!chunkHash) {
      part.file.resume();
      return reply.status(400).send({ error: 'Chunk hash is required' });
    }

    const existingSession = await readUploadSession(fileId);
    const legacyUploadedChunks = existingSession ? [] : await readLegacyUploadedChunks(fileId);
    const useLegacyChunkStore = !existingSession && legacyUploadedChunks.length > 0;

    if (useLegacyChunkStore) {
      const chunkDir = getUploadSessionDir(fileId);
      await fs.promises.mkdir(chunkDir, { recursive: true });

      const chunkPath = path.join(chunkDir, `chunk_${chunkIndex}`);
      try {
        await writeReadableToFile(part.file, chunkPath, {
          expectedHash: chunkHash
        });
      } catch (error) {
        error.statusCode = error.message === 'Chunk integrity check failed' ? 400 : (error.statusCode || 500);
        throw error;
      }
    } else {
      if (chunkStart === null || !sessionConfig) {
        part.file.resume();
        return reply.status(400).send({ error: 'Upload session metadata is required' });
      }

      if (chunkIndex >= sessionConfig.totalChunks || chunkStart !== (chunkIndex * sessionConfig.chunkSize) || chunkStart > sessionConfig.totalSize) {
        part.file.resume();
        return reply.status(400).send({ error: 'Invalid upload session chunk placement' });
      }

      let session;
      try {
        if (existingSession) {
          session = existingSession;
        } else {
          let lock = uploadSessionLocks.get(fileId);
          if (!lock) {
            lock = (async () => {
              try {
                return await ensureUploadSession(fileId, sessionConfig);
              } finally {
                uploadSessionLocks.delete(fileId);
              }
            })();
            uploadSessionLocks.set(fileId, lock);
          }
          session = await lock;
        }

        if (!uploadSessionMatches(session, sessionConfig)) {
          throw new Error('Upload session metadata mismatch');
        }
      } catch (error) {
        error.statusCode = error.message === 'Upload session metadata mismatch' ? 409 : (error.statusCode || 500);
        throw error;
      }

      try {
        await writeReadableChunkToSession(part.file, session, chunkStart, {
          expectedHash: chunkHash
        });
        await markUploadChunkReceived(session, chunkIndex);
      } catch (error) {
        error.statusCode = error.message === 'Chunk integrity check failed' ? 400 : (error.statusCode || 500);
        throw error;
      }
    }
    chunkHandled = true;
  }

  if (!chunkHandled) {
    return reply.status(400).send({ error: 'Chunk file is required' });
  }

  return { success: true };
});

fastify.post('/api/upload/merge', {
  schema: {
    body: {
      type: 'object',
      properties: {
        fileId: { type: 'string' },
        fileName: { type: 'string', minLength: 1 },
        totalChunks: { type: 'integer', minimum: 1 },
        folderSessionId: { type: 'string' },
        dedupSourceId: { type: 'string' },
        fingerprint: { type: 'string' }
      },
      required: ['fileName'],
      additionalProperties: false
    },
    response: {
      200: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          merged: { type: 'boolean' },
          file: fileRecordSchema
        },
        required: ['success', 'merged'],
        additionalProperties: false
      },
      400: errorSchema,
      500: errorSchema
    }
  }
}, async (request, reply) => {
  if (!isStorageConfigured) {
    return reply.status(400).send({ error: 'Storage not configured' });
  }

  const body = request.body;

  const fileId = body.fileId ? sanitizeUploadId(body.fileId) : null;
  const folderSessionId = body.folderSessionId ? sanitizeUploadId(body.folderSessionId) : null;
  const fileName = folderSessionId ? sanitizeRelativePath(body.fileName) : sanitizeFileName(body.fileName);
  const dedupSourceId = body.dedupSourceId ? path.basename(body.dedupSourceId) : null;
  let fingerprint = null;

  if (!fileName) {
    return reply.status(400).send({ error: 'Invalid fileName' });
  }

  if (!dedupSourceId && (!fileId || !Number.isInteger(body.totalChunks) || body.totalChunks <= 0)) {
    return reply.status(400).send({ error: 'Invalid upload configuration' });
  }

  if (folderSessionId) {
    const destinationPath = getStageFilePath(folderSessionId, fileName);
    try {
      const existingStats = await fs.promises.stat(destinationPath).catch(() => null);
      if (existingStats?.isFile()) {
        return { success: true, merged: true };
      }

      if (dedupSourceId) {
        await linkFileToPath(dedupSourceId, destinationPath);
        fingerprint = await getStoredFileFingerprint(dedupSourceId);
        if (fileId) {
          await fs.promises.rm(getUploadSessionDir(fileId), { recursive: true, force: true }).catch(() => { });
        }
      } else {
        const sessionResult = await finalizeUploadSession(fileId, destinationPath).catch(error => {
          if (error?.message === 'Upload session data not found') {
            return null;
          }
          throw error;
        });

        if (!sessionResult) {
          const chunkDir = getUploadSessionDir(fileId);
          if (!(await statIfExists(chunkDir))) {
            return reply.status(400).send({ error: 'Chunks not found' });
          }
          const mergeResult = await mergeChunkDirectory(chunkDir, destinationPath, body.totalChunks);
          fingerprint = mergeResult.fingerprint;
          await fs.promises.rm(chunkDir, { recursive: true, force: true }).catch(() => { });
        } else {
          fingerprint = sessionResult.fingerprint;
        }
      }

      return { success: true, merged: true };
    } catch (err) {
      await fs.promises.rm(destinationPath, { force: true }).catch(() => { });
      return reply.status(err.message?.startsWith('Missing chunk') ? 400 : 500).send({
        error: err.message || 'Merge failed'
      });
    }
  }

  if (!fileId) {
    return reply.status(400).send({ error: 'Invalid fileId' });
  }

  const completed = await readCompletedUpload(fileId);
  if (completed) {
    const existingRecord = findFileRecord(completed.storedId);
    if (existingRecord) {
      return { success: true, file: existingRecord, merged: true };
    }

    const existingPath = path.join(storageRoot(), completed.storedId);
    const existingStats = await fs.promises.stat(existingPath).catch(() => null);
    if (existingStats?.isFile()) {
      const fileRecord = buildFileRecord(
        completed.storedId,
        completed.storedId.split('_').slice(1).join('_') || fileName,
        existingStats.size,
        existingStats.mtime.toISOString(),
        completed.fingerprint ? { fingerprint: completed.fingerprint, hashVersion: completed.hashVersion } : {}
      );
      upsertFileRecord(fileRecord);
      fastify.io.emit('file-added', fileRecord);
      return { success: true, file: fileRecord, merged: true };
    }
  }

  const storedId = createStoredFileId(fileName);
  const destinationPath = path.join(storageRoot(), storedId);
  let mergedBytes = null;

  try {
    if (dedupSourceId) {
      await linkFileToPath(dedupSourceId, destinationPath);
      fingerprint = await getStoredFileFingerprint(dedupSourceId);
      await fs.promises.rm(getUploadSessionDir(fileId), { recursive: true, force: true }).catch(() => { });
    } else {
      const sessionResult = await finalizeUploadSession(fileId, destinationPath).catch(error => {
        if (error?.message === 'Upload session data not found') {
          return null;
        }
        throw error;
      });

      if (sessionResult) {
        mergedBytes = sessionResult.size;
        fingerprint = sessionResult.fingerprint;
      } else {
        const chunkDir = getUploadSessionDir(fileId);
        if (!(await statIfExists(chunkDir))) {
          return reply.status(400).send({ error: 'Chunks not found' });
        }
        const mergeResult = await mergeChunkDirectory(chunkDir, destinationPath, body.totalChunks);
        mergedBytes = mergeResult.size;
        fingerprint = mergeResult.fingerprint;
        await fs.promises.rm(chunkDir, { recursive: true, force: true }).catch(() => { });
      }
    }

    const stats = await fs.promises.stat(destinationPath);
    if (mergedBytes !== null && stats.size !== mergedBytes) {
      throw new Error('Merged file size mismatch');
    }

    const fileRecord = buildFileRecord(
      storedId,
      fileName,
      stats.size,
      stats.mtime.toISOString(),
      fingerprint ? { fingerprint, hashVersion: 2 } : {}
    );

    upsertFileRecord(fileRecord);
    await writeCompletedUpload(fileId, storedId, fingerprint);
    fastify.io.emit('file-added', fileRecord);

    return { success: true, file: fileRecord, merged: true };
  } catch (err) {
    await fs.promises.rm(destinationPath, { force: true }).catch(() => { });
    return reply.status(err.message?.startsWith('Missing chunk') ? 400 : 500).send({
      error: err.message || 'Merge failed'
    });
  }
});

fastify.post('/api/upload/folder/finalize', {
  schema: {
    body: {
      type: 'object',
      properties: {
        folderSessionId: { type: 'string', minLength: 1 },
        folderName: { type: 'string', minLength: 1 }
      },
      required: ['folderSessionId', 'folderName'],
      additionalProperties: false
    },
    response: {
      200: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          file: fileRecordSchema
        },
        required: ['success', 'file'],
        additionalProperties: false
      },
      400: errorSchema
    }
  }
}, async (request, reply) => {
  if (!isStorageConfigured) {
    return reply.status(400).send({ error: 'Storage not configured' });
  }

  const body = request.body;

  const folderSessionId = sanitizeUploadId(body.folderSessionId);
  const folderName = sanitizeDisplaySegment(body.folderName);
  if (!folderSessionId || !folderName) {
    return reply.status(400).send({ error: 'Invalid folder finalize payload' });
  }

  const stagePath = path.join(getStageDir(folderSessionId), folderName);
  const stagedStats = await fs.promises.stat(stagePath).catch(() => null);
  if (!stagedStats?.isDirectory()) {
    return reply.status(400).send({ error: 'Folder staging not found' });
  }

  const finalId = createStoredFolderId(folderName);
  const finalPath = path.join(storageRoot(), finalId);

  await fs.promises.rename(stagePath, finalPath);
  await fs.promises.rm(getStageDir(folderSessionId), { recursive: true, force: true }).catch(() => { });

  const folderRecord = buildFolderRecord(
    finalId,
    folderName,
    await getFolderSize(finalPath),
    new Date().toISOString()
  );

  upsertFileRecord(folderRecord);
  fastify.io.emit('file-added', folderRecord);

  return { success: true, file: folderRecord };
});

fastify.delete('/api/upload/cancel/:fileId', {
  schema: {
    params: {
      type: 'object',
      properties: {
        fileId: { type: 'string', minLength: 1 }
      },
      required: ['fileId'],
      additionalProperties: false
    },
    response: {
      200: successSchema,
      400: errorSchema
    }
  }
}, async (request, reply) => {
  if (!isStorageConfigured) {
    return reply.status(400).send({ error: 'Storage not configured' });
  }

  const fileId = sanitizeUploadId(request.params.fileId);
  if (!fileId) {
    return { success: true };
  }

  await fs.promises.rm(getUploadSessionDir(fileId), { recursive: true, force: true }).catch(() => { });
  return { success: true };
});

fastify.delete('/api/upload/folder/:folderSessionId', {
  schema: {
    params: {
      type: 'object',
      properties: {
        folderSessionId: { type: 'string', minLength: 1 }
      },
      required: ['folderSessionId'],
      additionalProperties: false
    },
    response: {
      200: successSchema,
      400: errorSchema
    }
  }
}, async (request, reply) => {
  if (!isStorageConfigured) {
    return reply.status(400).send({ error: 'Storage not configured' });
  }

  const folderSessionId = sanitizeUploadId(request.params.folderSessionId);
  if (!folderSessionId) {
    return { success: true };
  }

  await fs.promises.rm(getStageDir(folderSessionId), { recursive: true, force: true }).catch(() => { });
  return { success: true };
});

fastify.get('/files/:id', async (request, reply) => {
  if (!isStorageConfigured) {
    return reply.status(400).send({ error: 'Storage not configured' });
  }

  const fileId = path.basename(request.params.id);
  const filePath = path.join(storageRoot(), fileId);
  const stats = await fs.promises.stat(filePath).catch(() => null);
  if (!stats?.isFile()) {
    return reply.status(404).send({ error: 'File not found' });
  }

  const originalName = fileId.split('_').slice(1).join('_') || fileId;
  const disposition = request.query.preview === 'true' ? 'inline' : 'attachment';
  return sendFileResponse(request, reply, filePath, originalName, {
    disposition,
    mimeType: guessMimeType(originalName)
  });
});

fastify.get('/api/extract/:id', async (request, reply) => {
  if (!isStorageConfigured) {
    return reply.status(400).send({ error: 'Storage not configured' });
  }

  const fileId = path.basename(request.params.id);
  const filePath = path.join(storageRoot(), fileId);
  const stats = await fs.promises.stat(filePath).catch(() => null);
  if (!stats) {
    return reply.status(404).send({ error: 'File not found' });
  }

  if (stats.isDirectory()) {
    try {
      const originalName = fileId.split('_').slice(1).join('_') || 'folder';
      const job = await prepareFolderZip(fileId, filePath);
      return sendFileResponse(request, reply, job.zipPath, `${originalName}.zip`, {
        disposition: 'attachment',
        mimeType: 'application/zip'
      });
    } catch (err) {
      return reply.status(500).send({ error: err.message || 'Could not prepare folder download' });
    }
  }

  if (stats.size > 500 * 1024 * 1024) {
    return reply.status(400).send({ error: 'ZIP extract is limited to 500MB source files' });
  }

  try {
    const zip = new AdmZip(filePath);
    const zipEntries = zip.getEntries();
    const validEntries = zipEntries.filter(entry => !entry.isDirectory && !entry.entryName.includes('__MACOSX/'));

    let totalUncompressedSize = 0;
    for (const entry of validEntries) {
      totalUncompressedSize += entry.header.size;
    }

    if (totalUncompressedSize > 500 * 1024 * 1024) {
      return reply.status(400).send({ error: 'ZIP extract is limited to 500MB uncompressed data' });
    }

    if (validEntries.length === 0) {
      return reply.status(400).send({ error: 'ZIP file is empty' });
    }

    if (validEntries.length === 1) {
      const entry = validEntries[0];
      const buffer = entry.getData();
      const fileName = sanitizeFileName(path.basename(entry.entryName));
      reply.header('Content-Disposition', safeContentDisposition(fileName, 'attachment'));
      reply.header('Content-Length', buffer.length);
      reply.type(guessMimeType(fileName));
      return reply.send(buffer);
    }

    const rootNames = new Set(validEntries.map(entry => entry.entryName.split('/')[0]).filter(Boolean));
    if (rootNames.size === 1) {
      const originalName = fileId.split('_').slice(1).join('_') || fileId;
      return sendFileResponse(request, reply, filePath, originalName, {
        disposition: 'attachment',
        mimeType: 'application/zip'
      });
    }

    const baseName = sanitizeDisplaySegment((fileId.split('_').slice(1).join('_') || 'archive').replace(/\.zip$/i, ''));
    const repackedZip = new AdmZip();

    for (const entry of validEntries) {
      const safeEntryName = sanitizeRelativePath(entry.entryName);
      if (!safeEntryName) continue;
      repackedZip.addFile(`${baseName}/${safeEntryName}`, entry.getData());
    }

    const zipBuffer = repackedZip.toBuffer();
    reply.header('Content-Disposition', safeContentDisposition(`${baseName}.zip`, 'attachment'));
    reply.header('Content-Length', zipBuffer.length);
    reply.type('application/zip');
    return reply.send(zipBuffer);
  } catch (err) {
    return reply.status(500).send({ error: err.message || 'Could not extract ZIP file' });
  }
});

fastify.delete('/api/files/:id', {
  preHandler: fastify.verifyAdmin,
  schema: {
    params: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 }
      },
      required: ['id'],
      additionalProperties: false
    },
    response: {
      200: successSchema,
      400: errorSchema,
      401: errorSchema,
      404: errorSchema
    }
  }
}, async (request, reply) => {
  if (!isStorageConfigured) {
    return reply.status(400).send({ error: 'Storage not configured' });
  }

  const fileId = path.basename(request.params.id);
  const filePath = path.join(storageRoot(), fileId);
  const stats = await fs.promises.stat(filePath).catch(() => null);
  if (!stats) {
    return reply.status(404).send({ error: 'File not found' });
  }

  if (stats.isDirectory()) {
    await fs.promises.rm(filePath, { recursive: true, force: true });
    await cleanupFolderZip(fileId);
  } else {
    await fs.promises.unlink(filePath);
  }

  filesCache = filesCache.filter(record => record.id !== fileId);
  fastify.io.emit('file-deleted', fileId);
  return { success: true };
});

fastify.post('/api/shutdown', {
  preHandler: fastify.verifyAdmin,
  schema: {
    response: {
      200: successSchema,
      401: errorSchema
    }
  }
}, async (_request, reply) => {
  reply.send({ success: true });
  setTimeout(async () => {
    if (storagePath) {
      try {
        await fs.promises.rm(storageRoot(), { recursive: true, force: true }).catch(() => { });
      } catch (err) {
        console.error('Error deleting files:', err);
      }
    }
    console.log('Server cleaned up and terminating.');
    process.exit(0);
  }, 1000);
});

setInterval(async () => {
  if (!storagePath) return;

  const tmp = tempRoot();
  const stage = stagingRoot();
  const now = Date.now();

  const cleanupChildren = async (dirPath, allowed = new Set()) => {
    if (!(await statIfExists(dirPath))) return;
    const entries = await fs.promises.readdir(dirPath).catch(() => []);
    for (const entry of entries) {
      if (allowed.has(entry)) continue;
      const entryPath = path.join(dirPath, entry);
      const stats = await fs.promises.stat(entryPath).catch(() => null);
      if (stats && (now - stats.mtimeMs > CLEANUP_AGE_MS)) {
        await fs.promises.rm(entryPath, { recursive: true, force: true }).catch(() => { });
      }
    }
  };

  await cleanupChildren(tmp, new Set([COMPLETED_SUBDIR, DOWNLOAD_CACHE_SUBDIR]));
  await cleanupChildren(stage);

  const completed = completedRoot();
  if (completed && await statIfExists(completed)) {
    const markerFiles = await fs.promises.readdir(completed).catch(() => []);
    for (const markerFile of markerFiles) {
      const markerPath = path.join(completed, markerFile);
      const stats = await fs.promises.stat(markerPath).catch(() => null);
      if (stats && (now - stats.mtimeMs > CLEANUP_AGE_MS)) {
        await fs.promises.rm(markerPath, { force: true }).catch(() => { });
      }
    }
  }

  const downloadCache = downloadCacheRoot();
  if (downloadCache && await statIfExists(downloadCache)) {
    for (const [fileId, job] of folderZipJobs.entries()) {
      if (job.promise) continue;
      if (job.expiresAt && job.expiresAt < now) {
        await cleanupFolderZip(fileId);
      }
    }

    const cachedFiles = await fs.promises.readdir(downloadCache).catch(() => []);
    for (const zipFile of cachedFiles) {
      const zipPath = path.join(downloadCache, zipFile);
      const stats = await fs.promises.stat(zipPath).catch(() => null);
      if (stats && (now - stats.mtimeMs > ZIP_CACHE_AGE_MS)) {
        await fs.promises.rm(zipPath, { force: true }).catch(() => { });
      }
    }
  }
}, 60 * 60 * 1000);

const start = async () => {
  const net = await import('net');

  function isPortFree(port) {
    return new Promise(resolve => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      server.listen(port, '0.0.0.0');
    });
  }

  let actualPort = PORT;
  while (!(await isPortFree(actualPort))) {
    console.warn(`Port ${actualPort} is busy, trying ${actualPort + 1}...`);
    actualPort++;
    if (actualPort > 3999) {
      console.error('No available port found between 3000 and 3999. Exiting.');
      process.exit(1);
    }
  }

  try {
    await fastify.listen({ port: actualPort, host: '0.0.0.0' });
    const networkIp = getNetworkIp();

    console.log('\nSERVER STARTED SUCCESSFULLY (Bun + Fastify)');
    console.log('=================================================');
    console.log(`Web interface: http://localhost:${actualPort}`);
    console.log(`LAN access URL: http://${networkIp}:${actualPort}`);
    console.log('=================================================\n');

    if (networkIp && networkIp !== 'localhost') {
      console.log('QR Code for LAN access:');
      displayQr(`http://${networkIp}:${actualPort}`, 'Access from mobile devices');
    }
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

start();
