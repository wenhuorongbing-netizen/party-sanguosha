import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';
import {
  APP_ID,
  APP_VERSION,
  GENERAL_PRESETS,
  type ExtensionInfo,
  type RoomInfo,
  type ServerInfo,
  type EntryInfo,
} from '../../../packages/shared/src/contracts.js';
import type { EngineAdapter } from '../../../packages/noname-adapter/src/index.js';
import { NonameAdapter } from '../../../packages/noname-adapter/src/index.js';
import { NativeNonameService } from '../../../packages/noname-adapter/src/service.js';
import { isLocalRequest, parseUpgradeUrl } from '../../../packages/noname-adapter/src/access.js';
import { AppError } from './errors.js';
import { findHomeUrls } from './network.js';
import { LobbyStore } from './lobby.js';

interface ServerOptions {
  webRoot: string;
  port: number;
  publicUrl?: string;
  adapter?: EngineAdapter;
  extensions?: ExtensionInfo[];
  entryMode?: EntryInfo['mode'];
}

function cookies(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    (request.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim().split('=').slice(0, 2))
      .filter((part) => part.length === 2),
  );
}

function matches(supplied: unknown, expected: string): boolean {
  if (typeof supplied !== 'string') return false;
  const value = Buffer.from(supplied);
  const known = Buffer.from(expected);
  return value.length === known.length && timingSafeEqual(value, known);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 4096) throw new AppError(413, 'BODY_TOO_LARGE', '请求内容过长。');
    chunks.push(Buffer.from(chunk));
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new AppError(400, 'INVALID_JSON', '请求格式无效。');
  }
}

