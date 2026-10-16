import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type { EngineAdapter, EngineEvent, MatchSetup } from './index.js';
import {
  APP_VERSION,
  GENERAL_PRESETS,
  matchStartTimeout,
  type EngineStatus,
  type MatchFailureCode,
  type ObserverState,
  type PlayerNetwork,
} from '../../shared/src/contracts.js';
import { ObserverJournal, sanitizeObserver } from './observer.js';
import { EngineAssets } from './assets.js';
import { isLocalRequest, parseUpgradeUrl } from './access.js';
import { PollChannel } from './poll-channel.js';
import { LanBridge } from './lan-bridge.js';
import { sanitizeTable, tableAction } from './table.js';
import type { TableState } from '../../shared/src/table.js';
import { validateCardPile, type CardPile } from '../runtime/card-pile.js';
import { RuleClock } from './rule-clock.js';

type Match = {
  id: string;
  setup: MatchSetup;
  preset: RosterPreset;
  state: 'starting' | 'playing' | 'ended' | 'failed';
  host?: WebSocket;
  clock?: WebSocket;
  clockController?: RuleClock;
  executionId?: string;
  recoveryTimer?: NodeJS.Timeout;
  recoveryDeadline?: number;
  recovering: Set<'worker' | 'clock'>;
  players: Map<string, WebSocket | PollChannel>;
  tables: Map<string, WebSocket | PollChannel>;
  views: Set<string>;
  viewTimers: Map<string, NodeJS.Timeout>;
  tableStates: Map<string, TableState>;
  polling: Map<string, PollChannel>;
  pendingPlayers: {
    packet: { type: string; id: string; data?: string };
    source?: WebSocket | PollChannel;
  }[];
  pendingPlayerBytes: number;
  observer: ObserverState | null;
  journal: ObserverJournal;
  networks: Map<string, PlayerNetwork>;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};
type RosterPreset = {
  id: string;
  characters: string[];
  cardPile: CardPile;
  definitionPacks: { characters: string[]; cards: string[] };
};
type Membership = (roomCode: string, token?: string) => { id: string } | undefined;
type Portraits = {
  commit: string;
  hash: string;
  files: Record<string, { sha256: string; version?: string }>;
  characters: Record<string, string>;
};
const cookie = (request: IncomingMessage, name: string) =>
  (request.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};
function json(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, { 'Content-Type': types['.json']!, 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}
function send(socket: WebSocket | undefined, data: unknown) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
}
function safeMessage(data: string): boolean {
  if (data.length > 131072) return false;
  try {
    const message: unknown = JSON.parse(data);
    // Check decoded strings too; JSON Unicode escapes must not smuggle native
    // executable markers past a data-only command's early whitelist return.
    const decoded = JSON.stringify(message);
    if (decoded.includes('_noname_func:') || decoded.includes('_noname_event:')) return false;
    if (Array.isArray(message)) {
      if (message[0] === 'partyPing')
        return message.length === 2 && Number.isSafeInteger(message[1]) && message[1] > 0;
      if (message[0] === 'partyLuck')
        return (
          message.length === 4 &&
          typeof message[1] === 'string' &&
          /^[\w-]{1,80}$/.test(message[1]) &&
          Number.isSafeInteger(message[2]) &&
          message[2] >= 0 &&
          message[2] <= 3 &&
          ['refresh', 'keep'].includes(message[3])
        );
      if (message[0] === 'partySurrender')
        return (
          message.length === 3 &&
          typeof message[2] === 'string' &&
          (message[1] === 'request'
            ? message[2] === ''
            : ['approve', 'reject'].includes(message[1]) && /^[\w-]{1,80}$/.test(message[2]))
        );
      if (message[0] === 'throwEmotion')
        return (
          (message.length === 3 || (message.length === 4 && typeof message[3] === 'boolean')) &&
          typeof message[1] === 'string' &&
          /^_noname_player:[\w-]{1,80}$/.test(message[1]) &&
          ['flower', 'egg', 'wine', 'shoe'].includes(message[2])
        );
    }
    // These are native player actions. Configuration, arbitrary execution,
    // deck inspection and the upstream room host protocol are never accepted.
    if (
      !Array.isArray(message) ||
      ![
        'init',
        'inited',
        'reinited',
        'result',
        'tempResult',
        'auto',
        'unauto',
        'giveup',
        'dataSync',
        'syncHandcard',
      ].includes(message[0])
    )
      return false;
    // Native chooseButton factories run on the authenticated rule worker.
    // Even a code-free _sendskill must not replace its authoritative definition.
    if (
      ['result', 'tempResult'].includes(message[0]) &&
      message[1] &&
      typeof message[1] === 'object' &&
      Object.hasOwn(message[1], '_sendskill')
    )
      return false;
    return !data.includes('_noname_func:') && !data.includes('_noname_event:');
  } catch {
    return false;
  }
}

