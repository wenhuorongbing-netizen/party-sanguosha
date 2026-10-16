import { randomBytes, randomUUID } from 'node:crypto';
import type { EngineAdapter } from '../../../packages/noname-adapter/src/index.js';
import generalCatalog from '../../../config/general-catalog.json' with { type: 'json' };
import {
  findMode,
  GENERAL_PRESETS,
  OWNER_OFFLINE_GRACE_MS,
  ROOM_IDLE_GRACE_MS,
  DEFAULT_ANIMATION_SPEED,
  type ExtensionInfo,
  type GeneralPresetId,
  type GeneralChoiceView,
  type PlayerView,
  type RoomSettings,
  type RoomView,
} from '../../../packages/shared/src/contracts.js';
import { AppError } from './errors.js';

type Human = PlayerView & {
  kind: 'human';
  token: string;
  connections: number;
  pollUntil: number;
  offlineSince: number | null;
  general: string | null;
};
type Bot = PlayerView & { kind: 'bot' };
type Seat = Human | Bot;

export function normalizeNickname(nickname: unknown): string {
  if (typeof nickname !== 'string') throw new AppError(400, 'INVALID_NICKNAME', '请填写昵称。');
  const name = nickname.normalize('NFC').trim();
  if (!name || [...name].length > 16 || /[\p{Cc}\p{Cf}]/u.test(name))
    throw new AppError(400, 'INVALID_NICKNAME', '昵称需要 1–16 个字，不能包含控制字符。');
  return name;
}

export class RoomStore {
  readonly code = randomBytes(3).toString('hex').toUpperCase();
  private revision = 0;
  private phase: RoomView['phase'] = 'waiting';
  private settings: RoomSettings = {
    mode: 'identity',
    playerCount: 5,
    generalPreset: 'beginner',
    allowGeneralSelection: false,
    animationSpeed: DEFAULT_ANIMATION_SPEED,
    extensions: [],
  };
  private ownerId: string | null = null;
  private botSequence = 0;
  private startGeneration = 0;
  private betweenMatchesSince = Date.now();
  private matchFailure: RoomView['matchFailure'];
  private matchRecovery: RoomView['matchRecovery'];
  private readonly players = new Map<string, Seat>();
  private readonly listeners = new Set<(room: RoomView) => void>();
  private unsubscribeEngine: (() => void) | undefined;

  constructor(
    private readonly engine: EngineAdapter,
    private readonly catalog: ExtensionInfo[] = [],
  ) {}

  private subscribeEngine(): void {
    if (this.unsubscribeEngine || !this.engine.subscribe) return;
    this.unsubscribeEngine = this.engine.subscribe((event) => {
      if (event.type === 'status') this.changed();
      else if (event.roomCode === this.code && ['starting', 'playing'].includes(this.phase)) {
        if (event.type === 'recovering') this.matchRecovery = { deadline: event.deadline };
        else if (event.type === 'recovered') this.matchRecovery = undefined;
        else {
          this.matchRecovery = undefined;
          if (event.type === 'failed') {
            this.matchFailure = { code: event.code ?? 'runtime-error', at: Date.now() };
            // Keep an interrupted in-progress table visible until explicit
            // return. It has no winner and must not silently become a new lobby.
            this.phase = this.phase === 'playing' ? 'finished' : 'waiting';
            this.resetReady();
          } else this.phase = 'finished';
          this.betweenMatchesSince = Date.now();
        }
        this.changed();
      }
    });
  }

  snapshot(): RoomView {
    return {
      code: this.code,
      revision: this.revision,
      phase: this.phase,
      matchId: this.engine.matchId?.(this.code) ?? null,
      settings: { ...this.settings, extensions: [...this.settings.extensions] },
      players: [...this.players.values()].map((player) => this.publicPlayer(player)),
      ownerId: this.ownerId,
      ownerClaimAt: this.ownerClaimAt(),
      serverTime: Date.now(),
      idleCloseAt: this.idleCloseAt(),
      engine: this.engine.status(),
      ...(this.matchFailure ? { matchFailure: { ...this.matchFailure } } : {}),
      ...(this.matchRecovery ? { matchRecovery: { ...this.matchRecovery } } : {}),
    };
  }

