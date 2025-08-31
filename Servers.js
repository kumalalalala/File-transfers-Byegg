// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = 3000;
let storagePath = null;
let upload = null;
let isStorageConfigured = false;
let files = [];

// Utility: get network IP for sharing
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

// Admin check
function isAdminReq(req) {
  const host = req.hostname || req.headers.host || '';
  const clientIp = req.ip || req.connection.remoteAddress || '';
  return (host === 'localhost' || host.startsWith('127.0.0.1')) ||
         (clientIp === '127.0.0.1' || clientIp === '::1');
}

// Initialize multer only after storage path is set
function configureMulter() {
  if (!storagePath) return null;

  const luutamPath = path.join(storagePath, 'luutam');
  if (!fs.existsSync(luutamPath)) {
    fs.mkdirSync(luutamPath, { recursive: true });
  }

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, luutamPath);
    },
    filename: (req, file, cb) => {
      const timestamp = Date.now();
      const originalName = file.originalname;
      cb(null, `${timestamp}-${originalName}`);
    }
  });

  return multer({
    storage,
    limits: { fileSize: 100 * 1024 * 1024 * 1024 } // 100GB
  });
}

// Load existing files from luutam
function loadExistingFiles() {
  files = [];
  if (!storagePath) return;
  const luutamPath = path.join(storagePath, 'luutam');
  if (!fs.existsSync(luutamPath)) return;

  const list = fs.readdirSync(luutamPath)
    .filter(f => fs.statSync(path.join(luutamPath, f)).isFile())
    .map(file => {
      const stats = fs.statSync(path.join(luutamPath, file));
      return {
        name: file,
        size: stats.size,
        time: new Date(stats.mtime).toLocaleTimeString([], {
          hour: '2-digit', minute: '2-digit', second: '2-digit'
        }),
        mtime: stats.mtime
      };
    });

  // sort newest first by modification time
  list.sort((a, b) => b.mtime - a.mtime);

  // drop mtime field before storing
  files = list.map(f => ({
    name: f.name,
    size: f.size,
    time: f.time
  }));
}

// Middleware & static
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// API: status
app.get('/api/status', (req, res) => {
  res.json({
    storageConfigured: !!isStorageConfigured,
    isAdmin: isAdminReq(req),
    files
  });
});

// API: list files
app.get('/api/files', (req, res) => {
  if (!isStorageConfigured) {
    return res.status(400).json({ error: 'Storage not configured' });
  }
  try {
    res.json(files);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: set storage (admin only)
app.post('/api/set-storage', (req, res) => {
  if (!isAdminReq(req)) {
    return res.status(403).json({ error: 'Only localhost can set storage' });
  }

  const { path: storage } = req.body;
  if (!storage) {
    return res.status(400).json({ error: 'Path is required' });
  }

  try {
    if (!fs.existsSync(storage)) {
      fs.mkdirSync(storage, { recursive: true });
    }

    const luutamPath = path.join(storage, 'luutam');
    if (!fs.existsSync(luutamPath)) {
      fs.mkdirSync(luutamPath);
    }

    storagePath = storage;
    upload = configureMulter();
    isStorageConfigured = true;

    loadExistingFiles();

    res.json({ success: true, files });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Upload endpoint
app.post('/upload', (req, res) => {
  if (!isStorageConfigured) {
    return res.status(400).json({ error: 'Storage not configured' });
  }

  if (!upload) upload = configureMulter();

  upload.single('file')(req, res, (err) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    const f = req.file;
    const stats = fs.statSync(f.path);
    const newFile = {
      name: f.filename,
      size: stats.size,
      time: new Date(stats.mtime).toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      })
    };

    files.unshift(newFile);
    io.emit('file-updated', files);
    io.emit('files-uploaded', [newFile]);

    res.json({ success: true, file: newFile });
  });
});

// API upload endpoint
app.post('/api/upload', (req, res) => {
  if (!isStorageConfigured) {
    return res.status(400).json({ error: 'Storage not configured' });
  }

  if (!upload) upload = configureMulter();

  upload.array('files')(req, res, (err) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    const uploaded = (req.files || []).map(file => {
      const stats = fs.statSync(file.path);
      return {
        name: file.filename,
        size: stats.size,
        uploadTime: new Date()
      };
    });

    uploaded.forEach(f => {
      const stats = fs.statSync(path.join(storagePath, 'luutam', f.name));
      files.unshift({
        name: f.name,
        size: f.size,
        time: new Date(stats.mtime).toLocaleTimeString([], {
          hour: '2-digit', minute: '2-digit', second: '2-digit'
        })
      });
    });

    io.emit('files-uploaded', uploaded);
    io.emit('file-updated', files);

    res.json({ success: true, files: uploaded });
  });
});

// Download endpoints
app.get('/api/download/:filename', (req, res) => {
  if (!isStorageConfigured) {
    return res.status(400).json({ error: 'Storage not configured' });
  }
  const filename = req.params.filename;
  const filePath = path.join(storagePath, 'luutam', filename);
  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

app.get('/files/:filename', (req, res) => {
  if (!isStorageConfigured) {
    return res.status(400).send('Storage not configured');
  }
  const filePath = path.join(storagePath, 'luutam', req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }
  res.download(filePath);
});

// Shutdown (admin only)
app.post('/api/shutdown', (req, res) => {
  if (!isAdminReq(req)) {
    return res.status(403).json({ error: 'Only localhost can shutdown' });
  }

  res.json({ success: true });

  setTimeout(() => {
    if (storagePath) {
      const luutamPath = path.join(storagePath, 'luutam');
      try {
        if (fs.existsSync(luutamPath)) {
          fs.rmSync(luutamPath, { recursive: true, force: true });
        }
      } catch (err) {
        console.error('Error deleting files:', err);
      }
    }
    server.close(() => { process.exit(0); });
  }, 1000);
});

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.IO
io.on('connection', (socket) => {
  socket.emit('file-updated', files);
  socket.emit('files-uploaded', files);
});

// Start server
server.listen(PORT, () => {
  const networkIp = getNetworkIp();
  console.log(`🎉 Use this URL to access the admin control panel: http://localhost:${PORT}`);
  console.log(`🎉 Use this URL to access from other devices on the same LAN: http://${networkIp}:${PORT}`);
});
