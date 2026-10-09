import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer, type ServerOptions } from 'node:https';
import { resolve } from 'node:path';
import express from 'express';
import { createDemoApp } from './app.js';
import { ConfigError, DEMO_ORIGIN, DEMO_PORT, loadConfig } from './config.js';
import { EventLog } from './eventLog.js';
import { createLogger } from './logger.js';
import { createMockPerflo } from './mock/mockPerflo.js';
import { PerfloApi } from './perfloApi.js';
import { DemoService } from './service.js';
import { Store } from './store.js';

const CERT = resolve('certs/localhost.pem');
/** On SIGTERM, how long requests already on their way get to finish (a POST /orders can wait up to 90 s). */
const SHUTDOWN_GRACE_MS = 25_000;
const logger = createLogger();
const KEY = resolve('certs/localhost-key.pem');

function tls(): ServerOptions {
  if (!existsSync(CERT) || !existsSync(KEY)) {
    throw new ConfigError('No local certificate. Run: npm run cert');
  }
  return { cert: readFileSync(CERT), key: readFileSync(KEY) };
}

function listen(server: ReturnType<typeof createHttpServer>, port: number, label: string, host = 'localhost'): Promise<void> {
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
  const app = createDemoApp({ config, store, service, log, logger, production: process.env.NODE_ENV === 'production' });
  const servers: Array<ReturnType<typeof createHttpServer>> = [];

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
    servers.push(mockServer);
    logger.info('mock payments service listening', { origin: base.origin });
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
  } else {
    await listen(server, DEMO_PORT, 'demo');
  }
  servers.unshift(server);
  logger.info('Tiny listening', {
    at: config.listen.kind === 'hosted' ? `port ${config.listen.port}` : DEMO_ORIGIN,
    mode: config.mode,
    payments: config.perfloOrigin,
  });
  stopOnSignal(servers);
}

/**
 * Graceful stop for a host's redeploy: stop taking new connections, let
 * requests already running finish (a placed order is never cut off midway by
 * choice), then exit. A second signal, or the grace period running out, exits
 * at once. The store writes synchronously, so nothing is left half written.
 */
function stopOnSignal(servers: Array<ReturnType<typeof createHttpServer>>): void {
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) process.exit(1);
    stopping = true;
    logger.info('stopping', { signal });
    const force = setTimeout(() => {
      logger.warn('stopped before every request finished', { grace_ms: SHUTDOWN_GRACE_MS });
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();
    let open = servers.length;
    for (const server of servers) {
      server.close(() => {
        if (--open === 0) {
          logger.info('stopped');
          process.exit(0);
        }
      });
      server.closeIdleConnections();
    }
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((error: unknown) => {
  // A ConfigError is written for the operator; anything else is shown by name and message only.
  logger.error('failed to start', {
    reason: error instanceof ConfigError ? error.message : error instanceof Error ? `${error.name}: ${error.message}` : 'unknown',
  });
  process.exit(1);
});
