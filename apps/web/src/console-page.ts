import {
  findMode,
  GENERAL_PRESETS,
  ANIMATION_SPEEDS,
  DEFAULT_ANIMATION_SPEED,
  type ConsoleInfo,
  type ConsoleRoom,
  type ServerInfo,
  type ObserverLogPage,
} from '../../../packages/shared/src/contracts.js';
import { action, api, connection, element, frame, message, watchEvents } from './ui.js';
import { bindQr, isInternetInvite, qrMarkup } from './qr.js';
import { startEngineSupervisor } from './engine-supervisor.js';
import { renderObserver } from './observer-view.js';

const phases = {
  waiting: '等待玩家',
  starting: '选将中',
  playing: '对局中',
  finished: '已结算',
  closed: '已关闭',
};
const routes = { local: '局域网', lan: '局域网直连', direct: '跨网络直连', internet: '公网' };

export function showServerPage(info: ServerInfo): void {
  const internet = info.entry.mode === 'internet';
  frame(
    'server-layout console-layout',
    '本机服务控制台',
    '聚会<span>服务台</span>',
    '保持本页开启，朋友在自己的设备上入席、准备和开局。',
    `
    <section class="console-stats" aria-label="服务概况">
      <div><span>房间</span><strong id="room-total">0 间</strong></div>
      <div><span>在线真人</span><strong id="online-total">0 人</strong></div>
      <div><span>进行中的对局</span><strong id="match-total">0 局</strong></div>
      <div><span>较慢的连接</span><strong id="slow-total">0 个</strong></div>
    </section>
    <div class="server-grid console-grid"><section class="panel invite-panel"><div class="panel-heading"><h2>同 Wi-Fi 扫这个码</h2><span class="tag">局域网直连</span></div><p class="hint">同 Wi-Fi 或电脑热点的朋友直接连接本机。</p>${qrMarkup('局域网玩家主页二维码', '同 Wi-Fi · 直接进入聚会三国杀主页')}<button id="refresh-address" class="button text-button full-width" type="button">刷新连接状态</button></section>
    <section id="internet-invite" class="panel invite-panel" ${internet ? '' : 'hidden'}><div class="panel-heading"><h2>其他网络扫这个码</h2><span class="tag">跨网络</span></div><p id="entry-status" class="hint" role="status"></p>${qrMarkup('跨网络玩家主页二维码', '其他 Wi-Fi / 手机流量 · 进入同一个大厅', 'internet-')}</section>
    <section class="panel console-rooms"><div class="panel-heading"><h2>全部房间</h2><span class="tag muted">仅本机管理</span></div><ul id="room-list" class="room-list"></ul><p id="empty-rooms" class="empty-rooms">还没有牌桌。朋友扫码后即可创建房间。</p><p id="console-status" class="hint" role="status"></p></section></div>
    <p class="hint">两种入口的朋友可以加入同一间房。整局保持电脑开机、页面开启，并避免休眠；跨网络玩家还需要电脑联网。结束后双击「停止聚会三国杀」。</p>
    <section id="console-room" class="panel console-room" hidden><div class="panel-heading"><div><p class="eyebrow">房间详情与观战</p><h2 id="console-room-title"></h2></div><span id="console-room-phase" class="tag"></span></div><p id="console-room-settings" class="hint"></p><div id="console-players" class="console-players"></div><div id="console-actions" class="console-actions"></div><p class="hint">公开观战只显示已亮出的身份、体力、手牌数量、装备和公开动作。</p><div id="observer-view"></div></section>`,
  );
  const workspace = document.createElement('div');
  workspace.className = 'console-workspace';
  workspace.classList.toggle('has-internet', internet);
  element('.console-grid').before(workspace);
  workspace.append(element('.console-grid'), element('#console-room'));
  let rooms: ConsoleRoom[] = [];
  let selected = '';
  let checking = false;
  let refreshing = false;
  let stopped = false;
  let lastRooms = '';
  let speedSaving = false;
  element('#console-room-settings').insertAdjacentHTML(
    'afterend',
    `<div id="console-speed-control" hidden><label for="console-animation-speed">本房动画速度<select id="console-animation-speed">${ANIMATION_SPEEDS.map((speed) => `<option value="${speed}">${speed} 倍${speed === 2 ? '（默认）' : speed === 1 ? '（原速）' : ''}</option>`).join('')}</select></label><p class="hint">立即同步给本房所有玩家；可以在对局中调整，思考时间不变。</p></div>`,
  );
  const speedControl = element<HTMLSelectElement>('#console-animation-speed');
  speedControl.addEventListener('change', async () => {
    const entry = rooms.find((entry) => entry.room.code === selected);
    if (!entry || speedSaving) return;
    const animationSpeed = Number(speedControl.value);
    speedSaving = true;
    speedControl.disabled = true;
    try {
      await api(
        `/api/console/rooms/${entry.room.code}/animation-speed`,
        'PUT',
        { animationSpeed },
        { 'X-Party-Revision': String(entry.room.revision) },
      );
      message(`本房动画已设为 ${animationSpeed} 倍。`, true);
    } catch (cause) {
      message(cause instanceof Error ? cause.message : '动画速度保存失败，请重试。');
    } finally {
      speedSaving = false;
      lastRooms = '';
      await refresh();
      renderDetail();
    }
  });
  function renderEntry(updated: ServerInfo) {
    element('#entry-status').textContent = updated.entry.message;
    bindQr(
      updated.homeUrls.filter((url) => !isInternetInvite(url)),
      undefined,
      {
        mode: 'lan',
        status: updated.homeUrls.length ? 'ready' : updated.entry.status,
        message: updated.entry.message,
      },
    );
    if (internet)
      bindQr(updated.homeUrls.filter(isInternetInvite), undefined, updated.entry, 'internet-');
  }
  renderEntry(info);
  connection(true, '服务在线');
  function commandButton(
    label: string,
    entry: ConsoleRoom,
    method: string,
    suffix: string,
    warning: string,
  ) {
    const button = document.createElement('button');
    button.className = 'button secondary';
    button.textContent = label;
    action(button, async () => {
      if (!confirm(warning)) return;
      await api(`/api/console/rooms/${entry.room.code}${suffix}`, method, undefined, {
        'X-Party-Revision': String(entry.room.revision),
      });
      message('操作已完成。', true);
      lastRooms = '';
      await refresh();
    });
    return button;
  }
  function renderDetail() {
    const entry = rooms.find((entry) => entry.room.code === selected);
    element('#console-room').hidden = !entry;
    if (!entry) return;
    const { room } = entry;
    element('#console-speed-control').hidden = !room.engine.animationSpeed;
    speedControl.disabled = speedSaving;
    if (!speedSaving)
      speedControl.value = String(room.settings.animationSpeed ?? DEFAULT_ANIMATION_SPEED);
    const owner = room.players.find((player) => player.id === room.ownerId);
    element('#console-room-title').textContent =
      `${owner?.nickname ?? '朋友'}的房间 · ${room.code}`;
    element('#console-room-phase').textContent = phases[room.phase];
    element('#console-room-settings').textContent =
      `${findMode(room.settings.mode)?.name} · ${room.settings.playerCount} 席 · ${GENERAL_PRESETS.find((preset) => preset.id === room.settings.generalPreset)?.name} · ${room.settings.allowGeneralSelection ? '点将开放' : '点将关闭'}`;
    const players = element('#console-players');
    players.replaceChildren();
    for (const player of room.players) {
      const row = document.createElement('div');
      row.className = 'console-player';
      const name = document.createElement('strong');
      name.textContent = `${player.nickname}${player.id === room.ownerId ? ' · 房主' : ''}`;
      const status = document.createElement('span');
      const network = entry.networks.find((network) => network.playerId === player.id);
      const current = network && Date.now() - network.updatedAt < 30000;
      status.textContent =
        player.kind === 'bot'
          ? '原生 AI'
          : `${player.online ? (player.ready ? '在线 · 已准备' : '在线') : '离线'}${current ? ` · ${routes[network.route]} · ${network.transport.toUpperCase()} · ${network.rtt ?? '—'} ms${network.unstable ? ' · 不稳' : ''}` : ''}`;
      row.append(name, status);
      if (room.phase === 'waiting')
        row.append(
          commandButton(
            '移除席位',
            entry,
            'DELETE',
            `/players/${player.id}`,
            `移除「${player.nickname}」？若移除房主，房主会交接给下一位真人。`,
          ),
        );
      players.append(row);
    }
    const actions = element('#console-actions');
    actions.replaceChildren();
    if (['starting', 'playing', 'finished'].includes(room.phase))
      actions.append(
        commandButton(
          room.phase === 'finished' ? '回房准备下一局' : '结束对局并回房',
          entry,
          'POST',
          '/reset',
          '结束这次对局并让所有玩家回到房间？当前对局将结束，席位保留，真人需要重新准备。',
        ),
      );
    actions.append(
      commandButton(
        '关闭房间',
        entry,
        'DELETE',
        '',
        `关闭房间 ${room.code}？所有玩家将离开，本局无法继续。`,
      ),
    );
    renderObserver(element('#observer-view'), entry.observer, room.matchId, (before) =>
      api<ObserverLogPage>(
        `/api/console/rooms/${room.code}/log?match=${encodeURIComponent(room.matchId ?? '')}&before=${before}`,
      ),
    );
  }
  function render() {
    if (!rooms.some((entry) => entry.room.code === selected)) selected = rooms[0]?.room.code ?? '';
    element('#room-total').textContent = `${rooms.length} 间`;
    element('#online-total').textContent =
      `${rooms.flatMap((entry) => entry.room.players).filter((player) => player.kind === 'human' && player.online).length} 人`;
    element('#match-total').textContent =
      `${rooms.filter((entry) => ['starting', 'playing'].includes(entry.room.phase)).length} 局`;
    element('#slow-total').textContent =
      `${rooms.flatMap((entry) => entry.networks).filter((network) => Date.now() - network.updatedAt < 30000 && (network.unstable || (network.rtt ?? 0) >= 600)).length} 个`;
    const list = element('#room-list');
    list.replaceChildren();
    element('#empty-rooms').hidden = rooms.length > 0;
    for (const entry of rooms) {
      const room = entry.room;
      const item = document.createElement('li');
      item.className = 'room-list-item';
      const details = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = `${room.players.find((player) => player.id === room.ownerId)?.nickname ?? '朋友'}的房间`;
      const summary = document.createElement('p');
      summary.textContent = `${findMode(room.settings.mode)?.name} · ${room.players.length} / ${room.settings.playerCount} 席 · ${room.code} · ${phases[room.phase]}`;
      details.append(name, summary);
      const view = document.createElement('button');
      view.className = `button ${selected === room.code ? 'primary' : 'secondary'}`;
      view.textContent = '查看 / 观战';
      view.addEventListener('click', () => {
        selected = room.code;
        render();
        if (matchMedia('(max-width: 1100px)').matches)
          element('#console-room').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      item.append(details, view);
      list.append(item);
    }
    renderDetail();
  }
  async function refresh() {
    if (refreshing || stopped) return;
    refreshing = true;
    try {
      const data = await api<ConsoleInfo>('/api/console');
      const key = JSON.stringify(data.rooms);
      if (key !== lastRooms) {
        rooms = data.rooms;
        lastRooms = key;
        render();
      }
      element('#console-status').textContent =
        '房间状态自动更新 · 结束对局、移除席位和关闭房间需要确认';
    } catch (error) {
      element('#console-status').textContent =
        error instanceof Error ? error.message : '控制台暂时无法连接';
    } finally {
      refreshing = false;
    }
  }
  async function refreshEntry() {
    if (checking || stopped) return;
    checking = true;
    try {
      renderEntry(await api<ServerInfo>('/api/info'));
    } catch {
      renderEntry({
        ...info,
        homeUrls: [],
        entry: {
          mode: info.entry.mode,
          status: 'unavailable',
          message: '电脑服务已停止，请重新双击启动。',
        },
      });
    } finally {
      checking = false;
    }
  }
  action(element('#refresh-address'), async () => {
    await refreshEntry();
    await refresh();
  });
  watchEvents('/api/events', 'lobby', () => {
    void refresh();
  });
  const timer = setInterval(() => {
    void refresh();
    if (internet) void refreshEntry();
  }, 1500);
  window.addEventListener(
    'pagehide',
    () => {
      stopped = true;
      clearInterval(timer);
    },
    { once: true },
  );
  void refresh();
  startEngineSupervisor();
}
