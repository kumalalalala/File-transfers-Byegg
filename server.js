import fs from 'fs';
import path from 'path';
import os from 'os';
import { pipeline } from 'stream/promises';
import { v4 as uuidv4 } from 'uuid';
import qrcode from 'qrcode-terminal';
import Fastify from 'fastify';
import indexHtml from './public/index.html' with { type: 'text' };
import manifestJson from './public/manifest.json' with { type: 'text' };
import swJs from './public/sw.js' with { type: 'text' };
import fastifyMultipart from '@fastify/multipart';
import fastifySocketIo from 'fastify-socket.io';
import fastifyCors from '@fastify/cors';
import AdmZip from 'adm-zip';

const fastify = Fastify({ logger: false, bodyLimit: 100 * 1024 * 1024 * 1024 });

const PORT = 3000;
let storagePath = null;
let isStorageConfigured = false;
let filesCache = [];

// Generate a random admin token on startup to prevent Host Header spoofing
const adminToken = uuidv4();

function getNetworkIp() {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const config of iface) {
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

// Authentication Decorator
fastify.decorate('verifyAdmin', (request, reply, done) => {
  const token = request.headers['x-admin-token'];
  if (token !== adminToken) {
    return reply.status(401).send({ error: 'Unauthorized. Invalid admin token.' });
  }
  done();
});

// Load existing files
async function loadExistingFiles() {
  filesCache = [];
  if (!storagePath) return;
  const luutamPath = path.join(storagePath, 'luutam');
  if (!fs.existsSync(luutamPath)) return;

  const filesList = await fs.promises.readdir(luutamPath);
  const metadataPromises = filesList.map(async (filename) => {
    const filePath = path.join(luutamPath, filename);
    const stats = await fs.promises.stat(filePath);
    if (stats.isFile()) {
      return {
        id: filename,
        name: filename.split('_').slice(1).join('_') || filename,
        size: stats.size,
        timestamp: stats.mtime.toISOString(),
        mtime: stats.mtime.getTime()
      };
    }
    return null;
  });

  const results = await Promise.all(metadataPromises);
  filesCache = results.filter(f => f !== null).sort((a, b) => b.mtime - a.mtime).map(({ mtime, ...rest }) => rest);
}

// Register plugins
fastify.register(fastifyCors, { origin: '*' });

// Serve embedded static assets directly from memory (Standalone EXE support)
fastify.get('/', async (request, reply) => {
  reply.header('Cache-Control', 'no-store, max-age=0');
  reply.type('text/html');
  return reply.send(indexHtml);
});

fastify.get('/index.html', async (request, reply) => {
  reply.header('Cache-Control', 'no-store, max-age=0');
  reply.type('text/html');
  return reply.send(indexHtml);
});

fastify.get('/manifest.json', async (request, reply) => {
  reply.header('Cache-Control', 'no-store, max-age=0');
  reply.type('application/json');
  return reply.send(manifestJson);
});

fastify.get('/sw.js', async (request, reply) => {
  reply.header('Cache-Control', 'no-store, max-age=0');
  reply.type('application/javascript');
  return reply.send(swJs);
});

fastify.register(fastifyMultipart, {
  limits: {
    fileSize: 100 * 1024 * 1024 * 1024 // 100GB limit
  }
});

fastify.register(fastifySocketIo, {
  cors: { origin: '*' }
});

fastify.ready(err => {
  if (err) throw err;
  fastify.io.on('connection', (socket) => {
    socket.emit('file-updated', filesCache);
  });
});

// API Routes

// Status API
fastify.get('/api/status', async (request, reply) => {
  return {
    storageConfigured: isStorageConfigured,
    files: filesCache
  };
});

// Set Storage (Admin)
fastify.post('/api/set-storage', { preHandler: fastify.verifyAdmin }, async (request, reply) => {
  const { path: storage } = request.body;
  if (!storage) {
    return reply.status(400).send({ error: 'Path is required' });
  }

  const resolvedPath = path.resolve(storage);

  if (!fs.existsSync(resolvedPath)) {
    await fs.promises.mkdir(resolvedPath, { recursive: true });
  }
  const luutamPath = path.join(resolvedPath, 'luutam');
  if (!fs.existsSync(luutamPath)) {
    await fs.promises.mkdir(luutamPath, { recursive: true });
  }

  storagePath = resolvedPath;
  isStorageConfigured = true;
  await loadExistingFiles();
  return { success: true, files: filesCache };
});

// Fast hash calculation for deduplication (Fallback from Crypto to Manual 32-bit checksum for HTTP LAN safety)
function simpleChecksum(buffer) {
  let hash = 0;
  for (let i = 0; i < buffer.length; i++) {
    hash = Math.imul(31, hash) + buffer[i] | 0;
  }
  return hash.toString(16);
}

async function calculateFastHash(filePath, size) {
  let fd;
  try {
    fd = await fs.promises.open(filePath, 'r');
    const chunkSize = 100 * 1024; // 100KB is super fast and enough
    const buf1 = Buffer.alloc(Math.min(chunkSize, size));
    await fd.read(buf1, 0, buf1.length, 0);
    const buf2 = Buffer.alloc(Math.min(chunkSize, size));
    if (size > chunkSize) {
      await fd.read(buf2, 0, buf2.length, size - chunkSize);
    }
    const hash1 = simpleChecksum(buf1);
    const hash2 = simpleChecksum(buf2);
    return size + '_' + hash1 + '_' + hash2;
  } catch (e) {
    return null;
  } finally {
    if (fd) await fd.close().catch(() => { });
  }
}

// Check Deduplication
fastify.get('/api/upload/check', async (request, reply) => {
  if (!isStorageConfigured) return reply.status(400).send({ error: 'Storage not configured' });
  const { hash, fileName } = request.query;
  if (!hash) return { exists: false };

  for (const f of filesCache) {
    if (!f.hash) {
      f.hash = await calculateFastHash(path.join(storagePath, 'luutam', f.id), f.size);
    }
    if (f.hash === hash) {
      // Deduplicate using Hardlink
      const safeFilename = fileName.replace(/[/\\?%*:|"<>]/g, '-');
      const uniqueName = uuidv4() + '_' + safeFilename;
      const finalPath = path.join(storagePath, 'luutam', uniqueName);
      const srcPath = path.join(storagePath, 'luutam', f.id);

      try {
        await fs.promises.link(srcPath, finalPath);

        const stats = await fs.promises.stat(finalPath);
        const newFile = {
          id: uniqueName,
          name: fileName,
          size: stats.size,
          timestamp: stats.mtime.toISOString(),
          hash: hash
        };
        filesCache.unshift(newFile);
        fastify.io.emit('file-added', newFile);
        return { exists: true, newFile };
      } catch (e) {
        return { exists: false };
      }
    }
  }
  return { exists: false };
});

// Status for resumé uploads
fastify.get('/api/upload/status/:fileId', async (request, reply) => {
  if (!isStorageConfigured) return reply.status(400).send({ error: 'Storage not configured' });
  const fileId = request.params.fileId;
  if (!fileId) return { uploadedChunks: [] };
  const safeFileId = path.basename(fileId).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeFileId) return { uploadedChunks: [] };
  const tmpDir = path.join(storagePath, 'luutam', '.tmp', safeFileId);

  if (!fs.existsSync(tmpDir)) return { uploadedChunks: [] };
  try {
    const files = await fs.promises.readdir(tmpDir);
    const uploadedChunks = files
      .filter(f => f.startsWith('chunk_'))
      .map(f => parseInt(f.replace('chunk_', ''), 10))
      .filter(n => !isNaN(n));
    return { uploadedChunks };
  } catch (e) { return { uploadedChunks: [] }; }
});

// Upload chunk
fastify.post('/api/upload/chunk', async (request, reply) => {
  if (!isStorageConfigured) return reply.status(400).send({ error: 'Storage not configured' });

  const parts = request.parts();
  let fileId = '', chunkIndex = -1;
  let chunkStream = null;

  for await (const part of parts) {
    if (part.type === 'field') {
      if (part.fieldname === 'fileId') fileId = part.value;
      if (part.fieldname === 'chunkIndex') chunkIndex = parseInt(part.value, 10);
    } else if (part.type === 'file') {
      if (!fileId) continue;
      const safeFileId = path.basename(fileId).replace(/[^a-zA-Z0-9_-]/g, '');
      if (!safeFileId) continue;
      const tmpDir = path.join(storagePath, 'luutam', '.tmp', safeFileId);
      if (!fs.existsSync(tmpDir)) {
        await fs.promises.mkdir(tmpDir, { recursive: true }).catch(() => { });
      }
      const chunkPath = path.join(tmpDir, `chunk_${chunkIndex}`);
      // Natively pipe the stream to disk without bloating RAM ArrayBuffers (OOM Protection for chunks arbitrarily inflated by hackers)
      const writeStream = fs.createWriteStream(chunkPath);
      await pipeline(part.file, writeStream);
    }
  }
  return { success: true };
});

// Merge chunks
fastify.post('/api/upload/merge', async (request, reply) => {
  if (!isStorageConfigured) return reply.status(400).send({ error: 'Storage not configured' });

  const body = (typeof request.body === 'string') ? JSON.parse(request.body) : request.body;
  const { fileId, fileName, totalChunks } = body;

  if (!fileId || !fileName || totalChunks == null) return reply.status(400).send({ error: 'Invalid config' });

  const safeFileId = path.basename(fileId).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeFileId) return reply.status(400).send({ error: 'Invalid fileId' });

  const tmpDir = path.join(storagePath, 'luutam', '.tmp', safeFileId);

  if (!fs.existsSync(tmpDir)) return reply.status(400).send({ error: 'Chunks not found' });

  const safeFilename = fileName.replace(/[/\\?%*:|"<>]/g, '-');
  const uniqueName = uuidv4() + '_' + safeFilename;
  const finalPath = path.join(storagePath, 'luutam', uniqueName);

  try {
    await Bun.write(finalPath, ''); // Ensure file exists
    const fd = await fs.promises.open(finalPath, 'a');

    try {
      for (let i = 0; i < totalChunks; i++) {
        const chunkPath = path.join(tmpDir, `chunk_${i}`);
        if (!fs.existsSync(chunkPath)) {
          throw new Error(`Missing chunk ${i}`);
        }

        const chunkBuffer = await fs.promises.readFile(chunkPath);
        await fd.appendFile(chunkBuffer);
      }
    } finally {
      await fd.close().catch(() => { });
    }

    // Cleanup tmp dir
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => { });

    const stats = await fs.promises.stat(finalPath);
    const newFile = {
      id: uniqueName,
      name: fileName,
      size: stats.size,
      timestamp: stats.mtime.toISOString(),
    };

    filesCache.unshift(newFile);
    fastify.io.emit('file-added', newFile);

    return { success: true, file: newFile };
  } catch (err) {
    if (fs.existsSync(finalPath)) await fs.promises.unlink(finalPath).catch(() => { });
    request.log.error('Merge error:', err);
    const code = err.message.includes('Missing chunk') ? 400 : 500;
    return reply.status(code).send({ error: err.message || 'Merge failed.' });
  }
});

// Cancel Upload (Clean tmp chunks)
fastify.delete('/api/upload/cancel/:fileId', async (request, reply) => {
  if (!isStorageConfigured) return reply.status(400).send({ error: 'Storage not configured' });
  const safeFileId = path.basename(request.params.fileId).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeFileId) return { success: true };
  const tmpDir = path.join(storagePath, 'luutam', '.tmp', safeFileId);
  if (fs.existsSync(tmpDir)) {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => { });
  }
  return { success: true };
});