/** Each browser worker is a rule executor, never a player or room owner. */
export class NativeNonameService implements EngineAdapter {
  private readonly engineRoot: string;
  private readonly assetVersion: string;
  private readonly portraits: Portraits | undefined;
  private readonly runtimeRoot: string;
  private readonly assets = new EngineAssets();
  private readonly resourcesReady: boolean;
  private readonly hostToken = randomBytes(32).toString('base64url');
  private readonly matches = new Map<string, Match>();
  private readonly listeners = new Set<(event: EngineEvent) => void>();
  private lastSupervisor = 0;
  private hostOnline = false;
  private membership: Membership = () => undefined;
  private readonly lan = new LanBridge(
    (room, token) => this.membership(room, token),
    (request) => this.hostAuthorized(request),
    () => this.publishJobs(),
  );
  private wss?: WebSocketServer;
  private heartbeat?: NodeJS.Timeout;
  private readonly jobStreams = new Set<{ response: ServerResponse; publish: () => void }>();
  private readonly expiry: NodeJS.Timeout;
  constructor(private readonly projectRoot: string) {
    this.engineRoot = resolve(projectRoot, '.local/noname/v1.11.6');
    this.assetVersion = JSON.parse(
      readFileSync(resolve(projectRoot, 'config/noname-candidate.json'), 'utf8'),
    ).commit;
    this.runtimeRoot = resolve(projectRoot, 'packages/noname-adapter/runtime');
    try {
      const manifest = JSON.parse(
        readFileSync(resolve(projectRoot, 'config/noname-lab-assets.json'), 'utf8'),
      );
      const candidate = JSON.parse(
        readFileSync(resolve(projectRoot, 'config/noname-candidate.json'), 'utf8'),
      );
      const build = JSON.parse(readFileSync(this.engineFile('game/build-info.json'), 'utf8'));
      const bundle = JSON.parse(
        readFileSync(resolve(projectRoot, 'dist/engine/manifest.json'), 'utf8'),
      );
      this.resourcesReady =
        candidate.tag === 'v1.11.6' &&
        manifest.commit === candidate.commit &&
        build.commit === candidate.commit &&
        bundle.commit === candidate.commit &&
        bundle.hash ===
          createHash('sha256')
            .update(readFileSync(resolve(projectRoot, 'dist/engine/noname.js')))
            .digest('hex') &&
        manifest.assets.every((entry: { path: string; bytes: number; gitBlobSha: string }) => {
          const bytes = readFileSync(this.engineFile(entry.path));
          return (
            bytes.length === entry.bytes &&
            createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') ===
              entry.gitBlobSha
          );
        });
      try {
        const portraitRoot = resolve(projectRoot, 'dist/engine/portraits');
        const portraits: Portraits = JSON.parse(
          readFileSync(resolve(portraitRoot, 'manifest.json'), 'utf8'),
        );
        if (
          portraits.commit === candidate.commit &&
          Object.entries(portraits.files).every(
            ([file, info]) =>
              /^[\w-]+\.webp$/.test(file) &&
              createHash('sha256')
                .update(readFileSync(resolve(portraitRoot, file)))
                .digest('hex') === info.sha256,
          )
        )
          this.portraits = portraits;
      } catch {
        /* Older build artifacts retain their verified original portraits. */
      }
    } catch {
      this.resourcesReady = false;
    }
    this.expiry = setInterval(() => {
      this.lan.expire();
      if (this.hostOnline && Date.now() - this.lastSupervisor > 20000) {
        this.hostOnline = false;
        this.emit({ type: 'status' });
      }
      for (const match of this.matches.values())
        for (const channel of match.polling.values()) {
          if (channel.expiresAt > Date.now()) continue;
          channel.close(1001, '连接已中断');
          match.polling.delete(channel.id);
        }
    }, 5000);
    this.expiry.unref();
  }
  status(): EngineStatus {
    const assets = this.resourcesReady;
    const ready = assets && this.hostOnline;
    return {
      id: 'noname',
      ready,
      preload: assets,
      lightweight: false,
      cardPilePolicy: true,
      connectionRecovery: true,
      luckCards: true,
      surrender: true,
      playerHistory: true,
      publicSpectating: true,
      experience: true,
      animationSpeed: true,
      message: ready
        ? '无名杀已就绪，真人准备后可以开始对局。'
        : assets
          ? '请让电脑上的服务页面保持开启，等待对局服务就绪。'
          : '无名杀资源未准备，请在电脑上运行资源准备脚本。',
    };
  }
  subscribe(listener: (event: EngineEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(event: EngineEvent) {
    for (const listener of this.listeners) listener(event);
    this.publishJobs();
  }
  private jobs() {
    return [...this.matches.values()]
      .filter((match) => ['starting', 'playing', 'ended'].includes(match.state))
      .map(({ id, setup, views }) => ({
        id,
        roomCode: setup.roomCode,
        views: [...views],
        animationSpeed: setup.settings.animationSpeed,
      }));
  }
  private publishJobs() {
    for (const stream of this.jobStreams) stream.publish();
  }
  matchId(roomCode: string): string | null {
    return (
      [...this.matches.values()].find((match) => match.setup.roomCode === roomCode)?.id ?? null
    );
  }
  setAnimationSpeed(roomCode: string, speed: number): void {
    const match = [...this.matches.values()].find((match) => match.setup.roomCode === roomCode);
    if (!match) return;
    match.setup.settings.animationSpeed = speed;
    this.publishJobs();
  }
  start(setup: MatchSetup): Promise<void> {
    const presets = JSON.parse(
      readFileSync(resolve(this.projectRoot, 'config/roster-presets.json'), 'utf8'),
    ) as { presets: RosterPreset[] };
    const preset = presets.presets.find((item) => item.id === setup.settings.generalPreset);
    if (!preset?.characters.length) return Promise.reject(new Error('缺少武将白名单'));
    try {
      validateCardPile(preset);
    } catch (error) {
      return Promise.reject(error);
    }
    this.release(setup.roomCode);
    return new Promise((resolveStart, reject) => {
      const id = randomUUID();
      const match: Match = {
        id,
        setup: structuredClone(setup),
        preset: structuredClone(preset),
        state: 'starting',
        recovering: new Set(),
        players: new Map(),
        tables: new Map(),
        views: new Set(),
        viewTimers: new Map(),
        tableStates: new Map(),
        polling: new Map(),
        pendingPlayers: [],
        pendingPlayerBytes: 0,
        observer: null,
        journal: new ObserverJournal(),
        networks: new Map(),
        resolve: resolveStart,
        reject,
        timer: setTimeout(
          () => this.fail(match, 'startup-timeout'),
          matchStartTimeout(
            setup.settings,
            setup.seats.filter((seat) => seat.kind === 'human').length,
          ),
        ),
      };
      this.matches.set(id, match);
      this.publishJobs();
    });
  }
  private fail(match: Match, code: MatchFailureCode = 'runtime-error') {
    if (this.matches.get(match.id) !== match) return;
    if (match.state === 'failed' || match.state === 'ended') return;
    const wasStarting = match.state === 'starting';
    match.state = 'failed';
    match.pendingPlayers = [];
    match.pendingPlayerBytes = 0;
    clearTimeout(match.timer);
    clearTimeout(match.recoveryTimer);
    match.recovering.clear();
    match.clockController?.close();
    match.clock?.close(1000);
    match.host?.close(1000);
    if (wasStarting) match.reject(new Error('Native rule worker unavailable'));
    // Fixed lifecycle metadata only: no exception stack, native payload,
    // nickname, cards, identities, choices or session credentials.
    console.warn(
      JSON.stringify({
        event: 'match-failed',
        at: new Date().toISOString(),
        roomCode: match.setup.roomCode,
        matchId: match.id,
        mode: match.setup.settings.mode,
        code,
      }),
    );
    this.emit({ type: 'failed', roomCode: match.setup.roomCode, code });
    for (const player of match.players.values()) player.close(1011, '对局服务已中断');
    for (const player of match.tables.values()) player.close(1011, '对局服务已中断');
  }
  release(roomCode: string) {
    for (const match of this.matches.values()) {
      if (match.setup.roomCode !== roomCode) continue;
      this.matches.delete(match.id);
      match.pendingPlayers = [];
      match.pendingPlayerBytes = 0;
      clearTimeout(match.timer);
      clearTimeout(match.recoveryTimer);
      match.clockController?.close();
      if (match.state === 'starting') match.reject(new Error('对局已由电脑结束'));
      match.host?.close(1000);
      match.clock?.close(1000);
      for (const player of match.players.values()) player.close(1000);
      for (const player of match.tables.values()) player.close(1000);
      for (const timer of match.viewTimers.values()) clearTimeout(timer);
      match.tableStates.clear();
    }
    this.publishJobs();
  }
  close() {
    this.lan.close();
    clearInterval(this.expiry);
    clearInterval(this.heartbeat);
    for (const stream of this.jobStreams) stream.response.end();
    this.jobStreams.clear();
    for (const match of [...this.matches.values()]) this.release(match.setup.roomCode);
    for (const socket of this.wss?.clients ?? []) socket.terminate();
    this.wss?.close();
  }
  private hostAuthorized(request: IncomingMessage) {
    const value = cookie(request, 'party_engine');
    if (!isLocalRequest(request) || !value) return false;
    const supplied = Buffer.from(value),
      expected = Buffer.from(this.hostToken);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
  observe(roomCode: string) {
    const match = [...this.matches.values()].find((item) => item.setup.roomCode === roomCode);
    return { observer: match?.observer ?? null, networks: [...(match?.networks.values() ?? [])] };
  }
  observerLog(roomCode: string, matchId: string, before?: number) {
    const match = this.matches.get(matchId);
    return match?.setup.roomCode === roomCode ? match.journal.page(matchId, before) : null;
  }
  private tableConnected(match: Match, playerId: string) {
    clearTimeout(match.viewTimers.get(playerId));
    match.viewTimers.delete(playerId);
    match.views.add(playerId);
    const state = match.tableStates.get(playerId);
    if (state) this.sendTable(match, playerId, ['table', state]);
    this.publishJobs();
  }
  private sendTable(match: Match, playerId: string, packet: unknown) {
    const client = match.tables.get(playerId);
    if (!client || client.readyState !== 1) return;
    if (client instanceof WebSocket && client.bufferedAmount > 4 * 1024 * 1024) {
      client.close(1013, '连接过慢，正在恢复原座位');
      return;
    }
    const encoded = JSON.stringify(packet);
    if (Buffer.byteLength(encoded) <= 131072) client.send(encoded);
  }
  private tableDisconnected(match: Match, playerId: string) {
    if (match.tables.has(playerId) || !this.matches.has(match.id)) return;
    // Refresh keeps the same native choice on the computer. Long disconnection
    // releases the mirror and invokes the unchanged upstream offline AI path.
    clearTimeout(match.viewTimers.get(playerId));
    match.viewTimers.set(
      playerId,
      setTimeout(() => {
        match.viewTimers.delete(playerId);
        match.views.delete(playerId);
        match.tableStates.delete(playerId);
        match.players.get(playerId)?.close(1000, '玩家离线');
        this.publishJobs();
      }, 20000),
    );
  }
  private forwardTable(match: Match, id: string, data: string): boolean {
    const state = match.tableStates.get(id);
    if (!tableAction(data, state)) {
      // Stale choices are harmless: return the current seat view for retry.
      if (state) this.sendTable(match, id, ['table', state]);
      return true;
    }
    const [, epoch, choice, action] = JSON.parse(data);
    const mirror = match.players.get(id);
    if (mirror instanceof WebSocket && mirror.readyState === 1)
      mirror.send(JSON.stringify({ type: 'tableAction', epoch, choice, action }));
    return true;
  }
  private openChannel(match: Match, id: string, playerId: string, lightweight = false) {
    let channel = match.polling.get(id);
    if (channel)
      return channel.playerId === playerId && channel.lightweight === lightweight
        ? channel
        : undefined;
    const clients = lightweight ? match.tables : match.players;
    const previous = clients.get(playerId);
    previous?.close(1000, '已在另一页面继续对局');
    if (!lightweight && previous instanceof WebSocket)
      this.sendHost(match, { type: 'close', id: playerId });
    channel = new PollChannel(
      id,
      playerId,
      (code) => {
        if (clients.get(playerId) !== channel) return;
        clients.delete(playerId);
        if (lightweight) this.tableDisconnected(match, playerId);
        else this.sendHost(match, { type: code === 1008 ? 'close' : 'disconnect', id: playerId });
      },
      lightweight,
    );
    match.polling.set(id, channel);
    clients.set(playerId, channel);
    if (lightweight) this.tableConnected(match, playerId);
    else this.sendHost(match, { type: 'connect', id: playerId });
    return channel;
  }
  private forwardPlayer(
    match: Match,
    id: string,
    source: WebSocket | PollChannel,
    data: string,
  ): boolean {
    if (match.players.get(id) !== source || source.readyState !== 1) return false;
    return this.sendHost(match, { type: 'message', id, data }, source);
  }
  private sendHost(
    match: Match,
    packet: { type: string; id: string; data?: string },
    source?: WebSocket | PollChannel,
  ): boolean {
    if (match.host?.readyState === WebSocket.OPEN) {
      send(match.host, packet);
      return true;
    }
    if (match.state !== 'starting' && !(match.state === 'playing' && match.executionId))
      return false;
    // Before the very first worker connection, rebuild only the current seat
    // set on open; superseded initialization is checked against its source.
    if (!match.host && packet.type !== 'message') return true;
    const bytes = Buffer.byteLength(JSON.stringify(packet));
    if (match.pendingPlayers.length >= 512 || match.pendingPlayerBytes + bytes > 4 * 1024 * 1024) {
      if (!source) this.fail(match, 'protocol-error');
      return false;
    }
    match.pendingPlayers.push({ packet, ...(source ? { source } : {}) });
    match.pendingPlayerBytes += bytes;
    return true;
  }
  private ruleDisconnected(
    match: Match,
    role: 'worker' | 'clock',
    socket: WebSocket,
    code: number,
  ): void {
    if (!this.matches.has(match.id) || ['failed', 'ended'].includes(match.state)) return;
    if ((role === 'worker' ? match.host : match.clock) !== socket) return;
    if (!match.executionId || [1000, 1008, 4000].includes(code)) {
      this.fail(match, role === 'worker' ? 'worker-disconnected' : 'clock-disconnected');
      return;
    }
    match.recovering.add(role);
    if (match.recoveryTimer) return;
    match.recoveryDeadline = Date.now() + 20000;
    console.info(
      JSON.stringify({
        event: 'match-recovering',
        at: new Date().toISOString(),
        roomCode: match.setup.roomCode,
        matchId: match.id,
        role,
        closeCode: code,
      }),
    );
    this.emit({
      type: 'recovering',
      roomCode: match.setup.roomCode,
      deadline: match.recoveryDeadline,
    });
    match.recoveryTimer = setTimeout(
      () =>
        this.fail(
          match,
          match.recovering.has('worker') ? 'worker-disconnected' : 'clock-disconnected',
        ),
      20000,
    );
    match.recoveryTimer.unref();
  }
  private ruleRecovered(match: Match, role: 'worker' | 'clock'): void {
    match.recovering.delete(role);
    if (match.recovering.size || !match.recoveryTimer) return;
    clearTimeout(match.recoveryTimer);
    delete match.recoveryTimer;
    delete match.recoveryDeadline;
    console.info(
      JSON.stringify({
        event: 'match-recovered',
        at: new Date().toISOString(),
        roomCode: match.setup.roomCode,
        matchId: match.id,
      }),
    );
    this.emit({ type: 'recovered', roomCode: match.setup.roomCode });
  }
  private action(match: Match, channel: PollChannel, sequence: unknown, data: unknown) {
    channel.touch();
    if (
      channel.readyState !== 1 ||
      !Number.isSafeInteger(sequence) ||
      (sequence as number) < 1 ||
      (sequence as number) > channel.incoming + 1
    )
      return 409;
    if (
      typeof data !== 'string' ||
      (channel.lightweight ? !this.safeTableMessage(data) : !safeMessage(data))
    ) {
      channel.close(1008, '无效对局操作');
      return 403;
    }
    if (sequence === channel.incoming + 1) {
      if (
        !(channel.lightweight
          ? match.tables.get(channel.playerId) === channel &&
            this.forwardTable(match, channel.playerId, data)
          : this.forwardPlayer(match, channel.playerId, channel, data))
      ) {
        channel.close(1011, '对局服务暂时不可用，正在恢复原座位');
        return 503;
      }
      channel.incoming = sequence as number;
    }
    return 200;
  }
  private safeTableMessage(data: string): boolean {
    if (data.length > 512) return false;
    try {
      const value = JSON.parse(data);
      return (
        Array.isArray(value) &&
        value.length === 4 &&
        value[0] === 'tableAction' &&
        typeof value[1] === 'string' &&
        /^[\w.-]{1,80}$/.test(value[1]) &&
        Number.isSafeInteger(value[2]) &&
        typeof value[3] === 'string' &&
        /^[\w.-]{1,80}$/.test(value[3])
      );
    } catch {
      return false;
    }
  }
  attach(server: Server, membership: Membership) {
    this.membership = membership;
    const wss = new WebSocketServer({ noServer: true, maxPayload: 131072 });
    this.wss = wss;
    const alive = new WeakSet<WebSocket>();
    this.heartbeat = setInterval(() => {
      for (const socket of wss.clients) {
        if (!alive.has(socket)) {
          socket.terminate();
          continue;
        }
        alive.delete(socket);
        socket.ping();
      }
    }, 15000);
    this.heartbeat.unref();
    server.on('upgrade', (request, socket, head) => {
      const url = parseUpgradeUrl(request, socket);
      if (!url) return;
      const route = /^\/engine\/socket\/([\w-]+)\/(worker|player|view|clock)$/.exec(url.pathname);
      if (!route) return;
      const match = route && this.matches.get(route[1]!);
      let sameOrigin = false;
      try {
        sameOrigin = new URL(request.headers.origin ?? '').host === request.headers.host;
      } catch {
        /* invalid Origin */
      }
      const seat = match && this.membership(match.setup.roomCode, cookie(request, 'party_player'));
      const viewId = route[2] === 'view' ? url.searchParams.get('seat') : null;
      const allowed =
        match &&
        sameOrigin &&
        (route![2] === 'worker' || route![2] === 'view' || route![2] === 'clock'
          ? this.hostAuthorized(request) &&
            (route![2] !== 'view' || (!!viewId && match.views.has(viewId)))
          : seat &&
            match.setup.seats.some(
              (candidate) => candidate.kind === 'human' && candidate.id === seat.id,
            ));
      if (!allowed || !match || match.state === 'failed') {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        ws.on('error', () => {
          // ws closes this transport on protocol failure. Its normal close
          // path retains seat recovery without taking down other rooms.
        });
        alive.add(ws);
        ws.on('pong', () => alive.add(ws));
        if (route![2] === 'worker' || route![2] === 'clock') {
          const execution = url.searchParams.get('execution') ?? undefined;
          if (
            (execution && !/^[a-f0-9-]{36}$/.test(execution)) ||
            (match.executionId && execution !== match.executionId)
          ) {
            ws.close(1008);
            return;
          }
          if (execution) match.executionId = execution;
        }
        if (route![2] === 'clock') {
          if (match.clock?.readyState === WebSocket.OPEN) {
            ws.close(1008);
            return;
          }
          match.clock = ws;
          if (match.clockController) match.clockController.bind(ws);
          else match.clockController = new RuleClock(ws, Boolean(match.executionId));
          this.ruleRecovered(match, 'clock');
          ws.on('close', (code) => this.ruleDisconnected(match, 'clock', ws, code));
        } else if (route![2] === 'worker') {
          if (match.host?.readyState === WebSocket.OPEN) {
            ws.close(1008);
            return;
          }
          match.host = ws;
          for (const id of match.players.keys()) send(ws, { type: 'connect', id });
          for (const { packet, source } of match.pendingPlayers)
            if (!source || (match.players.get(packet.id) === source && source.readyState === 1))
              send(ws, packet);
          match.pendingPlayers = [];
          match.pendingPlayerBytes = 0;
          this.ruleRecovered(match, 'worker');
          ws.on('message', (bytes) => {
            if (
              this.matches.get(match.id) !== match ||
              match.host !== ws ||
              match.state === 'failed'
            )
              return;
            try {
              const message = JSON.parse(bytes.toString()) as {
                type: string;
                id?: string;
                data?: string;
              };
              if (message.type === 'send' && message.id && typeof message.data === 'string') {
                const player = match.players.get(message.id);
                if (player?.readyState === WebSocket.OPEN) player.send(message.data);
              } else if (message.type === 'close' && message.id)
                match.players.get(message.id)?.close();
              else if (message.type === 'observer') {
                match.observer = sanitizeObserver(
                  (message as unknown as { state: unknown }).state,
                  match.setup,
                );
                if (match.observer) match.journal.append(match.observer);
              } else if (message.type === 'started' && match.state === 'starting') {
                match.state = 'playing';
                clearTimeout(match.timer);
                match.resolve();
              } else if (message.type === 'ended' && match.state === 'playing') {
                match.state = 'ended';
                this.emit({ type: 'ended', roomCode: match.setup.roomCode });
              } else if (message.type === 'failed') this.fail(match);
            } catch {
              this.fail(match, 'protocol-error');
            }
          });
          ws.on('close', (code) => this.ruleDisconnected(match, 'worker', ws, code));
        } else {
          const id = viewId ?? seat!.id;
          const lightweight = route![2] === 'player' && url.searchParams.get('client') === 'light';
          if (url.searchParams.get('transport') === 'stream') {
            const channelId = url.searchParams.get('channel') ?? '';
            const after = Number(url.searchParams.get('after') ?? 0);
            if (!/^[a-f0-9-]{36}$/.test(channelId)) {
              ws.close(1008);
              return;
            }
            const channel = this.openChannel(match, channelId, id, lightweight);
            if (!channel) {
              ws.close(1008);
              return;
            }
            send(ws, { type: 'opened' });
            const off = channel.listen(after, (frame) => {
              if (ws.bufferedAmount > 4 * 1024 * 1024) {
                ws.close(1013, '连接过慢');
                return;
              }
              send(ws, { type: 'frames', ...frame });
            });
            if (!off) {
              ws.close(1008);
              return;
            }
            ws.on('pong', () => channel.touch());
            ws.on('message', (bytes) => {
              if (
                this.membership(match.setup.roomCode, cookie(request, 'party_player'))?.id !== id
              ) {
                ws.close(1008);
                return;
              }
              try {
                const body = JSON.parse(bytes.toString());
                if (body.type === 'ack' && channel.acknowledge(body.after)) return;
                if (body.type === 'ping') {
                  channel.touch();
                  send(ws, { type: 'pong', id: body.id });
                  return;
                }
                if (body.type !== 'action') {
                  ws.close(1008);
                  return;
                }
                const status = this.action(match, channel, body.sequence, body.data);
                send(ws, { type: 'ack', sequence: body.sequence, status });
                if (status !== 200) ws.close(status === 503 ? 1011 : 1008, '对局操作未接受');
              } catch {
                ws.close(1008, '无效对局操作');
              }
            });
            ws.once('close', off);
            return;
          }
          const clients = lightweight ? match.tables : match.players;
          const previous = clients.get(id);
          if (previous) {
            previous.close(1000, '已在另一页面继续对局');
            if (!lightweight && previous instanceof WebSocket)
              this.sendHost(match, { type: 'close', id });
          }
          clients.set(id, ws);
          if (lightweight) this.tableConnected(match, id);
          else this.sendHost(match, { type: 'connect', id });
          ws.on('message', (bytes) => {
            const data = bytes.toString();
            if (clients.get(id) !== ws || !this.matches.has(match.id)) return;
            if (viewId) {
              try {
                const message = JSON.parse(data);
                if (message[0] === 'tableView') {
                  const state = sanitizeTable(message[1], id);
                  if (state) {
                    match.tableStates.set(id, state);
                    this.sendTable(match, id, ['table', state]);
                  }
                  return;
                }
                if (message[0] === 'tableAudio') {
                  const path = message[1];
                  if (
                    typeof path === 'string' &&
                    /^[\w/-]+\.(mp3|ogg)$/.test(path) &&
                    path.length < 160
                  )
                    this.sendTable(match, id, ['audio', path]);
                  return;
                }
              } catch {
                ws.close(1008);
                return;
              }
            } else if (
              this.membership(match.setup.roomCode, cookie(request, 'party_player'))?.id !== id
            ) {
              ws.close(1008);
              return;
            }
            if (lightweight) {
              if (!this.safeTableMessage(data)) ws.close(1008, '无效对局操作');
              else this.forwardTable(match, id, data);
              return;
            }
            if (!safeMessage(data)) {
              ws.close(1008, '无效对局操作');
              return;
            }
            if (!this.forwardPlayer(match, id, ws, data)) ws.close(1011, '对局服务暂时不可用');
          });
          ws.on('close', (code) => {
            if (clients.get(id) !== ws) return;
            clients.delete(id);
            if (lightweight) this.tableDisconnected(match, id);
            else this.sendHost(match, { type: code === 1008 ? 'close' : 'disconnect', id });
          });
        }
      });
    });
  }
  private engineFile(path: string) {
    if (path.includes('\\') || path.includes('\0')) throw new Error('Invalid engine path');
    const file = resolve(this.engineRoot, path.replace(/^\/+/, ''));
    const within = relative(this.engineRoot, file);
    if (within.startsWith('..') || isAbsolute(within)) throw new Error('Invalid engine path');
    return file;
  }
  private async polling(
    request: IncomingMessage,
    response: ServerResponse,
    matchId: string,
    url: URL,
  ) {
    const match = this.matches.get(matchId);
    const seat =
      match &&
      (request.headers['x-party-relay']
        ? this.lan.relaySeat(request, match.setup.roomCode)
        : this.membership(match.setup.roomCode, cookie(request, 'party_player')));
    if (request.method === 'DELETE' && (!match || !seat)) {
      json(response, 200, {});
      return;
    }
    let origin = true;
    try {
      if (request.headers.origin)
        origin = new URL(request.headers.origin).host === request.headers.host;
    } catch {
      origin = false;
    }
    if (
      !match ||
      !seat ||
      !origin ||
      match.state === 'failed' ||
      !match.setup.seats.some((item) => item.kind === 'human' && item.id === seat.id)
    ) {
      json(response, 403, {});
      return;
    }
    let body: Record<string, unknown> = {};
    if (request.method === 'POST') {
      let length = 0;
      const parts = [];
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 140000) {
          json(response, 413, {});
          return;
        }
        parts.push(Buffer.from(chunk));
      }
      try {
        body = JSON.parse(Buffer.concat(parts).toString('utf8'));
      } catch {
        json(response, 400, {});
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        json(response, 400, {});
        return;
      }
    }
    const id = url.searchParams.get('channel') ?? body.channel;
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) {
      json(response, 400, {});
      return;
    }
    let channel = match.polling.get(id);
    if (channel && channel.playerId !== seat.id) {
      json(response, 403, {});
      return;
    }
    if (request.method === 'POST' && body.open === true) {
      channel ??= this.openChannel(match, id, seat.id, body.client === 'light');
      if (!channel) {
        json(response, 403, {});
        return;
      }
      channel.touch();
      json(response, 200, { channel: id, closed: channel.readyState !== 1 });
      return;
    }
    if (!channel) {
      json(response, 410, {});
      return;
    }
    if (request.method === 'GET') {
      channel.read(Number(url.searchParams.get('after') ?? 0), response);
      return;
    }
    if (request.method === 'DELETE') {
      channel.close();
      json(response, 200, {});
      return;
    }
    if (request.method !== 'POST') {
      json(response, 405, {});
      return;
    }
    const status = this.action(match, channel, body.sequence, body.data);
    json(response, status, status === 200 ? { sequence: body.sequence } : {});
  }
  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/engine/')) return false;
    const network = /^\/engine\/network\/([\w-]+)$/.exec(url.pathname);
    if (network && request.method === 'POST') {
      const match = this.matches.get(network[1]!);
      const seat = match && this.membership(match.setup.roomCode, cookie(request, 'party_player'));
      if (
        !match ||
        !seat ||
        !match.setup.seats.some((item) => item.kind === 'human' && item.id === seat.id)
      ) {
        json(response, 403, {});
        return true;
      }
      let length = 0;
      const parts = [];
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 2048) {
          json(response, 413, {});
          return true;
        }
        parts.push(Buffer.from(chunk));
      }
      try {
        const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
        if (
          !['local', 'lan', 'direct', 'internet'].includes(body.route) ||
          !['rtc', 'http', 'websocket'].includes(body.transport)
        )
          throw new Error();
        match.networks.set(seat.id, {
          playerId: seat.id,
          route: body.route,
          transport: body.transport,
          rtt:
            typeof body.rtt === 'number' &&
            Number.isFinite(body.rtt) &&
            body.rtt >= 0 &&
            body.rtt <= 60000
              ? Math.round(body.rtt)
              : null,
          unstable: body.unstable === true,
          updatedAt: Date.now(),
        });
        json(response, 200, {});
      } catch {
        json(response, 400, {});
      }
      return true;
    }
    if (await this.lan.handle(request, response, url, cookie(request, 'party_player'))) return true;
    const polling = /^\/engine\/poll\/([\w-]+)$/.exec(url.pathname);
    if (polling) {
      await this.polling(request, response, polling[1]!, url);
      return true;
    }
    if (!['GET', 'HEAD'].includes(request.method ?? '')) {
      json(response, 405, { error: { message: '只允许读取引擎资源。' } });
      return true;
    }
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
    );
    try {
      if (url.pathname === '/engine/preload') {
        const preset = url.searchParams.get('preset') ?? 'beginner';
        const mode = url.searchParams.get('mode') ?? 'identity';
        if (
          !GENERAL_PRESETS.some((entry) => entry.id === preset) ||
          !['identity', 'duel', 'doudizhu', 'versus'].includes(mode)
        ) {
          json(response, 400, {});
          return true;
        }
        if (!this.resourcesReady) {
          json(response, 503, {});
          return true;
        }
        if (url.searchParams.get('client') === 'light') {
          json(response, 200, { assets: ['/assets/table.js', '/assets/table.css'] });
          return true;
        }
        const manifest = JSON.parse(
          await readFile(resolve(this.projectRoot, 'dist/engine/manifest.json'), 'utf8'),
        );
        const presets = JSON.parse(
          await readFile(resolve(this.projectRoot, 'config/roster-presets.json'), 'utf8'),
        );
        const definitions = presets.presets.find(
          (item: { id: string }) => item.id === preset,
        ).definitionPacks;
        const base = `/engine/core/${this.assetVersion}/`;
        const paths = [
          'layout/default/layout.css',
          'layout/default/phone.css',
          'layout/long2/layout.css',
          'layout/default/menu.css',
          'layout/default/newmenu.css',
          'layout/others/dialog.css',
          'layout/others/skill.css',
          'layout/newlayout/layout.css',
          'layout/newlayout/global.css',
          'layout/newlayout/equip.css',
          'theme/simple/style.css',
          'theme/style/card/default.css',
          'theme/style/cardback/liusha.css',
          'theme/style/hp/default.css',
          'game/package.js',
          'game/update.js',
          'game/build-info.json',
          'game/keyWords.js',
          'font/suits.woff2',
          'character/rank.js',
          'character/replace.js',
          'character/perfectPairs.js',
          ...definitions.cards.map((name: string) => `card/${name}.js`),
          ...definitions.characters.map((name: string) => `character/${name}.js`),
          `mode/${mode === 'duel' ? 'single' : mode}.js`,
          'image/background/ol_bg.jpg',
          'image/card/handcard.png',
          'image/card/tiesuo_mark.png',
          'theme/simple/card.png',
          'theme/style/cardback/image/liusha.png',
          ...['male', 'female'].flatMap((sex) =>
            ['sha', 'shan', 'jiu'].map((name) => `audio/card/${sex}/${name}.mp3`),
          ),
          ...[
            'sha',
            'shan',
            'tao',
            'jiu',
            'nanman',
            'wanjian',
            'wuxie',
            'wugu',
            'juedou',
            'shunshou',
            'guohe',
            'wuzhong',
            'huogong',
            'tiesuo',
          ].map((name) => `image/card/${name}.png`),
        ];
        json(response, 200, {
          assets: [
            `/engine/bundle/noname-${manifest.hash}.js`,
            ...paths.map((path) => base + path),
          ],
        });
        return true;
      }
      const bundled = /^\/engine\/bundle\/noname-([a-f0-9]{64})\.js$/.exec(url.pathname);
      if (bundled) {
        const manifest = JSON.parse(
          await readFile(resolve(this.projectRoot, 'dist/engine/manifest.json'), 'utf8'),
        );
        if (bundled[1] !== manifest.hash) {
          json(response, 404, {});
          return true;
        }
        await this.assets.send(
          request,
          response,
          resolve(this.projectRoot, 'dist/engine/noname.js'),
          types['.js']!,
          { immutable: true },
        );
        return true;
      }
      const portrait = /^\/engine\/portraits\/([a-f0-9]{64})\/([\w-]+\.webp)$/.exec(url.pathname);
      if (portrait) {
        if (
          !this.portraits ||
          (portrait[1] !== this.portraits.hash &&
            portrait[1] !== this.portraits.files[portrait[2]!]?.version) ||
          !this.portraits.files[portrait[2]!]
        ) {
          json(response, 404, {});
          return true;
        }
        await this.assets.send(
          request,
          response,
          resolve(this.projectRoot, 'dist/engine/portraits', portrait[2]!),
          types['.webp']!,
          { immutable: true },
        );
        return true;
      }
      if (url.pathname === '/engine/jobs') {
        if (!isLocalRequest(request)) {
          json(response, 403, {});
          return true;
        }
        response.setHeader(
          'Set-Cookie',
          `party_engine=${this.hostToken}; Path=/; HttpOnly; SameSite=Strict`,
        );
        this.lastSupervisor = Date.now();
        if (!this.hostOnline) {
          this.hostOnline = true;
          this.emit({ type: 'status' });
        }
        if (url.searchParams.get('transport') === 'events') {
          response.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Accel-Buffering': 'no',
          });
          const stream = {
            response,
            publish: () => {
              if (response.destroyed || response.writableEnded) return;
              this.lastSupervisor = Date.now();
              response.write(
                `event: jobs\ndata: ${JSON.stringify({ jobs: this.jobs(), lanOffers: this.lan.offers() })}\n\n`,
              );
            },
          };
          this.jobStreams.add(stream);
          stream.publish();
          const heartbeat = setInterval(stream.publish, 8000);
          heartbeat.unref();
          response.once('close', () => {
            clearInterval(heartbeat);
            this.jobStreams.delete(stream);
          });
          return true;
        }
        json(response, 200, {
          jobs: this.jobs(),
          lanOffers: this.lan.offers(),
        });
        return true;
      }
      const tableRoute = /^\/engine\/(table|table-setup)\/([\w-]+)$/.exec(url.pathname);
      if (tableRoute) {
        const match = this.matches.get(tableRoute[2]!);
        const seat =
          match && this.membership(match.setup.roomCode, cookie(request, 'party_player'));
        if (
          !match ||
          !seat ||
          !match.setup.seats.some((item) => item.id === seat.id && item.kind === 'human')
        ) {
          json(response, 403, {});
          return true;
        }
        response.setHeader(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
        );
        if (tableRoute[1] === 'table-setup') {
          json(response, 200, {
            id: match.id,
            playerId: seat.id,
            assetBase: `/engine/core/${this.assetVersion}/`,
            playerStreaming: true,
            playerNetwork: request.headers['x-party-ingress'] === 'public' ? 'internet' : 'lan',
          });
        } else {
          const content = await readFile(resolve(this.projectRoot, 'dist/web/table.html'), 'utf8');
          response.writeHead(200, { 'Content-Type': types['.html']!, 'Cache-Control': 'no-store' });
          response.end(request.method === 'HEAD' ? undefined : content);
        }
        return true;
      }
      const observeRoute = /^\/engine\/observe\/([\w-]+)$/.exec(url.pathname);
      if (observeRoute) {
        const match = this.matches.get(observeRoute[1]!);
        const roomCode = url.searchParams.get('room');
        if (!roomCode) {
          json(response, 400, { error: { message: '请从房间链接进入观战。' } });
          return true;
        }
        if (!match || match.setup.roomCode !== roomCode) {
          json(response, 409, { error: { message: '这一局已经释放，请刷新房间查看当前牌局。' } });
          return true;
        }
        const before = url.searchParams.has('before')
          ? Number(url.searchParams.get('before'))
          : undefined;
        if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) {
          json(response, 400, { error: { message: '公开记录页码无效。' } });
          return true;
        }
        // This endpoint never opens a native client, grants a seat, or exposes
        // setup/network details. Both fields have already passed the deliberate
        // public whitelist used by the computer observer and public journal.
        json(response, 200, {
          ...match.journal.page(match.id, before),
          roomCode: match.setup.roomCode,
          observer: match.observer,
        });
        return true;
      }
      const historyRoute = /^\/engine\/history\/([\w-]+)$/.exec(url.pathname);
      if (historyRoute) {
        const match = this.matches.get(historyRoute[1]!);
        const seat =
          match && this.membership(match.setup.roomCode, cookie(request, 'party_player'));
        if (
          !match ||
          !seat ||
          !match.setup.seats.some((item) => item.id === seat.id && item.kind === 'human')
        ) {
          json(response, 403, {});
          return true;
        }
        const before = url.searchParams.has('before')
          ? Number(url.searchParams.get('before'))
          : undefined;
        if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) {
          json(response, 400, {});
          return true;
        }
        json(response, 200, {
          ...match.journal.page(match.id, before),
          deckCount: match.observer?.deckCount ?? null,
        });
        return true;
      }
      const matchRoute = /^\/engine\/(setup|worker|player|view)\/([\w-]+)$/.exec(url.pathname);
      if (matchRoute) {
        const match = this.matches.get(matchRoute[2]!);
        const view =
          matchRoute[1] === 'view' ||
          (matchRoute[1] === 'setup' && url.searchParams.get('role') === 'view');
        const viewId = view ? url.searchParams.get('seat') : null;
        const worker =
          matchRoute[1] === 'worker' ||
          (matchRoute[1] === 'setup' && url.searchParams.get('role') === 'worker');
        const seat =
          match && this.membership(match.setup.roomCode, cookie(request, 'party_player'));
        if (
          !match ||
          (worker || view
            ? !this.hostAuthorized(request) || (view && (!viewId || !match.views.has(viewId)))
            : !seat)
        ) {
          json(response, 403, {});
          return true;
        }
        if (matchRoute[1] === 'setup') {
          const config = JSON.parse(await readFile(this.engineFile('game/config.json'), 'utf8'));
          const assets = JSON.parse(
            await readFile(resolve(this.projectRoot, 'config/noname-lab-assets.json'), 'utf8'),
          );
          const portraitNames = new Set(
            match.preset.characters.flatMap((name) => [
              name,
              ...(assets.portraitVariants?.[name] ?? []),
            ]),
          );
          json(response, 200, {
            id: match.id,
            serverVersion: APP_VERSION,
            selectionRecovery: true,
            connectionRecovery: true,
            luckCards: true,
            surrender: true,
            emotions: true,
            experience: true,
            rosterPolicy: true,
            cardPilePolicy: true,
            ruleClock: worker,
            ruleRecovery: worker,
            tablePresentation: true,
            animationSpeedControl: true,
            ...match.setup,
            generalSelections: worker ? match.setup.generalSelections : undefined,
            role: worker ? 'worker' : 'player',
            playerId: worker ? null : view ? viewId : seat!.id,
            tableView: view,
            playerPolling: !view,
            playerStreaming: true,
            playerNetwork: request.headers['x-party-ingress'] === 'public' ? 'internet' : 'lan',
            choicePrompts: true,
            assetBase: `/engine/core/${this.assetVersion}/`,
            preset: match.preset,
            portraitAliases: Object.fromEntries(
              Object.entries(assets.portraitAliases ?? {}).filter(([name]) =>
                portraitNames.has(name),
              ),
            ),
            mobilePortraits: this.portraits
              ? Object.fromEntries(
                  Object.entries(this.portraits.characters)
                    .filter(([name]) => portraitNames.has(name))
                    .map(([name, file]) => [
                      name,
                      `/engine/portraits/${this.portraits!.files[file]!.version ?? this.portraits!.hash}/${file}`,
                    ]),
                )
              : {},
            audioFiles:
              assets.audioFilesByPreset?.[match.preset.id] ??
              assets.assets
                .filter((entry: { path: string }) => entry.path.startsWith('audio/'))
                .map((entry: { path: string }) => entry.path.slice(6)),
            config,
          });
        } else {
          const manifest = JSON.parse(
            await readFile(resolve(this.projectRoot, 'dist/engine/manifest.json'), 'utf8'),
          );
          const content = (await readFile(resolve(this.runtimeRoot, 'index.html'), 'utf8'))
            .replace('/engine/core/noname.js', `/engine/bundle/noname-${manifest.hash}.js`)
            .replaceAll('/engine/core/', `/engine/core/${this.assetVersion}/`);
          response.writeHead(200, { 'Content-Type': types['.html']!, 'Cache-Control': 'no-store' });
          response.end(request.method === 'HEAD' ? undefined : content);
        }
        return true;
      }
      if (url.pathname.startsWith('/engine/fs/')) {
        const file = this.engineFile(
          url.searchParams.get('fileName') ?? url.searchParams.get('dir') ?? '',
        );
        if (url.pathname === '/engine/fs/checkFile') {
          const info = await stat(file).catch(() => null);
          json(response, 200, {
            success: true,
            data: info?.isFile() ? 'file' : info?.isDirectory() ? 'directory' : null,
          });
        } else if (url.pathname === '/engine/fs/getFileList') {
          const entries = await readdir(file, { withFileTypes: true }).catch(() => []);
          json(response, 200, {
            success: true,
            data: {
              folders: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
              files: entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
            },
          });
        } else json(response, 403, { success: false });
        return true;
      }
      const versioned = /^\/engine\/core\/([a-f0-9]{40})\/(.*)$/.exec(url.pathname);
      if (versioned && versioned[1] !== this.assetVersion) {
        json(response, 404, {});
        return true;
      }
      const resourcePath = versioned ? `/engine/core/${versioned[2]}` : url.pathname;
      const wrapper =
        /^\/engine\/(?:modes\/(identity|single|doudizhu|versus)(?:\/index)?|core\/mode\/(identity|single|doudizhu|versus)\/index)\.js$/.exec(
          resourcePath,
        );
      if (wrapper) {
        response.writeHead(200, { 'Content-Type': types['.js']! });
        response.end(
          `import base from '/engine/core/${this.assetVersion}/mode/${wrapper[1] ?? wrapper[2]}.js'; import { adaptMode } from '/engine/runtime/mode.js'; export const type='mode'; export default function(){ return adaptMode(typeof base === 'function' ? base() : {...base}); }`,
        );
        return true;
      }
      let file: string;
      if (url.pathname.startsWith('/engine/runtime/')) {
        const name = url.pathname.slice('/engine/runtime/'.length);
        if (
          ![
            'bootstrap.js',
            'animation-speed.js',
            'mode.js',
            'roster-policy.js',
            'card-pile.js',
            'relay.js',
            'rule-clock.js',
            'rule-socket.js',
            'privacy.js',
            'controls.js',
            'audio.js',
            'player-transport.js',
            'prompts.js',
            'observer.js',
            'public-summary.js',
            'selection-recovery.js',
            'connection-recovery.js',
            'luck-cards.js',
            'surrender.js',
            'emotions.js',
            'table-projection.js',
            'table-presentation.js',
          ].includes(name)
        )
          throw new Error('Invalid runtime path');
        file = resolve(this.runtimeRoot, name);
      } else if (resourcePath.startsWith('/engine/core/'))
        file = this.engineFile(decodeURIComponent(resourcePath.slice('/engine/core/'.length)));
      else {
        json(response, 404, {});
        return true;
      }
      let transform: ((content: string) => string) | undefined;
      if (file === this.engineFile('noname/init/import.js')) {
        transform = (content) =>
          content
            .replaceAll('`/card/', `\`/engine/core/${this.assetVersion}/card/`)
            .replaceAll('`/character/', `\`/engine/core/${this.assetVersion}/character/`)
            .replaceAll('`/mode/', '`/engine/modes/');
      } else if (file === this.engineFile('noname/init/browser.js'))
        transform = (content) =>
          content.replaceAll('requestBackend("/', 'requestBackend("/engine/fs/');
      await this.assets.send(
        request,
        response,
        file,
        types[extname(file)] ?? 'application/octet-stream',
        { transform, immutable: !!versioned },
      );
    } catch (error) {
      json(response, (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 400, {
        error: { message: '引擎资源不可用。' },
      });
    }
    return true;
  }
}
