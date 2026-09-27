import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import QRCode from "qrcode";
import type { RemoteControlStatus, RemoteRenderSnapshot } from "../../shared/domain";
import type { RenderCommandState } from "./render-command-state";

const PAIRING_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 8 * 60 * 60_000;
const SESSION_IDLE_MS = 30 * 60_000;
const MAX_BODY_BYTES = 4_096;

interface PairingSecret {
  tokenHash: string;
  expiresAt: number;
  consumed: boolean;
}

interface SessionRecord {
  expiresAt: number;
  lastSeenAt: number;
  remoteAddress: string;
  csrfHash: string;
  cancelNonceHash?: string;
  cancelNonceExpiresAt?: number;
}

interface RateRecord {
  startedAt: number;
  count: number;
}

function token(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeAddress(value?: string): string {
  const raw = value ?? "";
  return raw.startsWith("::ffff:") ? raw.slice(7) : raw;
}

export function isPrivateLanAddress(value?: string): boolean {
  const address = normalizeAddress(value);
  if (address === "127.0.0.1" || address === "::1") return true;
  if (/^10\./.test(address) || /^192\.168\./.test(address)) return true;
  const match = /^172\.(\d{1,3})\./.exec(address);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return /^169\.254\./.test(address) || /^f[cd][0-9a-f]{2}:/i.test(address);
}

function lanAddresses(): string[] {
  const result = new Set<string>();
  for (const records of Object.values(networkInterfaces())) {
    for (const record of records ?? []) {
      if (record.family !== "IPv4" || record.internal || !isPrivateLanAddress(record.address)) continue;
      result.add(record.address);
    }
  }
  const priority = (address: string) => address.startsWith("192.168.") ? 0 : address.startsWith("10.") ? 1 : 2;
  return [...result].sort((left, right) => priority(left) - priority(right) || left.localeCompare(right));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  response.end(JSON.stringify(body));
}

function text(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(body);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("请求内容过大。");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("请求格式无效。");
  return parsed as Record<string, unknown>;
}

const REMOTE_HTML = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>SceneryWalker 遠端控制</title><link rel="stylesheet" href="/styles.css"></head><body><main><header><p>SceneryWalker</p><h1>iPhone 遠端控制</h1><span id="connection">正在配對…</span></header><section class="card"><h2 id="project">—</h2><div class="progress"><i id="bar"></i></div><strong id="percent">0%</strong><div class="times"><span>已耗時<b id="elapsed">—</b></span><span>預估剩餘<b id="eta">—</b></span></div><p id="segment">尚未開始</p></section><section class="grid" id="metrics"></section><section class="error" id="error" hidden></section><section class="actions"><button class="start" data-command="start">開始轉檔</button><button class="pause" data-command="pause">安全暫停</button><button class="resume" data-command="resume">繼續</button><button class="cancel" data-command="cancel">取消</button></section><p class="note" id="pauseDetail">暂停会先完成当前 FFmpeg 分段，不会强制中止编码器。</p></main><dialog id="cancelDialog"><h2>确定取消转档？</h2><p>目前分段会依既有安全流程结束或保存 checkpoint。</p><div><button id="keep">继续转档</button><button id="confirmCancel" class="cancel">确定取消</button></div></dialog><script src="/app.js"></script></body></html>`;

const REMOTE_CSS = `:root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#08131c;color:#edf7ff}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:linear-gradient(160deg,#08131c,#15102a);padding:max(18px,env(safe-area-inset-top)) 16px max(24px,env(safe-area-inset-bottom))}main{max-width:560px;margin:auto}header p{color:#84ccff;margin:0;font-weight:800}h1{font-size:1.65rem;margin:.2rem 0}.card,.grid>div,.error{background:#111e2a;border:1px solid #29445d;border-radius:18px;padding:16px;margin-top:14px}.card h2{margin:0 0 12px}.progress{height:14px;border-radius:20px;background:#253341;overflow:hidden}.progress i{display:block;height:100%;width:0;background:linear-gradient(90deg,#318aff,#9b6dff,#ff70b8)}#percent{font-size:1.8rem}.times{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}.times span,.grid span{display:flex;flex-direction:column;color:#a9bfd0}.times b,.grid b{color:#fff;font-size:1.1rem}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.grid>div{margin:0;min-width:0}.error{border-color:#f66;color:#ffd8d8}.actions{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:18px}button{min-height:58px;border:0;border-radius:16px;color:#fff;font-weight:800;font-size:1.08rem}.start{background:#1979e8}.pause{background:#8a57d8}.resume{background:#297f68}.cancel{background:#bb3448}button:disabled{opacity:.35}.note{color:#adc0d0;font-size:.9rem}dialog{background:#15222e;color:#fff;border:1px solid #4b6072;border-radius:20px;max-width:calc(100% - 32px)}dialog div{display:flex;gap:12px}dialog button{padding:0 18px;background:#44515e}@media(max-width:390px){.grid{grid-template-columns:1fr}.times{grid-template-columns:1fr}.actions{grid-template-columns:1fr}}`;

const REMOTE_JS = `(()=>{const $=id=>document.getElementById(id);let csrf=sessionStorage.getItem('scenery-csrf'),cancelNonce;const clock=ms=>{if(ms==null)return'—';const s=Math.max(0,Math.floor(ms/1000));return[String(Math.floor(s/3600)).padStart(2,'0'),String(Math.floor(s%3600/60)).padStart(2,'0'),String(s%60).padStart(2,'0')].join(':')};const bytes=n=>n==null?'—':(n/1073741824).toFixed(1)+' GB';async function pair(){const pairToken=location.hash.startsWith('#pair=')?decodeURIComponent(location.hash.slice(6)):'';history.replaceState(null,'',location.pathname);if(!pairToken)throw Error('配对连结已失效，请在 Windows 端重新产生 QR Code。');const r=await fetch('/api/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:pairToken})});const j=await r.json();if(!r.ok)throw Error(j.error||'配对失败');csrf=j.csrfToken;sessionStorage.setItem('scenery-csrf',csrf)}async function api(path,options={}){const r=await fetch(path,{...options,headers:{...(options.headers||{}),'X-Scenery-CSRF':csrf,'Content-Type':'application/json'}});const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||'操作失败');return j}function render(s){$('connection').textContent='已安全连接 · '+s.state;$('project').textContent=s.projectName||'未命名专案';$('bar').style.width=Math.max(0,Math.min(100,s.progressPercent||0))+'%';$('percent').textContent=Math.round(s.progressPercent||0)+'%';$('elapsed').textContent=clock(s.attemptElapsedMs);$('eta').textContent=clock(s.estimatedRemainingMs);$('segment').textContent=s.currentSegment||'尚未开始';$('pauseDetail').textContent=s.pauseDetail||'暂停会先完成当前 FFmpeg 分段，不会强制中止编码器。';const rows=[['Encoder',s.encoder],['Resolution',s.resolution],['Render Mode',s.renderMode],['Audio Mode',s.audioMode],['CPU',s.cpuUsagePercent==null?'—':Math.round(s.cpuUsagePercent)+'%'],['GPU Encode',s.gpuEncodeUsagePercent==null?'—':Math.round(s.gpuEncodeUsagePercent)+'%'],['RAM Used',bytes(s.ramUsedBytes)],['SSD Free',bytes(s.ssdFreeBytes)]];$('metrics').innerHTML=rows.map(r=>'<div><span>'+r[0]+'<b>'+String(r[1]??'—').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))+'</b></span></div>').join('');$('error').hidden=!s.latestError;$('error').textContent=s.latestError||'';document.querySelector('[data-command=start]').disabled=!s.prepared||['RUNNING','PAUSING','PAUSED'].includes(s.state);document.querySelector('[data-command=pause]').disabled=s.state!=='RUNNING';document.querySelector('[data-command=resume]').disabled=!['PAUSING','PAUSED','FAILED','CANCELLED'].includes(s.state);document.querySelector('[data-command=cancel]').disabled=!['RUNNING','PAUSING','PAUSED'].includes(s.state)}async function command(name,body={}){await api('/api/command/'+name,{method:'POST',body:JSON.stringify(body)});render((await api('/api/state')).render)}async function events(){const r=await fetch('/api/events',{headers:{'X-Scenery-CSRF':csrf}});if(!r.ok)throw Error('即时连线中断');const reader=r.body.getReader(),decoder=new TextDecoder();let buf='';for(;;){const v=await reader.read();if(v.done)throw Error('即时连线结束');buf+=decoder.decode(v.value,{stream:true});let i;while((i=buf.indexOf('\n\n'))>=0){const packet=buf.slice(0,i);buf=buf.slice(i+2);const data=packet.split('\n').find(x=>x.startsWith('data:'));if(data)render(JSON.parse(data.slice(5)))}}}document.querySelectorAll('[data-command]').forEach(b=>b.onclick=async()=>{const name=b.dataset.command;try{if(name==='cancel'){const intent=await api('/api/command/cancel-intent',{method:'POST',body:'{}'});cancelNonce=intent.cancelNonce;$('cancelDialog').showModal()}else await command(name)}catch(e){$('error').hidden=false;$('error').textContent=e.message}});$('keep').onclick=()=>{$('cancelDialog').close();cancelNonce=undefined};$('confirmCancel').onclick=()=>{ $('cancelDialog').close();command('cancel',{confirmation:'CANCEL',cancelNonce}).catch(e=>alert(e.message));cancelNonce=undefined};(async()=>{try{if(location.hash.startsWith('#pair=')||!csrf)await pair();render((await api('/api/state')).render);for(;;){try{await events()}catch(e){$('connection').textContent='连线中断，正在重连…';await new Promise(r=>setTimeout(r,2000))}}}catch(e){$('connection').textContent=e.message}})()})();`;

export class RemoteControlServer {
  private server?: Server;
  private pairing?: PairingSecret;
  private rawPairingToken?: string;
  private port?: number;
  private addresses: string[] = [];
  private qrDataUrl?: string;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly clients = new Set<ServerResponse>();
  private readonly rates = new Map<string, RateRecord>();
  private readonly pairingRates = new Map<string, RateRecord>();
  private unsubscribe?: () => void;
  private statusListener?: (status: RemoteControlStatus) => void;

  constructor(private readonly renderState: RenderCommandState) {}

  setStatusListener(listener: (status: RemoteControlStatus) => void): void {
    this.statusListener = listener;
  }

  async start(): Promise<RemoteControlStatus> {
    if (this.server) return this.status();
    this.addresses = lanAddresses();
    const server = createServer((request, response) => void this.handle(request, response));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, this.addresses[0] ?? "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.port = (server.address() as { port: number }).port;
    this.unsubscribe = this.renderState.subscribe((snapshot) => this.broadcast(snapshot));
    await this.rotatePairing();
    return this.status();
  }

  async stop(): Promise<RemoteControlStatus> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const client of this.clients) client.end();
    this.clients.clear();
    this.sessions.clear();
    this.pairing = undefined;
    this.rawPairingToken = undefined;
    this.qrDataUrl = undefined;
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    this.port = undefined;
    this.notifyStatus();
    return this.status();
  }

  async rotatePairing(): Promise<RemoteControlStatus> {
    if (!this.server || !this.port) throw new Error("请先启动 iPhone 远端控制。");
    const raw = token();
    this.rawPairingToken = raw;
    this.pairing = { tokenHash: hash(raw), expiresAt: Date.now() + PAIRING_TTL_MS, consumed: false };
    const url = this.pairingUrl();
    this.qrDataUrl = await QRCode.toDataURL(url, { width: 320, margin: 2, errorCorrectionLevel: "M" });
    this.notifyStatus();
    return this.status();
  }

  status(): RemoteControlStatus {
    return {
      enabled: Boolean(this.server),
      port: this.port,
      addresses: [...this.addresses],
      pairingUrl: this.server && this.pairing && !this.pairing.consumed ? this.pairingUrl() : undefined,
      qrDataUrl: this.server && this.pairing && !this.pairing.consumed ? this.qrDataUrl : undefined,
      pairingExpiresAt: this.pairing ? new Date(this.pairing.expiresAt).toISOString() : undefined,
      render: this.renderState.snapshot(),
    };
  }

  private pairingUrl(): string {
    const address = this.addresses[0] ?? "127.0.0.1";
    return `http://${address}:${this.port}/#pair=${encodeURIComponent(this.rawPairingToken ?? "")}`;
  }

  private notifyStatus(): void {
    this.statusListener?.(this.status());
  }

  private allowedOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (!origin) return true;
    if (!this.port) return false;
    return ["127.0.0.1", "localhost", ...this.addresses].some((address) => origin === `http://${address}:${this.port}`);
  }

  private allowedHost(request: IncomingMessage): boolean {
    if (!this.port) return false;
    const host = request.headers.host ?? "";
    return ["127.0.0.1", "localhost", ...this.addresses].some((address) => host === `${address}:${this.port}`);
  }

  private rateAllowed(request: IncomingMessage): boolean {
    const key = normalizeAddress(request.socket.remoteAddress);
    const now = Date.now();
    const current = this.rates.get(key);
    if (!current || now - current.startedAt > 60_000) {
      this.rates.set(key, { startedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= 120;
  }

  private pairingAllowed(request: IncomingMessage): boolean {
    const key = normalizeAddress(request.socket.remoteAddress);
    const now = Date.now();
    const current = this.pairingRates.get(key);
    if (!current || now - current.startedAt > 10 * 60_000) {
      this.pairingRates.set(key, { startedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= 10;
  }

  private authenticate(request: IncomingMessage): SessionRecord | undefined {
    const match = /(?:^|;\s*)scenery_remote=([A-Za-z0-9_-]{40,})(?:;|$)/.exec(request.headers.cookie ?? "");
    if (!match) return undefined;
    const key = hash(match[1]);
    const session = this.sessions.get(key);
    const now = Date.now();
    if (!session || session.expiresAt <= now || now - session.lastSeenAt > SESSION_IDLE_MS) {
      this.sessions.delete(key);
      return undefined;
    }
    if (session.remoteAddress !== normalizeAddress(request.socket.remoteAddress)) return undefined;
    const csrf = request.headers["x-scenery-csrf"];
    if (typeof csrf !== "string" || hash(csrf) !== session.csrfHash) return undefined;
    session.lastSeenAt = now;
    return session;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!isPrivateLanAddress(request.socket.remoteAddress) || !this.allowedHost(request) || !this.allowedOrigin(request)) {
        json(response, 403, { error: "只允许同一局域网的安全连接。" });
        return;
      }
      if (!this.rateAllowed(request)) {
        json(response, 429, { error: "请求过于频繁，请稍后再试。" });
        return;
      }
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      if (request.method === "GET" && url.pathname === "/") return text(response, 200, "text/html; charset=utf-8", REMOTE_HTML);
      if (request.method === "GET" && url.pathname === "/styles.css") return text(response, 200, "text/css; charset=utf-8", REMOTE_CSS);
      if (request.method === "GET" && url.pathname === "/app.js") return text(response, 200, "text/javascript; charset=utf-8", REMOTE_JS);
      if (request.method === "POST" && url.pathname === "/api/pair") {
        if (!this.pairingAllowed(request)) {
          json(response, 429, { error: "配对失败次数过多，请在 Windows 端重新产生 QR Code 后稍候再试。" });
          return;
        }
        const body = await readJsonBody(request);
        const raw = typeof body.token === "string" ? body.token : "";
        if (!this.pairing || this.pairing.consumed || this.pairing.expiresAt <= Date.now() || hash(raw) !== this.pairing.tokenHash) {
          json(response, 401, { error: "一次性配对连结无效或已使用，请在 Windows 端重新产生。" });
          return;
        }
        this.pairing.consumed = true;
        this.rawPairingToken = undefined;
        const sessionToken = token(36);
        const csrfToken = token(24);
        this.sessions.set(hash(sessionToken), {
          expiresAt: Date.now() + SESSION_TTL_MS,
          lastSeenAt: Date.now(),
          remoteAddress: normalizeAddress(request.socket.remoteAddress),
          csrfHash: hash(csrfToken),
        });
        this.pairingRates.delete(normalizeAddress(request.socket.remoteAddress));
        this.notifyStatus();
        response.setHeader("Set-Cookie", `scenery_remote=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
        json(response, 200, { csrfToken, expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() });
        return;
      }
      const authenticatedSession = this.authenticate(request);
      if (!authenticatedSession) {
        json(response, 401, { error: "远端控制授权已失效，请重新扫描 QR Code。" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        json(response, 200, { render: this.renderState.snapshot() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/events") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        const initial = this.renderState.snapshot();
        response.write(`id: ${initial.revision}\nevent: snapshot\ndata:${JSON.stringify(initial)}\n\n`);
        const keepAlive = setInterval(() => response.write(": keepalive\n\n"), 15_000);
        this.clients.add(response);
        request.once("close", () => {
          clearInterval(keepAlive);
          this.clients.delete(response);
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/command/cancel-intent") {
        await readJsonBody(request);
        if (!["RUNNING", "PAUSING", "PAUSED"].includes(this.renderState.snapshot().state)) {
          json(response, 409, { error: "目前没有可取消的转档工作。" });
          return;
        }
        const cancelNonce = token(24);
        authenticatedSession.cancelNonceHash = hash(cancelNonce);
        authenticatedSession.cancelNonceExpiresAt = Date.now() + 30_000;
        json(response, 200, { cancelNonce, expiresAt: new Date(authenticatedSession.cancelNonceExpiresAt).toISOString() });
        return;
      }
      const command = request.method === "POST" ? /^\/api\/command\/(start|pause|resume|cancel)$/.exec(url.pathname)?.[1] : undefined;
      if (command) {
        const body = await readJsonBody(request);
        if (
          command === "cancel" &&
          (body.confirmation !== "CANCEL" ||
            typeof body.cancelNonce !== "string" ||
            !authenticatedSession.cancelNonceHash ||
            authenticatedSession.cancelNonceExpiresAt! <= Date.now() ||
            hash(body.cancelNonce) !== authenticatedSession.cancelNonceHash)
        ) {
          json(response, 409, { error: "取消转档需要第二次确认。" });
          return;
        }
        if (command === "cancel") {
          authenticatedSession.cancelNonceHash = undefined;
          authenticatedSession.cancelNonceExpiresAt = undefined;
        }
        if (command === "start") await this.renderState.startPrepared();
        if (command === "pause") this.renderState.requestPause();
        if (command === "resume") await this.renderState.resumeCheckpoint();
        if (command === "cancel") await this.renderState.cancel();
        json(response, 202, { accepted: true, render: this.renderState.snapshot() });
        return;
      }
      json(response, 404, { error: "找不到此远端控制功能。" });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private broadcast(snapshot: RemoteRenderSnapshot): void {
    const packet = `id: ${snapshot.revision}\nevent: snapshot\ndata:${JSON.stringify(snapshot)}\n\n`;
    for (const client of this.clients) client.write(packet);
    this.notifyStatus();
  }
}
