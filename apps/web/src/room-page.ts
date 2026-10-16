import {
  GENERAL_PRESETS,
  MATCH_FAILURE_MESSAGES,
  MODES,
  ANIMATION_SPEEDS,
  DEFAULT_ANIMATION_SPEED,
  findMode,
  matchStartTimeout,
  type GeneralChoiceView,
  type MembershipResult,
  type ModeId,
  type RoomInfo,
  type RoomSettings,
  type RoomView,
  type SessionView,
  type SurrenderState,
} from '../../../packages/shared/src/contracts.js';
import {
  action,
  api,
  app,
  connection,
  disable,
  element,
  frame,
  message,
  perform,
  watchEvents,
} from './ui.js';
import { bindQr, qrMarkup } from './qr.js';
import { bindGeneralGuide, guideButton } from './general-guide.js';
import { createAssetPreloader } from './engine-preloader.js';
import { createLanConnection } from './lan-client.js';
import { modeIcon } from './lobby-art.js';
import { bindClassicToolbar } from './classic-ui.js';
import { renderRosterSource } from './roster-source.js';
import { bindSurrenderDialog } from './surrender-dialog.js';
import { bindMatchRecords } from './match-records.js';
import { bindRoomSpectator } from './room-spectator.js';
import { bindMatchExperience } from './match-experience.js';

