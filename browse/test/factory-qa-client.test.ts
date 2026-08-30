import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createServer, type Server } from 'node:net';
import {
  FACTORY_QA_CAPABILITIES,
  FACTORY_QA_PROTOCOL_VERSION,
  FactoryQaBrowseClient,
  buildFactoryQaRequest,
  resolveFactoryQaConfig,
  type FactoryQaConfig,
} from '../src/factory-qa-client';

const FIXTURE = JSON.parse(fs.readFileSync(
  path.join(import.meta.dir, 'fixtures', 'factory-qa-protocol-v1.json'),
  'utf8',
)) as {
  schemaVersion: number;
  origin: string;
  token: string;
  cases: Array<{
    name: string;
    command: string[];
    request: Record<string, unknown>;
    response: Record<string, unknown>;
  }>;
};

let socketSequence = 0;
const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

function socketPath(): string {
  const target = path.join(os.tmpdir(), `gstack-fqa-${process.pid}-${++socketSequence}.sock`);
  cleanupPaths.push(target);
  return target;
}

async function startMockSocket(response: Record<string, unknown>): Promise<{
  path: string;
  requests: Record<string, unknown>[];
  close(): Promise<void>;
}> {
  const target = socketPath();
  const requests: Record<string, unknown>[] = [];
  const server: Server = createServer((socket) => {
    let buffered = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      const newline = buffered.indexOf('\n');
      if (newline === -1) return;
      requests.push(JSON.parse(buffered.slice(0, newline)));
      socket.write(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(target, resolve);
  });
  return {
    path: target,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function config(socket: string): FactoryQaConfig {
  return { socketPath: socket, token: FIXTURE.token, origin: FIXTURE.origin, timeoutMs: 1000 };
}

describe('Factory QA protocol v1', () => {
  test('the checked-in fixture covers every protocol operation and exact request mapping', async () => {
    expect(FIXTURE.schemaVersion).toBe(FACTORY_QA_PROTOCOL_VERSION);
    expect(new Set(FIXTURE.cases.map((entry) => entry.request.op))).toEqual(new Set(FACTORY_QA_CAPABILITIES));

    for (const entry of FIXTURE.cases) {
      const mock = await startMockSocket(entry.response);
      try {
        const client = new FactoryQaBrowseClient(config(mock.path));
        await client.command(entry.command[0]!, entry.command.slice(1));
        expect(mock.requests, entry.name).toEqual([entry.request]);
      } finally {
        await mock.close();
      }
    }
  });

  test('the JSON schema operation enum stays aligned with the client', () => {
    const schema = JSON.parse(fs.readFileSync(
      path.join(import.meta.dir, '..', 'protocol', 'factory-qa-v1.schema.json'),
      'utf8',
    ));
    expect(schema.$defs.statusResponse.properties.capabilities.items.enum).toEqual([...FACTORY_QA_CAPABILITIES]);
    expect(schema.$defs.evalRequest.properties.schemaVersion.const).toBe(FACTORY_QA_PROTOCOL_VERSION);
  });

  test('Factory activation is all-or-none and errors never contain values', () => {
    expect(resolveFactoryQaConfig({})).toBeNull();
    const secret = 'do-not-print-this-token';
    expect(() => resolveFactoryQaConfig({ FACTORY_QA_TOKEN: secret })).toThrow('configuration is incomplete');
    try {
      resolveFactoryQaConfig({ FACTORY_QA_TOKEN: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  test('navigation is pinned before the socket is opened', () => {
    const cfg = config('/tmp/does-not-exist.sock');
    expect(() => buildFactoryQaRequest(cfg, 'goto', ['https://example.com'], 1))
      .toThrow('pinned to FACTORY_QA_ORIGIN');
  });

  test('unsupported commands and unrestricted interaction selectors fail explicitly', () => {
    const cfg = config('/tmp/does-not-exist.sock');
    expect(() => buildFactoryQaRequest(cfg, 'tabs', [], 1)).toThrow('protocol v1 incompatibility');
    expect(() => buildFactoryQaRequest(cfg, 'click', ['button'], 1)).toThrow('controller-issued @e/@c reference');
  });

  test('all errors and successful output redact the agent token', async () => {
    const errorMock = await startMockSocket({
      schemaVersion: 1,
      id: 1,
      ok: false,
      error: { code: FIXTURE.token, message: `bad ${FIXTURE.token}` },
    });
    try {
      let caught: unknown;
      try {
        await new FactoryQaBrowseClient(config(errorMock.path)).command('status');
      } catch (error) {
        caught = error;
      }
      expect(String(caught)).toContain('bad [REDACTED]');
      expect(String(caught)).not.toContain(FIXTURE.token);
      expect((caught as { code: string }).code).toBe('[REDACTED]');
    } finally {
      await errorMock.close();
    }

    const local = new FactoryQaBrowseClient(config('/tmp/does-not-exist.sock'));
    await expect(local.command(FIXTURE.token)).rejects.toThrow('[REDACTED]');

    const evalMock = await startMockSocket({ schemaVersion: 1, id: 1, ok: true, value: FIXTURE.token });
    try {
      expect(await new FactoryQaBrowseClient(config(evalMock.path)).command('js', ['document.title']))
        .toBe('[REDACTED]');
    } finally {
      await evalMock.close();
    }
  });

  test('CLI Factory mode does not health-check a valid ordinary daemon state', async () => {
    let httpRequests = 0;
    const http = Bun.serve({
      port: 0,
      fetch() {
        httpRequests++;
        return Response.json({ status: 'healthy' });
      },
    });
    const statusCase = FIXTURE.cases.find((entry) => entry.name === 'status')!;
    const mock = await startMockSocket(statusCase.response);
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-fqa-state-'));
    cleanupPaths.push(stateDir);
    const stateFile = path.join(stateDir, 'browse.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      pid: process.pid,
      port: http.port,
      token: 'ordinary-daemon-token',
      startedAt: new Date().toISOString(),
      serverPath: 'fixture',
    }));
    try {
      const cli = path.join(import.meta.dir, '..', 'src', 'cli.ts');
      const child = Bun.spawn([process.execPath, 'run', cli, 'status'], {
        cwd: path.join(import.meta.dir, '..', '..'),
        env: {
          ...process.env,
          BROWSE_STATE_FILE: stateFile,
          FACTORY_QA_BROWSE_SOCKET: mock.path,
          FACTORY_QA_TOKEN: FIXTURE.token,
          FACTORY_QA_ORIGIN: FIXTURE.origin,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode, stderr).toBe(0);
      expect(stdout).toContain('Mode: factory');
      expect(stdout).not.toContain(FIXTURE.token);
      expect(mock.requests).toEqual([statusCase.request]);
      expect(httpRequests).toBe(0);
    } finally {
      http.stop(true);
      await mock.close();
    }
  });
});
