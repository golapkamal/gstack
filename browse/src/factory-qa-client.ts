/**
 * Factory QA protocol v1 client.
 *
 * A Factory assurance attempt exposes Chromium only through an attempt-scoped
 * Unix socket. When all three FACTORY_QA_* variables are present, this client
 * is the complete browse transport: it never reads daemon state or falls back
 * to loopback HTTP.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createConnection } from 'node:net';

export const FACTORY_QA_PROTOCOL_VERSION = 1 as const;
export const FACTORY_QA_CAPABILITIES = [
  'status',
  'navigate',
  'screenshot',
  'eval',
  'snapshot',
  'click',
  'fill',
  'select',
  'press',
  'hover',
  'console',
  'viewport',
  'wait',
] as const;

export type FactoryQaCapability = typeof FACTORY_QA_CAPABILITIES[number];

export interface FactoryQaConfig {
  socketPath: string;
  token: string;
  origin: string;
  timeoutMs?: number;
}

type RequestBase = {
  schemaVersion: typeof FACTORY_QA_PROTOCOL_VERSION;
  id: number;
  token: string;
};

export type FactoryQaRequestV1 =
  | RequestBase & { op: 'status' }
  | RequestBase & { op: 'navigate'; url: string }
  | RequestBase & { op: 'screenshot'; name: string }
  | RequestBase & { op: 'eval'; expression: string; awaitPromise: true }
  | RequestBase & {
      op: 'snapshot';
      options: {
        interactiveOnly: boolean;
        compact: boolean;
        diff: boolean;
        cursorInteractive: boolean;
        includeLinks: boolean;
        depth?: number;
        annotate?: { name: string };
      };
    }
  | RequestBase & { op: 'click'; ref: string }
  | RequestBase & { op: 'fill'; ref: string; value: string }
  | RequestBase & { op: 'select'; ref: string; value: string }
  | RequestBase & { op: 'press'; key: string }
  | RequestBase & { op: 'hover'; ref: string }
  | RequestBase & { op: 'console'; errorsOnly: boolean; clear: boolean }
  | RequestBase & { op: 'viewport'; width: number; height: number; deviceScaleFactor: number }
  | RequestBase & {
      op: 'wait';
      condition: 'load' | 'networkidle' | 'ref' | 'selector';
      timeoutMs: number;
      ref?: string;
      selector?: string;
    };

type JsonRecord = Record<string, unknown>;

export class FactoryQaClientError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'FactoryQaClientError';
  }
}

const FACTORY_ENV_NAMES = [
  'FACTORY_QA_BROWSE_SOCKET',
  'FACTORY_QA_TOKEN',
  'FACTORY_QA_ORIGIN',
] as const;
const FACTORY_RESPONSE_MAX_BYTES = 1_048_576;
const FACTORY_WAIT_TIMEOUT_MS = 15_000;
const FACTORY_REF = /^@[ec][1-9]\d*$/;
const FACTORY_ARTIFACT_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** Resolve all-or-none Factory activation without ever including values in errors. */
export function resolveFactoryQaConfig(
  env: Record<string, string | undefined> = process.env,
): FactoryQaConfig | null {
  const present = FACTORY_ENV_NAMES.filter((name) => env[name] !== undefined);
  if (present.length === 0) return null;
  if (present.length !== FACTORY_ENV_NAMES.length) {
    const missing = FACTORY_ENV_NAMES.filter((name) => env[name] === undefined);
    throw new FactoryQaClientError(
      `Factory QA configuration is incomplete; missing ${missing.join(', ')}. `
      + 'Set all three FACTORY_QA_* variables or none.',
      'factory-config-partial',
    );
  }

  const socketPath = env.FACTORY_QA_BROWSE_SOCKET!;
  const token = env.FACTORY_QA_TOKEN!;
  const origin = env.FACTORY_QA_ORIGIN!;
  if (!socketPath || !token || !origin) {
    throw new FactoryQaClientError(
      'Factory QA configuration is invalid; all three FACTORY_QA_* variables must be non-empty.',
      'factory-config-invalid',
    );
  }
  if (!path.isAbsolute(socketPath) || socketPath.includes('\0')) {
    throw new FactoryQaClientError(
      'Factory QA socket must be an absolute NUL-free path.',
      'factory-config-invalid',
    );
  }
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new FactoryQaClientError('Factory QA origin is not a valid URL origin.', 'factory-config-invalid');
  }
  if (
    !['http:', 'https:'].includes(parsedOrigin.protocol)
    || parsedOrigin.origin !== origin
    || parsedOrigin.username !== ''
    || parsedOrigin.password !== ''
  ) {
    throw new FactoryQaClientError(
      'Factory QA origin must be an exact credential-free HTTP(S) origin.',
      'factory-config-invalid',
    );
  }
  return { socketPath, token, origin };
}