export function createPartyServer(options: ServerOptions) {
  const instanceId = randomBytes(16).toString('hex');
  // 仅供本机双击停止脚本使用，不赋予任何玩家房主权限，也不进入公开 API。
  const controlToken = randomBytes(32).toString('base64url');
  const consoleToken = randomBytes(32).toString('base64url');
  const extensions = options.extensions ?? [];
  const engine = options.adapter ?? new NonameAdapter();
  const lobby = new LobbyStore(engine, extensions);
  const eventStreams = new Set<ServerResponse>();
  let internetUrl: string | undefined;
  let entry: EntryInfo =
    options.entryMode === 'internet'
      ? { mode: 'internet', status: 'starting', message: '正在准备跨网络入口，局域网可立即扫码…' }
      : { mode: 'lan', status: 'ready', message: '手机连接同一 Wi-Fi 或电脑热点后扫码。' };
  let retryInternet = () => {};
  const playerCookie = (request: IncomingMessage, value: string, expiry = 86400) =>
    `party_player=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${expiry}${request.headers['x-party-ingress'] === 'public' ? '; Secure' : ''}`;

  const server = createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      const known =
        error instanceof AppError
          ? error
          : new AppError(500, 'INTERNAL_ERROR', '服务遇到问题，请查看电脑上的服务日志。');
      if (!(error instanceof AppError)) console.error(error);
      json(response, known.status, { error: { code: known.code, message: known.message } });
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 15000;
  const realtime = new WebSocketServer({ noServer: true, maxPayload: 64 });
  server.on('upgrade', (request, socket, head) => {
    const url = parseUpgradeUrl(request, socket);
    if (!url || url.pathname !== '/api/realtime-check') return;
    let sameOrigin = true;
    try {
      if (request.headers.origin)
        sameOrigin = new URL(request.headers.origin).host === request.headers.host;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    realtime.handleUpgrade(request, socket, head, (ws) => {
      ws.on('error', () => {
        // ws already closes protocol-invalid peers. Consume its error event so
        // a bad public probe cannot terminate the shared game server.
      });
      const timeout = setTimeout(() => ws.terminate(), 10000);
      ws.once('close', () => clearTimeout(timeout));
      ws.once('message', () => ws.send('party-sanguosha-realtime'));
    });
  });
  if (engine instanceof NativeNonameService)
    engine.attach(server, (code, token) => {
      try {
        return lobby.get(code).session(token);
      } catch {
        return undefined;
      }
    });

  const closeStreams = () => {
    for (const stream of eventStreams) stream.end();
  };
  const stop = () => {
    clearInterval(pollExpiry);
    for (const socket of realtime.clients) socket.terminate();
    realtime.close();
    if (engine instanceof NativeNonameService) engine.close();
    closeStreams();
    server.close();
    server.closeIdleConnections();
  };
  const pollExpiry = setInterval(() => {
    lobby.sweep();
  }, 5000);
  pollExpiry.unref();
  server.once('close', () => clearInterval(pollExpiry));

  function stream<T>(
    response: ServerResponse,
    name: string,
    subscribe: (send: (data: T) => void) => () => void,
    snapshot: () => T,
    connect: () => () => void = () => () => {},
  ): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    eventStreams.add(response);
    const send = (data: T) => {
      if (!response.destroyed && !response.writableEnded) {
        response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        if (name === 'room' && (data as { phase?: string }).phase === 'closed') response.end();
      }
    };
    const unsubscribe = subscribe(send);
    const disconnect = connect();
    send(snapshot());
    const heartbeat = setInterval(() => {
      if (!response.destroyed && !response.writableEnded) response.write(': heartbeat\n\n');
    }, 10000);
    response.once('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      disconnect();
      eventStreams.delete(response);
    });
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const route = `${request.method} ${url.pathname}`;
    if (!['GET', 'HEAD'].includes(request.method ?? '') && request.headers.origin) {
      let validOrigin = false;
      try {
        validOrigin = new URL(request.headers.origin).host === request.headers.host;
      } catch {
        /* 拒绝无效 Origin。 */
      }
      if (!validOrigin) throw new AppError(403, 'INVALID_ORIGIN', '请从本机房间页面操作。');
    }
    const playerToken = cookies(request).party_player;
    if (url.pathname.startsWith('/api/console')) {
      if (!isLocalRequest(request) || !matches(cookies(request).party_console, consoleToken))
        throw new AppError(403, 'CONSOLE_REQUIRED', '请在服务器电脑的控制台操作。');
      if (route === 'GET /api/console') {
        json(response, 200, {
          rooms: lobby.list().map(({ code }) => ({
            room: lobby.get(code).snapshot(),
            ...(engine instanceof NativeNonameService
              ? engine.observe(code)
              : { observer: null, networks: [] }),
          })),
        });
        return;
      }
      const logRoom = /^\/api\/console\/rooms\/([A-F0-9]{6})\/log$/.exec(url.pathname);
      if (request.method === 'GET' && logRoom) {
        lobby.get(logRoom[1]!);
        const before = url.searchParams.has('before')
          ? Number(url.searchParams.get('before'))
          : undefined;
        if (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
          throw new AppError(400, 'INVALID_LOG_CURSOR', '记录位置无效。');
        const page =
          engine instanceof NativeNonameService
            ? engine.observerLog(logRoom[1]!, url.searchParams.get('match') ?? '', before)
            : null;
        if (!page) throw new AppError(409, 'MATCH_CHANGED', '本局已变化，请查看当前对局。');
        json(response, 200, page);
        return;
      }
      const command =
        /^\/api\/console\/rooms\/([A-F0-9]{6})(?:\/(reset|animation-speed|players\/[\w-]+))?$/.exec(
          url.pathname,
        );
      if (command) {
        const room = lobby.get(command[1]!);
        // Refuse a stale operator click after the room has changed phase/seat.
        const revision = Number(request.headers['x-party-revision']);
        if (!Number.isSafeInteger(revision) || revision !== room.snapshot().revision)
          throw new AppError(409, 'ROOM_CHANGED', '房间刚刚有变化，请查看更新后再操作。');
        if (request.method === 'DELETE' && !command[2]) room.consoleClose();
        else if (request.method === 'PUT' && command[2] === 'animation-speed')
          room.consoleSetAnimationSpeed((await readBody(request)).animationSpeed);
        else if (request.method === 'POST' && command[2] === 'reset') room.consoleReset();
        else if (request.method === 'DELETE' && command[2]?.startsWith('players/'))
          room.consoleRemovePlayer(command[2].slice(8));
        else throw new AppError(405, 'INVALID_CONSOLE_ACTION', '这项控制台操作不可用。');
        json(response, 200, { ok: true });
        return;
      }
      throw new AppError(404, 'NOT_FOUND', '控制台接口不存在。');
    }
    if (engine instanceof NativeNonameService && (await engine.handle(request, response))) return;
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : options.port;
    const publicAccess = request.headers['x-party-ingress'] === 'public';
    const localUrls =
      options.publicUrl ||
      (typeof address === 'object' &&
        address &&
        !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address.address))
        ? findHomeUrls(actualPort, options.publicUrl)
        : [];
    // A published public address stays shareable during a temporary outage.
    // Public visitors do not receive the computer's private network addresses.
    const publicUrls = internetUrl ? [internetUrl] : [];
    const homeUrls = publicAccess ? publicUrls : [...localUrls, ...publicUrls];
    const responseEntry: EntryInfo = { ...entry, access: publicAccess ? 'internet' : 'lan' };
    const roomInfo = (code: string): RoomInfo => ({
      room: lobby.get(code).snapshot(),
      joinUrls: homeUrls.map((base) => new URL(`/join/${code}`, base).href),
      entry: responseEntry,
    });

    if (route === 'GET /api/health') {
      json(response, 200, {
        app: APP_ID,
        version: APP_VERSION,
        instanceId,
        ok: true,
        engineReady: engine.status().ready,
      });
      return;
    }
    if (route === 'POST /api/shutdown' || route === 'POST /api/internet/retry') {
      if (!isLocalRequest(request) || !matches(request.headers['x-party-control'], controlToken))
        throw new AppError(403, 'LOCAL_CONTROL_REQUIRED', '请在服务器电脑上双击停止脚本。');
      if (route === 'POST /api/shutdown') response.once('finish', stop);
      else retryInternet();
      json(response, 200, { ok: true });
      return;
    }
    if (route === 'GET /api/info') {
      const info: ServerInfo = {
        version: APP_VERSION,
        homeUrls,
        rooms: lobby.list(),
        extensions,
        engine: engine.status(),
        entry: responseEntry,
      };
      json(response, 200, info);
      return;
    }
    if (route === 'GET /api/me') {
      const token = lobby.identify(playerToken);
      if (token !== playerToken) response.setHeader('Set-Cookie', playerCookie(request, token));
      json(response, 200, lobby.session(token));
      return;
    }
    if (route === 'POST /api/rooms') {
      const created = lobby.create((await readBody(request)).nickname, playerToken);
      response.setHeader('Set-Cookie', playerCookie(request, created.token));
      json(response, 201, { ...roomInfo(created.room.code), playerId: created.playerId });
      return;
    }
    if (route === 'GET /api/events') {
      if (url.searchParams.get('transport') === 'poll') {
        json(response, 200, lobby.list());
        return;
      }
      stream(
        response,
        'lobby',
        (send) => lobby.subscribe(send),
        () => lobby.list(),
      );
      return;
    }

    const roomRoute =
      /^\/api\/rooms\/([A-F0-9]{6})(?:\/(players(?:\/[\w-]+)?|me(?:\/(?:ready|general))?|owner(?:\/claim)?|start|rematch|bots|events|animation-speed))?$/.exec(
        url.pathname,
      );
    if (roomRoute) {
      const code = roomRoute[1]!;
      const room = lobby.get(code);
      const operation = `${request.method} ${roomRoute[2] ?? ''}`;
      const body = [
        'POST players',
        'PUT me/ready',
        'PUT me/general',
        'PUT animation-speed',
        'PUT ',
        'POST bots',
        'PUT owner',
        'POST owner/claim',
      ].includes(operation)
        ? await readBody(request)
        : undefined;
      const expectedPlayer = request.headers['x-party-player'];
      if (
        expectedPlayer !== undefined &&
        !['GET', 'HEAD'].includes(request.method ?? '') &&
        operation !== 'POST players' &&
        room.session(playerToken)?.id !== expectedPlayer
      )
        throw new AppError(409, 'SEAT_CHANGED', '你的席位已经变化，请刷新房间后再操作。');
      switch (operation) {
        case 'GET ':
          json(response, 200, roomInfo(code));
          return;
        case 'POST players': {
          const joined = lobby.join(code, body!.nickname, playerToken);
          response.setHeader('Set-Cookie', playerCookie(request, joined.token));
          json(response, 201, { ...roomInfo(code), playerId: joined.playerId });
          return;
        }
        case 'DELETE me':
          room.leave(playerToken);
          // Leaving removes membership, not browser identity. A late response
          // must not erase the cookie used by a subsequent join or create.
          json(response, 200, { ok: true });
          return;
        case 'PUT me/ready':
          room.setReady(playerToken, body!.ready);
          json(response, 200, room.snapshot());
          return;
        case 'GET me/general':
          json(response, 200, room.generalChoice(playerToken));
          return;
        case 'PUT me/general':
          json(response, 200, room.setGeneralChoice(playerToken, body!.general));
          return;
        case 'PUT ':
          room.updateSettings(body, playerToken);
          json(response, 200, room.snapshot());
          return;
        case 'PUT animation-speed':
          room.setAnimationSpeed(body!.animationSpeed, playerToken);
          json(response, 200, room.snapshot());
          return;
        case 'POST start':
          await room.start(playerToken);
          json(response, 200, room.snapshot());
          return;
        case 'POST rematch':
          room.returnToWaiting(playerToken);
          json(response, 200, room.snapshot());
          return;
        case 'PUT owner':
          room.transferOwnership(body!.playerId, playerToken);
          json(response, 200, room.snapshot());
          return;
        case 'POST owner/claim':
          room.claimOwnership(body!.ownerId, playerToken);
          json(response, 200, room.snapshot());
          return;
        case 'POST bots':
          room.addBots(body!.count, playerToken);
          json(response, 200, room.snapshot());
          return;
        case 'GET events':
          if (url.searchParams.get('transport') === 'poll') {
            room.poll(playerToken);
            json(response, 200, room.snapshot());
            return;
          }
          stream(
            response,
            'room',
            (send) => room.subscribe(send),
            () => room.snapshot(),
            () => room.connect(playerToken),
          );
          return;
      }
      if (request.method === 'DELETE' && roomRoute[2]?.startsWith('players/')) {
        room.removePlayer(roomRoute[2].slice('players/'.length), playerToken);
        json(response, 200, room.snapshot());
        return;
      }
    }

    if (route === 'GET /api/qr.svg' || route === 'GET /api/qr.png') {
      const code = url.searchParams.get('room');
      let allowed = homeUrls;
      if (code) {
        const room = lobby.get(code);
        if (!room.session(playerToken))
          throw new AppError(403, 'MEMBER_REQUIRED', '入座后可以展示本房间的邀请二维码。');
        allowed = roomInfo(code).joinUrls;
      }
      const target = url.searchParams.get('url');
      if (!target || !allowed.includes(target))
        throw new AppError(400, 'INVALID_QR_TARGET', '当前邀请入口未就绪，请刷新后再试。');
      if (url.pathname.endsWith('.png')) {
        response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        response.end(
          await QRCode.toBuffer(target, { width: 720, margin: 2, errorCorrectionLevel: 'M' }),
        );
        return;
      }
      const svg = await QRCode.toString(target, {
        type: 'svg',
        margin: 2,
        errorCorrectionLevel: 'M',
        color: { dark: '#172520', light: '#ffffff' },
      });
      response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
      response.end(svg);
      return;
    }
    // 旧原型电脑入口迁移到服务页，不再兑换任何房主权限。
    if (['/server', '/host'].includes(url.pathname) && !isLocalRequest(request))
      throw new AppError(
        403,
        'LOCAL_PAGE_REQUIRED',
        '电脑服务页只在服务器电脑打开，玩家请进入主页。',
      );
    if (route === 'GET /host') {
      response.writeHead(302, { Location: '/server' });
      response.end();
      return;
    }
    if (route === 'GET /server')
      response.setHeader(
        'Set-Cookie',
        `party_console=${consoleToken}; Path=/api/console; HttpOnly; SameSite=Strict`,
      );
    const assets: Record<string, { file: string; mime: string }> = {
      '/assets/app.js': { file: 'app.js', mime: 'text/javascript; charset=utf-8' },
      '/assets/style.css': { file: 'style.css', mime: 'text/css; charset=utf-8' },
      '/assets/generals.json': { file: 'generals.json', mime: 'application/json; charset=utf-8' },
      '/assets/table.js': { file: 'table.js', mime: 'text/javascript; charset=utf-8' },
      '/assets/table.css': { file: 'table.css', mime: 'text/css; charset=utf-8' },
    };
    for (const preset of GENERAL_PRESETS)
      assets[`/assets/generals-${preset.id}.json`] = {
        file: `generals-${preset.id}.json`,
        mime: 'application/json; charset=utf-8',
      };
    const asset =
      assets[url.pathname] ??
      (/^\/(server|join\/[A-F0-9]{6})?$/.test(url.pathname)
        ? { file: 'index.html', mime: 'text/html; charset=utf-8' }
        : undefined);
    if (asset && ['GET', 'HEAD'].includes(request.method ?? '')) {
      const content = await readFile(path.join(options.webRoot, asset.file));
      response.writeHead(200, { 'Content-Type': asset.mime, 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : content);
      return;
    }
    throw new AppError(404, 'NOT_FOUND', '页面不存在。');
  }

  return {
    server,
    lobby,
    instanceId,
    controlToken,
    closeStreams,
    stop,
    setInternetRetry: (retry: () => void) => {
      retryInternet = retry;
    },
    setInternetEntry: (status: EntryInfo['status'], message: string, url?: string) => {
      if (url && !/^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com\/$/.test(url))
        throw new Error('Invalid temporary public URL');
      if (url) internetUrl = url;
      entry = { mode: 'internet', status, message };
    },
  };
}