  subscribe(listener: (room: RoomView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  session(token?: string): PlayerView | undefined {
    const player = this.human(token);
    return player && this.publicPlayer(player);
  }

  join(nickname: unknown, token?: string): { token: string; playerId: string } {
    this.assertWaiting();
    const cleanName = normalizeNickname(nickname);
    const existing = this.human(token);
    if (existing) {
      existing.nickname = cleanName;
      this.changed();
      return { token: existing.token, playerId: existing.id };
    }
    if (this.players.size >= this.settings.playerCount)
      throw new AppError(409, 'ROOM_FULL', '房间已满，请联系房主调整人数或移除一个 AI。');
    const player: Human = {
      id: randomUUID(),
      // LobbyStore supplies a server-issued browser session, reused across rooms.
      token: token ?? randomBytes(24).toString('base64url'),
      kind: 'human',
      nickname: cleanName,
      ready: false,
      online: false,
      connections: 0,
      pollUntil: 0,
      offlineSince: Date.now(),
      general: null,
    };
    this.players.set(player.id, player);
    this.ownerId ??= player.id;
    this.subscribeEngine();
    this.resetReady();
    this.changed();
    return { token: player.token, playerId: player.id };
  }

  leave(token?: string): void {
    this.assertBetweenMatches();
    this.expirePolls();
    const player = this.human(token);
    if (!player) throw new AppError(401, 'PLAYER_REQUIRED', '请先加入房间。');
    this.players.delete(player.id);
    if (player.id === this.ownerId) {
      // 显式离开才交接房主；短暂断线或刷新保留原房主身份。
      const humans = [...this.players.values()].filter((seat) => seat.kind === 'human');
      const successor = humans.find((seat) => seat.online) ?? humans[0];
      this.ownerId = successor?.id ?? null;
      if (!successor) {
        this.consoleClose();
        return;
      } else if (this.phase === 'finished') this.resetMatch();
    }
    this.resetReady();
    this.changed();
  }

  transferOwnership(id: unknown, ownerToken?: string): void {
    this.requireOwner(ownerToken);
    this.assertBetweenMatches();
    this.expirePolls();
    const successor = typeof id === 'string' ? this.players.get(id) : undefined;
    if (!successor || successor.kind !== 'human' || successor.id === this.ownerId)
      throw new AppError(400, 'INVALID_SUCCESSOR', '请选择本房间的另一位真人玩家。');
    if (!successor.online)
      throw new AppError(409, 'SUCCESSOR_OFFLINE', '这位玩家暂时离线，请等连接恢复后再转交。');
    this.ownerId = successor.id;
    this.resetReady();
    this.changed();
  }

  claimOwnership(expectedOwnerId: unknown, token?: string, now = Date.now()): void {
    this.assertBetweenMatches();
    this.expirePolls(now);
    const player = this.human(token);
    if (!player) throw new AppError(401, 'PLAYER_REQUIRED', '请先加入本房间。');
    if (!player.online) throw new AppError(409, 'PLAYER_OFFLINE', '连接还未恢复，请稍后再试。');
    if (expectedOwnerId !== this.ownerId)
      throw new AppError(409, 'OWNER_CHANGED', '房主已经变化，请按当前房间状态操作。');
    const claimAt = this.ownerClaimAt();
    if (player.id === this.ownerId || claimAt === null || now < claimAt)
      throw new AppError(409, 'OWNER_RESERVED', '房主仍在线或正在断线保留期内，请稍后再试。');
    this.ownerId = player.id;
    this.resetReady();
    this.changed();
  }

  removePlayer(id: string, ownerToken?: string): void {
    this.requireOwner(ownerToken);
    this.assertWaiting();
    if (id === this.ownerId)
      throw new AppError(400, 'OWNER_CANNOT_KICK_SELF', '请使用离开房间，房主会交接给下一位玩家。');
    if (!this.players.delete(id)) throw new AppError(404, 'PLAYER_NOT_FOUND', '这个座位已移除。');
    this.resetReady();
    this.changed();
  }

  addBots(count: unknown, ownerToken?: string): void {
    this.requireOwner(ownerToken);
    this.assertWaiting();
    if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > 7)
      throw new AppError(400, 'INVALID_BOT_COUNT', '请选择要添加的 AI 数量。');
    if (this.players.size + (count as number) > this.settings.playerCount)
      throw new AppError(409, 'ROOM_FULL', '空位不足，请减少 AI 数量或调整总人数。');
    for (let index = 0; index < (count as number); index++) {
      const bot: Bot = {
        id: randomUUID(),
        nickname: `AI ${String(++this.botSequence).padStart(2, '0')}`,
        kind: 'bot',
        ready: true,
        online: true,
      };
      this.players.set(bot.id, bot);
    }
    this.resetReady();
    this.changed();
  }

  setReady(token: string | undefined, ready: unknown): void {
    this.assertWaiting();
    this.expirePolls();
    const player = this.human(token);
    if (!player) throw new AppError(401, 'PLAYER_REQUIRED', '请先加入房间。');
    if (typeof ready !== 'boolean') throw new AppError(400, 'INVALID_READY', '准备状态无效。');
    if (!player.online) throw new AppError(409, 'PLAYER_OFFLINE', '连接还未恢复，请稍后再试。');
    player.ready = ready;
    this.changed();
  }

  generalChoice(token?: string): GeneralChoiceView {
    const player = this.human(token);
    if (!player) throw new AppError(401, 'PLAYER_REQUIRED', '请先加入本房间。');
    this.assertWaiting();
    if (!this.settings.allowGeneralSelection)
      throw new AppError(409, 'GENERAL_SELECTION_DISABLED', '房主尚未开放点将。');
    const taken = new Set(
      [...this.players.values()]
        .filter((seat): seat is Human => seat.kind === 'human' && seat !== player)
        .map((seat) => seat.general),
    );
    return {
      selected: player.general,
      available: generalCatalog.characters
        .filter(
          (general) => general.preset === this.settings.generalPreset && !taken.has(general.id),
        )
        .map((general) => general.id),
    };
  }

  setGeneralChoice(token: string | undefined, general: unknown): GeneralChoiceView {
    const choice = this.generalChoice(token);
    if (general !== null && (typeof general !== 'string' || !choice.available.includes(general))) {
      const inPreset = generalCatalog.characters.some(
        (entry) => entry.preset === this.settings.generalPreset && entry.id === general,
      );
      throw new AppError(
        inPreset ? 409 : 400,
        inPreset ? 'GENERAL_TAKEN' : 'INVALID_GENERAL',
        inPreset ? '这名武将已被其他玩家点将，请选择另一名。' : '请选择当前武将档内的武将。',
      );
    }
    const player = this.human(token)!;
    if (player.general !== general) {
      player.general = general as string | null;
      this.resetReady();
      this.changed();
    }
    return this.generalChoice(token);
  }

  updateSettings(input: unknown, ownerToken?: string): void {
    this.requireOwner(ownerToken);
    this.assertWaiting();
    if (!input || typeof input !== 'object')
      throw new AppError(400, 'INVALID_SETTINGS', '房间设置无效。');
    const body = input as Record<string, unknown>;
    const mode = findMode(body.mode);
    if (
      !mode ||
      !Number.isInteger(body.playerCount) ||
      (body.playerCount as number) < mode.minPlayers ||
      (body.playerCount as number) > mode.maxPlayers
    )
      throw new AppError(400, 'INVALID_MODE', '模式或人数不符合要求。');
    if (!Array.isArray(body.extensions) || body.extensions.some((id) => typeof id !== 'string'))
      throw new AppError(400, 'INVALID_EXTENSIONS', '扩展包设置无效。');
    const extensions = [...new Set(body.extensions as string[])];
    if (!GENERAL_PRESETS.some((preset) => preset.id === body.generalPreset))
      throw new AppError(400, 'INVALID_PRESET', '请选择当前可用的武将范围。');
    if (body.allowGeneralSelection !== undefined && typeof body.allowGeneralSelection !== 'boolean')
      throw new AppError(400, 'INVALID_GENERAL_SELECTION', '点将开关需要开启或关闭。');
    if (
      extensions.some(
        (id) =>
          !this.catalog.some((pack) => pack.id === id && pack.supportedModes.includes(mode.id)),
      )
    )
      throw new AppError(400, 'UNSUPPORTED_EXTENSION', '存在尚未验证或不支持当前模式的扩展包。');
    const humans = [...this.players.values()].filter((player) => player.kind === 'human');
    if (humans.length > (body.playerCount as number))
      throw new AppError(409, 'TOO_MANY_PLAYERS', '请先移出多余真人玩家，再减少人数。');
    const next: RoomSettings = {
      mode: mode.id,
      playerCount: body.playerCount as number,
      generalPreset: body.generalPreset as GeneralPresetId,
      allowGeneralSelection:
        (body.allowGeneralSelection as boolean | undefined) ?? this.settings.allowGeneralSelection,
      animationSpeed: this.settings.animationSpeed ?? DEFAULT_ANIMATION_SPEED,
      extensions,
    };
    if (JSON.stringify(next) === JSON.stringify(this.settings)) return;
    if (!next.allowGeneralSelection || next.generalPreset !== this.settings.generalPreset)
      for (const player of this.players.values())
        if (player.kind === 'human') player.general = null;
    this.settings = next;
    // 缩小房间只裁掉多余 AI，绝不自动移出真人。
    for (const bot of [...this.players.values()].reverse()) {
      if (this.players.size <= next.playerCount) break;
      if (bot.kind === 'bot') this.players.delete(bot.id);
    }
    this.resetReady();
    this.changed();
  }

  setAnimationSpeed(value: unknown, ownerToken?: string): void {
    this.requireOwner(ownerToken);
    if (this.phase !== 'waiting')
      throw new AppError(409, 'ROOM_LOCKED', '请在等待大厅修改动画速度。');
    this.updateAnimationSpeed(value);
  }

  /** Separate local operator authority; never grants a player-owner session. */
  consoleSetAnimationSpeed(value: unknown): void {
    this.updateAnimationSpeed(value);
  }

  private updateAnimationSpeed(value: unknown): void {
    if (this.phase === 'closed') throw new AppError(409, 'ROOM_CLOSED', '房间已关闭。');
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 10)
      throw new AppError(400, 'INVALID_ANIMATION_SPEED', '动画速度需要是 1–10 倍的整数。');
    if (value === this.settings.animationSpeed) return;
    this.settings.animationSpeed = value as number;
    this.engine.setAnimationSpeed?.(this.code, value as number);
    // Cosmetic changes retain seats, ready flags, pending choices and deadlines.
    this.changed();
  }

