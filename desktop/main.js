'use strict'
/**
 * LUCA Desktop — Electron main process
 *
 * Opens the LUCA web dashboard directly (same as the browser version).
 * After the user logs in the app fetches a per-user WebSocket token and
 * connects the OS-capability channel (screenshots, shell, mouse/keyboard).
 *
 * Users sign in with their LUCA account. The companion has one connection
 * target and never asks users for a server URL or provider API key.
 */

const {
  app, BrowserWindow, Tray, Menu,
  ipcMain, dialog, globalShortcut,
  Notification, shell, nativeImage,
} = require('electron')

const path    = require('path')
const fs      = require('fs')
const os      = require('os')
const { exec } = require('child_process')
const WebSocket = require('ws')
const https   = require('https')
const http    = require('http')

// ── Auto-updater ──────────────────────────────────────────────────────────────
let autoUpdater = null
try {
  autoUpdater = require('electron-updater').autoUpdater
} catch (_) {
  // electron-updater not installed (dev mode) — updates disabled
}

// ── Optional native OS-control ───────────────────────────────────────────────
let robot = null
try { robot = require('@jitsi/robotjs') } catch (_) {
  try  { robot = require('robotjs')     } catch (_) {}
}

// ── Hosted service ────────────────────────────────────────────────────────────
const DEFAULT_SERVER_URL = 'https://goluca.ai'

function getServerUrl () {
  return DEFAULT_SERVER_URL
}

// ── Safe external URL opener ─────────────────────────────────────────────────
const SAFE_SCHEMES = ['https:', 'http:']
function safeOpenExternal (url) {
  try {
    const p = new URL(url)
    if (SAFE_SCHEMES.includes(p.protocol)) shell.openExternal(url)
  } catch (_) {}
}

// ── State ────────────────────────────────────────────────────────────────────
let mainWindow   = null
let setupWindow  = null
let tray         = null
let ws           = null
let wsReconnectTimer  = null
let screenInterval    = null
let currentWsToken    = null
const CLIENT_ID  = `desktop-${os.hostname()}-${process.platform}`
const PLATFORM   = process.platform