function incompatible(message: string): never {
  throw new FactoryQaClientError(
    `Factory QA protocol v${FACTORY_QA_PROTOCOL_VERSION} incompatibility: ${message}. `
    + 'The ordinary HTTP browse daemon is disabled in Factory mode.',
    'factory-protocol-incompatible',
  );
}

function requireArgs(command: string, args: string[], count: number, usage: string): void {
  if (args.length !== count || args.some((arg) => arg.length === 0)) {
    throw new FactoryQaClientError(`Usage: browse ${usage}`, `factory-${command}-usage`);
  }
}

function requireRef(ref: string, command: string): string {
  if (!FACTORY_REF.test(ref)) {
    incompatible(`${command} requires a controller-issued @e/@c reference from snapshot`);
  }
  return ref;
}

function artifactName(input: string | undefined, fallback: string): string {
  const basename = path.basename(input || fallback);
  const name = basename.toLowerCase().endsWith('.png') ? basename.slice(0, -4) : basename;
  if (!FACTORY_ARTIFACT_NAME.test(name)) {
    incompatible('screenshot output must resolve to a 1-64 character safe artifact name');
  }
  return name;
}

function isPathWithin(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeReadRoots(): string[] {
  const classicTemp = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const roots = [process.cwd(), classicTemp];
  const runtimeTemp = path.resolve(os.tmpdir());
  const rootPath = path.parse(runtimeTemp).root;
  if (
    runtimeTemp !== rootPath
    && runtimeTemp !== path.resolve(os.homedir())
    && (!isPathWithin(path.resolve(process.cwd()), runtimeTemp) || isPathWithin(runtimeTemp, path.resolve(classicTemp)))
  ) roots.push(runtimeTemp);
  return [...new Set(roots.map((root) => {
    try { return fs.realpathSync(root); } catch { return path.resolve(root); }
  }))];
}

function factoryEvalPath(input: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync(input);
  } catch {
    throw new FactoryQaClientError('Factory QA eval file was not found or could not be resolved.', 'factory-eval-file');
  }
  if (!safeReadRoots().some((root) => isPathWithin(resolved, root)) || !fs.statSync(resolved).isFile()) {
    throw new FactoryQaClientError('Factory QA eval file must be a regular file under the working or temporary directory.', 'factory-eval-file');
  }
  return resolved;
}

function wrapUntrustedContent(result: string, url: string): string {
  const safeUrl = url.replace(/[\n\r]/g, '').slice(0, 200);
  const safeResult = result.replace(/--- (BEGIN|END) UNTRUSTED EXTERNAL CONTENT/g, '--- $1 UNTRUSTED EXTERNAL C\u200BONTENT');
  return `--- BEGIN UNTRUSTED EXTERNAL CONTENT (source: ${safeUrl}) ---\n${safeResult}\n--- END UNTRUSTED EXTERNAL CONTENT ---`;
}

function pinnedUrl(origin: string, input: string): string {
  let target: URL;
  try {
    target = new URL(input, `${origin}/`);
  } catch {
    throw new FactoryQaClientError('Factory QA navigation URL is malformed.', 'factory-navigation-invalid');
  }
  if (target.origin !== origin || target.username !== '' || target.password !== '') {
    throw new FactoryQaClientError(
      'Factory QA navigation is pinned to FACTORY_QA_ORIGIN.',
      'factory-origin-pinned',
    );
  }
  return target.toString();
}