// Download File / Preview Media (Automatic Range handling by Fastify/Bun)
fastify.get('/files/:id', async (request, reply) => {
  if (!isStorageConfigured) return reply.status(400).send({ error: 'Storage not configured' });

  const fileId = path.basename(request.params.id);
  const filePath = path.join(storagePath, 'luutam', fileId);
  if (!fs.existsSync(filePath)) return reply.status(404).send({ error: 'File not found' });

  const stats = fs.statSync(filePath);
  const originalName = fileId.split('_').slice(1).join('_');

  // Fast mime determination
  let mimeType = 'application/octet-stream';
  if (originalName.match(/\.mp4$/i)) mimeType = 'video/mp4';
  else if (originalName.match(/\.webm$/i)) mimeType = 'video/webm';
  else if (originalName.match(/\.mp3$/i)) mimeType = 'audio/mpeg';
  else if (originalName.match(/\.wav$/i)) mimeType = 'audio/wav';
  else if (originalName.match(/\.(jpg|jpeg)$/i)) mimeType = 'image/jpeg';
  else if (originalName.match(/\.png$/i)) mimeType = 'image/png';

  const range = request.headers.range;
  const isPreview = request.query.preview === 'true';

  reply.header('Accept-Ranges', 'bytes');

  if (range && isPreview) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
    const chunksize = (end - start) + 1;

    const fileStream = fs.createReadStream(filePath, { start, end });
    reply.status(206);
    reply.header('Content-Range', `bytes ${start}-${end}/${stats.size}`);
    reply.header('Content-Length', chunksize);
    reply.type(mimeType);
    return reply.send(fileStream);
  } else {
    reply.header('Content-Length', stats.size);
    if (isPreview) {
      reply.type(mimeType);
      reply.header('Content-Disposition', `inline; filename="${encodeURIComponent(originalName)}"`);
    } else {
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(originalName)}"`);
    }
    return reply.send(fs.createReadStream(filePath));
  }
});