  async start(ownerToken?: string): Promise<void> {
    this.requireOwner(ownerToken);
    this.assertWaiting();
    this.expirePolls();
    if (!this.engine.status().ready)
      throw new AppError(503, 'ENGINE_NOT_READY', this.engine.status().message);
    if (
      this.players.size !== this.settings.playerCount ||
      [...this.players.values()].some((player) => !player.online || !player.ready)
    )
      throw new AppError(409, 'PLAYERS_NOT_READY', '需要人数齐全且所有真人在线、已准备。');
    this.phase = 'starting';
    this.matchFailure = undefined;
    this.matchRecovery = undefined;
    const generation = ++this.startGeneration;
    try {
      const starting = this.engine.start({
        roomCode: this.code,
        ownerPlayerId: this.ownerId!,
        settings: structuredClone(this.settings),
        seats: [...this.players.values()].map(({ id, nickname, kind }) => ({ id, nickname, kind })),
        aiPolicy: 'strongest-native',
        generalSelections: Object.fromEntries(
          [...this.players.values()]
            .filter((player): player is Human => player.kind === 'human' && player.general !== null)
            .map((player) => [player.id, player.general!]),
        ),
      });
      this.changed();
      await starting;
      if (generation !== this.startGeneration)
        throw new AppError(409, 'MATCH_CANCELLED', '电脑控制台已结束这次开局。');
      if (this.phase === 'starting') this.phase = 'playing';
      this.changed();
    } catch {
      if (generation !== this.startGeneration)
        throw new AppError(409, 'MATCH_CANCELLED', '电脑控制台已结束这次开局。');
      this.phase = 'waiting';
      this.betweenMatchesSince = Date.now();
      this.matchRecovery = undefined;
      this.matchFailure ??= { code: 'runtime-error', at: Date.now() };
      this.resetReady();
      this.engine.release?.(this.code);
      this.changed();
      throw new AppError(
        503,
        'ENGINE_START_FAILED',
        '对局启动失败，房间已恢复，请查看电脑服务状态。',
      );
    }
  }

