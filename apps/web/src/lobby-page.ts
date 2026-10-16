import {
  MODES,
  findMode,
  type MembershipResult,
  type RoomSummary,
  type ServerInfo,
  type SessionView,
} from '../../../packages/shared/src/contracts.js';
import { api, app, element, frame, perform, watchEvents } from './ui.js';
import { bindGeneralGuide, guideButton } from './general-guide.js';
import { createAssetPreloader } from './engine-preloader.js';
import { arrowIcon, modeIcon } from './lobby-art.js';

const joinable = (room: RoomSummary) =>
  room.phase === 'waiting' && room.humanCount + room.botCount < room.playerCount;

function createRoomList() {
  const list = element('#room-list');
  const entries = new Map<string, HTMLElement>();
  return (rooms: RoomSummary[], onlyJoinable: boolean) => {
    element('#room-total').textContent = `${rooms.length} 间`;
    const visible = rooms.filter((room) => !onlyJoinable || joinable(room));
    element('#empty-rooms').hidden = visible.length > 0;
    const noAvailableRooms = onlyJoinable && rooms.length > 0;
    element('#empty-room-title').textContent = noAvailableRooms
      ? '这一刻，大家都已入席。'
      : '第一桌，等你来开。';
    element('#empty-room-hint').textContent = noAvailableRooms
      ? '可以自己开一桌，或切回全部房间看看朋友。'
      : '填个昵称，邀上朋友。人少也可以用 AI 补位。';
    for (const [code, entry] of entries) {
      if (!visible.some((room) => room.code === code)) {
        entry.remove();
        entries.delete(code);
      }
    }
    visible.forEach((room, index) => {
      let item = entries.get(room.code);
      if (!item) {
        item = document.createElement('li');
        item.className = 'room-list-item';
        item.dataset.roomCode = room.code;
        // Only fixed interface markup goes through innerHTML; names remain textContent.
        item.innerHTML =
          '<span class="room-emblem"></span><div class="room-description"><strong></strong><p></p><span class="room-number"></span></div><div class="room-availability"><span class="room-state"></span><a class="button secondary room-link"></a></div>';
        entries.set(room.code, item);
      }
      const emblem = item.querySelector<HTMLElement>('.room-emblem')!;
      if (emblem.dataset.mode !== room.mode) {
        emblem.innerHTML = modeIcon(room.mode);
        emblem.dataset.mode = room.mode;
      }
      item.querySelector('strong')!.textContent = `${room.ownerNickname}的房间`;
      item.querySelector('p')!.textContent =
        `${findMode(room.mode)?.name} · ${room.humanCount} 真人 + ${room.botCount} AI / ${room.playerCount} 席`;
      item.querySelector('.room-number')!.textContent = `房间 ${room.code}`;
      const state = item.querySelector<HTMLElement>('.room-state')!;
      state.classList.toggle('available', joinable(room));
      state.textContent = joinable(room)
        ? `还差 ${room.playerCount - room.humanCount - room.botCount} 位`
        : room.phase === 'waiting'
          ? '已满席'
          : room.phase === 'finished'
            ? '已结算'
            : '对局中';
      const link = item.querySelector<HTMLAnchorElement>('a')!;
      link.textContent = joinable(room) ? '加入房间' : '查看房间';
      link.href = `/join/${room.code}`;
      // Do not replace unchanged rows: polling must not steal keyboard focus.
      if (list.children[index] !== item) list.insertBefore(item, list.children[index] ?? null);
    });
  };
}