// ── Auto-update setup ─────────────────────────────────────────────────────────
function setupAutoUpdater () {
  if (!autoUpdater) return

  // Point the updater at the server's /api/update/ endpoint dynamically
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: `${getServerUrl()}/api/update`,
  })

  autoUpdater.autoDownload        = true   // download silently in background
  autoUpdater.autoInstallOnAppQuit = true  // install when the user quits

  autoUpdater.on('update-available', (info) => {
    console.log(`[LUCA] Update available: v${info.version}`)
    updateTrayMenuWithUpdate(false, info.version)
    if (Notification.isSupported()) {
      new Notification({
        title: 'LUCA Update Available',
        body:  `v${info.version} is downloading in the background…`,
      }).show()
    }
  })

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[LUCA] Update downloaded: v${info.version}`)
    updateTrayMenuWithUpdate(true, info.version)
    if (Notification.isSupported()) {
      new Notification({
        title: 'LUCA Update Ready',
        body:  `v${info.version} is ready. Restart LUCA to apply it.`,
      }).show()
    }
    // Push a banner into the dashboard
    mainWindow?.webContents.executeJavaScript(`
      window.dispatchEvent(new CustomEvent('luca-update-ready', { detail: ${JSON.stringify({ version: info.version })} }))
    `).catch(() => {})
  })

  autoUpdater.on('error', (err) => {
    const msg = (err.message || '').slice(0, 200)
    console.error('[LUCA] Auto-update error:', msg)
  })

  // Check immediately on launch (with a short delay to let the UI settle),
  // then every 4 hours.
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 10_000)
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000)
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  setupTray()
  registerGlobalShortcut()
  openMainWindow()
  setupAutoUpdater()
})

app.on('window-all-closed', () => {
  // Stay in tray — never quit on window close
})

app.on('before-quit', () => {
  if (ws) { try { ws.close() } catch (_) {} }
  globalShortcut.unregisterAll()
})

app.on('activate', () => {
  if (mainWindow) mainWindow.show()
  else openMainWindow()
})

// ── Main dashboard window ─────────────────────────────────────────────────────
function openMainWindow () {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); return }

  mainWindow = new BrowserWindow({
    width:    1280,
    height:   800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: PLATFORM === 'darwin' ? 'hidden' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#080e1a',
    title: 'LUCA',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: ['--enable-features=MediaStream'],
    },
  })

  if (PLATFORM !== 'darwin') mainWindow.setMenuBarVisibility(false)

  // Load the LUCA dashboard — same URL as the browser version
  mainWindow.loadURL(getServerUrl())

  // Minimise to tray instead of closing
  mainWindow.on('close', (e) => {
    e.preventDefault()
    mainWindow.hide()
    if (Notification.isSupported()) {
      new Notification({
        title: 'LUCA',
        body:  'Still running in the background. Click the tray icon to bring me back.',
      }).show()
    }
  })

  mainWindow.on('closed', () => { mainWindow = null })

  // Grant media permissions (mic/camera for voice mode)
  mainWindow.webContents.session.setPermissionRequestHandler((_, perm, cb) => {
    cb(['media', 'mediaKeySystem', 'notifications', 'clipboard-read'].includes(perm))
  })

  // Open external links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    safeOpenExternal(url)
    return { action: 'deny' }
  })

  // Poll for login state once the page is ready
  mainWindow.webContents.on('did-finish-load', () => {
    pollLoginState()
    // If the OS-capability WS is already open (e.g. page was reloaded while
    // the app was connected) signal the renderer immediately so it never shows
    // the "connect the desktop app" nudge for an already-live connection.
    if (ws && ws.readyState === WebSocket.OPEN) {
      mainWindow.webContents.executeJavaScript(
        `window.dispatchEvent(new CustomEvent('luca-client-ws-open'))`
      ).catch(() => {})
    }
  })

  // ── Connection-failure overlay ─────────────────────────────────────────────
  // If the hosted service can't be reached show a clean retry screen
  // screen instead of a blank dark page.  Error codes -3 (aborted) are
  // navigation cancellations triggered by in-page JS and should be ignored.
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return          // ignore sub-resource failures
    if (errorCode === -3) return      // navigation was cancelled by JS (normal)

    const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>LUCA — Connect</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#080e1a;color:#c9d6e3;font-family:"Courier New",monospace;
       display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  .card{background:#0d1526;border:1px solid #1e3a5f;border-radius:12px;padding:40px 48px;
        max-width:480px;width:100%;text-align:center}
  .hex{font-size:52px;margin-bottom:16px}
  h1{color:#4fb8d4;font-size:22px;margin-bottom:8px;letter-spacing:.05em}
  p{color:#7a92b0;font-size:13px;line-height:1.6;margin-bottom:28px}
  label{display:block;text-align:left;color:#4fb8d4;font-size:11px;
        letter-spacing:.1em;text-transform:uppercase;margin-bottom:6px}
  input{width:100%;background:#080e1a;border:1px solid #1e3a5f;border-radius:6px;
        color:#c9d6e3;font-family:"Courier New",monospace;font-size:14px;
        padding:10px 14px;outline:none;transition:border-color .2s}
  input:focus{border-color:#4fb8d4}
  button{margin-top:16px;width:100%;background:#4fb8d4;color:#000814;border:none;
         border-radius:6px;font-family:"Courier New",monospace;font-weight:bold;
         font-size:14px;padding:12px;cursor:pointer;letter-spacing:.05em;transition:opacity .2s}
  button:hover{opacity:.85}
  .err{margin-top:12px;color:#f87171;font-size:12px;min-height:18px}
  .hint{margin-top:20px;color:#4a6080;font-size:11px}
  .hint a{color:#4fb8d4;cursor:pointer;text-decoration:none}
</style>
</head>
<body>
<div class="card">
  <div class="hex">⬡</div>
  <h1>LUCA</h1>
   <p>Could not reach the hosted LUCA service.<br>Check your internet connection and try again.</p>
   <button id="btn" onclick="connect()">Retry connection</button>
  <div class="err" id="err"></div>
  <div class="hint">Need help? See the <a onclick="window.lucaDesktop && window.lucaDesktop.openExternal('https://goluca.ai')">quick-start guide</a>.</div>
</div>
<script>
  async function connect() {
    const err = document.getElementById('err')
    const btn = document.getElementById('btn')
    btn.textContent = 'Connecting…'
    btn.disabled = true
    err.textContent = ''
     const result = await window.lucaDesktop.retryConnection()
    if (result && result.ok === false) {
       err.textContent = result.error || 'Could not reconnect.'
       btn.textContent = 'Retry connection'
      btn.disabled = false
    }
  }
</script>
</body>
</html>`.replace(/`/g, '\\`')

    mainWindow.webContents.executeJavaScript(`
      document.open();
      document.write(\`${html}\`);
      document.close();
    `).catch(() => {
      // If executeJavaScript fails the window is gone — ignore
    })
  })
}

