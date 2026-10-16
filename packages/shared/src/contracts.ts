export { GENERAL_PRESETS } from './general-presets.js';
import type { GeneralPresetId } from './general-presets.js';
export type { GeneralPresetId } from './general-presets.js';

export const APP_ID = 'party-sanguosha';
export const APP_VERSION = '0.7.13';
export const OWNER_OFFLINE_GRACE_MS = 60000;
export const ROOM_IDLE_GRACE_MS = 10 * 60000;
export const DEFAULT_ANIMATION_SPEED = 2;
export const ANIMATION_SPEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

export const MODES = [
  {
    id: 'identity',
    name: '经典身份局',
    minPlayers: 5,
    maxPlayers: 8,
    description: '主公、忠臣、反贼、内奸，5–8 人',
  },
  {
    id: 'doudizhu',
    name: '斗地主',
    minPlayers: 3,
    maxPlayers: 3,
    description: '一名地主，两名农民，3 人',
  },
  {
    id: 'versus',
    name: '2v2',
    minPlayers: 4,
    maxPlayers: 4,
    description: 'OL 常规 2v2，1、4 位与 2、3 位各一队，4 人',
  },
  {
    id: 'duel',
    name: '单挑',
    minPlayers: 2,
    maxPlayers: 2,
    description: '两位玩家，面对面对决，2 人',
  },
] as const;

export type ModeId = (typeof MODES)[number]['id'];

export interface ExtensionInfo {
  id: string;
  name: string;
  version: string;
  supportedModes: ModeId[];
}

export interface RoomSettings {
  mode: ModeId;
  playerCount: number;
  generalPreset: GeneralPresetId;
  allowGeneralSelection: boolean;
  /** Presentation multiplier; absent only in older server snapshots. */
  animationSpeed?: number;
  extensions: string[];
}

/** Only the requesting seated human's preference, never a public room snapshot. */
export interface GeneralChoiceView {
  selected: string | null;
  available: string[];
}

/** Loading, lord-first selection, and each human's possible faction deadline. */
export function matchStartTimeout(settings: RoomSettings, humanCount: number): number {
  return (
    150000 +
    (settings.mode === 'identity' ? 2 : 1) * 65000 +
    (settings.generalPreset !== 'beginner' ? humanCount * 65000 : 0)
  );
}

export interface PlayerView {
  id: string;
  nickname: string;
  kind: 'human' | 'bot';
  ready: boolean;
  online: boolean;
}

export interface EngineStatus {
  id: 'noname';
  ready: boolean;
  message: string;
  preload?: boolean;
  lightweight?: boolean;
  cardPilePolicy?: boolean;
  connectionRecovery?: boolean;
  luckCards?: boolean;
  surrender?: boolean;
  playerHistory?: boolean;
  experience?: boolean;
  publicSpectating?: boolean;
  animationSpeed?: boolean;
}

/** Explicit consent only; identity votes do not contain roles or factions. */
export interface SurrenderState {
  kind: 'surrender' | 'end';
  available: boolean;
  cooldownMs: number;
  notice: string;
  vote: {
    epoch: string;
    initiator: string;
    remainingMs: number;
    eligible: boolean;
    voted: boolean;
    participants: { id: string; nickname: string; approved: boolean }[];
  } | null;
}

export interface RoomView {
  code: string;
  revision: number;
  phase: 'waiting' | 'starting' | 'playing' | 'finished' | 'closed';
  matchId: string | null;
  settings: RoomSettings;
  players: PlayerView[];
  ownerId: string | null;
  /** Offline owner's seat is retained; an online member can explicitly claim after this time.
   * Undefined on older servers that do not support ownership management. */
  ownerClaimAt?: number | null;
  /** Lets phones show the ownership grace countdown without trusting their clock. */
  serverTime?: number;
  /** Only waiting/finished rooms with every human offline have an idle deadline. */
  idleCloseAt?: number | null;
  engine: EngineStatus;
  matchFailure?: { code: MatchFailureCode; at: number };
  matchRecovery?: { deadline: number };
}

export type MatchFailureCode =
  | 'worker-disconnected'
  | 'clock-disconnected'
  | 'runtime-error'
  | 'startup-timeout'
  | 'protocol-error';
export const MATCH_FAILURE_MESSAGES: Record<MatchFailureCode, string> = {
  'worker-disconnected': '电脑规则连接已中断，原牌局未能恢复。请保持电脑服务页开启。',
  'clock-disconnected': '电脑规则计时连接已中断，原牌局未能恢复。请检查电脑服务。',
  'runtime-error': '电脑执行牌局时发生异常，本局已中断。',
  'startup-timeout': '开局等待超过期限，请检查电脑服务页和玩家连接。',
  'protocol-error': '电脑规则通信发生异常，本局已中断。',
};

export interface RoomSummary {
  code: string;
  ownerNickname: string;
  mode: ModeId;
  playerCount: number;
  humanCount: number;
  botCount: number;
  phase: RoomView['phase'];
}

export interface ServerInfo {
  version: string;
  homeUrls: string[];
  rooms: RoomSummary[];
  extensions: ExtensionInfo[];
  engine: EngineStatus;
  entry: EntryInfo;
}

export interface EntryInfo {
  mode: 'lan' | 'internet';
  /** Route used to reach this response, independent of public tunnel health. */
  access?: 'lan' | 'internet';
  status: 'starting' | 'ready' | 'unavailable';
  message: string;
}

export interface RoomInfo {
  room: RoomView;
  joinUrls: string[];
  entry: EntryInfo;
}

export interface SessionView {
  playerId: string | null;
  roomCode: string | null;
}

export interface MembershipResult extends RoomInfo {
  playerId: string;
}

export interface ApiError {
  error: { code: string; message: string };
}

export interface IdentityCounts {
  zhu: number;
  zhong: number;
  fan: number;
  nei: number;
}

/** Explicit public projection for an observer; never native serialized state. */
export interface ObserverState {
  updatedAt: number;
  round: number;
  currentPlayerId: string | null;
  ended: boolean;
  deckCount?: number;
  identityCounts?: IdentityCounts | null;
  players: {
    id: string;
    nickname: string;
    general: string;
    identity: string;
    hp: number;
    maxHp: number;
    armor: number;
    handCount: number;
    dead: boolean;
    linked: boolean;
    turnedOver: boolean;
    controller?: 'human' | 'auto' | 'offline' | 'reconnecting' | 'bot';
    equipment: string[];
    judgments: string[];
  }[];
  recent: string[];
  /** Sequence of recent[0], plus total public log count (new rule workers). */
  logStart?: number;
  logTotal?: number;
  logFirst?: number;
}

export interface ObserverLogPage {
  matchId: string;
  total: number;
  first: number;
  entries: { sequence: number; text: string }[];
}

export interface PlayerNetwork {
  playerId: string;
  route: 'local' | 'lan' | 'direct' | 'internet';
  transport: 'websocket' | 'http' | 'rtc';
  rtt: number | null;
  unstable: boolean;
  updatedAt: number;
}

export interface ConsoleRoom {
  room: RoomView;
  observer: ObserverState | null;
  networks: PlayerNetwork[];
}

export interface ConsoleInfo {
  rooms: ConsoleRoom[];
}

export function findMode(id: unknown) {
  return MODES.find((mode) => mode.id === id);
}
