// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const qrcode = require('qrcode-terminal');
const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = 3000;
let storagePath = null;
let upload = null;
let isStorageConfigured = false;
let files = [];

// THÊM MỚI: Utility function để lấy địa chỉ IP mạng cho việc chia sẻ
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

// THÊM MỚI: Hàm helper để hiển thị QR code với xử lý lỗi đầy đủ
function displayQr(url, description) {
  try {
    qrcode.generate(url, { small: true });
    console.log(`Scan this QR to open: ${url}`);
    console.log(`(${description})`);
  } catch (err) {
    console.error('Failed to generate QR code:', err && err.message ? err.message : err);
  }
}

// THÊM MỚI: Hàm kiểm tra quyền admin
function isAdminReq(req) {
  const host = req.hostname || req.headers.host || '';
  const clientIp = req.ip || req.connection.remoteAddress || '';
  return (host === 'localhost' || host.startsWith('127.0.0.1')) ||
         (clientIp === '127.0.0.1' || clientIp === '::1');
}

// THÊM MỚI: Khởi tạo multer chỉ sau khi đường dẫn lưu trữ được thiết lập
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

// THÊM MỚI: Tải danh sách file hiện có từ thư mục luutam
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
  // Sắp xếp file mới nhất lên trước theo thời gian sửa đổi
  list.sort((a, b) => b.mtime - a.mtime);
  // Loại bỏ trường mtime trước khi lưu trữ
  files = list.map(f => ({
    name: f.name,
    size: f.size,
    time: f.time
  }));
}

// THÊM MỚI: Middleware & thư mục tĩnh
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// THÊM MỚI: API kiểm tra trạng thái
app.get('/api/status', (req, res) => {
  res.json({
    storageConfigured: !!isStorageConfigured,
    isAdmin: isAdminReq(req),
    files
  });
});

// THÊM MỚI: API danh sách file
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

// THÊM MỚI: API thiết lập đường dẫn lưu trữ (chỉ admin)
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

// THÊM MỚI: Endpoint upload file
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

// THÊM MỚI: API upload file
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

// THÊM MỚI: Endpoint tải xuống
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

// THÊM MỚI: API shutdown (chỉ admin)
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

// THÊM MỚI: Trang chủ
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// THÊM MỚI: Socket.IO
io.on('connection', (socket) => {
  socket.emit('file-updated', files);
  socket.emit('files-uploaded', files);
});

// THÊM MỚI: Khởi động server với thông báo chi tiết và QR code cho LAN
server.listen(PORT, () => {
  const networkIp = getNetworkIp();
  
  console.log(`\n🎉🎉🎉 SERVER STARTED SUCCESSFULLY 🎉🎉🎉`);
  console.log(`=================================================`);
  console.log(`✅ Admin panel is available at: http://localhost:${PORT}`);
  console.log(`✅ Share this URL with other devices on your network: http://${networkIp}:${PORT}`);
  console.log(`=================================================\n`);
  
  // Chỉ hiển thị QR cho LAN nếu có địa chỉ mạng hợp lệ
  if (networkIp && networkIp !== 'localhost') {
    console.log('📱 QR Code for LAN access (for other devices on your network):');
    displayQr(`http://${networkIp}:${PORT}`, 'Truy cập từ các thiết bị khác trong mạng');
  } else {
    console.log('\n⚠️  Không tìm thấy địa chỉ mạng hợp lệ để tạo QR code');
    console.log('   Bạn chỉ có thể truy cập qua localhost (http://localhost:3000)');
    console.log('   Đảm bảo bạn đang kết nối với mạng có địa chỉ IP hợp lệ');
  }
  
  console.log('\n💡 Mẹo: Quét mã QR bằng camera điện thoại để truy cập nhanh');
  console.log('💡 Tip: Scan the QR code with your phone camera for quick access');
  console.log('⚠️ Lưu ý: Nếu không thấy mã QR, hãy sao chép URL và dán vào trình duyệt');
  console.log('⚠️ Note: If you dont see the QR code, copy the URL and paste it into your browser');
});