// ── Detect login and connect WebSocket ───────────────────────────────────────
// After the dashboard page loads we read localStorage for the session token.
// If found we exchange it for a per-user WS token via /auth/client-key,
// then open the OS-capability WebSocket channel.
function pollLoginState () {
  if (!mainWindow) return

  mainWindow.webContents.executeJavaScript(`
    (() => {
      try {
        return localStorage.getItem('luca_token') || '';
      } catch (_) { return ''; }
    })()
  `).then((token) => {
    if (token && token !== currentWsToken) {
      currentWsToken = token
      fetchWsToken(token)
    } else if (!token) {
      // Not logged in yet — check again after 3 s
      setTimeout(pollLoginState, 3000)
    }
  }).catch(() => {
    setTimeout(pollLoginState, 5000)
  })
}

function fetchWsToken (sessionToken) {
  const base   = getServerUrl()
  const parsed = new URL(base)
  const isHttps = parsed.protocol === 'https:'
  const lib    = isHttps ? https : http
  const port   = parsed.port || (isHttps ? 443 : 80)

  const options = {
    hostname: parsed.hostname,
    port,
    path: '/auth/client-key',
    method: 'GET',
    headers: { 'x-auth-token': sessionToken },
    timeout: 10000,
  }

  const req = lib.request(options, (res) => {
    let body = ''
    res.on('data', (d) => { body += d })
    res.on('end', () => {
      try {
        const data = JSON.parse(body)
        if (data.api_key) {
          connectWebSocket(data.api_key)
        }
      } catch (_) {}
    })
  })

  req.on('error', () => {
    setTimeout(() => pollLoginState(), 10000)
  })

  req.on('timeout', () => { req.destroy() })
  req.end()
}

// ── WebSocket — OS capability channel ────────────────────────────────────────
function connectWebSocket (wsToken) {
  if (ws) { try { ws.close() } catch (_) {} }
  clearTimeout(wsReconnectTimer)

  const base  = getServerUrl()
  const wsUrl = base
    .replace(/^https:\/\//, 'wss://')
    .replace(/^http:\/\//, 'ws://')

  ws = new WebSocket(`${wsUrl}/ws/client?api_key=${encodeURIComponent(wsToken)}`)

  ws.on('open', () => {
    updateTrayMenu(true)
    send({
      type: 'client_hello',
      payload: {
        client_id: CLIENT_ID,
        capabilities: {
          has_vision:     true,
          has_voice:      false,
          has_os_control: true,
          platform:       PLATFORM,
          ollama_available: false,
          ollama_models:  [],
        },
      },
    })
    // Notify the renderer immediately — avoids waiting for the server-side
    // /ws/dash broadcast round-trip (which adds 2-8 s of "connect desktop app"
    // nudge even though the user IS on the desktop app).
    mainWindow?.webContents.executeJavaScript(
      `window.dispatchEvent(new CustomEvent('luca-client-ws-open'))`
    ).catch(() => {})
  })

  ws.on('message', async (data) => {
    let msg
    try { msg = JSON.parse(data.toString()) } catch { return }
    await handleServerMessage(msg)
  })

  ws.on('close', () => {
    updateTrayMenu(false)
    // Notify the renderer so it can show "reconnecting…" state immediately
    // instead of waiting for a /ws/dash event that will never arrive.
    mainWindow?.webContents.executeJavaScript(
      `window.dispatchEvent(new CustomEvent('luca-client-ws-close'))`
    ).catch(() => {})
    // Re-check login state in case token expired
    wsReconnectTimer = setTimeout(() => {
      currentWsToken = null
      if (mainWindow) pollLoginState()
    }, 8000)
  })

  ws.on('error', (err) => {
    const safe = (err.message || '').replace(/api_key=[^&\s]*/gi, 'api_key=***')
    console.error('[LUCA] WebSocket error:', safe)
  })
}

function send (obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ ...obj, timestamp: Date.now() / 1000 }))
  }
}