// Extract and Download ZIP
fastify.get('/api/extract/:id', async (request, reply) => {
  if (!isStorageConfigured) return reply.status(400).send({ error: 'Storage not configured' });
  const fileId = path.basename(request.params.id);
  const filePath = path.join(storagePath, 'luutam', fileId);
  if (!fs.existsSync(filePath)) return reply.status(404).send({ error: 'File not found' });

  const stats = fs.statSync(filePath);
  // Prevent OOM by limiting dynamic zip repackaging to files < 500MB
  if (stats.size > 500 * 1024 * 1024) {
    return reply.status(400).send('Cảnh báo: Tệp tin gốc quá lớn (>500MB). Vui lòng Download trực tiếp để bảo vệ RAM máy chủ!');
  }

  try {
    const zip = new AdmZip(filePath);
    const zipEntries = zip.getEntries();

    // Thường ZIP trên macOS có dính __MACOSX tàng hình
    const validEntries = zipEntries.filter(e => !e.isDirectory && !e.entryName.includes('__MACOSX/'));

    // ZERO-DAY PATCH: Limit uncompressed dynamic RAM allocation to 500MB (OOM Bomb protection)
    let totalUncompressedSize = 0;
    for (const e of validEntries) {
      totalUncompressedSize += e.header.size;
    }
    if (totalUncompressedSize > 500 * 1024 * 1024) {
      return reply.status(400).send('Phát hiện Mã độc Zip Bomb: Lượng dữ liệu thực tế bên trong ZIP vượt mức 500MB tàn phá RAM máy chủ! Tiến trình giải nén Web bị kịch hoạt hủy bỏ.');
    }

    if (validEntries.length === 0) return reply.status(400).send('Tệp ZIP trống.');

    if (validEntries.length === 1) {
      // Chứa duy nhất 1 file: Tải duy nhất file đó (như phim, mp3)
      const entry = validEntries[0];
      const buffer = entry.getData();
      const fileName = path.basename(entry.entryName);
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
      reply.header('Content-Length', buffer.length);
      let mimeType = 'application/octet-stream';
      if (fileName.match(/\.mp4$/i)) mimeType = 'video/mp4';
      else if (fileName.match(/\.(jpg|jpeg)$/i)) mimeType = 'image/jpeg';
      else if (fileName.match(/\.png$/i)) mimeType = 'image/png';
      else if (fileName.match(/\.mp3$/i)) mimeType = 'audio/mpeg';
      reply.type(mimeType);
      return reply.send(buffer);
    } else {
      // Chứa nhiều file/folder:
      const rootPaths = new Set(validEntries.map(e => e.entryName.split('/')[0]));
      if (rootPaths.size === 1) {
        // ZIP gáy đỏ (Đã nằm chung 1 thư mục gốc) -> Gửi lại file nguyên bản
        const originalName = fileId.split('_').slice(1).join('_');
        reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(originalName)}"`);
        reply.header('Content-Length', stats.size);
        return reply.send(fs.createReadStream(filePath));
      } else {
        // Tệp bị vứt lung tung -> Repackage vào 1 thư mục mẹ
        const baseName = fileId.split('_').slice(1).join('_').replace(/\.zip$/i, '');
        const newZip = new AdmZip();
        for (const entry of validEntries) {
          newZip.addFile(`${baseName}/${entry.entryName}`, entry.getData());
        }
        const zipBuffer = newZip.toBuffer();
        reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(baseName + '.zip')}"`);
        reply.header('Content-Length', zipBuffer.length);
        reply.type('application/zip');
        return reply.send(zipBuffer);
      }
    }
  } catch (err) {
    request.log.error('Extract error:', err);
    return reply.status(500).send('Không thể giải nén file ZIP này. Xin tải chay!');
  }
});

