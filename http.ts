// Shared HTTP helpers: JSON replies carry X-GitHub-Request-Id on EVERY response,
// error bodies always have a string `message`. Deterministic request id from a counter.
import type { ServerResponse, IncomingMessage } from 'node:http';

const JSON_TYPE = 'application/json; charset=utf-8';
let reqSeq = 0;
function nextReqId(): string { reqSeq += 1; return `forge-${reqSeq.toString(36)}`; }

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string,string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextReqId(),
    ...headers,
  });
  res.end(text);
}
export function sendRaw(res: ServerResponse, status: number, body: Buffer|string, headers: Record<string,string> = {}): void {
  res.writeHead(status, { 'content-length': Buffer.isBuffer(body)?body.length:Buffer.byteLength(body), 'x-github-request-id': nextReqId(), ...headers });
  res.end(body);
}
export function err(res: ServerResponse, status: number, message: string, extra: Record<string,string> = {}): void {
  sendJson(res, status, { message, documentation_url: 'https://docs.github.com/rest' }, extra);
}

export function pathOf(req: IncomingMessage): string {
  const u = req.url ?? '/';
  const q = u.indexOf('?');
  return q < 0 ? u : u.slice(0, q);
}
export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c)?c:Buffer.from(c));
  return Buffer.concat(chunks);
}
export async function readJson(req: IncomingMessage): Promise<{ ok: boolean; value: unknown }> {
  try { const b = await readBody(req); return { ok: true, value: JSON.parse(b.toString('utf8')) }; }
  catch { return { ok: false, value: {} }; }
}

export function parsePath(path: string): string[] { return path.split('/').filter(Boolean); }