function sendResult (commandId, success, output = '', data = {}) {
  send({
    type: 'command_result',
    payload: { command_id: commandId, success, output, data, timestamp: Date.now() / 1000 },
  })
}

// ── Handle server commands ────────────────────────────────────────────────────
async function handleServerMessage (msg) {
  const { type, payload = {} } = msg

  switch (type) {
    case 'ping':
      send({ type: 'pong', payload: {} })
      break

    case 'server_hello':
      break

    case 'request_screenshot':
      await captureAndSendScreenshot()
      break

    case 'send_command':
      await executeCommand(payload)
      break

    case 'notification': {
      const { title = 'LUCA', body = '' } = payload
      if (Notification.isSupported()) new Notification({ title, body }).show()
      mainWindow?.webContents.executeJavaScript(
        `window.dispatchEvent(new CustomEvent('luca-notification', { detail: ${JSON.stringify({ title, body })} }))`
      ).catch(() => {})
      break
    }

    default:
      break
  }
}

// ── Screenshot ────────────────────────────────────────────────────────────────
async function captureAndSendScreenshot () {
  try {
    const screenshot = require('screenshot-desktop')
    const imgBuffer  = await screenshot({ format: 'jpg' })
    const b64 = imgBuffer.toString('base64')
    send({
      type: 'screenshot_data',
      payload: { image_b64: b64, frame: { image_b64: b64, width: 0, height: 0, timestamp: Date.now() / 1000 } },
    })
  } catch (err) {
    send({ type: 'screenshot_data', payload: { error: String(err.message) } })
  }
}

function stopScreenshotLoop () {
  if (screenInterval) { clearInterval(screenInterval); screenInterval = null }
}