function snapshotOptions(args: string[]): Extract<FactoryQaRequestV1, { op: 'snapshot' }>['options'] {
  const options: Extract<FactoryQaRequestV1, { op: 'snapshot' }>['options'] = {
    interactiveOnly: false,
    compact: false,
    diff: false,
    cursorInteractive: false,
    includeLinks: false,
  };
  let annotate = false;
  let output: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '-i' || arg === '--interactive') options.interactiveOnly = true;
    else if (arg === '-c' || arg === '--compact') options.compact = true;
    else if (arg === '-D' || arg === '--diff') options.diff = true;
    else if (arg === '-C' || arg === '--cursor-interactive') options.cursorInteractive = true;
    else if (arg === '-a' || arg === '--annotate') annotate = true;
    else if (arg === '-d' || arg === '--depth') {
      const value = args[++index];
      if (!value || !/^\d+$/.test(value)) {
        throw new FactoryQaClientError('Usage: browse snapshot -d <non-negative integer>', 'factory-snapshot-usage');
      }
      const depth = Number(value);
      if (!Number.isSafeInteger(depth)) {
        throw new FactoryQaClientError('Factory QA snapshot depth is too large.', 'factory-snapshot-usage');
      }
      options.depth = depth;
    } else if (arg === '-o' || arg === '--output') {
      output = args[++index];
      if (!output) {
        throw new FactoryQaClientError('Usage: browse snapshot -a -o <artifact.png>', 'factory-snapshot-usage');
      }
    } else {
      incompatible(`snapshot flag ${JSON.stringify(arg)} is not supported`);
    }
  }
  if (output && !annotate) {
    throw new FactoryQaClientError('Factory QA snapshot -o requires -a.', 'factory-snapshot-usage');
  }
  if (annotate) options.annotate = { name: artifactName(output, 'snapshot') };
  return options;
}

