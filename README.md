# 🎙️ voice-mcp

An MCP (Model Context Protocol) server for AI voice synthesis with an inline audio player. Give your AI assistant a custom cloned voice!

![License](https://img.shields.io/badge/license-MIT-green)

## Features

- 🎤 **Custom Voice Cloning** — Use ElevenLabs TTS API with your own cloned voice
- 🎵 **Inline Audio Player** — Beautiful WeChat-style player with waveform visualization
- 📝 **Transcript Toggle** — Show/hide the spoken text
- 🌙 **Dark Mode Support** — Automatic theme adaptation
- ⚡ **Cloudflare Workers** — Fast, serverless deployment

## Demo

When you call the `speak` tool, you get:
- A sleek audio player with play/pause button
- Animated waveform that follows playback progress
- Duration display
- Expandable transcript

## Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/garan0613/voice-mcp.git
cd voice-mcp
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure

TTS is performed by a **VPS relay** (which calls ElevenLabs), because ElevenLabs
blocks Cloudflare Workers' datacenter IPs directly. The worker itself needs no
ElevenLabs credentials — the relay holds them.

Optionally override the relay URL or display name:

```bash
npx wrangler secret put SPEAK_API_URL  # Optional, defaults to https://ke-yu.top/speak-api
npx wrangler secret put BOT_NAME       # Optional, defaults to "daddy"
```

The relay must accept `GET {SPEAK_API_URL}?text=...` and return raw MP3 audio.

### 4. Deploy

```bash
npx wrangler deploy
```

### 5. Connect to Claude.ai

1. Go to **Settings → Connectors → Add Connector**
2. Enter your Worker URL: `https://your-worker.workers.dev/mcp`
3. Done! The `speak` tool is now available.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `SPEAK_API_URL` | ❌ | VPS relay endpoint (default: `https://ke-yu.top/speak-api`) |
| `BOT_NAME` | ❌ | Display name (default: "daddy") |
| `OAUTH_SIGNING_SECRET` | ❌ | Secret for signing OAuth tokens (has a default) |

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /mcp` | MCP server (SSE protocol) |
| `GET /speak?text=Hello` | Direct audio file |
| `GET /status` | Health check |

## How to Clone a Voice

1. Go to [ElevenLabs](https://elevenlabs.io/)
2. Navigate to Voice Lab → Voice Cloning
3. Upload 10-30 seconds of clear audio
4. Wait for processing (usually a few minutes)
5. Copy the Voice ID

## Custom Deployment

### Using a Custom Domain

1. Add your domain to Cloudflare
2. Create a DNS record pointing to your Worker
3. Update `wrangler.jsonc`:

```json
{
  "routes": [
    { "pattern": "voice.yourdomain.com/*", "zone_name": "yourdomain.com" }
  ]
}
```

### Self-Hosting (Node.js)

The core MCP logic can be adapted for other platforms. You'll need to:

1. Replace `createMcpHandler` with a standard HTTP/SSE handler
2. Use `@modelcontextprotocol/sdk` directly
3. Handle the SSE transport yourself

## Tech Stack

- [Cloudflare Workers](https://workers.cloudflare.com/) — Serverless runtime
- [MCP SDK](https://github.com/modelcontextprotocol/sdk) — Model Context Protocol
- [ElevenLabs TTS](https://elevenlabs.io/) — Voice synthesis
- [ext-apps](https://modelcontextprotocol.io/docs/concepts/ext-apps) — Inline UI rendering

## License

MIT © 2026

## Credits

Inspired by the need to give AI assistants a voice. Built with ❤️