// ── OS command execution ──────────────────────────────────────────────────────
async function executeCommand (payload) {
  const { id: cmdId, type, payload: args = {} } = payload
  if (!cmdId) return

  try {
    switch (type) {
      case 'shell': {
        const cmd     = args.command || ''
        const cwd     = args.cwd || os.homedir()
        const timeout = (args.timeout_seconds || 30) * 1000
        const { success, output } = await runShell(cmd, cwd, timeout)
        sendResult(cmdId, success, output)
        break
      }
      case 'mouse_move': {
        const { x, y } = args
        if (robot) { robot.moveMouse(x, y); sendResult(cmdId, true, `Moved to ${x},${y}`) }
        else await platformMouseMove(cmdId, x, y)
        break
      }
      case 'mouse_click': {
        const { x, y, button = 'left', double = false } = args
        if (robot) {
          robot.moveMouse(x, y); robot.mouseClick(button, double)
          sendResult(cmdId, true, `Clicked ${button} at ${x},${y}`)
        } else await platformMouseClick(cmdId, x, y, button, double)
        break
      }
      case 'mouse_scroll': {
        const { dx = 0, dy = 3 } = args
        if (robot) { robot.scrollMouse(dx, dy); sendResult(cmdId, true, 'Scrolled') }
        else sendResult(cmdId, false, 'Mouse scroll is not available on this system')
        break
      }
      case 'type_text': {
        const { text = '' } = args
        if (robot) { robot.typeString(text); sendResult(cmdId, true, `Typed ${text.length} chars`) }
        else await platformTypeText(cmdId, text)
        break
      }
      case 'key_press': {
        const { key = '', modifiers = [] } = args
        if (robot) { robot.keyTap(key, modifiers); sendResult(cmdId, true, `Key: ${key}`) }
        else sendResult(cmdId, false, 'Key press control is not available on this system')
        break
      }
      case 'screenshot':
      case 'request_screenshot':
        await captureAndSendScreenshot()
        sendResult(cmdId, true, 'Screenshot sent')
        break
      case 'list_windows': {
        const wins = await listWindows()
        sendResult(cmdId, true, JSON.stringify(wins), { windows: wins })
        break
      }
      case 'list_processes': {
        const procs = await listProcesses()
        sendResult(cmdId, true, JSON.stringify(procs), { processes: procs })
        break
      }
      case 'play_audio': {
        const { audio_b64, mime = 'audio/mpeg' } = args
        const SAFE_AUDIO_MIME = /^audio\/(mpeg|ogg|wav|webm|aac|flac|mp4)$/
        const safeMime  = SAFE_AUDIO_MIME.test(mime) ? mime : 'audio/mpeg'
        const audioData = JSON.stringify({ mime: safeMime, audio_b64 })
        mainWindow?.webContents.executeJavaScript(`
          (() => {
            const d = ${audioData};
            const a = new Audio('data:' + d.mime + ';base64,' + d.audio_b64);
            a.play().catch(() => {});
          })()
        `).catch(() => {})
        sendResult(cmdId, true, 'Audio forwarded to dashboard')
        break
      }
      case 'confirm_request': {
        const { message = 'LUCA wants to perform a high-risk action. Approve?' } = args
        mainWindow?.show(); mainWindow?.focus()
        const { response } = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: 'LUCA — Action Confirmation',
          message: 'High-Risk Action',
          detail: message,
          buttons: ['Approve', 'Deny'],
          defaultId: 1,
          cancelId: 1,
        })
        const confirmed = response === 0
        send({ type: 'confirmation', payload: { confirmed } })
        sendResult(cmdId, true, confirmed ? 'Approved' : 'Denied')
        break
      }
      default:
        sendResult(cmdId, false, `Unknown command type: ${type}`)
    }
  } catch (err) {
    sendResult(cmdId, false, String(err.message))
  }
}

// ── Shell helper ──────────────────────────────────────────────────────────────
function runShell (cmd, cwd, timeout) {
  return new Promise((resolve) => {
    const proc = exec(cmd, { cwd, timeout, maxBuffer: 1024 * 1024 * 4 }, (err, stdout, stderr) => {
      const out = [stdout, stderr].filter(Boolean).join('\n').trim()
      resolve({ success: !err, output: out || (err ? String(err.message) : '(no output)') })
    })
    if (proc.stdout) {
      proc.stdout.on('data', (chunk) => {
        send({ type: 'client_event', payload: { event: 'shell_progress', line: chunk.toString(), command: cmd } })
      })
    }
  })
}

// ── Platform mouse / keyboard fallbacks ──────────────────────────────────────
async function platformMouseMove (cmdId, x, y) {
  const ix = Math.round(Number(x)), iy = Math.round(Number(y))
  if (!Number.isFinite(ix) || !Number.isFinite(iy)) {
    sendResult(cmdId, false, 'Invalid coordinates'); return
  }
  if (PLATFORM === 'darwin') {
    await runShell(`cliclick m:${ix},${iy}`, os.homedir(), 5000)
  } else if (PLATFORM === 'linux') {
    await runShell(`xdotool mousemove ${ix} ${iy}`, os.homedir(), 5000)
  } else {
    await runShell(`powershell -c "[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${ix},${iy})"`, os.homedir(), 5000)
  }
  sendResult(cmdId, true, `Moved to ${ix},${iy}`)
}

