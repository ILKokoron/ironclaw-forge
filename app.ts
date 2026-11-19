import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { store } from './store.ts';
import { sendJson, err, pathOf, parsePath } from './http.ts';
import { handleRest } from './handlers/rest.ts';
import { handleGit } from './handlers/git.ts';
import { handleGraphql } from './handlers/graphql.ts';
import { handleMcp } from './handlers/mcp.ts';

export type Ctx = { method: string; path: string; parts: string[]; req: IncomingMessage; res: ServerResponse };

export function createApp(): Server {
  return createServer(async (req, res) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';
    const parts = parsePath(path);
    const ctx: Ctx = { method, path, parts, req, res };

    // boot check — no token
    if (method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }

    // token from environment; also capture scenario token for auth comparisons
    const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
    if (expected && !store.token) store.token = expected;

    try {
      // git smart HTTP: /<owner>/<repo>.git/...
      if (parts.length >= 2 && parts[1].endsWith('.git')) {
        if (await handleGit(ctx)) return;
      }
      // GraphQL
      if (method === 'POST' && path === '/api/graphql') { if (await handleGraphql(ctx)) return; }
      // MCP
      if (path === '/mcp') { if (await handleMcp(ctx)) return; }
      // REST v3
      if (parts[0] === 'api' && parts[1] === 'v3') { if (await handleRest(ctx)) return; }

      // API root (checked for X-Oauth-Scopes)
      if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
        sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
          { 'x-oauth-scopes': 'repo, read:org' });
        return;
      }
      err(res, 404, 'Not Found');
    } catch (e) {
      err(res, 500, 'Internal Server Error');
    }
  });
}