export function showRoomPage(initial: RoomInfo, initialSession: SessionView): void {
  let room = initial.room;
  const session = { ...initialSession };
  let events: { close(): void } | undefined;
  let settingsDirty = false;
  let settingsSaving = false;
  let settingsError = '';
  let settingsSaved = false;
  let settingsVersion = 0;
  let settingsGeneration = 0;
  let settingsTimer: ReturnType<typeof setTimeout> | undefined;
  let draftMode: ModeId = room.settings.mode;
  let wasOwner = false;
  let qrBound = false;
  let matchId: string | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  let connectionIssue = false;
  let restoring = false;
  let disconnectedAt = 0;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let finishedSyncTimer: ReturnType<typeof setTimeout> | undefined;
  let finishedSyncMatch: string | null = null;
  const returnedMatchKey = `party_returned_match_${room.code}`;
  let returnedMatchId = sessionStorage.getItem(returnedMatchKey);
  let ownershipTimer: ReturnType<typeof setTimeout> | undefined;
  let serverTimeOffset = Date.now() - (room.serverTime ?? Date.now());
  let pendingReturnMatchId: string | null = null;
  let returning = false;
  let recoveringRules = false;
  let speedSaving = false;
  // Native is the product client, including while an older service is running.
  // Keep the former client reachable only for explicit regression fixtures.
  const lightweight = sessionStorage.getItem('party_lightweight_verification') === '1';
  const playerFrameUrl = (id: string) => `/engine/${lightweight ? 'table' : 'player'}/${id}`;
  let horizontalTable = sessionStorage.getItem('party_table_view') !== 'portrait';
  let localConnection: ReturnType<typeof createLanConnection>;
  let localMatchAttempt: string | null = null;
  let localAttemptAt = 0;
  const roomPath = `/api/rooms/${room.code}`;
  function roomApi<T>(
    path: string,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
    timeoutMs?: number,
  ): Promise<T> {
    return api<T>(
      path,
      method,
      body,
      {
        ...headers,
        ...(method !== 'GET' && session.playerId ? { 'X-Party-Player': session.playerId } : {}),
      },
      timeoutMs,
    );
  }

  frame(
    'room-layout',
    '房间等候厅',
    '群英<span>入席</span>',
    '确认本局规则，准备后由房主开局。',
    `
    <section id="match-panel" class="match-panel" hidden><div class="match-toolbar"><strong id="match-label">正在选将</strong><span id="orientation-hint" class="orientation-hint" hidden>请横着握手机</span><button id="match-orientation" class="button secondary" type="button" hidden>竖屏显示</button><button id="match-sound" class="button secondary" type="button" aria-pressed="false">开启声音</button><label class="match-volume" for="match-volume">音量<input id="match-volume" type="range" min="0" max="100" step="5" value="35" aria-label="声音音量"><output id="match-volume-value" for="match-volume">35%</output></label><button id="match-share" class="button secondary" type="button">房间二维码</button><button id="rematch-button" class="button primary" type="button" hidden>回到房间，准备下一局</button><span id="finished-hint" hidden>请等房主返回房间</span></div><div id="game-frame-container"><div id="game-frame-mount"></div><div id="match-loading" class="match-loading" role="status" aria-live="polite" hidden><strong id="match-loading-status">正在准备对局…</strong><progress id="match-loading-progress" max="6" value="0" aria-label="对局载入步骤"></progress><p id="match-loading-detail">第 1 / 6 步 · 首次进入需要载入游戏资源</p></div></div></section>
    <div class="room-grid">
      <section class="panel welcome-panel"><div class="panel-heading"><h2>我的席位</h2><span class="tag" id="player-room-code"></span></div>
        <div id="other-room" class="message" hidden>你已经在另一间房，请先回去离开。<a id="other-room-link" href="/">返回原房间</a></div>
        <form id="join-form"><label for="nickname">怎么称呼你</label><input id="nickname" name="nickname" placeholder="输入昵称，朋友才认得你" autocomplete="nickname" maxlength="32" required /><p class="hint">昵称 1–16 个字，无需注册账号。</p><button id="join-button" class="button primary full-width" type="submit">入座</button></form>
        <div id="my-seat" hidden><p class="my-seat-label" id="my-role"></p><h3 id="my-nickname"></h3><section id="start-check" class="start-check" aria-label="开局检查" role="status"><strong id="start-check-title"></strong><ul id="start-blockers"></ul></section><div class="room-primary"><button id="ready-button" class="button primary full-width" type="button">我准备好了</button><div id="owner-start" hidden><button id="start-button" class="button secondary full-width" type="button" disabled>开始对局</button></div></div><div class="room-secondary"><button id="share-button" class="button secondary" type="button">展示房间二维码</button><button id="leave-button" class="button text-button" type="button">离开房间</button></div><p id="owner-leave-hint" class="hint" hidden>离开后交接房主；最后一位真人离开会关闭房间。</p></div>
        <details id="room-rules-summary" class="room-rules-summary"><summary><span id="summary-mode" class="summary-mode"></span><span id="summary-details"></span><span class="rules-expand">查看规则</span></summary><div class="room-rules-body"><p id="summary-preset" class="hint"></p>${guideButton}</div></details>
      </section>
      <section class="panel players-panel"><div class="panel-heading"><div><p class="section-index">虚位以待 · 共聚一堂</p><h2>本桌席位</h2></div><span id="player-counter" class="tag muted"></span></div><p id="seat-count" class="hint seat-count"></p><ul id="players" class="players"></ul><div id="bot-controls" class="bot-controls" hidden><button id="add-bot" class="button secondary" type="button">添加 1 个 AI</button><button id="fill-bots" class="button subtle" type="button">用 AI 补满空位</button></div><p id="waiting-text" class="waiting-text"></p><details class="room-service-details"><summary>房主与连接状态</summary><p id="owner-status" class="hint"></p><p id="engine-status" class="hint engine-status"></p></details></section>
      <details id="settings-panel" class="panel settings-panel" hidden><summary><span>房主设置</span><small>玩法 · 武将 · 动画</small></summary><div class="settings-body"><section id="tempo-settings" class="settings-group"><h3>动画与节奏</h3></section><section class="settings-group"><h3>开局规则</h3><div class="mode-grid">${MODES.map((mode) => `<button type="button" class="mode-card" data-mode="${mode.id}" aria-pressed="false"><span class="mode-mark">${modeIcon(mode.id)}</span><strong>${mode.name}</strong><small>${mode.minPlayers === mode.maxPlayers ? mode.minPlayers : '5–8'} 席</small></button>`).join('')}</div><p id="mode-description" class="mode-description"></p><label for="player-count">总席位（含 AI）<select id="player-count"></select></label></section><section class="settings-group"><h3>武将与点将</h3><label for="general-preset">武将范围<select id="general-preset">${GENERAL_PRESETS.map((preset) => `<option value="${preset.id}">${preset.name}</option>`).join('')}</select></label><p id="preset-description" class="hint"></p></section><button id="save-settings" class="button secondary full-width" type="button" hidden>重试保存</button><p id="settings-state" class="hint" role="status" aria-live="polite"></p></div></details>
    </div>
    <dialog id="share-dialog" aria-labelledby="share-title"><div class="panel-heading"><h2 id="share-title">扫码直接进入本房间</h2><button id="close-share" class="close-dialog" type="button" aria-label="关闭房间二维码">×</button></div><p class="room-code">房间 <strong>${room.code}</strong></p>${qrMarkup('本房间邀请二维码', '微信扫一扫 · 直接进入这张牌桌')}</dialog>`,
  );
  const surrender = bindSurrenderDialog(() => room.settings.mode);
  element('#room-rules-summary').insertAdjacentHTML(
    'beforebegin',
    '<button id="room-settings-link" class="button secondary full-width room-settings-link" type="button" hidden>房主设置 · 动画与规则</button>',
  );
  element('#room-settings-link').addEventListener('click', () => {
    const panel = element<HTMLDetailsElement>('#settings-panel');
    panel.open = true;
    panel.scrollIntoView({ block: 'start' });
    element<HTMLSelectElement>(
      room.engine.animationSpeed ? '#room-animation-speed' : '#player-count',
    ).focus({ preventScroll: true });
  });
  const records = bindMatchRecords();
  const experience = bindMatchExperience();
  const speedOptions = ANIMATION_SPEEDS.map(
    (speed) =>
      `<option value="${speed}">${speed} 倍${speed === 2 ? '（默认）' : speed === 1 ? '（原速）' : ''}</option>`,
  ).join('');
  element('#tempo-settings').insertAdjacentHTML(
    'beforeend',
    `<div id="room-speed-control"><label for="room-animation-speed">动画速度<select id="room-animation-speed">${speedOptions}</select></label><p class="hint">在等待大厅修改 · 全桌同步 · 思考时间不变</p></div>`,
  );
  element('#room-rules-summary').insertAdjacentHTML(
    'afterend',
    '<p id="summary-animation-speed" class="hint" hidden></p>',
  );
  function syncAnimationSpeed(): void {
    if (!room.engine.animationSpeed) return;
    document.querySelector<HTMLIFrameElement>('#game-frame')?.contentWindow?.postMessage(
      {
        type: 'party-animation-speed',
        matchId: room.matchId,
        animationSpeed: room.settings.animationSpeed ?? DEFAULT_ANIMATION_SPEED,
      },
      location.origin,
    );
  }
  const spectator = bindRoomSpectator(room.code);
  function updateMatchControls(): void {
    const connected =
      !connectionIssue &&
      !room.matchRecovery &&
      !room.matchFailure &&
      !(connectionNotice.classList.contains('blocking') && !connectionNotice.hidden);
    surrender.context(
      matchId,
      Boolean(matchId) && room.phase === 'playing' && Boolean(room.engine.surrender),
      connected,
    );
    experience.context(
      matchId,
      room.phase === 'playing' && connected,
      Boolean(room.engine.experience),
    );
    toolbar.update(connected, room.phase === 'finished');
  }
  for (const [anchor, id] of [
    ['#preset-description', 'preset-source'],
    ['#summary-preset', 'summary-roster-source'],
  ] as const) {
    const source = document.createElement('div');
    source.id = id;
    element(anchor).after(source);
  }
  element('#preset-description').insertAdjacentHTML(
    'afterend',
    '<label class="general-selection-setting"><input id="allow-general-selection" type="checkbox" />允许点将</label><p id="general-selection-description" class="hint">开放后，真人可在大厅点一名武将作为第1个候选；同局上场武将不重复，开局仍需选将。</p>',
  );
  element('#settings-panel summary small').textContent = '玩法 · 武将 · 点将 · 动画';
  element('#preset-description').insertAdjacentHTML(
    'afterend',
    '<p id="preset-deck" class="hint"></p>',
  );
  element('#summary-preset').insertAdjacentHTML(
    'afterend',
    '<p id="summary-deck" class="hint"></p><p id="summary-selection" class="hint"></p><p id="summary-rules" class="hint" hidden></p>',
  );
  element('#ready-button').insertAdjacentHTML(
    'afterend',
    '<div id="general-pick-panel" hidden><button id="general-pick" class="button secondary full-width" type="button">点将 · 设置第1个候选</button><p id="general-pick-state" class="hint" role="status"></p></div>',
  );
  element('#owner-start').insertAdjacentHTML(
    'afterend',
    '<div id="owner-transfer-row" hidden><button id="owner-transfer" class="button secondary full-width" type="button">转交房主</button></div><div id="owner-claim-row" hidden><button id="owner-claim" class="button secondary full-width" type="button">接任房主</button><p id="owner-claim-hint" class="hint" role="status"></p></div>',
  );
  app.insertAdjacentHTML(
    'beforeend',
    '<dialog id="ownership-dialog" aria-labelledby="ownership-title"><div class="panel-heading"><h2 id="ownership-title">转交房主</h2><button id="ownership-close" class="close-dialog" type="button" aria-label="关闭转交房主">×</button></div><p class="hint">转交后你仍在原席位；新房主管理设置、AI和下一局开局，真人需要重新准备。</p><label for="owner-successor">交给哪位朋友<select id="owner-successor"></select></label><button id="ownership-confirm" class="button primary full-width" type="button" disabled>确认转交</button></dialog>',
  );
  const matchLeave = document.createElement('button');
  matchLeave.id = 'match-leave';
  matchLeave.className = 'button secondary';
  matchLeave.type = 'button';
  matchLeave.textContent = '离开房间';
  matchLeave.hidden = true;
  element('#rematch-button').after(matchLeave);
  const generalGuide = bindGeneralGuide(() => room.settings.generalPreset, {
    sharedTeamPool: () => room.settings.mode === 'versus',
    enabled: () =>
      room.phase === 'waiting' &&
      room.settings.allowGeneralSelection === true &&
      session.roomCode === room.code &&
      room.players.some((player) => player.id === session.playerId),
    read: () => roomApi<GeneralChoiceView>(`${roomPath}/me/general`),
    choose: (general) => roomApi<GeneralChoiceView>(`${roomPath}/me/general`, 'PUT', { general }),
  });
  const preloadStatus = document.createElement('p');
  preloadStatus.id = 'engine-preload';
  preloadStatus.className = 'hint';
  preloadStatus.setAttribute('role', 'status');
  element('.welcome-panel').appendChild(preloadStatus);
  const preloader = createAssetPreloader(preloadStatus, lightweight);
  const waitingReturn = document.createElement('p');
  waitingReturn.id = 'waiting-return';
  waitingReturn.className = 'message';
  waitingReturn.hidden = true;
  waitingReturn.textContent = '你已回到房间，等房主准备下一局。';
  element('.welcome-panel').prepend(waitingReturn);
  const roomFailure = document.createElement('p');
  roomFailure.className = 'message';
  roomFailure.id = 'room-failure';
  roomFailure.hidden = true;
  element('.welcome-panel').prepend(roomFailure);
  const roomIdle = document.createElement('p');
  roomIdle.id = 'room-idle-hint';
  roomIdle.className = 'hint';
  roomIdle.hidden = true;
  roomIdle.textContent = '所有入座玩家已离线；连续10分钟无人回房，这间房将自动关闭。';
  element('.welcome-panel').append(roomIdle);
  const networkStatus = document.createElement('span');
  networkStatus.id = 'match-network';
  networkStatus.className = 'match-network';
  networkStatus.textContent = '网络检测中';
  networkStatus.title = '最近一次手机到电脑服务的往返延迟，游戏动画不计入';
  element('.match-toolbar').insertBefore(networkStatus, element('#orientation-hint'));
  const restoreButton = document.createElement('button');
  restoreButton.id = 'match-restore';
  restoreButton.className = 'button secondary';
  restoreButton.type = 'button';
  restoreButton.textContent = '恢复牌桌';
  action(restoreButton, restoreGame);
  element('.match-toolbar').insertBefore(restoreButton, element('#match-share'));
  const toolbar = bindClassicToolbar(app);
  const connectionNotice = document.createElement('section');
  connectionNotice.id = 'match-connection';
  connectionNotice.className = 'match-connection';
  connectionNotice.hidden = true;
  connectionNotice.setAttribute('role', 'alert');
  connectionNotice.innerHTML =
    '<strong id="match-connection-title"></strong><p id="match-connection-detail"></p><button id="match-retry" class="button primary" type="button">立即重连</button><button id="match-manual" class="button primary" type="button" hidden>恢复手动操作</button>';
  element('#game-frame-container').append(connectionNotice);
  action(element('#match-retry'), restoreGame);
  action(element('#match-manual'), async () => {
    document
      .querySelector<HTMLIFrameElement>('#game-frame')
      ?.contentWindow?.postMessage({ type: 'party-manual', matchId }, location.origin);
  });
  function showConnectionNotice(
    title: string,
    detail: string,
    blocking: boolean,
    auto = false,
  ): void {
    clearTimeout(noticeTimer);
    connectionNotice.hidden = false;
    connectionNotice.classList.toggle('blocking', blocking);
    element('#match-connection-title').textContent = title;
    element('#match-connection-detail').textContent = detail;
    element('#match-retry').hidden = !blocking;
    element('#match-manual').hidden = !auto;
    element('#game-frame-mount').classList.toggle('connection-blocked', blocking);
    const frame = document.querySelector<HTMLIFrameElement>('#game-frame');
    if (frame) frame.inert = blocking;
    updateMatchControls();
  }
  function confirmConnection(auto = false, offline = false): void {
    if (room.matchFailure || room.matchRecovery) return;
    const wasInterrupted = connectionIssue;
    connectionIssue = false;
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    reconnectAttempt = 0;
    element('#game-frame-mount').classList.remove('connection-blocked');
    const frame = document.querySelector<HTMLIFrameElement>('#game-frame');
    if (frame) frame.inert = false;
    if (auto)
      showConnectionNotice(
        '你正在托管',
        `${wasInterrupted ? '已恢复连接，请先核对当前牌桌。' : ''}AI 正在替你操作，点击下方按钮收回操作。`,
        false,
        true,
      );
    else if (wasInterrupted) {
      const seconds = Math.max(1, Math.round((Date.now() - disconnectedAt) / 1000));
      showConnectionNotice(
        '已恢复连接 · 手动操作',
        `本次恢复耗时约 ${seconds} 秒。${offline ? '断线期间 AI 可能已行动，请核对当前回合、体力和手牌。' : '已同步当前牌桌；AI 可能已按原期限行动，请核对回合、体力和手牌。未完成选择仍沿用原期限。'}`,
        false,
      );
      noticeTimer = setTimeout(() => {
        connectionNotice.hidden = true;
      }, 10000);
    } else connectionNotice.hidden = true;
    refresh();
  }

  const owner = () => session.roomCode === room.code && session.playerId === room.ownerId;
  const refresh = () => renderRoom(room);

  function renderOwnership(): void {
    clearTimeout(ownershipTimer);
    const me =
      session.roomCode === room.code
        ? room.players.find((player) => player.id === session.playerId)
        : undefined;
    const between = ['waiting', 'finished'].includes(room.phase);
    const supported = room.ownerClaimAt !== undefined;
    element('#owner-transfer-row').hidden = !me || !owner() || !between || !supported;
    disable(element('#owner-transfer'), settingsDirty || settingsSaving || !between);
    const claiming = Boolean(me && !owner() && between && typeof room.ownerClaimAt === 'number');
    element('#owner-claim-row').hidden = !claiming;
    if (claiming) {
      const seconds = Math.max(
        0,
        Math.ceil((room.ownerClaimAt! + serverTimeOffset - Date.now()) / 1000),
      );
      disable(element('#owner-claim'), seconds > 0 || !me?.online);
      element('#owner-claim-hint').textContent = seconds
        ? `房主暂时离线，${seconds}秒后可接任；房主重新连接会取消倒计时。`
        : '房主已连续离线满60秒。可接任以继续这一桌，原房主的席位仍保留。';
      if (seconds > 0) ownershipTimer = setTimeout(renderOwnership, 1000);
    }
    if (!me || !owner() || !between) element<HTMLDialogElement>('#ownership-dialog').close();
  }

  function refreshSuccessors(): void {
    const select = element<HTMLSelectElement>('#owner-successor');
    const selected = select.value;
    select.replaceChildren(new Option('选择一位在线玩家', ''));
    for (const player of room.players)
      if (player.kind === 'human' && player.online && player.id !== room.ownerId)
        select.add(new Option(player.nickname, player.id));
    select.value = selected;
    disable(element('#ownership-confirm'), !select.value || !owner());
  }
  function resizeTable(): void {
    const panel = element('#match-panel');
    const portrait = window.innerWidth < window.innerHeight;
    const rotated = portrait && horizontalTable;
    panel.classList.toggle('rotated-table', rotated);
    panel.style.setProperty('--table-width', `${window.innerHeight}px`);
    panel.style.setProperty('--table-height', `${window.innerWidth}px`);
    element('#match-orientation').hidden = !portrait;
    element('#match-orientation').textContent = horizontalTable ? '竖屏显示' : '横屏牌桌';
    element('#orientation-hint').hidden = !rotated;
  }
  element('#match-orientation').addEventListener('click', () => {
    horizontalTable = !horizontalTable;
    sessionStorage.setItem('party_table_view', horizontalTable ? 'landscape' : 'portrait');
    resizeTable();
  });
  window.addEventListener('resize', resizeTable);
  element('#match-sound').addEventListener('click', () => {
    const frame = document.querySelector<HTMLIFrameElement>('#game-frame');
    const engine = (
      frame?.contentWindow as
        | (Window & {
            partyEngine?: {
              audio?: { toggle(): Promise<void>; setEnabled?(enabled: boolean): Promise<void> };
            };
          })
        | null
    )?.partyEngine;
    const audio = engine?.audio;
    if (audio?.setEnabled)
      void audio.setEnabled(element('#match-sound').getAttribute('aria-pressed') !== 'true');
    else void audio?.toggle();
  });
  element<HTMLInputElement>('#match-volume').addEventListener('input', (event) => {
    const volume = Number((event.target as HTMLInputElement).value);
    element('#match-volume-value').textContent = volume + '%';
    const audio = (
      document.querySelector<HTMLIFrameElement>('#game-frame')?.contentWindow as
        (Window & { partyEngine?: { audio?: { setVolume?(volume: number): void } } }) | null
    )?.partyEngine?.audio;
    audio?.setVolume?.(volume);
  });
  async function restoreGame(): Promise<void> {
    if (room.matchFailure || room.matchRecovery) return;
    const restoringMatch = matchId;
    if (!restoringMatch || restoring) return;
    restoring = true;
    try {
      const info = await roomApi<RoomInfo>(roomPath, 'GET', undefined, {}, 8000);
      renderRoom(info.room);
      const frame = document.querySelector<HTMLIFrameElement>('#game-frame');
      if (
        frame &&
        matchId === restoringMatch &&
        info.room.matchId === restoringMatch &&
        ['starting', 'playing', 'finished'].includes(info.room.phase)
      ) {
        element('#match-loading-status').textContent =
          info.room.phase === 'finished' ? '正在同步最终牌桌…' : '正在恢复原座位…';
        element('#match-loading').hidden = false;
        frame.src = playerFrameUrl(restoringMatch);
        if (connectionIssue && !reconnectTimer)
          reconnectTimer = setTimeout(() => {
            reconnectTimer = undefined;
            reconnectGame();
          }, 30000);
      }
    } finally {
      restoring = false;
    }
  }
  function reconnectGame(): void {
    if (room.matchFailure || room.matchRecovery) return;
    if (reconnectTimer || !matchId || !['starting', 'playing', 'finished'].includes(room.phase))
      return;
    if (!connectionIssue) disconnectedAt = Date.now();
    connectionIssue = true;
    showConnectionNotice(
      '连接中断，正在恢复原座位',
      '请保持此页面开启。短暂断线保留原选择；原操作期限到期由 AI 完成，长断线后续选择由 AI 接管。',
      true,
    );
    element('#match-label').textContent = '连接中断，正在恢复原座位…';
    reconnectTimer = setTimeout(
      () => {
        reconnectTimer = undefined;
        void restoreGame().catch(reconnectGame);
      },
      Math.min(5000, 1000 * ++reconnectAttempt),
    );
  }
  window.addEventListener('message', (event) => {
    const frame = document.querySelector<HTMLIFrameElement>('#game-frame');
    if (
      event.origin !== location.origin ||
      event.source !== frame?.contentWindow ||
      event.data?.matchId !== matchId
    )
      return;
    if (event.data.type === 'party-disconnected') reconnectGame();
    if (event.data.type === 'party-connection-ended') {
      if (room.matchFailure || room.matchRecovery) return;
      if (!connectionIssue) disconnectedAt = Date.now();
      connectionIssue = true;
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      showConnectionNotice('牌桌连接已结束', String(event.data.reason).slice(0, 160), true);
    }
    if (
      event.data.type === 'party-checking' &&
      !connectionIssue &&
      !room.matchFailure &&
      !room.matchRecovery
    )
      showConnectionNotice('正在确认牌桌连接', '返回前台后先同步连接状态，请稍候。', true);
    if (event.data.type === 'party-control')
      confirmConnection(event.data.auto === true, event.data.offline === true);
    if (event.data.type === 'party-surrender-state')
      surrender.update(event.data.state as SurrenderState);
    if (event.data.type === 'party-return-room')
      void perform(element('#rematch-button'), returnRoom, refresh);
    if (event.data.type === 'party-network') {
      const data = event.data;
      const milliseconds = Number.isFinite(data.rtt) ? `${Math.round(data.rtt)} ms` : '';
      networkStatus.textContent = data.unstable
        ? `网络不稳${milliseconds ? ` · ${milliseconds}` : ''}`
        : `${data.route === 'lan' ? '局域网直连' : data.route === 'direct' ? '跨网络直连' : data.route === 'internet' ? '公网' : '局域网'} · ${milliseconds || '检测中'}${data.rtt >= 600 ? ' · 稍慢' : ''}`;
      networkStatus.classList.toggle('slow-network', data.unstable || data.rtt >= 600);
      networkStatus.dataset.route = data.route;
      networkStatus.dataset.rtt = String(data.rtt ?? '');
      networkStatus.dataset.transport = data.transport ?? '';
      if (data.unstable && !connectionIssue && !room.matchRecovery && !room.matchFailure) {
        showConnectionNotice(
          '牌桌连接暂时没有响应',
          '正在检测并自动恢复。请稍候，避免反复点击；原操作期限仍在计时。',
          true,
        );
      } else if (
        !data.unstable &&
        !connectionIssue &&
        !room.matchRecovery &&
        !room.matchFailure &&
        connectionNotice.classList.contains('blocking')
      ) {
        connectionNotice.hidden = true;
        element('#game-frame-mount').classList.remove('connection-blocked');
        if (frame) frame.inert = false;
        updateMatchControls();
      }
    }
    if (event.data.type === 'party-loading' && !room.matchFailure) {
      element('#match-loading').hidden = event.data.failed || event.data.step === 6;
      element('#match-loading-status').textContent = event.data.message;
      element('#match-loading-detail').textContent = event.data.detail;
      element<HTMLProgressElement>('#match-loading-progress').value = event.data.step;
    }
    if (event.data.type === 'party-audio') {
      const button = element('#match-sound');
      button.textContent = event.data.enabled ? '声音开' : event.data.muted ? '声音关' : '开启声音';
      button.setAttribute('aria-pressed', String(event.data.enabled));
      if (typeof event.data.volume === 'number' && Number.isFinite(event.data.volume)) {
        element<HTMLInputElement>('#match-volume').value = String(event.data.volume);
        element('#match-volume-value').textContent = event.data.volume + '%';
      }
    }
    if (event.data.type === 'party-connected') {
      element('#match-loading').hidden = true;
      if (!room.engine.connectionRecovery) confirmConnection();
      refresh();
    }
    if (event.data.type === 'party-animation-ready') syncAnimationSpeed();
  });
  window.addEventListener(
    'pagehide',
    () => {
      clearTimeout(reconnectTimer);
      clearTimeout(finishedSyncTimer);
      clearTimeout(noticeTimer);
      clearTimeout(settingsTimer);
      clearTimeout(ownershipTimer);
      settingsGeneration++;
    },
    { once: true },
  );
  window.addEventListener('offline', () => {
    if (matchId) reconnectGame();
  });
  window.addEventListener('online', () => {
    if (connectionIssue) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      void restoreGame().catch(reconnectGame);
    }
  });

  function setDraftMode(modeId: ModeId, count: number): void {
    draftMode = modeId;
    const mode = findMode(modeId)!;
    app.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
      const selected = button.dataset.mode === modeId;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    const select = element<HTMLSelectElement>('#player-count');
    select.replaceChildren();
    for (let value = mode.minPlayers; value <= mode.maxPlayers; value++)
      select.add(new Option(`${value} 席`, String(value)));
    select.value = String(
      count >= mode.minPlayers && count <= mode.maxPlayers ? count : mode.minPlayers,
    );
    select.disabled = mode.minPlayers === mode.maxPlayers || room.phase !== 'waiting';
    element('#mode-description').textContent = mode.description;
    preloader.update(
      Boolean(room.engine.preload) && room.phase === 'waiting',
      element<HTMLSelectElement>('#general-preset').value,
      draftMode,
    );
  }

  function presetDescription(): void {
    const selected = element<HTMLSelectElement>('#general-preset').value;
    element('#preset-description').textContent =
      GENERAL_PRESETS.find((preset) => preset.id === selected)?.description ?? '';
    renderRosterSource(element('#preset-source'), selected);
    element('#preset-deck').textContent = cardPileDescription(selected);
    preloader.update(Boolean(room.engine.preload) && room.phase === 'waiting', selected, draftMode);
  }

  function cardPileDescription(presetId: string): string {
    const preset = GENERAL_PRESETS.find((entry) => entry.id === presetId);
    if (!room.engine.cardPilePolicy)
      return '牌堆：标准108张；电脑更新并重启服务后，进阶档使用军争160张。';
    return `牌堆：${preset?.cardPile ?? ''}；四种模式按档位统一使用。`;
  }

  function renderRoom(snapshot: RoomView): void {
    // 旧 HTTP 响应晚于 SSE 到达时，仍使用较新的在线和权限状态。
    if (snapshot.revision < room.revision) return;
    if (snapshot !== room && typeof snapshot.serverTime === 'number')
      serverTimeOffset = Date.now() - snapshot.serverTime;
    room = snapshot;
    if (returnedMatchId && (returnedMatchId !== room.matchId || room.phase === 'waiting')) {
      returnedMatchId = null;
      sessionStorage.removeItem(returnedMatchKey);
    }
    preloader.update(
      Boolean(room.engine.preload) && room.phase === 'waiting',
      settingsDirty
        ? element<HTMLSelectElement>('#general-preset').value
        : room.settings.generalPreset,
      settingsDirty ? draftMode : room.settings.mode,
    );
    const me =
      session.roomCode === room.code
        ? room.players.find((player) => player.id === session.playerId)
        : undefined;
    if (session.roomCode === room.code && session.playerId && !me) {
      session.playerId = null;
      session.roomCode = null;
      element<HTMLDialogElement>('#share-dialog').close();
      message(
        room.phase === 'closed'
          ? '房间已关闭，请返回主页。'
          : '你的座位已被房主移除，可以重新入座或返回主页。',
      );
      qrBound = false;
    }
    const isOwner = owner();
    if (!me && localConnection) {
      localConnection.close();
      localConnection = undefined;
      Object.assign(window, { partyLan: undefined });
    }
    if (
      me &&
      (initial.entry?.access ?? initial.entry?.mode) === 'internet' &&
      room.engine.preload &&
      (!localConnection ||
        (localConnection.closed &&
          (room.matchId !== localMatchAttempt || Date.now() - localAttemptAt >= 30000)))
    ) {
      localConnection = createLanConnection(room.code);
      localMatchAttempt = room.matchId;
      localAttemptAt = Date.now();
      Object.assign(window, { partyLan: localConnection });
    }
    const waiting = room.phase === 'waiting';
    const inMatch = Boolean(
      me &&
      room.matchId &&
      returnedMatchId !== room.matchId &&
      ['starting', 'playing', 'finished'].includes(room.phase),
    );
    element('#match-panel').hidden = !inMatch;
    app.classList.toggle('in-match', inMatch);
    document.body.classList.toggle('playing-match', inMatch);
    spectator.context(room, !me);
    resizeTable();
    element('#match-label').textContent = room.matchFailure
      ? '本局中断 · 未判胜负'
      : room.matchRecovery
        ? '电脑规则连接中断，正在恢复…'
        : connectionIssue
          ? '连接中断，正在恢复原座位…'
          : room.phase === 'finished'
            ? '本局已结束'
            : room.phase === 'starting'
              ? '正在选将'
              : `${findMode(room.settings.mode)!.name} · ${room.code}`;
    element('#rematch-button').hidden = room.phase !== 'finished';
    element('#rematch-button').textContent = isOwner ? '回到房间，准备下一局' : '回到房间';
    element('#finished-hint').hidden = room.phase !== 'finished' || isOwner;
    matchLeave.hidden = room.phase !== 'finished' || room.ownerClaimAt === undefined;
    waitingReturn.hidden = room.phase !== 'finished' || returnedMatchId !== room.matchId;
    if (inMatch && room.matchId !== matchId) {
      const frame = document.createElement('iframe');
      frame.id = 'game-frame';
      frame.title = '三国杀对局';
      frame.allow = 'autoplay';
      frame.src = playerFrameUrl(room.matchId!);
      frame.addEventListener('load', () => {
        syncAnimationSpeed();
        if (room.phase === 'finished' && !room.matchFailure)
          frame.contentWindow?.postMessage(
            { type: 'party-finished', matchId: room.matchId },
            location.origin,
          );
      });
      element('#game-frame-mount').replaceChildren(frame);
      element('#match-loading').hidden = false;
      element('#match-sound').textContent = '开启声音';
      matchId = room.matchId;
      connectionIssue = false;
      connectionNotice.hidden = true;
      disconnectedAt = 0;
    } else if (!inMatch && matchId) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      element('#game-frame-mount').replaceChildren();
      element('#match-loading').hidden = true;
      matchId = null;
      connectionIssue = false;
      connectionNotice.hidden = true;
      clearTimeout(noticeTimer);
    }
    if (inMatch && room.phase === 'finished' && !room.matchFailure)
      document
        .querySelector<HTMLIFrameElement>('#game-frame')
        ?.contentWindow?.postMessage(
          { type: 'party-finished', matchId: room.matchId },
          location.origin,
        );
    updateMatchControls();
    syncAnimationSpeed();
    const speedSupported = Boolean(room.engine.animationSpeed);
    const animationSpeed = room.settings.animationSpeed ?? DEFAULT_ANIMATION_SPEED;
    element('#room-speed-control').hidden = !speedSupported || !isOwner || !waiting;
    element('#summary-animation-speed').hidden = !speedSupported;
    element('#summary-animation-speed').textContent =
      `动画 ${animationSpeed} 倍 · 全桌同步 · 思考时间不变`;
    const speedControl = element<HTMLSelectElement>('#room-animation-speed');
    if (!speedSaving) speedControl.value = String(animationSpeed);
    speedControl.disabled = speedSaving || !isOwner || !waiting;
    records.context(inMatch ? room.matchId : null, Boolean(room.engine.playerHistory));
    roomFailure.hidden = !room.matchFailure || inMatch;
    roomIdle.hidden = room.idleCloseAt == null || room.phase === 'closed';
    roomFailure.textContent = room.matchFailure
      ? MATCH_FAILURE_MESSAGES[room.matchFailure.code]
      : '';
    restoreButton.hidden = Boolean(room.matchFailure || room.matchRecovery);
    if (inMatch && room.matchFailure) {
      clearTimeout(reconnectTimer);
      clearTimeout(finishedSyncTimer);
      showConnectionNotice(
        '本局中断 · 未判胜负',
        `${MATCH_FAILURE_MESSAGES[room.matchFailure.code]} 房间和席位仍在，请点击「回到房间」后重新准备。`,
        true,
      );
      element('#match-retry').hidden = true;
      element('#match-loading').hidden = true;
    } else if (inMatch && room.matchRecovery) {
      recoveringRules = true;
      if (!connectionIssue) disconnectedAt = Date.now();
      connectionIssue = true;
      clearTimeout(reconnectTimer);
      showConnectionNotice(
        '电脑规则连接中断，正在恢复',
        '正在尝试恢复原牌局，最多等待20秒。请保持电脑服务页开启；原操作期限继续计时。',
        true,
      );
      element('#match-retry').hidden = true;
    } else if (recoveringRules) {
      recoveringRules = false;
      // Frames sent just before the local relay dropped can be lost in flight.
      // Restore each private view and pending choice from this same worker;
      // a live connection alone cannot prove the old canvas is current.
      void restoreGame().catch(reconnectGame);
    }
    if (room.phase !== 'finished' || finishedSyncMatch !== room.matchId) {
      clearTimeout(finishedSyncTimer);
      finishedSyncTimer = undefined;
    }
    if (
      inMatch &&
      room.phase === 'finished' &&
      !room.matchFailure &&
      finishedSyncMatch !== room.matchId
    ) {
      finishedSyncMatch = room.matchId;
      finishedSyncTimer = setTimeout(() => {
        finishedSyncTimer = undefined;
        const frame = document.querySelector<HTMLIFrameElement>('#game-frame');
        const native = (
          frame?.contentWindow as
            (Window & { partyEngine?: { _status?: { over?: boolean } } }) | null
        )?.partyEngine;
        // The lobby can finish while an interrupted native client still shows
        // old HP and equipment. Allow normal delivery, then fetch an authenticated
        // native reinit once; never fabricate a winner or alter the rule worker.
        if (room.phase === 'finished' && matchId === finishedSyncMatch && !native?._status?.over)
          void restoreGame().catch(() => {
            if (room.phase === 'finished' && matchId === finishedSyncMatch)
              element('#match-label').textContent = '本局已结束，点击恢复牌桌同步最终画面';
          });
      }, 2000);
    }
    if (isOwner !== wasOwner) {
      settingsGeneration++;
      clearTimeout(settingsTimer);
      settingsDirty = false;
      settingsError = '';
      settingsSaved = false;
      if (isOwner)
        element<HTMLDetailsElement>('#settings-panel').open =
          window.matchMedia('(min-width: 761px)').matches;
      wasOwner = isOwner;
    }
    if (!waiting && settingsDirty) {
      settingsGeneration++;
      clearTimeout(settingsTimer);
      settingsDirty = false;
      settingsError = '';
    }
    const settingsPending = settingsDirty || settingsSaving;
    const humans = room.players.filter((player) => player.kind === 'human');
    const bots = room.players.filter((player) => player.kind === 'bot');
    const readyHumans = humans.filter((player) => player.online && player.ready).length;
    const empty = room.settings.playerCount - room.players.length;
    const blockers: string[] = [];
    if (me && !me.online) blockers.push('你已离线，正在重新连接');
    else if (me && !me.ready) blockers.push('你尚未准备');
    const others = humans.filter((player) => player.id !== me?.id);
    const offline = others.filter((player) => !player.online).length;
    const unready = others.filter((player) => player.online && !player.ready).length;
    if (offline) blockers.push(`${offline} 位朋友离线，等待重新连接`);
    if (unready) blockers.push(`${unready} 位朋友尚未准备`);
    if (empty > 0) blockers.push(`还差 ${empty} 个席位 · 邀请朋友或用 AI 补位`);
    if (!room.engine.ready) blockers.push('电脑规则服务未就绪，请保持电脑服务台开启');
    if (settingsPending)
      blockers.push(settingsError ? '房主设置保存失败，请重试' : '正在保存房主设置');
    element('#start-check').hidden = !waiting;
    element('#start-check').classList.toggle('all-ready', blockers.length === 0);
    element('#start-check-title').textContent = blockers.length
      ? `开局还差 ${blockers.length} 项`
      : isOwner
        ? '一切就绪，可以开局'
        : '一切就绪，等待房主开局';
    element('#start-blockers').replaceChildren(
      ...blockers.map((text) => {
        const item = document.createElement('li');
        item.textContent = text;
        return item;
      }),
    );
    const mode = findMode(room.settings.mode)!;
    const preset = GENERAL_PRESETS.find((entry) => entry.id === room.settings.generalPreset);
    renderRosterSource(element('#summary-roster-source'), room.settings.generalPreset);
    element('#player-counter').textContent =
      `${room.players.length} / ${room.settings.playerCount} 席`;
    element('#seat-count').textContent = `${humans.length} 位真人 · ${bots.length} 个 AI`;
    element('#player-room-code').textContent = room.code;
    element('#summary-mode').textContent = mode.name;
    element('#summary-details').textContent =
      `${room.settings.playerCount} 席 · ${preset?.name ?? '将池已移除'}`;
    element('#summary-preset').textContent =
      preset?.description ?? '请房主选择当前可用的武将范围，再准备下一局。';
    element('#summary-deck').textContent = cardPileDescription(room.settings.generalPreset);
    if (room.engine.luckCards)
      element('#summary-deck').textContent +=
        ' 每位真人每局可免费刷新起手牌3次，30秒内完成；AI保留原牌。';
    element('#summary-selection').textContent =
      `${room.settings.allowGeneralSelection ? '点将已开放' : '点将未开放'}${room.settings.mode === 'identity' ? ` · 主公 ${room.settings.generalPreset === 'beginner' ? 5 : 10} 名候选，其余每人 ${room.settings.generalPreset === 'beginner' ? 3 : 6} 名；主公先选并展示` : ''}`;
    element('#summary-rules').hidden = room.settings.mode !== 'versus';
    element('#summary-rules').textContent =
      'OL 常规 2v2：随机座次，1、4 号位同队，2、3 号位同队，按 1→2→3→4 行动。每队共享 10 名候选，两名队友从同一将池各选一名；已选武将保留在将池，标明「队友已选」且不可重复选择。起手分别 4/4/4/5 张，1 号位首回合摸牌阶段少摸 1 张；队友阵亡可摸 1 张，击杀无额外奖惩，敌方全部阵亡获胜。';
    element('#general-pick-panel').hidden = !me || !waiting || !room.settings.allowGeneralSelection;
    generalGuide.refreshSelection(room.revision);
    element('#engine-status').textContent = room.engine.message;
    const roomOwner = room.players.find((player) => player.id === room.ownerId);
    element('#owner-status').textContent = roomOwner
      ? `房主：${roomOwner.nickname}${roomOwner.online ? '' : ' · 暂时离线，等待重新连接'}`
      : '房间已关闭';
    element('#waiting-text').textContent = waiting
      ? `${readyHumans} / ${humans.length} 位真人已准备，${empty} 个空位；AI 自动准备。`
      : room.phase === 'closed'
        ? '这张牌桌已散，返回主页可以另开一局。'
        : room.phase === 'finished'
          ? '本局已结束，等待房主回房准备下一局。'
          : '对局正在启动或进行中，房间设置已锁定。';

    element('#join-form').hidden =
      Boolean(me) || Boolean(session.roomCode && session.roomCode !== room.code) || !waiting;
    element('#other-room').hidden = !session.roomCode || session.roomCode === room.code;
    if (session.roomCode)
      element<HTMLAnchorElement>('#other-room-link').href = `/join/${session.roomCode}`;
    element('#my-seat').hidden = !me;
    disable(element('#join-button'), empty <= 0 || !waiting);
    element('#join-button').textContent = empty <= 0 ? '房间已满席' : '入座';
    if (me) {
      element('#my-nickname').textContent = me.nickname;
      element('#my-role').textContent = isOwner ? '你是房主，也参加这一局' : '已为你留好座位';
      const ready = element<HTMLButtonElement>('#ready-button');
      ready.textContent = me.ready ? '已准备 · 点击取消' : '我准备好了';
      ready.classList.toggle('is-ready', me.ready);
      ready.classList.toggle('primary', !me.ready || !isOwner);
      ready.classList.toggle('secondary', me.ready && isOwner);
      element('#start-button').classList.toggle('primary', me.ready);
      element('#start-button').classList.toggle('secondary', !me.ready);
      disable(ready, !me.online || !waiting || (isOwner && settingsPending));
    }
    element('#owner-start').hidden = !isOwner || !waiting;
    element('#owner-leave-hint').hidden = !isOwner;
    element('#bot-controls').hidden = !isOwner;
    element('#settings-panel').hidden = !isOwner || !waiting;
    element('#room-settings-link').hidden = !isOwner || !waiting;
    disable(element('#add-bot'), empty === 0 || !waiting || settingsPending);
    disable(element('#fill-bots'), empty === 0 || !waiting || settingsPending);
    disable(
      element('#leave-button'),
      !waiting && !(room.phase === 'finished' && room.ownerClaimAt !== undefined),
    );
    disable(
      element('#start-button'),
      !isOwner ||
        !room.engine.ready ||
        !waiting ||
        empty !== 0 ||
        readyHumans !== humans.length ||
        settingsPending,
    );
    if (!settingsDirty) {
      setDraftMode(room.settings.mode, room.settings.playerCount);
      element<HTMLSelectElement>('#general-preset').value = room.settings.generalPreset;
      element<HTMLInputElement>('#allow-general-selection').checked =
        room.settings.allowGeneralSelection === true;
      presetDescription();
    }
    const settingsState = element('#settings-state');
    renderOwnership();
    refreshSuccessors();
    settingsState.classList.toggle('settings-error', Boolean(settingsError));
    settingsState.textContent = settingsError
      ? `自动保存失败：${settingsError} 你的修改仍保留，请点击重试保存。`
      : settingsPending
        ? '正在自动保存设置，请稍候再准备或开局…'
        : `${settingsSaved ? '设置已自动保存。' : '修改设置后会自动保存。'}修改玩法、点将或增减席位后，真人需要重新准备；缩小房间时会自动移除多余 AI。`;
    const selectionSupported = typeof room.settings.allowGeneralSelection === 'boolean';
    element<HTMLInputElement>('#allow-general-selection').disabled =
      !waiting || !selectionSupported;
    element('#general-selection-description').textContent = selectionSupported
      ? `开放后，真人可在大厅点一名武将作为第1个候选；${room.settings.mode === 'versus' ? '2v2 会加入本队共享将池，队友也可选择；' : ''}同局上场武将不重复。关闭点将或更换武将档会清除已有点将。`
      : '电脑服务更新并重新启动后可开放点将。';
    element<HTMLSelectElement>('#general-preset').disabled = !waiting;
    element('#save-settings').hidden = !settingsError;
    disable(element('#save-settings'), !waiting || settingsSaving || !isOwner);
    app
      .querySelectorAll<HTMLButtonElement>('[data-mode]')
      .forEach((button) => disable(button, !waiting));
    if (me && !qrBound) {
      bindQr(initial.joinUrls, room.code, initial.entry);
      qrBound = true;
    }

    const list = element<HTMLUListElement>('#players');
    list.replaceChildren();
    for (let index = 0; index < room.settings.playerCount; index++) {
      const player = room.players[index];
      const item = document.createElement('li');
      item.className = `seat ${player ? player.kind : 'empty'}`;
      item.classList.toggle('self', player?.id === session.playerId);
      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      avatar.textContent =
        player?.kind === 'bot' ? 'AI' : player ? String(index + 1).padStart(2, '0') : '＋';
      const name = document.createElement('strong');
      name.textContent = player
        ? player.nickname +
          (player.id === room.ownerId ? '（房主）' : '') +
          (player.id === session.playerId ? '（你）' : '')
        : '虚位以待';
      const status = document.createElement('span');
      status.className = `seat-state ${player?.ready ? 'ready' : ''}`;
      status.textContent = player
        ? player.kind === 'bot'
          ? '自动准备'
          : !player.online
            ? '已断开'
            : player.ready
              ? '已准备'
              : '待准备'
        : '等朋友 / AI';
      item.append(avatar, name, status);
      if (isOwner && player && player.id !== room.ownerId) {
        const button = document.createElement('button');
        button.className = 'remove-player';
        button.type = 'button';
        button.textContent = '移除';
        button.setAttribute('aria-label', `移除 ${player.nickname}`);
        disable(button, !waiting || settingsPending);
        action(
          button,
          async () => {
            renderRoom(await roomApi<RoomView>(`${roomPath}/players/${player.id}`, 'DELETE'));
          },
          refresh,
        );
        item.append(button);
      }
      list.append(item);
    }
    if (room.phase === 'closed') {
      events?.close();
      connection(false, '房间已关闭');
    }
    if (pendingReturnMatchId && pendingReturnMatchId !== room.matchId) pendingReturnMatchId = null;
    if (!returning && pendingReturnMatchId === room.matchId && room.phase === 'finished') {
      pendingReturnMatchId = null;
      queueMicrotask(() => void perform(element('#rematch-button'), returnRoom, refresh));
    }
  }

  function connectEvents(): void {
    events?.close();
    events = watchEvents(
      `${roomPath}/events`,
      'room',
      (snapshot) => renderRoom(snapshot as RoomView),
      (initial.entry.access ?? initial.entry.mode) === 'internet',
    );
  }

  element<HTMLFormElement>('#join-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void perform(
      element('#join-button'),
      async () => {
        const joined = await roomApi<MembershipResult>(`${roomPath}/players`, 'POST', {
          nickname: element<HTMLInputElement>('#nickname').value,
        });
        session.playerId = joined.playerId;
        session.roomCode = room.code;
        renderRoom(joined.room);
        refresh();
        connectEvents();
        renderRoom((await roomApi<RoomInfo>(roomPath)).room);
      },
      refresh,
    );
  });
  action(
    element('#ready-button'),
    async () => {
      const me = room.players.find((player) => player.id === session.playerId);
      renderRoom(await roomApi<RoomView>(`${roomPath}/me/ready`, 'PUT', { ready: !me?.ready }));
    },
    refresh,
  );
  action(element('#leave-button'), leaveRoom, refresh);
  async function leaveRoom(): Promise<void> {
    await roomApi(`${roomPath}/me`, 'DELETE');
    sessionStorage.removeItem(returnedMatchKey);
    location.assign('/');
  }
  action(matchLeave, leaveRoom, refresh);
  element('#owner-transfer').addEventListener('click', () => {
    refreshSuccessors();
    element<HTMLDialogElement>('#ownership-dialog').showModal();
  });
  element('#ownership-close').addEventListener('click', () =>
    element<HTMLDialogElement>('#ownership-dialog').close(),
  );
  element('#owner-successor').addEventListener('change', () => {
    disable(element('#ownership-confirm'), !element<HTMLSelectElement>('#owner-successor').value);
  });
  action(
    element('#ownership-confirm'),
    async () => {
      renderRoom(
        await roomApi<RoomView>(`${roomPath}/owner`, 'PUT', {
          playerId: element<HTMLSelectElement>('#owner-successor').value,
        }),
      );
      element<HTMLDialogElement>('#ownership-dialog').close();
    },
    refresh,
  );
  action(
    element('#owner-claim'),
    async () => {
      renderRoom(
        await roomApi<RoomView>(`${roomPath}/owner/claim`, 'POST', { ownerId: room.ownerId }),
      );
    },
    refresh,
  );
  action(
    element('#start-button'),
    async () => {
      renderRoom(
        await roomApi<RoomView>(
          `${roomPath}/start`,
          'POST',
          undefined,
          {},
          matchStartTimeout(
            room.settings,
            room.players.filter((player) => player.kind === 'human').length,
          ) + 10000,
        ),
      );
    },
    refresh,
  );
  action(
    element('#add-bot'),
    async () => {
      renderRoom(await roomApi<RoomView>(`${roomPath}/bots`, 'POST', { count: 1 }));
    },
    refresh,
  );
  action(
    element('#fill-bots'),
    async () => {
      renderRoom(
        await roomApi<RoomView>(`${roomPath}/bots`, 'POST', {
          count: room.settings.playerCount - room.players.length,
        }),
      );
    },
    refresh,
  );
  async function shareRoom() {
    element<HTMLDialogElement>('#share-dialog').showModal();
    try {
      const current = await roomApi<RoomInfo>(roomPath);
      bindQr(current.joinUrls, room.code, current.entry ?? initial.entry);
    } catch {
      element('#qr-hint').textContent =
        '邀请信息暂时无法刷新，保留上次二维码；请确认对应网络可用。';
    }
  }
  element('#share-button').addEventListener('click', () => void shareRoom());
  element('#match-share').addEventListener('click', () => void shareRoom());
  async function returnRoom(): Promise<void> {
    if (returning) return;
    returning = true;
    try {
      // Native settlement may reach the table before the outer room's poll.
      // Re-read authority, or remember the click until that match is finished.
      const current = await roomApi<RoomInfo>(roomPath);
      renderRoom(current.room);
      if (room.phase !== 'finished') {
        if (room.phase === 'playing') pendingReturnMatchId = room.matchId;
        return;
      }
      pendingReturnMatchId = null;
      if (owner()) renderRoom(await roomApi<RoomView>(`${roomPath}/rematch`, 'POST', {}));
      else {
        returnedMatchId = room.matchId;
        if (returnedMatchId) sessionStorage.setItem(returnedMatchKey, returnedMatchId);
        refresh();
      }
    } finally {
      returning = false;
    }
  }
  action(element('#rematch-button'), returnRoom, refresh);
  element('#close-share').addEventListener('click', () =>
    element<HTMLDialogElement>('#share-dialog').close(),
  );
  const draftSettings = (): RoomSettings => ({
    mode: draftMode,
    playerCount: Number(element<HTMLSelectElement>('#player-count').value),
    generalPreset: element<HTMLSelectElement>('#general-preset')
      .value as RoomSettings['generalPreset'],
    allowGeneralSelection: element<HTMLInputElement>('#allow-general-selection').checked,
    ...(room.settings.animationSpeed === undefined
      ? {}
      : { animationSpeed: room.settings.animationSpeed }),
    extensions: [],
  });
  function scheduleSettings(): void {
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => void saveSettings(), 500);
  }
  async function saveSettings(): Promise<void> {
    clearTimeout(settingsTimer);
    if (!owner() || room.phase !== 'waiting' || !settingsDirty || settingsSaving) return;
    const version = settingsVersion;
    const generation = settingsGeneration;
    const settings = draftSettings();
    settingsSaving = true;
    settingsError = '';
    refresh();
    try {
      const updated = await roomApi<RoomView>(roomPath, 'PUT', settings);
      if (generation !== settingsGeneration || !owner() || room.phase !== 'waiting') return;
      // SSE can publish this response before HTTP finishes. A newer local edit
      // keeps the form dirty, so neither response can overwrite its controls.
      if (version === settingsVersion) {
        settingsDirty = false;
        settingsSaved = true;
      }
      renderRoom(updated);
    } catch (cause) {
      if (generation === settingsGeneration && version === settingsVersion && owner())
        settingsError = cause instanceof Error ? cause.message : '连接暂时不可用。';
    } finally {
      settingsSaving = false;
      refresh();
      if (owner() && room.phase === 'waiting' && settingsDirty && !settingsError)
        scheduleSettings();
    }
  }
  const markDirty = () => {
    if (!owner() || room.phase !== 'waiting') return;
    settingsVersion++;
    settingsSaved = false;
    settingsError = '';
    settingsDirty =
      settingsSaving || JSON.stringify(draftSettings()) !== JSON.stringify(room.settings);
    if (settingsDirty) scheduleSettings();
    else clearTimeout(settingsTimer);
    refresh();
  };
  app.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) =>
    button.addEventListener('click', () => {
      setDraftMode(
        button.dataset.mode as ModeId,
        Number(element<HTMLSelectElement>('#player-count').value),
      );
      markDirty();
    }),
  );
  element('#player-count').addEventListener('change', markDirty);
  element('#allow-general-selection').addEventListener('change', markDirty);
  element('#general-preset').addEventListener('change', () => {
    presetDescription();
    markDirty();
  });
  element('#save-settings').addEventListener('click', () => void saveSettings());
  element<HTMLSelectElement>('#room-animation-speed').addEventListener('change', async () => {
    if (speedSaving || !owner() || room.phase !== 'waiting') return;
    const control = element<HTMLSelectElement>('#room-animation-speed');
    const animationSpeed = Number(control.value);
    speedSaving = true;
    refresh();
    try {
      renderRoom(await roomApi<RoomView>(`${roomPath}/animation-speed`, 'PUT', { animationSpeed }));
    } catch (cause) {
      message(cause instanceof Error ? cause.message : '动画速度保存失败，请重试。');
    } finally {
      speedSaving = false;
      refresh();
    }
  });
  renderRoom(room);
  connectEvents();
}