async function platformMouseClick (cmdId, x, y, button, double) {
  const ix = Math.round(Number(x)), iy = Math.round(Number(y))
  if (!Number.isFinite(ix) || !Number.isFinite(iy)) {
    sendResult(cmdId, false, 'Invalid coordinates'); return
  }
  const btn = button === 'right' ? 3 : 1
  if (PLATFORM === 'darwin') {
    const cmd = double ? `cliclick dc:${ix},${iy}` : `cliclick c:${ix},${iy}`
    await runShell(cmd, os.homedir(), 5000)
  } else if (PLATFORM === 'linux') {
    await runShell(`xdotool mousemove ${ix} ${iy} click ${btn}${double ? ` click ${btn}` : ''}`, os.homedir(), 5000)
  } else {
    const script = `Add-Type -A System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = '${ix},${iy}'; Start-Sleep -m 100; [System.Windows.Forms.SendKeys]::SendWait(' ')`
    await runShell(`powershell -c "${script}"`, os.homedir(), 5000)
  }
  sendResult(cmdId, true, `Clicked at ${ix},${iy}`)
}

async function platformTypeText (cmdId, text) {
  if (PLATFORM === 'darwin') {
    const escaped = text.replace(/'/g, "'\\''").replace(/"/g, '" & quote & "')
    await runShell(`osascript -e 'tell application "System Events" to keystroke "${escaped}"'`, os.homedir(), 5000)
  } else if (PLATFORM === 'linux') {
    const escaped = text.replace(/'/g, "'\\''")
    await runShell(`xdotool type --clearmodifiers '${escaped}'`, os.homedir(), 5000)
  } else {
    const escaped = text.replace(/'/g, "''")
    await runShell(`powershell -c "[System.Windows.Forms.SendKeys]::SendWait('${escaped}')"`, os.homedir(), 5000)
  }
  sendResult(cmdId, true, `Typed ${text.length} chars`)
}

// ── Window / process listing ──────────────────────────────────────────────────
function listWindows () {
  return new Promise((resolve) => {
    if (PLATFORM === 'darwin') {
      runShell(`osascript -e 'tell application "System Events" to get name of every process whose visible is true'`, os.homedir(), 5000)
        .then(({ output }) => resolve(output.split(', ').map((n) => ({ title: n.trim() }))))
        .catch(() => resolve([]))
    } else if (PLATFORM === 'linux') {
      runShell(`wmctrl -l`, os.homedir(), 5000)
        .then(({ output }) => resolve(output.split('\n').map((l) => ({ title: l.trim() })).filter((w) => w.title)))
        .catch(() => resolve([]))
    } else {
      runShell(`powershell -c "Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object -ExpandProperty MainWindowTitle"`, os.homedir(), 5000)
        .then(({ output }) => resolve(output.split('\n').map((t) => ({ title: t.trim() })).filter((w) => w.title)))
        .catch(() => resolve([]))
    }
  })
}

function listProcesses () {
  return new Promise((resolve) => {
    const cmd = PLATFORM === 'win32'
      ? `powershell -c "Get-Process | Select-Object Name,Id,CPU | ConvertTo-Json"`
      : PLATFORM === 'darwin'
        ? `ps aux | head -30`
        : `ps aux | head -30`
    runShell(cmd, os.homedir(), 5000)
      .then(({ output }) => resolve([{ raw: output }]))
      .catch(() => resolve([]))
  })
}

// ── System tray ───────────────────────────────────────────────────────────────
function setupTray () {
  tray = new Tray(createTrayIcon())
  tray.setToolTip('LUCA')
  updateTrayMenu()
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show()
    } else {
      openMainWindow()
    }
  })
}

let _updateState = null  // null | { version, ready: bool }

function updateTrayMenu (connected = false) {
  _buildTrayMenu(connected, _updateState)
}

function updateTrayMenuWithUpdate (ready, version) {
  _updateState = { version, ready }
  _buildTrayMenu(ws?.readyState === WebSocket.OPEN, _updateState)
}