// Delete Single File (Admin)
fastify.delete('/api/files/:id', { preHandler: fastify.verifyAdmin }, async (request, reply) => {
  if (!isStorageConfigured) return reply.status(400).send({ error: 'Storage not configured' });

  const fileId = path.basename(request.params.id);
  const filePath = path.join(storagePath, 'luutam', fileId);

  if (fs.existsSync(filePath)) {
    await fs.promises.unlink(filePath);
    filesCache = filesCache.filter(f => f.id !== fileId);
    fastify.io.emit('file-deleted', fileId);
    return { success: true };
  }
  return reply.status(404).send({ error: 'File not found' });
});

// Shutdown Server (Admin)
fastify.post('/api/shutdown', { preHandler: fastify.verifyAdmin }, async (request, reply) => {
  reply.send({ success: true });
  setTimeout(async () => {
    if (storagePath) {
      const luutamPath = path.join(storagePath, 'luutam');
      try {
        if (fs.existsSync(luutamPath)) {
          await fs.promises.rm(luutamPath, { recursive: true, force: true });
        }
      } catch (err) {
        console.error('Error deleting files:', err);
      }
    }
    console.log('Server cleaned up and terminating.');
    process.exit(0);
  }, 1000);
});

// Background Cron: Clean orphaned .tmp directories older than 24 hours
setInterval(async () => {
  if (!storagePath) return;
  const tmpDir = path.join(storagePath, 'luutam', '.tmp');
  if (!fs.existsSync(tmpDir)) return;
  try {
    const tmpContents = await fs.promises.readdir(tmpDir);
    const now = Date.now();
    for (const item of tmpContents) {
      const itemPath = path.join(tmpDir, item);
      const stats = await fs.promises.stat(itemPath).catch(() => null);
      if (stats && (now - stats.mtimeMs > 86400000)) { // 24 hours
        await fs.promises.rm(itemPath, { recursive: true, force: true }).catch(() => { });
      }
    }
  } catch (e) { }
}, 60 * 60 * 1000); // 1 hour sweep

const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    const networkIp = getNetworkIp();

    console.log(`\n🎉🎉🎉 SERVER STARTED SUCCESSFULLY (Bun + Fastify) 🎉🎉🎉`);
    console.log(`=================================================`);
    console.log(`✅ Web interface: http://localhost:${PORT}`);
    console.log(`✅ LAN access URL: http://${networkIp}:${PORT}`);
    console.log(`\n🔐 ADMIN ACCESS TOKEN: ${adminToken}`);
    console.log(`   (Paste this token in the UI to manage storage or delete files)`);
    console.log(`=================================================\n`);

    if (networkIp && networkIp !== 'localhost') {
      console.log('📱 QR Code for LAN access:');
      displayQr(`http://${networkIp}:${PORT}`, 'Access from mobile devices');
    }
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
