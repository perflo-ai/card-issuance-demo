import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer, type ServerOptions } from 'node:https';
import { resolve } from 'node:path';
import express from 'express';
import { createDemoApp } from './app.js';
import { ConfigError, DEMO_ORIGIN, DEMO_PORT, loadConfig } from './config.js';
import { EventLog } from './eventLog.js';
import { createMockPerflo } from './mock/mockPerflo.js';
import { PerfloApi } from './perfloApi.js';
import { DemoService } from './service.js';
import { Store } from './store.js';

const CERT = resolve('certs/localhost.pem');
const KEY = resolve('certs/localhost-key.pem');

function tls(): ServerOptions {
  if (!existsSync(CERT) || !existsSync(KEY)) {
    throw new ConfigError('No local certificate. Run: npm run cert');
  }
  return { cert: readFileSync(CERT), key: readFileSync(KEY) };
}

function listen(
  server: ReturnType<typeof createHttpServer>,
  port: number,
  label: string,
  host = 'localhost',
): Promise<void> {
  return new Promise((done, fail) => {
    server.once('error', (error: NodeJS.ErrnoException) =>
      fail(error.code === 'EADDRINUSE' ? new ConfigError(`Port ${port} (${label}) is already in use`) : error),
    );
    server.listen(port, host, () => done());
  });
}

async function main(): Promise<void> {
  // On this computer the settings live in .env. A host sets them as variables
  // and has no file; a variable already set is never replaced by the file.
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = loadConfig();
  const hosted = config.listen.kind === 'hosted';
  const log = new EventLog();
  const store = new Store(config.dataFile);
  const api = new PerfloApi(config.perfloApiBase, config.credentials, log);
  const service = new DemoService(store, api, log, config);
  const app = createDemoApp({ config, store, service, log });

  if (config.mode === 'mock') {
    const certificate = tls();
    const base = new URL(config.perfloApiBase);
    const mock = createMockPerflo({
      partnerId: config.credentials.partnerId,
      keyVersion: config.credentials.keyVersion,
      secret: config.credentials.secret,
      selfOrigin: base.origin,
      partnerOrigin: DEMO_ORIGIN,
    });
    const mockServer = base.protocol === 'https:' ? createHttpsServer(certificate, mock) : createHttpServer(mock);
    const port = Number(base.port || (base.protocol === 'https:' ? 443 : 80));
    await listen(mockServer, port, 'mock payments service');
    console.log(`[mock] test payments service on ${base.origin}`);
  }

  // A host terminates HTTPS in front of the demo; here it needs the local certificate.
  const server = hosted ? createHttpServer(app) : createHttpsServer(tls(), app);
  if (process.env.NODE_ENV === 'production') {
    const webRoot = resolve('dist/web');
    app.use(express.static(webRoot, { index: 'index.html' }));
    app.get(/^(?!\/demo\/).*/, (_req, res) => res.sendFile(resolve(webRoot, 'index.html')));
  } else {
    const { createServer: createVite } = await import('vite');
    const vite = await createVite({
      configFile: resolve('web/vite.config.ts'),
      server: { middlewareMode: true, hmr: { server } },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }
  if (config.listen.kind === 'hosted') {
    await listen(server, config.listen.port, 'demo', '0.0.0.0');
    console.log(`[demo] Tiny on port ${config.listen.port} (${config.mode} mode, payments at ${config.perfloOrigin})`);
  } else {
    await listen(server, DEMO_PORT, 'demo');
    console.log(`[demo] Tiny on ${DEMO_ORIGIN} (${config.mode} mode, payments at ${config.perfloOrigin})`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? `[demo] ${error.message}` : error instanceof Error ? `[demo] ${error.name}: ${error.message}` : '[demo] failed to start');
  process.exit(1);
});