export function showHomePage(info: ServerInfo, session: SessionView): void {
  frame(
    'player-layout home-layout',
    '聚会大厅',
    '群英聚首，<span>即刻开局。</span>',
    '开一张牌桌，或加入朋友的房间。',
    `
    <div class="home-main" id="lobby-actions">
      <section id="current-room" class="panel current-room" hidden><p class="section-index">继续这一局</p><h2>你的座位还在。</h2><p class="hint">朋友和牌桌都在原房间，随时可以回来。</p><a id="return-room" class="button primary full-width" href="/">返回我的房间${arrowIcon}</a></section>
      <section class="panel create-panel" id="create-panel"><div class="panel-heading"><div><p class="section-index">从你开始</p><h2>我来开一桌</h2></div><span class="mini-seal" aria-hidden="true">邀</span></div><form id="create-form"><label for="nickname">怎么称呼你</label><input id="nickname" name="nickname" placeholder="取个朋友认得的昵称" autocomplete="nickname" maxlength="32" aria-describedby="nickname-hint" required /><p class="hint" id="nickname-hint">昵称 1–16 个字。创建后自动入座，成为房主。</p><button id="create-button" class="button primary full-width" type="submit">创建房间并入座${arrowIcon}</button><p class="create-note">玩法、武将和 AI，入座后由你安排。</p></form></section>
      <section class="panel rooms-panel" id="friends-rooms"><div class="panel-heading"><div><p class="section-index">好戏正在发生</p><h2>朋友的房间</h2></div><span id="room-total" class="room-total">0 间</span></div><div class="room-filters" aria-label="筛选房间"><button type="button" data-room-filter="all" aria-pressed="true" aria-controls="room-list">全部房间</button><button type="button" data-room-filter="joinable" aria-pressed="false" aria-controls="room-list">可加入</button><span class="live-note">实时更新</span></div><ul id="room-list" class="room-list"></ul><div id="empty-rooms" class="empty-rooms"><span class="empty-symbol" aria-hidden="true">${modeIcon('identity')}</span><h3 id="empty-room-title">第一桌，等你来开。</h3><p id="empty-room-hint">填个昵称，邀上朋友。人少也可以用 AI 补位。</p></div></section>
    </div>
    <section class="lobby-discover" id="lobby-guide"><div class="discover-heading"><p class="section-index">随人数，选好戏</p><h2>各有玩法，同样尽兴。</h2><p class="hint">两个人也能开场，八个人正好热闹。</p></div><ul class="lobby-modes" aria-label="支持的玩法">${MODES.map((mode) => `<li><span class="lobby-mode-icon">${modeIcon(mode.id)}</span><strong>${mode.name}</strong><span>${mode.minPlayers === mode.maxPlayers ? mode.minPlayers : '5–8'} 人</span></li>`).join('')}</ul><div class="guide-panel"><div><h3>识英雄，知招式。</h3><p class="hint">标准27将、经典进阶96将与官方活动将池，上桌前先看看技能。</p></div>${guideButton}</div><p id="engine-preload" class="hint" role="status" hidden></p></section>`,
  );
  bindGeneralGuide();
  createAssetPreloader(
    element('#engine-preload'),
    sessionStorage.getItem('party_lightweight_verification') === '1',
  ).update(Boolean(info.engine.preload));
  const renderSession = () => {
    element('#current-room').hidden = !session.roomCode;
    element('#create-panel').hidden = Boolean(session.roomCode);
    if (session.roomCode)
      element<HTMLAnchorElement>('#return-room').href = `/join/${session.roomCode}`;
  };
  renderSession();
  let rooms = info.rooms;
  let onlyJoinable = false;
  const roomList = createRoomList();
  const renderList = () => roomList(rooms, onlyJoinable);
  renderList();
  app.querySelectorAll<HTMLButtonElement>('[data-room-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      onlyJoinable = button.dataset.roomFilter === 'joinable';
      app
        .querySelectorAll<HTMLButtonElement>('[data-room-filter]')
        .forEach((filter) =>
          filter.setAttribute(
            'aria-pressed',
            String((filter.dataset.roomFilter === 'joinable') === onlyJoinable),
          ),
        );
      renderList();
    });
  });
  element<HTMLFormElement>('#create-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void perform(element('#create-button'), async () => {
      const created = await api<MembershipResult>('/api/rooms', 'POST', {
        nickname: element<HTMLInputElement>('#nickname').value,
      });
      location.assign(`/join/${created.room.code}`);
    });
  });
  watchEvents(
    '/api/events',
    'lobby',
    (updatedRooms) => {
      rooms = updatedRooms as RoomSummary[];
      renderList();
      void api<SessionView>('/api/me')
        .then((updated) => {
          session = updated;
          renderSession();
        })
        .catch(() => {});
    },
    (info.entry.access ?? info.entry.mode) === 'internet',
  );
}