/** Translate one public browse command into the exact Factory protocol request. */
export function buildFactoryQaRequest(
  config: FactoryQaConfig,
  command: string,
  args: string[],
  id = 1,
): FactoryQaRequestV1 {
  const base: RequestBase = { schemaVersion: FACTORY_QA_PROTOCOL_VERSION, id, token: config.token };
  switch (command) {
    case 'status':
      requireArgs(command, args, 0, 'status');
      return { ...base, op: 'status' };
    case 'goto':
      requireArgs(command, args, 1, 'goto <same-origin-url>');
      return { ...base, op: 'navigate', url: pinnedUrl(config.origin, args[0]!) };
    case 'screenshot':
      if (args.length > 1 || args.some((arg) => arg.startsWith('-') || FACTORY_REF.test(arg))) {
        incompatible('screenshot supports only a controller-owned artifact name/path');
      }
      return { ...base, op: 'screenshot', name: artifactName(args[0], 'screenshot') };
    case 'js':
      requireArgs(command, args, 1, 'js <expression>');
      if (args[0]!.length > 4000) incompatible('js expression exceeds the 4000-character protocol ceiling');
      return { ...base, op: 'eval', expression: args[0]!, awaitPromise: true };
    case 'eval': {
      requireArgs(command, args, 1, 'eval <js-file>');
      const expression = fs.readFileSync(factoryEvalPath(args[0]!), 'utf8');
      if (expression.length > 4000) incompatible('eval file exceeds the 4000-character protocol ceiling');
      return { ...base, op: 'eval', expression, awaitPromise: true };
    }
    case 'snapshot':
      return { ...base, op: 'snapshot', options: snapshotOptions(args) };
    case 'links':
      requireArgs(command, args, 0, 'links');
      return {
        ...base,
        op: 'snapshot',
        options: {
          interactiveOnly: false,
          compact: true,
          diff: false,
          cursorInteractive: false,
          includeLinks: true,
        },
      };
    case 'click':
      requireArgs(command, args, 1, 'click <@ref>');
      return { ...base, op: 'click', ref: requireRef(args[0]!, command) };
    case 'fill':
      requireArgs(command, args, 2, 'fill <@ref> <value>');
      return { ...base, op: 'fill', ref: requireRef(args[0]!, command), value: args[1]! };
    case 'select':
      requireArgs(command, args, 2, 'select <@ref> <value>');
      return { ...base, op: 'select', ref: requireRef(args[0]!, command), value: args[1]! };
    case 'press':
      requireArgs(command, args, 1, 'press <key>');
      return { ...base, op: 'press', key: args[0]! };
    case 'hover':
      requireArgs(command, args, 1, 'hover <@ref>');
      return { ...base, op: 'hover', ref: requireRef(args[0]!, command) };
    case 'console': {
      let errorsOnly = false;
      let clear = false;
      for (const arg of args) {
        if (arg === '--errors') errorsOnly = true;
        else if (arg === '--clear') clear = true;
        else incompatible(`console flag ${JSON.stringify(arg)} is not supported`);
      }
      return { ...base, op: 'console', errorsOnly, clear };
    }
    case 'viewport': {
      if (args.length !== 1 && args.length !== 3) {
        throw new FactoryQaClientError('Usage: browse viewport <WxH> [--scale <1-3>]', 'factory-viewport-usage');
      }
      const dimensions = /^(\d+)x(\d+)$/.exec(args[0] || '');
      const scale = args.length === 3 && args[1] === '--scale' ? Number(args[2]) : 1;
      if (!dimensions || !Number.isFinite(scale) || scale < 1 || scale > 3) {
        throw new FactoryQaClientError('Usage: browse viewport <WxH> [--scale <1-3>]', 'factory-viewport-usage');
      }
      const width = Number(dimensions[1]);
      const height = Number(dimensions[2]);
      if (width < 1 || height < 1 || width > 10_000 || height > 10_000) {
        throw new FactoryQaClientError('Factory QA viewport dimensions must be between 1 and 10000.', 'factory-viewport-usage');
      }
      return { ...base, op: 'viewport', width, height, deviceScaleFactor: scale };
    }
    case 'wait': {
      requireArgs(command, args, 1, 'wait <@ref|selector|--networkidle|--load>');
      const target = args[0]!;
      if (target === '--load') return { ...base, op: 'wait', condition: 'load', timeoutMs: FACTORY_WAIT_TIMEOUT_MS };
      if (target === '--networkidle') return { ...base, op: 'wait', condition: 'networkidle', timeoutMs: FACTORY_WAIT_TIMEOUT_MS };
      if (FACTORY_REF.test(target)) {
        return { ...base, op: 'wait', condition: 'ref', ref: target, timeoutMs: FACTORY_WAIT_TIMEOUT_MS };
      }
      if (target.length > 1000) incompatible('wait selector exceeds the 1000-character protocol ceiling');
      return { ...base, op: 'wait', condition: 'selector', selector: target, timeoutMs: FACTORY_WAIT_TIMEOUT_MS };
    }
    default:
      incompatible(`browse command ${JSON.stringify(command)} is not supported`);
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(record: JsonRecord, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in record) && Object.keys(record).every((key) => allowed.has(key));
}

function validRefEntry(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['ref', 'role', 'name'])
    && typeof value.ref === 'string' && FACTORY_REF.test(value.ref)
    && typeof value.role === 'string'
    && typeof value.name === 'string';
}

function validLinkEntry(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['ref', 'text', 'href'])
    && typeof value.ref === 'string' && FACTORY_REF.test(value.ref)
    && typeof value.text === 'string'
    && typeof value.href === 'string';
}

function validScreenshot(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['path', 'bytes'])
    && typeof value.path === 'string'
    && typeof value.bytes === 'number' && Number.isSafeInteger(value.bytes) && value.bytes >= 0;
}