function _buildTrayMenu (connected, updateState) {
  const template = [
    { label: 'LUCA', enabled: false },
    { label: connected ? '● Connected' : '○ Disconnected', enabled: false },
    { type: 'separator' },
    { label: 'Open Dashboard', click: () => { openMainWindow(); mainWindow?.show() } },
    { type: 'separator' },
  ]

  if (updateState?.ready) {
    template.push({
      label: `⟳  Restart to Update (v${updateState.version})`,
      click: () => { autoUpdater?.quitAndInstall(false, true) },
    })
    template.push({ type: 'separator' })
  } else if (updateState && !updateState.ready) {
    template.push({ label: `↓  Downloading v${updateState.version}…`, enabled: false })
    template.push({ type: 'separator' })
  } else {
    template.push({
      label: 'Check for Updates',
      click: () => { autoUpdater?.checkForUpdates().catch(() => {}) },
    })
    template.push({ type: 'separator' })
  }

  template.push({ label: 'Connection Help…', click: openSetupWindow })
  template.push({ type: 'separator' })
  template.push({ label: 'Quit LUCA', click: () => { app.exit(0) } })

  tray.setContextMenu(Menu.buildFromTemplate(template))
}

function createTrayIcon () {
  try {
    return nativeImage.createFromBuffer(
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'),
      { width: 1, height: 1 }
    )
  } catch {
    return nativeImage.createEmpty()
  }
}

// ── Connection help window ───────────────────────────────────────────────────
function openSetupWindow () {
  if (setupWindow) { setupWindow.focus(); return }

  setupWindow = new BrowserWindow({
    width: 520, height: 420,
    resizable: false,
    titleBarStyle: PLATFORM === 'darwin' ? 'hidden' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#080e1a',
     title: 'LUCA — Connection Help',
    parent: mainWindow || undefined,
    modal: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  setupWindow.loadFile(path.join(__dirname, 'setup.html'))
  if (PLATFORM !== 'darwin') setupWindow.setMenuBarVisibility(false)
  setupWindow.on('closed', () => { setupWindow = null })
}

// ── Global shortcut — summon LUCA ─────────────────────────────────────────────
function registerGlobalShortcut () {
  const shortcut = PLATFORM === 'darwin' ? 'Command+Space' : 'Ctrl+Space'

  const registered = globalShortcut.register(shortcut, () => {
    if (!mainWindow) { openMainWindow(); return }
    if (mainWindow.isVisible() && mainWindow.isFocused()) {
      mainWindow.webContents.executeJavaScript(`
        if (typeof toggleConvoMode === 'function' && !_convoMode) toggleConvoMode();
        else if (typeof toggleVoice === 'function' && !voiceMode) { toggleVoice(); setTimeout(() => handleMicClick && handleMicClick(), 400); }
      `).catch(() => {})
    } else {
      mainWindow.show(); mainWindow.focus()
    }
  })

  if (!registered) {
    globalShortcut.register('Alt+L', () => {
      if (mainWindow) { mainWindow.show(); mainWindow.focus() }
    })
  }
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
ipcMain.handle('get-status', () => ({
  connected: ws?.readyState === WebSocket.OPEN,
  serverUrl: getServerUrl(),
}))

ipcMain.handle('screenshot', async () => {
  await captureAndSendScreenshot()
  return { ok: true }
})

ipcMain.handle('open-external', (_, url) => {
  safeOpenExternal(url)
})

ipcMain.handle('show-notification', (_, { title, body }) => {
  if (Notification.isSupported()) new Notification({ title, body }).show()
})

ipcMain.handle('confirm-dialog', async (_, message) => {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning', title: 'LUCA — Confirmation',
    message: 'Confirmation Required', detail: message,
    buttons: ['Confirm', 'Cancel'], defaultId: 1, cancelId: 1,
  })
  return response === 0
})

ipcMain.handle('retry-connection', () => {
  currentWsToken = null
  if (ws) { try { ws.close() } catch (_) {} }
  mainWindow?.loadURL(DEFAULT_SERVER_URL)
  return { ok: true }
})

ipcMain.handle('install-update', () => {
  if (autoUpdater && _updateState?.ready) {
    autoUpdater.quitAndInstall(false, true)
  }
})

ipcMain.handle('get-update-state', () => _updateState)
