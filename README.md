# ByeggLAN - Ultimate File Transfer Server

![Bun](https://img.shields.io/badge/Powered%20by-Bun-black?logo=bun)
![Architecture](https://img.shields.io/badge/Architecture-Standalone%20Single%20Binary-blue)

A high-performance, ultra-secure, and elegant self-hosted file transfer solution for local networks. Handcrafted to crush Node.js bottlenecks using **Bun** and **Fastify**, operating as a 100% standalone executable. No dependencies, no installers—just one file.

---

## 🌟 Elite Features

* **📦 Zero-Dependency Single Binary**: Everything (including the HTML/CSS/JS frontend, Service Workers, and APIs) is baked directly into `TransferByegg.exe` (Windows) and `TransferByegg-linux` (Linux).
* **⚡ Concurrent Chunked Uploading**: Slices heavy files (100GB+) into 5MB chunks and streams them via 4 parallel WebWorkers. Maxes out your LAN Gigabit bandwidth without consuming server RAM. 
* **🔄 Infinite Resumability**: Connection dropped? Closed your laptop? The upload mechanism utilizes intelligent browser-fingerprinting (`DeviceID`) to instantly resume EXACTLY where it left off, even days later.
* **🧙‍♂️ FastHash Deduplication**: If two users upload the same 50GB file, the engine samples the file ends to generate an ultra-fast SHA-256 hash. The second user completes the upload in `0.1s` with 0 bytes of disk space wasted (powered by OS Hard-links).
* **🎬 Instant Media Streaming**: Preview massive MP4/WebM videos, MP3s, or high-res images directly in the browser via a sleek overlay modal. Fully supports HTTP `206 Partial Content Range` requests so you can seek through 4K videos smoothly without downloading.
* **🗜️ Dynamic ZIP Extractor**: With a click of a button, extract `.zip` files purely on the server. If it contains a single file, it's streamed uncompressed. If it has heavy folders, it's beautifully repacked into a single safe directory and sent to you instantly.
* **📱 Progressive Web App (PWA)**: Navigate to the LAN IP on your iPhone/Android and click "Add to Homescreen" to install ByeggLAN as a native offline-capable App!
* **🛡️ Admin Host Security**: The Admin settings (Storage path configuration, Global Shutdown, and File Deletion) are strictly hard-locked to the host `localhost` machine. LAN guests only see a beautiful minimalist drop-zone. No "Delete" buttons for guests. Random UUID Admin Tokens block all API spoofing.

---

## 🚀 Quick Start

**No Node.js. No `npm install`. No scripts.**

1. Download the executable for your OS:
   - **Windows:** `TransferByegg.exe`
   - **Linux:** `TransferByegg-linux`
2. Double-click the file (or run `./TransferByegg-linux` in terminal).
3. The server will instantly boot. Open your browser and go to:
   ```http
   http://localhost:3000
   ```
4. Set the internal vault path (where you want files saved on the host computer).
5. Share the generated **LAN IP** or the **QR Code** projected in your terminal to your colleagues!

---

## 🔐 Advanced Security & Admin Console

- **Admin Access Token:** Every time the server starts, a highly secure randomized Token is printed in the Terminal. This token is required for destructive actions (Delete, Change Path, Shutdown).
- **The Red Button:** Always use the Red `Close Website and Delete All Data` button from the `localhost` UI when finishing a session. This triggers a graceful destruction sequence that wipes all cached chunks and shared files, ensuring absolute privacy when closing up.

---

*Engineered for modern Gigabit environments and heavily optimized for 0% event-loop blocking.*
*© 2026 ByeggLAN File Transfer System.*
