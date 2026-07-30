/**
 * voice-mcp
 * 
 * An MCP server for AI voice synthesis with inline audio player.
 * Proxies TTS through a VPS relay (which calls ElevenLabs) with a custom
 * cloned voice — ElevenLabs blocks Cloudflare Workers' datacenter IPs directly.
 * 
 * GitHub: https://github.com/garan0613/voice-mcp
 * License: MIT
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";

// =============================================================================
// Types
// =============================================================================

export interface Env {
  // Optional: VPS relay endpoint that performs the actual TTS (defaults below)
  SPEAK_API_URL?: string;
  // Optional: custom bot name for display
  BOT_NAME?: string;
  // Optional: secret for signing OAuth codes/tokens (falls back to a default)
  OAUTH_SIGNING_SECRET?: string;
}

// =============================================================================
// Constants
// =============================================================================

const EXT_APPS_MIME = "text/html;profile=mcp-app" as const;
const VOICE_RESOURCE_URI = "ui://voice-mcp/player.html";
const DEFAULT_BOT_NAME = "daddy";
// VPS relay that calls ElevenLabs and returns raw MP3 (GET ?text=...).
const DEFAULT_SPEAK_API_URL = "https://ke-yu.top/speak-api";

// OAuth
const OAUTH_CODE_TTL = 600;                    // authorization code: 10 minutes
const OAUTH_TOKEN_TTL = 60 * 60 * 24 * 30;     // access token: 30 days
const DEFAULT_OAUTH_SECRET = "voice-mcp-oauth-signing-key-v1";

// =============================================================================
// Audio Player HTML (WeChat-style UI)
// =============================================================================

function getPlayerHTML(botName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Voice Player</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: transparent;
      padding: 8px;
    }
    .container {
      background: #fff;
      border-radius: 16px;
      padding: 14px 16px;
      max-width: 100%;
      box-shadow: 0 1px 4px rgba(0,0,0,0.08);
    }
    .player {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 4px 0;
    }
    .play-btn {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      border: none;
      background: #f5f5f5;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: background 0.2s;
    }
    .play-btn:hover { background: #eee; }
    .play-btn:active { background: #e0e0e0; }
    .play-btn svg { width: 14px; height: 14px; fill: #333; }
    .play-btn.playing svg { fill: #07c160; }
    .waveform {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 2px;
      height: 24px;
    }
    .wave-bar {
      width: 3px;
      background: #d0d0d0;
      border-radius: 2px;
      transition: background 0.1s;
    }
    .wave-bar.active { background: #07c160; }
    .duration {
      font-size: 13px;
      color: #999;
      min-width: 36px;
      text-align: right;
    }
    .toggle-btn {
      background: none;
      border: none;
      color: #07c160;
      font-size: 12px;
      cursor: pointer;
      padding: 8px 0 4px 0;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .toggle-btn:hover { text-decoration: underline; }
    .toggle-btn .arrow { 
      display: inline-block;
      transition: transform 0.2s; 
      font-size: 10px;
    }
    .toggle-btn.expanded .arrow { transform: rotate(90deg); }
    .text-bubble {
      background: #f7f7f7;
      border-radius: 8px;
      padding: 10px 12px;
      margin-top: 8px;
      font-size: 14px;
      line-height: 1.6;
      color: #333;
      display: none;
    }
    .text-bubble.show { display: block; }
    .loading {
      text-align: center;
      color: #999;
      font-size: 13px;
      padding: 16px;
    }
    .error {
      color: #fa5151;
      background: #fff2f2;
      padding: 10px;
      border-radius: 8px;
      font-size: 13px;
    }
    @media (prefers-color-scheme: dark) {
      .container { background: #2c2c2c; }
      .play-btn { background: #3a3a3a; }
      .play-btn svg { fill: #e0e0e0; }
      .wave-bar { background: #555; }
      .wave-bar.active { background: #4cd964; }
      .duration { color: #888; }
      .text-bubble { background: #3a3a3a; color: #e0e0e0; }
      .toggle-btn { color: #4cd964; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div id="content">
      <div class="loading">Loading...</div>
    </div>
  </div>

  <script>
    const contentEl = document.getElementById('content');
    const BOT_NAME = '${botName}';
    let audio = null;
    let waveInterval = null;
    
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
    
    function showError(msg) {
      contentEl.innerHTML = '<div class="error">' + escapeHtml(msg) + '</div>';
    }
    
    function formatTime(sec) {
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return m + ':' + (s < 10 ? '0' : '') + s;
    }
    
    function createWaveform() {
      const heights = [40, 70, 55, 85, 45, 90, 60, 75, 50, 80, 65, 55, 70, 45, 85, 50];
      return heights.map(h => '<div class="wave-bar" style="height:' + h + '%"></div>').join('');
    }
    
    function renderPlayer(text, audioBase64) {
      const audioUrl = 'data:audio/mpeg;base64,' + audioBase64;
      
      contentEl.innerHTML = 
        '<div class="player">' +
          '<button class="play-btn" id="playBtn">' +
            '<svg viewBox="0 0 24 24"><path id="playIcon" d="M8 5v14l11-7z"/></svg>' +
          '</button>' +
          '<div class="waveform" id="waveform">' + createWaveform() + '</div>' +
          '<span class="duration" id="duration">0:00</span>' +
        '</div>' +
        '<button class="toggle-btn" id="toggleBtn">' +
          '<span class="arrow">▶</span> Show transcript' +
        '</button>' +
        '<div class="text-bubble" id="textBubble">' + escapeHtml(text) + '</div>' +
        '<audio id="audio" src="' + audioUrl + '" preload="metadata"></audio>';
      
      audio = document.getElementById('audio');
      const playBtn = document.getElementById('playBtn');
      const playIcon = document.getElementById('playIcon');
      const durationEl = document.getElementById('duration');
      const waveform = document.getElementById('waveform');
      const bars = waveform.querySelectorAll('.wave-bar');
      const toggleBtn = document.getElementById('toggleBtn');
      const textBubble = document.getElementById('textBubble');
      
      audio.addEventListener('loadedmetadata', function() {
        durationEl.textContent = formatTime(audio.duration);
      });
      
      playBtn.addEventListener('click', function() {
        if (audio.paused) {
          audio.play();
        } else {
          audio.pause();
        }
      });
      
      audio.addEventListener('play', function() {
        playBtn.classList.add('playing');
        playIcon.setAttribute('d', 'M6 19h4V5H6v14zm8-14v14h4V5h-4z');
        animateWave(bars, true);
      });
      
      audio.addEventListener('pause', function() {
        playBtn.classList.remove('playing');
        playIcon.setAttribute('d', 'M8 5v14l11-7z');
        animateWave(bars, false);
      });
      
      audio.addEventListener('ended', function() {
        playBtn.classList.remove('playing');
        playIcon.setAttribute('d', 'M8 5v14l11-7z');
        animateWave(bars, false);
        bars.forEach(b => b.classList.remove('active'));
      });
      
      audio.addEventListener('timeupdate', function() {
        const progress = audio.currentTime / audio.duration;
        const activeCount = Math.floor(progress * bars.length);
        bars.forEach((b, i) => b.classList.toggle('active', i < activeCount));
      });
      
      toggleBtn.addEventListener('click', function() {
        const isShow = textBubble.classList.toggle('show');
        toggleBtn.classList.toggle('expanded', isShow);
        toggleBtn.innerHTML = isShow 
          ? '<span class="arrow">▶</span> Hide transcript' 
          : '<span class="arrow">▶</span> Show transcript';
      });
    }
    
    function animateWave(bars, playing) {
      if (waveInterval) clearInterval(waveInterval);
      if (!playing) return;
      
      waveInterval = setInterval(function() {
        bars.forEach(bar => {
          if (!bar.classList.contains('active')) {
            bar.style.opacity = 0.5 + Math.random() * 0.5;
          }
        });
      }, 150);
    }
    
    function handleData(data) {
      if (data.error) { showError(data.error); return; }
      if (data.audio_base64 && data.text) {
        renderPlayer(data.text, data.audio_base64);
      }
    }
    
    function sendToHost(method, params, id) {
      const msg = { jsonrpc: '2.0', method: method, params: params || {} };
      if (id !== undefined) msg.id = id;
      window.parent.postMessage(msg, '*');
    }
    
    window.addEventListener('message', function(event) {
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;
      
      if (msg.jsonrpc === '2.0') {
        if (msg.method === 'ui/notifications/tool-input') {
          contentEl.innerHTML = '<div class="loading">Generating voice...</div>';
        }
        if (msg.method === 'ui/notifications/tool-result') {
          const structured = msg.params?.structuredContent;
          if (structured) handleData(structured);
        }
      }
      if (msg.structuredContent) handleData(msg.structuredContent);
    });
    
    sendToHost('ui/initialize', { name: 'voice-mcp', version: '1.0.0' }, 1);
    setTimeout(function() { sendToHost('ui/notifications/initialized', {}); }, 50);
  </script>
</body>
</html>`;
}

// =============================================================================
// Voice Relay Helper
// =============================================================================
//
// ElevenLabs blocks Cloudflare Workers' datacenter IPs (flagged as proxy/VPN),
// so TTS is proxied through a VPS relay. The relay calls ElevenLabs itself and
// returns raw MP3 bytes for `GET {SPEAK_API_URL}?text=...`.

async function generateAudio(env: Env, text: string): Promise<{ success: boolean; audio_base64?: string; error?: string }> {
  try {
    const relayBase = env.SPEAK_API_URL || DEFAULT_SPEAK_API_URL;
    const relayUrl = `${relayBase}?text=${encodeURIComponent(text)}`;

    const response = await fetch(relayUrl);

    if (!response.ok) {
      let errMsg = `Voice relay error (${response.status})`;
      try {
        const body = (await response.text()).trim();
        if (body) errMsg += `: ${body.slice(0, 300)}`;
      } catch {
        // Non-text body; keep the status-based message.
      }
      return { success: false, error: errMsg };
    }

    const bytes = new Uint8Array(await response.arrayBuffer());

    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.slice(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, Array.from(chunk));
    }
    const base64Audio = btoa(binary);

    return { success: true, audio_base64: base64Audio };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// =============================================================================
// MCP Server Factory
// =============================================================================

function createVoiceServer(env: Env): McpServer {
  const botName = env.BOT_NAME || DEFAULT_BOT_NAME;
  const PLAYER_HTML = getPlayerHTML(botName);
  
  const server = new McpServer({
    name: "voice-mcp",
    version: "1.0.0",
  });

  server.server.registerCapabilities({
    extensions: {
      "io.modelcontextprotocol/ui": {},
    },
  });

  server.resource(
    VOICE_RESOURCE_URI,
    VOICE_RESOURCE_URI,
    { mimeType: EXT_APPS_MIME, description: "Voice Player" },
    async () => ({
      contents: [
        {
          uri: VOICE_RESOURCE_URI,
          mimeType: EXT_APPS_MIME,
          text: PLAYER_HTML,
        },
      ],
    }),
  );

  server.registerTool(
    "speak",
    {
      title: `${botName}'s Voice`,
      description: `Make ${botName} speak with a custom cloned voice. The audio will play in an inline player.`,
      inputSchema: z.object({
        text: z.string().describe("Text to speak"),
      }),
      _meta: {
        ui: { resourceUri: VOICE_RESOURCE_URI },
        "ui/resourceUri": VOICE_RESOURCE_URI,
      },
    },
    async ({ text }) => {
      const result = await generateAudio(env, text);
      
      if (result.success && result.audio_base64) {
        return {
          content: [
            { type: "text" as const, text: `🎙️ ${botName} says: "${text}"` },
          ],
          structuredContent: {
            text: text,
            audio_base64: result.audio_base64,
          },
        };
      }
      
      return {
        content: [
          { type: "text" as const, text: `Voice generation failed: ${result.error}` },
        ],
        structuredContent: {
          error: result.error || 'Unknown error',
        },
      };
    },
  );

  return server;
}

// =============================================================================
// Worker Handler
// =============================================================================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// =============================================================================
// OAuth 2.0 (discovery + RFC 7591 dynamic client registration + PKCE)
// =============================================================================
//
// Claude.ai connects to remote MCP servers over OAuth. This implements the
// minimal standards-compliant flow it expects: discovery metadata, dynamic
// client registration, and a PKCE authorization_code grant that auto-approves.
// There are no user accounts — anyone who completes the flow receives a bearer
// token that /mcp accepts. Modeled on ke-yu.top's implementation.

function oauthSecret(env: Env): string {
  return env.OAUTH_SIGNING_SECRET || DEFAULT_OAUTH_SECRET;
}

const jsonHeaders = { 'Content-Type': 'application/json', ...corsHeaders };

function b64urlFromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlFromString(str: string): string {
  return b64urlFromBytes(new TextEncoder().encode(str));
}

function stringFromB64url(b64url: string): string {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const binary = atob(b64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function sha256b64url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return b64urlFromBytes(new Uint8Array(digest));
}

async function hmacSign(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return b64urlFromBytes(new Uint8Array(sig));
}

// A self-contained signed token: base64url(payload) + "." + signature.
// Lets /token and /mcp validate codes/tokens without any server-side storage
// (Workers isolates are ephemeral and don't share memory).
async function signPayload(payload: Record<string, unknown>, secret: string): Promise<string> {
  const body = b64urlFromString(JSON.stringify(payload));
  return `${body}.${await hmacSign(body, secret)}`;
}

async function verifyPayload(token: string, secret: string): Promise<Record<string, any> | null> {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (sig !== await hmacSign(body, secret)) return null;
  try {
    const payload = JSON.parse(stringFromB64url(body));
    if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function oauthMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  };
}

function protectedResourceMetadata(origin: string) {
  return { resource: origin, authorization_servers: [origin] };
}

// RFC 7591 Dynamic Client Registration — public client, no secret issued.
async function handleRegister(request: Request): Promise<Response> {
  let body: any = {};
  try { body = await request.json(); } catch { /* tolerate empty/invalid body */ }

  const registration = {
    client_id: crypto.randomUUID(),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'],
    response_types: ['code'],
    ...(body.client_name ? { client_name: body.client_name } : {}),
    ...(body.scope ? { scope: body.scope } : {}),
  };
  return new Response(JSON.stringify(registration), { status: 201, headers: jsonHeaders });
}

