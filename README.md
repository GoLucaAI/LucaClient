# LUCA Desktop

The desktop app for [LUCA](https://goluca.ai). An AI that sees your screen, controls your computer, and speaks with you.

## Download

Grab the latest build from the [Releases](../../releases) page:

- **Windows 10/11:** `LUCA-Setup-*.exe` (silent install)
- **macOS 12+:** `LUCA-*.dmg` (drag to Applications)
- **Linux:** `LUCA-*.AppImage` (`chmod +x` then run)

Sign in on first launch with your [goluca.ai](https://goluca.ai) account.

## How it works

The AI runs on LUCA's servers. This app is the local half. It connects your machine to the cloud over an encrypted WebSocket and lets LUCA see your screen, control your mouse and keyboard, and hear your voice.

Your machine handles screen capture, OS control, mic input, TTS playback, tray icon, and auto-updates.  
LUCA's servers handle all AI reasoning, memory, skills, speech recognition, and billing.

## Build from source

```bash
git clone https://github.com/GoLucaAI/LucaClient.git
cd LucaClient/desktop
npm install
npm start
```

## Security

- Every connection requires a token tied to your signed-in account
- Shell commands are filtered. Recursive deletion, privilege escalation, and credential patterns are blocked before anything runs
- High-risk actions (file deletes, payments, emails) show a confirmation dialog before executing
- Your session token is stored in your OS user data folder and never logged

## License

MIT. See [LICENSE](LICENSE).

Built by the LUCA team at [goluca.ai](https://goluca.ai)
