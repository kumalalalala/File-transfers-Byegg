# File Transfer Server - Local Network Setup Guide

![Node.js](https://img.shields.io/badge/Node.js->=18.0.0-brightgreen?logo=node.js)
*Self-hosted file transfer solution for local networks with admin-controlled temporary storage*

---

## 🛠️ Installation

### Prerequisites

* **Node.js v18.0.0 or higher** is required.
* Install Node.js using either:

  * The installer included in this repository (`node-installer.exe`), **OR**
  * The [official Node.js installer](https://nodejs.org)

Verify installation:

```bash
node -v && npm -v
```

### Setup Process

1. **Clone the Repository**
   Clone the repository to your local machine.

2. **Install Dependencies**
   Run the initialization script to install all required packages:

   ```bat
   Run this first.bat
   ```

   *This executes `npm install` and configures core dependencies.*

3. **Launch the Application**
   Start the server with:

   ```bat
   TransferByegg.exe
   ```

   The terminal will display access URLs upon successful startup.

---

## ⚙️ Admin Configuration (Required)

### Access Admin Panel

* Open in your browser:

```http
http://localhost:3000
```

*This interface is only accessible from the host machine.*

### Critical Setup Steps

1. **Configure Temporary Storage Path**

   * Enter a **dedicated directory path** for temporary file storage (e.g., `C:\FileTransfer\temp`)
   * ⚠️ **Requirements**:

     * Ensure the drive has **sufficient free space** (10GB+ recommended)
     * Path **must exist** and have **write permissions**
     * *LAN access will be blocked until this is configured*

2. **Safe Shutdown Procedure**

   * Always use the **red "Shutdown & Clean" button** at the bottom of the admin panel to:

     * Gracefully stop servers
     * **Delete all temporary files permanently**
   * ❗ **Do not close the terminal directly** – this will leave uploaded files undeleted, causing:

     * Disk space bloat
     * Potential security risks
     * System performance degradation

💡 **Note**: The Admin panel (`localhost:3000`) also supports file transfers just like the LAN interface.

---

## 🌐 LAN Access for Users

### Shareable URL

Provide users on the same LAN with this link:

```
http://<your-local-IP>:3000
```
```
Or simply **scan the QR code displayed in the terminal** for quick access.
```
*(Replace `<your-local-IP>` with your machine's LAN IP, e.g., `http://192.168.1.10:3000`)*

### Access Requirements

* LAN users can only connect after:

  1. Admin panel configuration is complete
  2. Temporary storage path is validated
  3. Server is running via `TransferByegg.exe`

---

## 🔒 Best Practices

| Action                 | Recommended Method                    | Risk if Ignored                        |
| ---------------------- | ------------------------------------- | -------------------------------------- |
| **Stopping Server**    | Use the red "Shutdown & Clean" button | Disk space exhaustion & leftover files |
| **Storage Management** | Use a dedicated high-capacity drive   | System slowdown & fragmented storage   |
| **LAN Deployment**     | Ensure firewall allows port 3000      | Network connection failures            |

---

## ❓ Troubleshooting

* **Page not loading on LAN devices?**
  → Ensure storage path is configured in Admin panel
  → Check firewall (allow port `3000` on `Private` networks)

* **Temporary files not deleted?**
  → Always use the shutdown button – never just close the terminal

* **Insufficient storage warnings?**
  → Free up space in the temp directory or reconfigure path

ℹ️ *The Admin panel (`localhost:3000`) remains fully functional for file transfers even after LAN setup.*

---

## 📖 Recommended Workflow

1. Install Node.js (v18+).
2. Clone repository.
3. Run `Run this first.bat` to install dependencies.
4. Run `TransferByegg.exe` to start the application.
5. Open `http://localhost:3000` and set the temp storage path.
6. Share `http://<your-ip>:3000` or QR code with LAN users.
7. Use the Admin panel’s red button to stop the server & delete files.

---

## 🔐 Security Considerations

* Share `http://<your-ip>:3000` **only with trusted LAN users**.
* Do not expose the service to the public internet without:

  * Authentication
  * TLS/HTTPS

---

## 🤝 Contributing

* Open PRs for documentation or bug fixes.
* Keep changes focused and tested.

---

© 2025 File Transfer Server. Optimized for Windows environments. For support, contact your system administrator.
