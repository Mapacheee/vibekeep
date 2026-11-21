import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { TeamBoard, operations } from './team-board.js';

const envelope = z.object({
  workspace: z.string().uuid(), action: z.enum(Object.keys(operations) as [keyof typeof operations, ...(keyof typeof operations)[]]),
  input: z.record(z.string(), z.unknown()), requestId: z.string().uuid().optional(),
});

export async function serveTeam(board: TeamBoard, port: number) {
  const server = createServer(async (req, res) => {
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'POST' || req.url !== '/team' || req.headers.origin) return reply(403, { error: 'Expected a team client request.' });
    const token = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization ?? '')?.[1];
    const actor = token && board.authenticate(token);
    if (!actor) return reply(401, { error: 'Invalid team credential.' });
    let size = 0;
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) return reply(413, { error: 'Team request too large.' });
        chunks.push(chunk);
      }
      const call = envelope.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const result = board.execute(actor, call.workspace, call.action, call.input, call.requestId);
      reply(200, result);
    } catch (error) {
      reply(400, { error: error instanceof Error ? error.message : 'Invalid request.' });
    }
  });
  server.requestTimeout = 15000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections();
    }) };
}