// Authorization endpoint — auto-approves and redirects back with a code that
// carries the PKCE challenge so /token can verify it statelessly.
async function handleAuthorize(url: URL, env: Env): Promise<Response> {
  const p = url.searchParams;
  const redirectUri = p.get('redirect_uri');
  if (!redirectUri) {
    return new Response('Missing redirect_uri', { status: 400, headers: corsHeaders });
  }

  let dest: URL;
  try {
    dest = new URL(redirectUri);
  } catch {
    return new Response('Invalid redirect_uri', { status: 400, headers: corsHeaders });
  }

  const code = await signPayload({
    cc: p.get('code_challenge'),
    m: p.get('code_challenge_method') || 'plain',
    ru: redirectUri,
    exp: Math.floor(Date.now() / 1000) + OAUTH_CODE_TTL,
  }, oauthSecret(env));

  dest.searchParams.set('code', code);
  const state = p.get('state');
  if (state) dest.searchParams.set('state', state);
  return Response.redirect(dest.toString(), 302);
}

// Token endpoint — exchanges an authorization code for an access token,
// verifying PKCE and redirect_uri.
async function handleToken(request: Request, env: Env): Promise<Response> {
  const secret = oauthSecret(env);
  const err = (error: string, desc?: string) => new Response(
    JSON.stringify({ error, ...(desc ? { error_description: desc } : {}) }),
    { status: 400, headers: jsonHeaders },
  );

  // Token endpoint uses form encoding per spec; also accept JSON defensively.
  let params: Record<string, string> = {};
  try {
    if ((request.headers.get('content-type') || '').includes('application/json')) {
      params = await request.json() as Record<string, string>;
    } else {
      (await request.formData()).forEach((v, k) => { params[k] = String(v); });
    }
  } catch {
    return err('invalid_request', 'Unable to parse request body');
  }

  if (params.grant_type !== 'authorization_code') return err('unsupported_grant_type');
  if (!params.code) return err('invalid_request', 'Missing code');

  const payload = await verifyPayload(params.code, secret);
  if (!payload) return err('invalid_grant', 'Invalid or expired code');

  if (params.redirect_uri && payload.ru && params.redirect_uri !== payload.ru) {
    return err('invalid_grant', 'redirect_uri mismatch');
  }

  // PKCE verification.
  if (payload.cc) {
    const verifier = params.code_verifier;
    if (!verifier) return err('invalid_grant', 'Missing code_verifier');
    const ok = payload.m === 'S256'
      ? (await sha256b64url(verifier)) === payload.cc
      : verifier === payload.cc;
    if (!ok) return err('invalid_grant', 'PKCE verification failed');
  }

  const accessToken = await signPayload({
    sub: 'voice-mcp',
    exp: Math.floor(Date.now() / 1000) + OAUTH_TOKEN_TTL,
  }, secret);

  return new Response(JSON.stringify({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: OAUTH_TOKEN_TTL,
  }), { headers: jsonHeaders });
}

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return (await verifyPayload(m[1], oauthSecret(env))) !== null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // OAuth discovery metadata (also served on path-suffixed variants that
    // some clients probe, e.g. /.well-known/oauth-protected-resource/mcp).
    if (path.startsWith('/.well-known/oauth-authorization-server')) {
      return Response.json(oauthMetadata(url.origin), { headers: corsHeaders });
    }
    if (path.startsWith('/.well-known/oauth-protected-resource')) {
      return Response.json(protectedResourceMetadata(url.origin), { headers: corsHeaders });
    }

    // OAuth flow
    if (path === '/oauth/register' && request.method === 'POST') {
      return handleRegister(request);
    }
    if (path === '/oauth/authorize' && request.method === 'GET') {
      return handleAuthorize(url, env);
    }
    if (path === '/oauth/token' && request.method === 'POST') {
      return handleToken(request, env);
    }

    // MCP Endpoint (requires a bearer token; an unauthenticated request gets a
    // 401 challenge that kicks off the OAuth flow above).
    if (path === '/mcp' || path === '/mcp/' || path === '/sse') {
      if (!(await isAuthorized(request, env))) {
        return new Response(
          JSON.stringify({ error: 'invalid_token', error_description: 'Authentication required' }),
          {
            status: 401,
            headers: {
              ...jsonHeaders,
              'WWW-Authenticate': `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
            },
          },
        );
      }
      const server = createVoiceServer(env);
      const handler = createMcpHandler(server, {
        route: null as unknown as string,
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      return handler(request, env, ctx);
    }

    // Status check
    if (path === '/status') {
      return Response.json({
        status: 'ok',
        service: 'voice-mcp',
        version: '1.0.0',
        relay: env.SPEAK_API_URL || DEFAULT_SPEAK_API_URL,
      }, { headers: corsHeaders });
    }

    // Direct audio API
    if (path === '/speak' && request.method === 'GET') {
      const text = url.searchParams.get('text');
      if (!text) {
        return Response.json({ error: 'Missing text parameter' }, { 
          status: 400, 
          headers: corsHeaders 
        });
      }

      const result = await generateAudio(env, text);
      
      if (result.success && result.audio_base64) {
        const binaryString = atob(result.audio_base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        
        return new Response(bytes, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'audio/mpeg',
            'Content-Disposition': 'inline; filename="voice.mp3"',
          },
        });
      }

      return Response.json({ error: result.error }, { 
        status: 500, 
        headers: corsHeaders 
      });
    }

    // Landing page
    if (path === '/' || path === '') {
      const botName = env.BOT_NAME || DEFAULT_BOT_NAME;
      return new Response(
        `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>voice-mcp</title>
<style>
  body { font-family: system-ui; max-width: 600px; margin: 40px auto; padding: 20px; color: #333; line-height: 1.6; }
  h1 { color: #07c160; }
  code { background: #f5f5f5; padding: 2px 8px; border-radius: 4px; font-size: 14px; }
  .section { margin: 24px 0; }
  .endpoint { margin: 8px 0; }
  a { color: #07c160; }
</style>
</head><body>
<h1>🎙️ voice-mcp</h1>
<p>An MCP server for AI voice synthesis with inline audio player.</p>

<div class="section">
<h3>MCP Server</h3>
<p>Add this URL to your Claude.ai Connectors:</p>
<code>${url.origin}/mcp</code>
</div>

<div class="section">
<h3>Direct API</h3>
<div class="endpoint">
  <code>GET /speak?text=Hello</code> — Get audio file directly
</div>
<div class="endpoint">
  <code>GET /status</code> — Health check
</div>
</div>

<div class="section">
<h3>Configuration</h3>
<p>Bot name: <strong>${botName}</strong></p>
</div>

<p style="margin-top: 32px; color: #666; font-size: 14px;">
  <a href="https://github.com/xxx/voice-mcp">GitHub</a> · MIT License
</p>
</body></html>`,
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
      );
    }

    return new Response('Not Found', { status: 404 });
  },
};