function assertSuccessShape(request: FactoryQaRequestV1, response: JsonRecord): void {
  const common = ['schemaVersion', 'id', 'ok'];
  const exact = (required: string[], optional: string[] = []) => {
    if (!hasExactKeys(response, [...common, ...required], optional)) incompatible(`invalid ${request.op} response shape`);
  };
  switch (request.op) {
    case 'status': {
      exact(['origin', 'capabilities']);
      const capabilities = response.capabilities;
      if (response.origin !== undefined && typeof response.origin !== 'string') incompatible('status origin is invalid');
      if (!Array.isArray(capabilities)
        || capabilities.some((item) => typeof item !== 'string')
        || capabilities.length !== FACTORY_QA_CAPABILITIES.length
        || FACTORY_QA_CAPABILITIES.some((op) => !capabilities.includes(op))) {
        incompatible('capsule does not advertise the complete protocol v1 capability set');
      }
      return;
    }
    case 'navigate':
      exact(['url']);
      if (typeof response.url !== 'string') incompatible('navigate URL is invalid');
      return;
    case 'screenshot':
      exact(['path', 'bytes']);
      if (!validScreenshot({ path: response.path, bytes: response.bytes })) incompatible('screenshot result is invalid');
      return;
    case 'eval':
      exact(['value']);
      if (typeof response.value !== 'string') incompatible('eval value is invalid');
      return;
    case 'snapshot':
      exact(['tree', 'refs', 'links'], ['screenshot']);
      if (typeof response.tree !== 'string'
        || !Array.isArray(response.refs) || !response.refs.every(validRefEntry)
        || !Array.isArray(response.links) || !response.links.every(validLinkEntry)
        || (response.screenshot !== undefined && !validScreenshot(response.screenshot))) {
        incompatible('snapshot result is invalid');
      }
      return;
    case 'console':
      exact(['messages']);
      if (!Array.isArray(response.messages) || !response.messages.every((entry) =>
        isRecord(entry)
        && hasExactKeys(entry, ['level', 'text'])
        && ['debug', 'log', 'info', 'warning', 'error'].includes(String(entry.level))
        && typeof entry.text === 'string')) incompatible('console result is invalid');
      return;
    case 'viewport':
      exact(['width', 'height', 'deviceScaleFactor']);
      if (![response.width, response.height, response.deviceScaleFactor].every((value) => typeof value === 'number')) {
        incompatible('viewport result is invalid');
      }
      return;
    case 'wait':
      exact(['condition', 'elapsedMs']);
      if (response.condition !== request.condition
        || typeof response.elapsedMs !== 'number'
        || !Number.isSafeInteger(response.elapsedMs)
        || response.elapsedMs < 0) incompatible('wait result is invalid');
      return;
    default:
      exact([]);
  }
}

function redactToken(value: string, token: string): string {
  return token ? value.split(token).join('[REDACTED]') : value;
}

function parseResponse(request: FactoryQaRequestV1, value: unknown, token: string): JsonRecord {
  if (!isRecord(value)
    || value.schemaVersion !== FACTORY_QA_PROTOCOL_VERSION
    || value.id !== request.id
    || typeof value.ok !== 'boolean') {
    incompatible('capsule returned a malformed or mismatched response');
  }
  if (value.ok === false) {
    if (!hasExactKeys(value, ['schemaVersion', 'id', 'ok', 'error']) || !isRecord(value.error)
      || !hasExactKeys(value.error, ['code', 'message'])
      || typeof value.error.code !== 'string' || typeof value.error.message !== 'string') {
      incompatible('capsule returned a malformed error response');
    }
    const code = value.error.code;
    const message = redactToken(value.error.message, token);
    throw new FactoryQaClientError(
      `Factory QA protocol v${FACTORY_QA_PROTOCOL_VERSION} rejected ${request.op} (${code}): ${message}`,
      code,
    );
  }
  assertSuccessShape(request, value);
  return value;
}

