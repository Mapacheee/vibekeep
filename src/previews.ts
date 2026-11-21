import { createServer, type Server } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { accessiblePath } from './paths.js';
import { artifactType } from './artifacts.js';

/** Untrusted project HTML runs on a different origin from the authenticated control UI. */
export class PreviewManager {
  private server?: Server;
  private origin?: string;
  private readonly token = randomBytes(24).toString('hex');
  constructor(readonly root: string) {}

  async url(path: string): Promise<string> {
    accessiblePath(this.root, path);
    if (!this.server) {
      this.server = createServer((request, response) => {
        try {
          if (request.method !== 'GET' || !request.url?.startsWith(`/${this.token}/`)) { response.writeHead(404).end(); return; }
          const raw = request.url.split('?')[0]!.slice(this.token.length + 2);
          const path = decodeURIComponent(raw) || 'index.html';
          const file = accessiblePath(this.root, path);
          if (statSync(file).size > 16 * 1024 * 1024) throw new Error('Preview file exceeds 16 MiB.');
          const content = readFileSync(file);
          let type = artifactType(path, content.includes(0)).mediaType ?? 'application/octet-stream';
          if (extname(path) === '.js' || extname(path) === '.mjs') type = 'text/javascript';
          response.writeHead(200, {
            'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'self'",
          }).end(content);
        } catch { response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Preview resource unavailable.'); }
      });
      await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(0, '127.0.0.1', resolve); });
      const address = this.server.address();
      if (!address || typeof address === 'string') throw new Error('Preview server did not start.');
      this.origin = `http://127.0.0.1:${address.port}`;
    }
    return `${this.origin}/${this.token}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }
  async close(): Promise<void> { if (this.server) await new Promise<void>(resolve => { this.server!.closeAllConnections(); this.server!.close(() => resolve()); }); this.server = undefined; }
}
