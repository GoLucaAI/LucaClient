# LUCA Desktop — Build Guide

## Development (run without installing)

```bash
cd desktop
npm install
npm start
```

## Package for distribution

### Prerequisites
- Node.js 18+
- On **Windows**: Visual Studio Build Tools (for native modules)
- On **macOS**: Xcode Command Line Tools (`xcode-select --install`)
- On **Linux**: `build-essential`, `libx11-dev`, `libxtst-dev`

### Build

```bash
cd desktop
npm install

# Build for your current platform
npm run build:mac      # → dist/LUCA-1.0.0.dmg
npm run build:win      # → dist/LUCA Setup 1.0.0.exe
npm run build:linux    # → dist/LUCA-1.0.0.AppImage
```

### macOS code signing (for distribution outside App Store)

Set these environment variables before building:
```bash
export CSC_LINK="path/to/cert.p12"
export CSC_KEY_PASSWORD="your-cert-password"
export APPLE_ID="your@apple.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"
npm run build:mac
```

### App icons

Replace `assets/` with real icons before distributing:
- `assets/icon.icns` — macOS (1024×1024)
- `assets/icon.ico`  — Windows (256×256)
- `assets/icon.png`  — Linux (512×512)

Use a tool like [electron-icon-builder](https://www.npmjs.com/package/electron-icon-builder):
```bash
npx electron-icon-builder --input=icon-source.png --output=./assets
```

## OS Control — optional enhancement

For **full** mouse and keyboard control (beyond shell commands), install robotjs:
```bash
npm install @jitsi/robotjs
```

Without robotjs, LUCA uses platform shell commands:
- macOS: `cliclick`, `osascript`
- Linux: `xdotool`
- Windows: PowerShell + `System.Windows.Forms`

Install platform tools if needed:
```bash
# macOS
brew install cliclick

# Linux
sudo apt install xdotool
```

## Screenshot — platform dependencies

`screenshot-desktop` calls native tools automatically:
- macOS: built-in `screencapture` ✓
- Linux: requires `scrot` → `sudo apt install scrot`
- Windows: built-in PowerShell ✓

## User data location

Config is stored at:
- macOS:  `~/Library/Application Support/luca-desktop/luca-config.json`
- Windows: `%APPDATA%\luca-desktop\luca-config.json`
- Linux:  `~/.config/luca-desktop/luca-config.json`

To reset / re-run setup, delete `luca-config.json`.

## Architecture

```
main.js   → Electron main process
             ├── Opens setup.html on first run
             ├── Opens dashboard (server URL) in BrowserWindow
             ├── Manages system tray
             ├── Connects to wss://your-server/ws/client
             └── Handles all LUCA commands natively

preload.js → contextBridge between renderer ↔ main
             Safe API exposed to the dashboard page

setup.html → First-run screen: enter server URL + API key
```

## WebSocket protocol

The desktop app speaks the same protocol as `client/client.py`:

| Direction       | Message type        | Purpose                        |
|----------------|---------------------|--------------------------------|
| Client → Server | `client_hello`      | Announce capabilities          |
| Client → Server | `screenshot_data`   | Send screen capture            |
| Client → Server | `command_result`    | Reply to a command             |
| Client → Server | `pong`              | Heartbeat reply                |
| Server → Client | `send_command`      | Execute shell/mouse/keyboard   |
| Server → Client | `request_screenshot`| Take screenshot now            |
| Server → Client | `notification`      | Show OS notification           |
| Server → Client | `ping`              | Heartbeat                      |