function formatResponse(
  config: FactoryQaConfig,
  command: string,
  request: FactoryQaRequestV1,
  response: JsonRecord,
): string {
  let output: string;
  if (command === 'links') {
    const links = response.links as Array<{ text: string; href: string }>;
    output = wrapUntrustedContent(links.map((link) => `${link.text} → ${link.href}`).join('\n'), config.origin);
  } else {
    switch (request.op) {
      case 'status':
        if (response.origin !== config.origin) incompatible('status returned an origin different from FACTORY_QA_ORIGIN');
        output = `Mode: factory\nOrigin: ${response.origin}\nProtocol: ${FACTORY_QA_PROTOCOL_VERSION}\nCapabilities: ${(response.capabilities as string[]).join(', ')}`;
        break;
      case 'navigate': {
        let responseOrigin = '';
        try { responseOrigin = new URL(response.url as string).origin; } catch {}
        if (responseOrigin !== config.origin) incompatible('navigate returned an off-origin URL');
        output = `Navigated to ${response.url}`;
        break;
      }
      case 'screenshot':
        output = `[screenshot: ${response.path}] (${response.bytes} bytes)`;
        break;
      case 'eval':
        output = response.value as string;
        break;
      case 'snapshot': {
        output = wrapUntrustedContent(response.tree as string, config.origin);
        if (response.screenshot) {
          const shot = response.screenshot as { path: string; bytes: number };
          output += `\n[annotated screenshot: ${shot.path}] (${shot.bytes} bytes)`;
        }
        break;
      }
      case 'click': output = `Clicked ${request.ref}`; break;
      case 'fill': output = `Filled ${request.ref}`; break;
      case 'select': output = `Selected ${request.ref}`; break;
      case 'press': output = `Pressed ${request.key}`; break;
      case 'hover': output = `Hovered ${request.ref}`; break;
      case 'console': {
        const messages = response.messages as Array<{ level: string; text: string }>;
        const text = messages.length === 0
          ? 'No console messages.'
          : messages.map((entry) => `[${entry.level}] ${entry.text}`).join('\n');
        output = wrapUntrustedContent(text, config.origin);
        break;
      }
      case 'viewport':
        output = `Viewport set to ${response.width}x${response.height} (scale ${response.deviceScaleFactor})`;
        break;
      case 'wait':
        output = `Wait complete: ${response.condition} (${response.elapsedMs}ms)`;
        break;
    }
  }
  return redactToken(output, config.token);
}

export class FactoryQaBrowseClient {
  private nextId = 1;

  constructor(private readonly config: FactoryQaConfig) {}

  async command(command: string, args: string[] = []): Promise<string> {
    try {
      const request = buildFactoryQaRequest(this.config, command, args, this.nextId++);
      const response = await this.request(request);
      return formatResponse(this.config, command, request, response);
    } catch (error) {
      const message = redactToken(error instanceof Error ? error.message : String(error), this.config.token);
      const code = error instanceof FactoryQaClientError && error.code
        ? redactToken(error.code, this.config.token)
        : undefined;
      throw new FactoryQaClientError(message, code);
    }
  }

  private request(request: FactoryQaRequestV1): Promise<JsonRecord> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.config.socketPath });
      let settled = false;
      let buffered = '';
      const finish = (error?: Error, response?: JsonRecord) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(response!);
      };
      const timer = setTimeout(() => finish(new FactoryQaClientError(
        `Factory QA socket request timed out after ${this.config.timeoutMs ?? 30_000}ms.`,
        'factory-socket-timeout',
      )), this.config.timeoutMs ?? 30_000);

      socket.setEncoding('utf8');
      socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on('data', (chunk: string) => {
        buffered += chunk;
        if (Buffer.byteLength(buffered, 'utf8') > FACTORY_RESPONSE_MAX_BYTES) {
          finish(new FactoryQaClientError('Factory QA response exceeded the 1 MiB client ceiling.', 'factory-response-too-large'));
          return;
        }
        const newline = buffered.indexOf('\n');
        if (newline === -1) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(buffered.slice(0, newline));
        } catch {
          finish(new FactoryQaClientError('Factory QA capsule returned malformed JSON.', 'factory-response-malformed'));
          return;
        }
        try {
          finish(undefined, parseResponse(request, parsed, this.config.token));
        } catch (error) {
          finish(error instanceof Error ? error : new FactoryQaClientError('Factory QA response failed validation.'));
        }
      });
      socket.once('error', (error: NodeJS.ErrnoException) => finish(new FactoryQaClientError(
        `Factory QA socket request failed (${error.code || 'socket-error'}).`,
        'factory-socket-error',
      )));
      socket.once('close', () => {
        if (!settled) finish(new FactoryQaClientError('Factory QA socket closed before a response.', 'factory-socket-closed'));
      });
    });
  }
}