  /** Separate local operator authority, granted only by the console API. */
  consoleRemovePlayer(id: string): void {
    this.assertWaiting();
    const player = this.players.get(id);
    if (!player) throw new AppError(404, 'PLAYER_NOT_FOUND', '这个座位已移除。');
    if (player.id === this.ownerId && player.kind === 'human') {
      this.leave(player.token);
      return;
    }
    this.players.delete(id);
    this.resetReady();
    this.changed();
  }

  consoleReset(): void {
    if (!['starting', 'playing', 'finished'].includes(this.phase))
      throw new AppError(409, 'NO_ACTIVE_MATCH', '这个房间已在等待玩家。');
    this.resetMatch();
    this.changed();
  }

  consoleClose(): void {
    this.startGeneration++;
    this.phase = 'closed';
    this.ownerId = null;
    this.players.clear();
    this.matchFailure = undefined;
    this.matchRecovery = undefined;
    this.engine.release?.(this.code);
    this.changed();
  }

  returnToWaiting(ownerToken?: string): void {
    this.requireOwner(ownerToken);
    if (this.phase !== 'finished')
      throw new AppError(409, 'MATCH_NOT_FINISHED', '请等这一局结束后再返回房间。');
    this.resetMatch();
    this.changed();
  }

  connect(token?: string): () => void {
    let closed = false;
    const player = this.human(token);
    if (player) {
      player.connections++;
      player.online = true;
      player.offlineSince = null;
      this.changed();
    }
    return () => {
      if (closed) return;
      closed = true;
      if (!player || this.players.get(player.id) !== player) return;
      player.connections = Math.max(0, player.connections - 1);
      const online = player.connections > 0 || player.pollUntil > Date.now();
      if (player.online && !online) player.offlineSince = Date.now();
      player.online = online;
      if (!player.online) player.ready = false;
      this.changed();
    };
  }

