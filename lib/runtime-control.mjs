import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { PLUGIN_ID } from './constants.mjs';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function localHttpJson({ port, path, method = 'GET', headers = {}, timeoutMs = 2_000 }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        agent: false,
        headers
      },
      res => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          if (raw.length < 65_536) raw += chunk;
        });
        res.on('end', () => {
          let body = {};
          try {
            body = raw ? JSON.parse(raw) : {};
          } catch {
            body = {};
          }
          resolve({ statusCode: res.statusCode || 0, body });
        });
        res.on('error', reject);
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Runtime request timeout')));
    req.on('error', reject);
    req.end();
  });
}

export async function servePluginRuntime({
  directory,
  version,
  stop,
  getHealth,
  exitProcess = () => process.exit(0)
}) {
  const token = randomBytes(24).toString('hex');
  const recordFile = join(directory, `${process.pid}-${randomUUID()}.json`);

  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(403).end();
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      try {
        const healthPayload = await getHealth();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ id: PLUGIN_ID, version, pid: process.pid, ...healthPayload }));
      } catch {
        res.writeHead(503).end();
      }
      return;
    }
    if (req.method === 'POST' && req.url === '/stop') {
      try {
        await stop({ purge: req.headers['x-agy-purge'] === 'true' });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end('{}');
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end('{}');
      } finally {
        try {
          unlinkSync(recordFile);
        } catch {}
        server.close();
        setTimeout(exitProcess, 100).unref();
      }
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  mkdirSync(directory, { recursive: true });
  writeFileSync(
    recordFile,
    JSON.stringify({
      id: PLUGIN_ID,
      version,
      pid: process.pid,
      port: server.address().port,
      token
    }),
    { mode: 0o600 }
  );

  return async () => {
    try {
      unlinkSync(recordFile);
    } catch {}
    await new Promise(resolve => server.close(resolve));
  };
}

export function listRuntimeRecords(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter(name => /^\d+-[\da-f-]+\.json$/.test(name))
    .flatMap(name => {
      const file = join(directory, name);
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (
          parsed?.id === PLUGIN_ID &&
          Number.isInteger(parsed.port) &&
          parsed.port > 0 &&
          parsed.port < 65_536 &&
          typeof parsed.token === 'string' &&
          /^[a-f\d]{48}$/.test(parsed.token)
        ) {
          return [{ ...parsed, file }];
        }
        return [];
      } catch {
        return [];
      }
    });
}

export async function findActiveRuntime(directory) {
  for (const record of listRuntimeRecords(directory)) {
    try {
      const { statusCode, body } = await localHttpJson({
        port: record.port,
        path: '/health',
        headers: { authorization: `Bearer ${record.token}` },
        timeoutMs: 1_500
      });
      if (statusCode === 200 && body?.id === PLUGIN_ID) {
        return { ...record, health: body };
      }
    } catch {
      try {
        unlinkSync(record.file);
      } catch {}
    }
  }
  return null;
}

export async function stopExistingRuntimes(directory, { purge = false } = {}) {
  const records = listRuntimeRecords(directory);
  await Promise.all(
    records.map(async record => {
      try {
        await localHttpJson({
          port: record.port,
          path: '/stop',
          method: 'POST',
          headers: {
            authorization: `Bearer ${record.token}`,
            'x-agy-purge': String(purge)
          },
          timeoutMs: 6_000
        });
      } catch {
        // Stale runtime file is cleaned up below.
      }
      try {
        unlinkSync(record.file);
      } catch {}
    })
  );
  if (records.length > 0) {
    await delay(200);
  }
}