  /** HTTP polling has a lease so every completed request does not mark a phone offline. */
  poll(token?: string, now = Date.now()): void {
    const player = this.human(token);
    if (!player) return;
    player.pollUntil = now + 30000;
    if (!player.online) {
      player.online = true;
      player.offlineSince = null;
      this.changed();
    }
  }

  expirePolls(now = Date.now()): void {
    for (const player of this.players.values()) {
      if (player.kind !== 'human' || player.connections || !player.online || player.pollUntil > now)
        continue;
      player.online = false;
      player.offlineSince = player.pollUntil;
      player.ready = false;
      this.changed();
    }
  }

  /** Public observers and engine status events never renew a human's room presence. */
  reapIfIdle(now = Date.now()): boolean {
    const deadline = this.idleCloseAt();
    if (deadline === null || now < deadline) return false;
    this.consoleClose();
    return true;
  }

  private human(token?: string): Human | undefined {
    return token
      ? [...this.players.values()].find(
          (seat): seat is Human => seat.kind === 'human' && seat.token === token,
        )
      : undefined;
  }

  private publicPlayer({ id, nickname, kind, ready, online }: Seat): PlayerView {
    return { id, nickname, kind, ready, online };
  }

  private requireOwner(token?: string): void {
    if (!this.ownerId || this.human(token)?.id !== this.ownerId)
      throw new AppError(403, 'OWNER_REQUIRED', '只有本房间的玩家房主可以进行这项操作。');
  }

  private resetReady(): void {
    for (const player of this.players.values()) player.ready = player.kind === 'bot';
  }

  private ownerClaimAt(): number | null {
    const owner = this.ownerId ? this.players.get(this.ownerId) : undefined;
    return owner?.kind === 'human' && !owner.online && owner.offlineSince !== null
      ? owner.offlineSince + OWNER_OFFLINE_GRACE_MS
      : null;
  }

  private idleCloseAt(): number | null {
    if (!['waiting', 'finished'].includes(this.phase)) return null;
    const humans = [...this.players.values()].filter(
      (seat): seat is Human => seat.kind === 'human',
    );
    if (!humans.length || humans.some((player) => player.online)) return null;
    const lastOffline = Math.max(
      this.betweenMatchesSince,
      ...humans.map((player) => player.offlineSince ?? this.betweenMatchesSince),
    );
    return lastOffline + ROOM_IDLE_GRACE_MS;
  }

  private resetMatch(): void {
    this.startGeneration++;
    this.phase = 'waiting';
    this.betweenMatchesSince = Date.now();
    this.matchFailure = undefined;
    this.matchRecovery = undefined;
    this.resetReady();
    this.engine.release?.(this.code);
  }

  private assertBetweenMatches(): void {
    if (!['waiting', 'finished'].includes(this.phase))
      throw new AppError(409, 'ROOM_LOCKED', '请等本局结束后再离房或交接房主。');
  }

  private assertWaiting(): void {
    if (this.phase !== 'waiting')
      throw new AppError(409, 'ROOM_LOCKED', '房间已关闭或对局正在启动，暂时不能修改。');
  }

  private changed(): void {
    if (this.phase === 'closed') {
      this.unsubscribeEngine?.();
      this.unsubscribeEngine = undefined;
    }
    this.revision++;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
