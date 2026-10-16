import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { RoomView } from '../../packages/shared/src/contracts.js';
import { GENERAL_PRESETS } from '../../packages/shared/src/contracts.js';
import type { EngineAdapter, EngineEvent } from '../../packages/noname-adapter/src/index.js';
import { createPartyServer } from '../../apps/server/src/server.js';
import { createPublicGateway } from '../../apps/server/src/public-gateway.js';

for (const theme of ['camp', 'ink']) {
  test(`经典大厅 ${theme}：首屏操作、全部开局阻塞和本地主题记忆`, async ({ browser }) => {
    await withLobby(browser, async ({ party, base, page }) => {
      const owner = await page();
      await owner.setViewportSize({ width: 1366, height: 768 });
      await owner.goto(base);
      await owner.locator('#nickname').fill('同袍');
      const mutations: string[] = [];
      owner.on('request', (request) => {
        if (['POST', 'PUT', 'DELETE'].includes(request.method())) mutations.push(request.url());
      });
      await owner.locator('#lobby-theme').selectOption(theme);
      await expect(owner.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(owner.locator('#nickname')).toHaveValue('同袍');
      expect(mutations).toEqual([]);
      expect(
        await owner.locator('.page-hero').evaluate((el) => el.getBoundingClientRect().height),
      ).toBeLessThan(161);
      expect(
        await owner
          .locator('#create-button')
          .evaluate((el) => el.getBoundingClientRect().bottom < innerHeight),
      ).toBe(true);
      await owner.locator('#create-button').click();
      await owner.waitForURL(/\/join\/([A-Z0-9]{6})$/);
      const code = owner.url().split('/').at(-1)!;
      await expect(owner.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(owner.locator('#start-blockers')).toContainText('你尚未准备');
      await expect(owner.locator('#start-blockers')).toContainText('电脑规则服务未就绪');
      await expect(owner.locator('#start-button')).toBeDisabled();
      const room = party.lobby.get(code);
      await owner.locator('#ready-button').click();
      await expect.poll(() => room.snapshot().players[0]?.ready).toBe(true);
      const revision = room.snapshot().revision;
      await owner.locator('#lobby-theme').selectOption(theme === 'camp' ? 'ink' : 'camp');
      expect(room.snapshot().revision).toBe(revision);
      await expect(owner.locator('#start-blockers')).not.toContainText('你尚未准备');
      await expect(owner.locator('#start-blockers')).toContainText('电脑规则服务未就绪');
      for (const size of [
        { width: 390, height: 844 },
        { width: 1366, height: 768 },
      ]) {
        await owner.setViewportSize(size);
        expect(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        expect(
          await owner.locator('#ready-button').evaluate((el) => {
            const r = el.getBoundingClientRect();
            return r.top >= 0 && r.bottom <= innerHeight;
          }),
        ).toBe(true);
        expect(
          await owner
            .locator('#start-check')
            .evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight),
        ).toBe(true);
      }
    });
  });
}

test('动画速度：默认2倍，房主与本机管理员1至10倍调整，准备和对局视图同步保留', async ({
  browser,
}) => {
  const matches = new Map<string, string>();
  const adapter: EngineAdapter = {
    status: () => ({
      id: 'noname',
      ready: true,
      animationSpeed: true,
      message: '动画设置页面夹具',
    }),
    start: async (setup) => {
      matches.set(setup.roomCode, `speed-${setup.roomCode}`);
    },
    matchId: (code) => matches.get(code) ?? null,
  };
  await withLobby(
    browser,
    async ({ party, base, page }) => {
      const owner = await page(),
        member = await page(),
        operator = await page(true);
      for (const phone of [owner, member])
        await phone.route('**/engine/player/speed-*', (route) =>
          route.fulfill({
            contentType: 'text/html',
            body: `<body>动画同步夹具<script>addEventListener('message', e => { if(e.origin === location.origin && e.source === parent && e.data.type === 'party-animation-speed') document.body.dataset.speed = e.data.animationSpeed; });</script></body>`,
          }),
        );
      const code = await createRoom(owner, base, '调速房主');
      await owner.reload();
      await expect(owner.locator('#settings-panel')).not.toHaveAttribute('open', '');
      await owner.locator('#room-settings-link').click();
      await expect(owner.locator('#room-animation-speed')).toBeFocused();
      await joinRoom(member, base, code, '朋友');
      await expect(owner.locator('#room-animation-speed')).toHaveValue('2');
      await expect(owner.locator('#room-animation-speed option')).toHaveCount(10);
      await expect(member.locator('#room-speed-control')).toBeHidden();
      await owner.locator('#fill-bots').click();
      await owner.locator('#ready-button').click();
      await member.locator('#ready-button').click();
      const room = party.lobby.get(code);
      await expect.poll(() => room.snapshot().players.every((player) => player.ready)).toBe(true);
      await owner.locator('#room-animation-speed').selectOption('10');
      await expect(member.locator('#summary-animation-speed')).toContainText('10 倍');
      expect(room.snapshot().players.every((player) => player.ready)).toBe(true);
      await owner.route('**/animation-speed', (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: '测试保存失败' } }),
        }),
      );
      await owner.locator('#room-animation-speed').selectOption('5');
      await expect(owner.locator('#message')).toHaveText('测试保存失败');
      await expect(owner.locator('#room-animation-speed')).toHaveValue('10');
      await expect(owner.locator('#room-animation-speed')).toBeEnabled();
      await owner.unroute('**/animation-speed');
      await owner.locator('#start-button').click();
      await expect(owner.locator('#match-animation-speed')).toHaveCount(0);
      await expect(owner.locator('#room-speed-control')).toBeHidden();
      await expect(owner.frameLocator('#game-frame').locator('body')).toHaveAttribute(
        'data-speed',
        '10',
      );
      const stale = await owner.request.put(`${base}/api/rooms/${code}/animation-speed`, {
        data: { animationSpeed: 2 },
        headers: { 'X-Party-Player': room.snapshot().ownerId! },
      });
      expect(stale.status()).toBe(409);
      expect((await stale.json()).error.message).toContain('等待大厅');
      expect(room.snapshot().settings.animationSpeed).toBe(10);
      await operator.goto(base + '/server');
      await expect(operator.locator('#console-animation-speed')).toHaveValue('10');
      await operator.locator('#console-animation-speed').selectOption('1');
      await expect(owner.frameLocator('#game-frame').locator('body')).toHaveAttribute(
        'data-speed',
        '1',
      );
      expect(room.snapshot().matchId).toBe(`speed-${code}`);
      expect(room.snapshot().phase).toBe('playing');
      const nativeFrame = owner.frames().find((frame) => frame.url().includes('/engine/player/'));
      await expect(owner.locator('#match-more')).toHaveAccessibleName('更多');
      await expect(owner.locator('#match-sound-menu')).toHaveAccessibleName('声音');
      await owner.locator('#match-more').click();
      await expect(owner.locator('#match-share')).toBeVisible();
      await owner.locator('#match-theme').selectOption('ink');
      await expect(owner.locator('html')).toHaveAttribute('data-theme', 'ink');
      expect(owner.frames().find((frame) => frame.url().includes('/engine/player/'))).toBe(
        nativeFrame,
      );
      await owner.locator('#match-theme').press('Escape');
      await expect(owner.locator('#match-more-panel')).toBeHidden();
      await expect(owner.locator('#match-more')).toBeFocused();
      await owner.locator('#match-sound-menu').click();
      await expect(owner.locator('#match-volume')).toBeVisible();
      await owner.locator('#match-volume').press('Escape');
      await expect(owner.locator('#match-sound-menu-panel')).toBeHidden();
      await owner.locator('#match-more').click();
      await owner.locator('#match-share').click();
      await expect(owner.locator('#share-dialog')).toBeVisible();
      await expect(owner.locator('#match-more-panel')).toBeHidden();
      await owner.locator('#close-share').click();
      await expect(owner.locator('#match-more')).toBeFocused();
      expect(room.snapshot().matchId).toBe(`speed-${code}`);
      const stamp = Date.now();
      await owner.screenshot({ path: `.runtime/previews/animation-speed-owner-${stamp}.png` });
      await operator.screenshot({ path: `.runtime/previews/animation-speed-console-${stamp}.png` });
    },
    false,
    adapter,
  );
});

for (const internet of [false, true]) {
  test(`${internet ? '公网轮询' : '局域网SSE'}：大家关页后无人房间自动回收，观战不续期，旧邀请失效`, async ({
    browser,
  }) => {
    await withLobby(
      browser,
      async ({ party, base, publicBase, page }) => {
        const entry = internet ? publicBase : base;
        const owner = await page();
        const member = await page();
        const observer = await page();
        const home = await page();
        const code = await createRoom(owner, entry, '散场房主');
        await joinRoom(member, entry, code, '朋友');
        await owner.locator('#fill-bots').click();
        await observer.goto(`${entry}/join/${code}`);
        await home.goto(entry + '/');
        await expect(home.locator('#room-list li')).toHaveCount(1);
        const room = party.lobby.get(code);
        const tokens = await Promise.all(
          [owner, member].map(
            async (phone) =>
              (await phone.context().cookies()).find((cookie) => cookie.name === 'party_player')!
                .value,
          ),
        );
        await owner.goto(entry + '/');
        await member.goto(entry + '/');
        if (!internet)
          await expect
            .poll(() =>
              room
                .snapshot()
                .players.filter((player) => player.kind === 'human')
                .every((player) => !player.online),
            )
            .toBe(true);
        // Advance the server's presence leases without waiting ten real minutes.
        for (const token of tokens) room.poll(token, Date.now() - 31000);
        room.expirePolls();
        const deadline = room.snapshot().idleCloseAt!;
        await expect(observer.locator('#room-idle-hint')).toBeVisible();
        expect(room.snapshot().idleCloseAt).toBe(deadline);
        party.lobby.sweep(deadline - 1);
        expect(party.lobby.list()).toHaveLength(1);
        party.lobby.sweep(deadline);
        await expect(observer.locator('#connection')).toHaveText('房间已关闭');
        await expect(home.locator('#room-list li')).toHaveCount(0);
        expect((await observer.request.get(`${entry}/api/rooms/${code}`)).status()).toBe(404);
        await owner.reload();
        await expect(owner.locator('#current-room')).toBeHidden();
        await expect(owner.locator('#create-button')).toBeVisible();
        await observer.reload();
        await expect(observer.getByText('暂时没找到牌桌')).toBeVisible();
      },
      internet,
    );
  });

  test(`${internet ? '公网轮询' : '局域网SSE'}：转交房主、短断线取消接任、超时显式接任，原房主席位保留`, async ({
    browser,
  }) => {
    await withLobby(
      browser,
      async ({ party, base, publicBase, page }) => {
        const entry = internet ? publicBase : base;
        const first = await page();
        const code = await createRoom(first, entry, '原房主');
        const second = await page();
        await joinRoom(second, entry, code, '接班朋友');
        await expect(first.locator('#general-preset option')).toHaveCount(10);
        await expect(first.locator('#general-preset option')).not.toContainText(['2024', '2025']);
        await first.locator('#owner-transfer').click();
        const room = party.lobby.get(code);
        const member = room.snapshot().players.find((player) => player.nickname === '接班朋友')!;
        await first.locator('#owner-successor').selectOption(member.id);
        await first.locator('#ownership-confirm').click();
        await expect(second.locator('#my-role')).toHaveText('你是房主，也参加这一局');
        await expect(first.locator('#settings-panel')).toBeHidden();
        const memberToken = (await second.context().cookies()).find(
          (cookie) => cookie.name === 'party_player',
        )!.value;
        await second.goto(entry + '/');
        if (!internet) await expect.poll(() => room.session(memberToken)?.online).toBe(false);
        room.poll(memberToken, Date.now() - 31000);
        room.expirePolls();
        await expect(first.locator('#owner-claim-row')).toBeVisible();
        await expect(first.locator('#owner-claim')).toBeDisabled();
        await second.goto(`${entry}/join/${code}`);
        await expect(first.locator('#owner-claim-row')).toBeHidden();
        expect(room.snapshot().ownerId).toBe(member.id);
        await second.goto(entry + '/');
        if (!internet) await expect.poll(() => room.session(memberToken)?.online).toBe(false);
        room.poll(memberToken, Date.now() - 90001);
        room.expirePolls();
        await expect(first.locator('#owner-claim')).toBeEnabled();
        await first.locator('#owner-claim').click();
        await expect(first.locator('#my-role')).toHaveText('你是房主，也参加这一局');
        expect(room.session(memberToken)?.id).toBe(member.id);
        await second.goto(`${entry}/join/${code}`);
        await expect(second.locator('#my-role')).toHaveText('已为你留好座位');
        await first.screenshot({
          path: `.runtime/previews/room-ownership-${internet ? 'poll' : 'sse'}-${Date.now()}.png`,
        });
      },
      internet,
    );
  });
}

test('结算可直接离房；普通成员回房后刷新仍在大厅，房主离开后接班并再开局', async ({ browser }) => {
  const listeners = new Set<(event: EngineEvent) => void>();
  let sequence = 0;
  const matches = new Map<string, string>();
  const adapter: EngineAdapter = {
    status: () => ({ id: 'noname', ready: true, message: '房间生命周期页面占位器' }),
    start: async (setup) => {
      matches.set(setup.roomCode, `lifecycle-${++sequence}`);
    },
    matchId: (code) => matches.get(code) ?? null,
    release: (code) => {
      matches.delete(code);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  await withLobby(
    browser,
    async ({ party, base, page }) => {
      const owner = await page();
      const member = await page();
      const leaving = await page();
      for (const phone of [owner, member, leaving])
        await phone.route('**/engine/player/lifecycle-*', (route) =>
          route.fulfill({
            contentType: 'text/html',
            body: '<p>牌桌页面占位器</p><script>window.partyEngine={_status:{over:true}};parent.postMessage({type:"party-connected",matchId:location.pathname.split("/").pop()},location.origin)</script>',
          }),
        );
      const code = await createRoom(owner, base, '房主');
      await joinRoom(member, base, code, '下一任');
      await joinRoom(leaving, base, code, '先走朋友');
      await owner.locator('#fill-bots').click();
      for (const phone of [owner, member, leaving]) await phone.locator('#ready-button').click();
      await owner.locator('#start-button').click();
      await expect(member.locator('#game-frame')).toHaveCount(1);
      expect(party.lobby.get(code).snapshot().phase).toBe('playing');
      for (const listener of listeners) listener({ type: 'ended', roomCode: code });
      await leaving.locator('#match-more').click();
      await leaving.locator('#match-leave').click();
      await expect(leaving.locator('#create-panel')).toBeVisible();
      expect(party.lobby.get(code).snapshot().phase).toBe('finished');
      await member.locator('#rematch-button').click();
      await expect(member.locator('#waiting-return')).toBeVisible();
      await member.reload();
      await expect(member.locator('#waiting-return')).toBeVisible();
      await expect(member.locator('#game-frame')).toHaveCount(0);
      await expect(member.locator('#leave-button')).toBeEnabled();
      await owner.locator('#match-more').click();
      await owner.locator('#match-leave').click();
      await expect(owner.locator('#create-panel')).toBeVisible();
      await expect(member.locator('#my-role')).toHaveText('你是房主，也参加这一局');
      expect(party.lobby.get(code).snapshot().phase).toBe('waiting');
      await member.locator('#fill-bots').click();
      await member.locator('#ready-button').click();
      await member.locator('#start-button').click();
      await expect(member.locator('#game-frame')).toHaveCount(1);
      expect(sequence).toBe(2);
      for (const listener of listeners) listener({ type: 'ended', roomCode: code });
      await member.locator('#match-more').click();
      await member.locator('#match-leave').click();
      await expect(member.locator('#create-panel')).toBeVisible();
      expect(party.lobby.list()).toHaveLength(0);
    },
    false,
    adapter,
  );
});

test('手机公开记录分页与安全文本，规则端恢复和失败均保留原牌桌直到主动回房', async ({
  browser,
}) => {
  const listeners = new Set<(event: EngineEvent) => void>();
  const adapter: EngineAdapter = {
    status: () => ({ id: 'noname', ready: true, message: '页面测试占位器', playerHistory: true }),
    start: async () => {},
    matchId: () => 'records-fixture',
    release: () => {},
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  await withLobby(
    browser,
    async ({ party, base, page }) => {
      const phone = await page();
      let loads = 0;
      await phone.route('**/engine/player/records-fixture', (route) => {
        loads++;
        return route.fulfill({
          contentType: 'text/html',
          body: '<p>原牌桌</p><span id="party-table-count">1轮 剩余牌: 73</span><script>parent.postMessage({type:"party-connected",matchId:"records-fixture"},location.origin)</script>',
        });
      });
      await phone.route('**/engine/history/records-fixture*', (route) => {
        const before = Number(new URL(route.request().url()).searchParams.get('before') || 241);
        const start = Math.max(1, before - 100);
        return route.fulfill({
          json: {
            matchId: 'records-fixture',
            deckCount: 73,
            first: 1,
            total: 240,
            entries: Array.from({ length: before - start }, (_, i) => ({
              sequence: start + i,
              text: `<b>玩家</b>展示了涉猎牌 ${start + i}`,
            })),
          },
        });
      });
      const code = await createRoom(phone, base, '记录测试');
      await phone.getByRole('button', { name: /单挑/ }).click();
      await waitForSettings(phone);
      await phone.getByRole('button', { name: '补满空位' }).click();
      await phone.locator('#ready-button').click();
      await phone.locator('#start-button').click();
      await expect(phone.locator('#match-deck')).toHaveCount(0);
      await expect(phone.frameLocator('#game-frame').locator('#party-table-count')).toBeVisible();
      await phone.locator('#match-records').click();
      await expect(phone.locator('#match-records-dialog .observer-recent li')).toHaveCount(100);
      await expect(
        phone.locator('#match-records-dialog .observer-recent li').first(),
      ).toContainText('<b>玩家</b>');
      await expect(phone.locator('#match-records-dialog b')).toHaveCount(0);
      await phone.getByRole('button', { name: '查看更早记录' }).click();
      await expect(phone.locator('#match-records-dialog .observer-recent li')).toHaveCount(200);
      await phone.getByRole('button', { name: '查看更早记录' }).click();
      await expect(phone.locator('#match-records-dialog .observer-recent li')).toHaveCount(240);
      await phone.getByRole('button', { name: '关闭本局记录' }).click();
      expect(party.lobby.get(code).snapshot().phase).toBe('playing');
      for (const listener of listeners)
        listener({ type: 'recovering', roomCode: code, deadline: Date.now() + 20000 });
      await expect(phone.locator('#match-connection-title')).toHaveText(
        '电脑规则连接中断，正在恢复',
      );
      const lateDisconnect = async () => {
        const native = phone.frames().find((frame) => frame.url().includes('/engine/player/'))!;
        await native.evaluate(() =>
          parent.postMessage(
            {
              type: 'party-connection-ended',
              matchId: 'records-fixture',
              reason: '迟到的通道失效',
            },
            location.origin,
          ),
        );
        await phone.waitForTimeout(100);
      };
      await lateDisconnect();
      await expect(phone.locator('#match-connection-title')).toHaveText(
        '电脑规则连接中断，正在恢复',
      );
      for (const listener of listeners) listener({ type: 'recovered', roomCode: code });
      await expect.poll(() => loads).toBe(2);
      await expect(phone.locator('#match-connection button:visible')).toHaveCount(0);
      for (const listener of listeners)
        listener({ type: 'failed', roomCode: code, code: 'worker-disconnected' });
      await expect(phone.locator('#match-connection-title')).toHaveText('本局中断 · 未判胜负');
      await expect(phone.locator('#match-panel')).toBeVisible();
      await expect(phone.locator('#game-frame')).toHaveCount(1);
      await expect(phone.locator('#match-retry')).toBeHidden();
      await lateDisconnect();
      await phone.waitForTimeout(2500);
      await expect(phone.locator('#match-connection-title')).toHaveText('本局中断 · 未判胜负');
      await expect(phone.locator('#match-retry')).toBeHidden();
      expect(loads).toBe(2);
      await phone.locator('#rematch-button').click();
      await expect(phone.locator('#game-frame')).toHaveCount(0);
      await expect(phone.locator('#ready-button')).toBeEnabled();
      expect(party.lobby.get(code).snapshot().matchFailure).toBeUndefined();
    },
    false,
    adapter,
  );
});

test('新版主页在手机与电脑可入座，筛选随房间更新，轮询保留焦点与昵称安全文本', async ({
  browser,
}) => {
  await withLobby(
    browser,
    async ({ party, publicBase, page }) => {
      const available = party.lobby.create('<b>乔</b>');
      const full = party.lobby.create('曹操');
      full.room.updateSettings(
        { mode: 'duel', playerCount: 2, generalPreset: 'beginner', extensions: [] },
        full.token,
      );
      full.room.addBots(1, full.token);
      const home = await page();
      await home.goto(publicBase + '/');
      await expect(home.locator('#room-list li')).toHaveCount(2);
      await expect(home.locator('#room-list strong').first()).toHaveText('<b>乔</b>的房间');
      expect(await home.locator('#room-list strong b').count()).toBe(0);
      for (const width of [320, 390, 768, 1024, 1440]) {
        await home.setViewportSize({ width, height: 844 });
        expect(await home.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      }
      await home.emulateMedia({ reducedMotion: 'reduce' });
      await expect(home.locator('#create-button')).toHaveCSS('transition-duration', '0s');
      await home.setViewportSize({ width: 390, height: 844 });
      await home.getByRole('button', { name: '可加入', exact: true }).click();
      await expect(home.locator('#room-list li')).toHaveCount(1);
      const link = home.getByRole('link', { name: '加入房间', exact: true });
      await link.focus();
      available.room.addBots(1, available.token);
      await expect(home.locator('#room-list p')).toContainText('1 AI');
      await expect(link).toBeFocused();
      available.room.addBots(3, available.token);
      await expect(home.locator('#room-list li')).toHaveCount(0);
      await expect(home.locator('#empty-room-title')).toHaveText('这一刻，大家都已入席。');
      const bot = available.room.snapshot().players.find((player) => player.kind === 'bot')!;
      available.room.removePlayer(bot.id, available.token);
      await expect(home.locator('#room-list li')).toHaveCount(1);
      await expect(home.getByRole('button', { name: '可加入', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await home.getByRole('button', { name: '全部房间', exact: true }).click();
      await expect(home.locator('#room-list li')).toHaveCount(2);
      await link.click();
      await home.getByLabel('怎么称呼你').fill('关羽');
      await home.getByRole('button', { name: '入座', exact: true }).click();
      await expect(home.locator('#my-nickname')).toHaveText('关羽');
      await home.goto(publicBase + '/');
      await expect(home.locator('#current-room')).toBeVisible();
      await expect(home.locator('#create-panel')).toBeHidden();
      await home.getByRole('link', { name: '返回我的房间', exact: true }).click();
      await expect(home.locator('#my-nickname')).toHaveText('关羽');
      expect(
        available.room.snapshot().players.filter((player) => player.kind === 'human'),
      ).toHaveLength(2);
    },
    true,
  );
});

test('四模式的房间与设置同步展示档位牌堆，旧服务保留108说明', async ({ browser }) => {
  const adapter: EngineAdapter = {
    status: () => ({
      id: 'noname',
      ready: true,
      cardPilePolicy: true,
      message: '牌堆说明测试占位器',
    }),
    start: async () => {},
  };
  await withLobby(
    browser,
    async ({ base, page }) => {
      const owner = await page();
      const code = await createRoom(owner, base, '牌堆房主');
      const member = await page();
      await joinRoom(member, base, code, '看规则');
      for (const mode of ['identity', 'doudizhu', 'versus', 'duel']) {
        await owner.locator(`[data-mode="${mode}"]`).click();
        for (const preset of ['advanced', 'beginner']) {
          await owner.getByLabel('武将范围').selectOption(preset);
          const expected = preset === 'beginner' ? '标准108张' : '军争160张（去木牛流马）';
          await expect(owner.locator('#preset-deck')).toContainText(expected);
          await waitForSettings(owner);
          await expect(member.locator('#summary-deck')).toContainText(expected);
          await expect(member.locator('#summary-deck')).toContainText('四种模式按档位统一');
        }
      }
      expect(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    },
    false,
    adapter,
  );
  await withLobby(browser, async ({ base, page }) => {
    const owner = await page();
    await createRoom(owner, base, '旧服务说明');
    await owner.getByLabel('武将范围').selectOption('advanced');
    await waitForSettings(owner);
    await expect(owner.locator('#summary-deck')).toContainText(
      '牌堆：标准108张；电脑更新并重启服务后',
    );
  });
});

async function withLobby(
  browser: Browser,
  scenario: (fixture: {
    party: ReturnType<typeof createPartyServer>;
    base: string;
    publicBase: string;
    gateway: ReturnType<typeof createPublicGateway> | null;
    page: (desktop?: boolean) => Promise<Page>;
  }) => Promise<void>,
  internet = false,
  adapter?: EngineAdapter,
) {
  const party = createPartyServer({
    port: 0,
    webRoot: fileURLToPath(new URL('../../dist/web/', import.meta.url)),
    publicUrl: 'http://192.168.1.100:3000',
    entryMode: internet ? 'internet' : 'lan',
    ...(adapter ? { adapter } : {}),
  });
  await new Promise<void>((resolve) => party.server.listen(0, '127.0.0.1', resolve));
  const address = party.server.address();
  if (!address || typeof address === 'string') throw new Error('No server address');
  const base = `http://127.0.0.1:${address.port}`;
  const gateway = internet ? createPublicGateway(address.port) : null;
  if (gateway) await new Promise<void>((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const ingress = gateway?.server.address();
  const publicBase =
    ingress && typeof ingress === 'object' ? `http://127.0.0.1:${ingress.port}` : base;
  const contexts: BrowserContext[] = [];
  const errors: string[] = [];
  try {
    await scenario({
      party,
      base,
      publicBase,
      gateway,
      page: async (desktop = false) => {
        const context = await browser.newContext({
          viewport: desktop ? { width: 1440, height: 1050 } : { width: 390, height: 844 },
          isMobile: !desktop,
          hasTouch: !desktop,
        });
        contexts.push(context);
        if (internet)
          await context.addInitScript(() => {
            Object.defineProperty(AbortSignal, 'any', { value: undefined });
            Object.defineProperty(AbortSignal, 'timeout', { value: undefined });
          });
        const page = await context.newPage();
        page.on('pageerror', (error) => errors.push(error.message));
        return page;
      },
    });
    expect(errors).toEqual([]);
  } finally {
    for (const context of contexts) await context.close();
    gateway?.close();
    party.closeStreams();
    party.server.closeAllConnections();
    await new Promise<void>((resolve) => party.server.close(() => resolve()));
  }
}

async function createRoom(page: Page, base: string, nickname: string): Promise<string> {
  await page.goto(base + '/');
  await page.getByLabel('怎么称呼你').fill(nickname);
  await page.getByRole('button', { name: '创建房间并入座' }).click();
  await expect(page.locator('#my-role')).toHaveText('你是房主，也参加这一局');
  if (
    !(await page.locator('#settings-panel').evaluate((panel) => (panel as HTMLDetailsElement).open))
  )
    await page.locator('#room-settings-link').click();
  await page.locator('#room-rules-summary > summary').click();
  return page.url().split('/').at(-1)!;
}

async function waitForSettings(page: Page): Promise<void> {
  await expect(page.locator('#settings-state')).toHaveText(
    /^(?:设置已自动保存。|修改设置后会自动保存。)/,
  );
  await expect(page.locator('#save-settings')).toBeHidden();
}

async function checkQr(page: Page, roomCode?: string, prefix = ''): Promise<string> {
  await expect(page.locator(`#${prefix}qr`)).toBeVisible();
  await expect
    .poll(() =>
      page.locator(`#${prefix}qr`).evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  const url = await page.locator(`#${prefix}join-url`).inputValue();
  expect(new URL(url).pathname).toBe(roomCode ? `/join/${roomCode}` : '/');
  expect(new URL(url).hash).toBe('');
  return url;
}

async function joinRoom(page: Page, base: string, code: string, nickname: string): Promise<void> {
  await page.goto(`${base}/join/${code}`);
  await page.getByLabel('怎么称呼你').fill(nickname);
  await page.getByRole('button', { name: '入座', exact: true }).click();
  await expect(page.getByRole('button', { name: '我准备好了' })).toBeEnabled();
  await page.locator('#room-rules-summary > summary').click();
}

test('房主设置自动合并与串行保存，晚响应保留新草稿，失败可重试并重新准备', async ({ browser }) => {
  const adapter: EngineAdapter = {
    status: () => ({ id: 'noname', ready: true, message: '自动保存页面测试占位器' }),
    start: async () => {},
  };
  await withLobby(
    browser,
    async ({ party, base, page }) => {
      const owner = await page();
      const code = await createRoom(owner, base, '房主');
      const member = await page();
      await joinRoom(member, base, code, '朋友');
      await owner.locator('#fill-bots').click();
      await owner.locator('#ready-button').click();
      await member.locator('#ready-button').click();
      await expect(owner.locator('#start-button')).toBeEnabled();
      const settings: unknown[] = [];
      let releaseFirst!: () => void;
      const firstResponse = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let rejectNext = false;
      await owner.route(`**/api/rooms/${code}`, async (route) => {
        if (route.request().method() !== 'PUT') return route.continue();
        settings.push(route.request().postDataJSON());
        if (rejectNext) {
          rejectNext = false;
          return route.fulfill({ status: 503, json: { error: { message: '连接暂时不可用。' } } });
        }
        const response = await route.fetch();
        if (settings.length === 1) await firstResponse;
        await route.fulfill({ response });
      });
      await owner.getByLabel('总席位（含 AI）').selectOption('8');
      await expect(owner.locator('#ready-button')).toBeDisabled();
      await expect(owner.locator('#fill-bots')).toBeDisabled();
      await expect(owner.locator('#start-button')).toBeDisabled();
      await expect.poll(() => settings.length).toBe(1);
      await owner.getByLabel('武将范围').selectOption('advanced');
      await owner.getByLabel('总席位（含 AI）').selectOption('7');
      await owner.getByLabel('允许点将').check();
      await owner.waitForTimeout(650);
      expect(settings).toHaveLength(1);
      await expect(owner.getByLabel('武将范围')).toHaveValue('advanced');
      releaseFirst();
      await waitForSettings(owner);
      expect(settings).toHaveLength(2);
      expect(settings[1]).toMatchObject({
        playerCount: 7,
        generalPreset: 'advanced',
        allowGeneralSelection: true,
      });
      expect(party.lobby.get(code).snapshot().settings).toMatchObject({
        playerCount: 7,
        generalPreset: 'advanced',
      });
      expect(
        party.lobby
          .get(code)
          .snapshot()
          .players.filter((player) => player.kind === 'human')
          .every((player) => !player.ready),
      ).toBe(true);
      await expect(owner.getByLabel('武将范围')).toHaveValue('advanced');
      await expect(member.locator('#summary-details')).toContainText('7 席');

      rejectNext = true;
      await owner.locator('[data-mode="duel"]').click();
      await expect(owner.locator('#settings-state')).toContainText(
        '自动保存失败：连接暂时不可用。',
      );
      await expect(owner.locator('#save-settings')).toBeVisible();
      await expect(owner.locator('[data-mode="duel"]')).toHaveAttribute('aria-pressed', 'true');
      await expect(owner.locator('#ready-button')).toBeDisabled();
      expect(party.lobby.get(code).snapshot().settings.mode).toBe('identity');
      await owner.getByRole('button', { name: '重试保存' }).click();
      await waitForSettings(owner);
      await expect(member.locator('#summary-mode')).toHaveText('单挑');
      expect(party.lobby.get(code).snapshot().players).toHaveLength(2);
      await expect(member.locator('#ready-button')).toHaveText('我准备好了');
      await expect(owner.locator('#ready-button')).toBeEnabled();
      await expect(owner.locator('#start-button')).toBeDisabled();
      await owner.reload();
      await expect(owner.locator('[data-mode="duel"]')).toHaveAttribute('aria-pressed', 'true');
      await expect(owner.getByLabel('武将范围')).toHaveValue('advanced');
    },
    false,
    adapter,
  );
});

test('后来者由房间链接公开观战，不入座或打开私有牌桌，刷新分页与下一局状态同步', async ({
  browser,
}) => {
  let matchId = 'spectator-fixture-1';
  let total = 220;
  let ended = false;
  const listeners = new Set<(event: EngineEvent) => void>();
  const adapter: EngineAdapter = {
    status: () => ({
      id: 'noname',
      ready: true,
      publicSpectating: true,
      message: '观战页面测试占位器',
    }),
    start: async () => {},
    matchId: () => matchId,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    release: () => {},
  };
  await withLobby(
    browser,
    async ({ party, base, page }) => {
      const owner = await page();
      await owner.route('**/engine/player/spectator-fixture-*', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<p>页面测试占位牌桌</p>',
        }),
      );
      const code = await createRoom(owner, base, '房主');
      await owner.locator('[data-mode="duel"]').click();
      await waitForSettings(owner);
      await owner.locator('#fill-bots').click();
      await owner.locator('#ready-button').click();
      await owner.locator('#start-button').click();
      const spectator = await page();
      const privateRequests: string[] = [];
      spectator.on('request', (request) => {
        if (/\/engine\/(player|setup|view|table|poll|socket|history|lan)\//.test(request.url()))
          privateRequests.push(request.url());
      });
      await spectator.route('**/engine/observe/*?*', (route) => {
        const before = Number(
          new URL(route.request().url()).searchParams.get('before') || total + 1,
        );
        const first = Math.max(1, before - 100);
        return route.fulfill({
          json: {
            matchId,
            roomCode: code,
            total,
            first: 1,
            entries: Array.from({ length: before - first }, (_, offset) => ({
              sequence: first + offset,
              text: `公开动作 ${first + offset} <img src=x>`,
            })),
            observer: {
              updatedAt: Date.now(),
              round: 2,
              ended,
              deckCount: 77,
              currentPlayerId: 'public-player',
              identityCounts: { zhu: 1, zhong: 0, fan: 3, nei: 1 },
              players: [
                {
                  id: 'public-player',
                  nickname: '<b>玩家</b>',
                  general: '公开武将',
                  identity: '身份未公开',
                  hp: 3,
                  maxHp: 4,
                  armor: 0,
                  handCount: 4,
                  dead: false,
                  linked: false,
                  turnedOver: false,
                  equipment: ['诸葛连弩'],
                  judgments: [],
                  controller: 'human',
                },
              ],
              recent: Array.from(
                { length: Math.min(total, 100) },
                (_, offset) => `公开动作 ${Math.max(1, total - 99) + offset} <img src=x>`,
              ),
              logStart: Math.max(1, total - 99),
              logTotal: total,
              logFirst: 1,
            },
          },
        });
      });
      await spectator.goto(`${base}/join/${code}`);
      await expect(spectator.locator('#spectator-panel')).toBeVisible();
      await expect(spectator.locator('#join-form')).toBeHidden();
      await expect(spectator.locator('#my-seat')).toBeHidden();
      await expect(spectator.locator('#settings-panel')).toBeHidden();
      await expect(spectator.locator('#game-frame')).toHaveCount(0);
      await expect(spectator.locator('#spectator-table .observer-seat h3')).toHaveText(
        '<b>玩家</b>',
      );
      await expect(spectator.locator('#spectator-table .observer-round')).toContainText(
        '剩余身份：主 1 忠 0 反 3 内 1',
      );
      await expect(spectator.locator('#spectator-deck')).toHaveText('牌堆剩余 77 张');
      await expect(spectator.locator('#spectator-table img, #spectator-table b')).toHaveCount(0);
      const list = spectator.locator('#spectator-table .observer-recent');
      await expect(list.locator('li')).toHaveCount(100);
      await spectator.getByRole('button', { name: '查看更早记录' }).click();
      await expect(list.locator('li')).toHaveCount(200);
      await spectator.getByRole('button', { name: '查看更早记录' }).click();
      await expect(list.locator('li')).toHaveCount(220);
      total = 240;
      await expect(list.locator('li')).toHaveCount(240);
      expect(party.lobby.get(code).snapshot().players).toHaveLength(2);
      expect(
        await spectator.request.get(`${base}/api/me`).then((response) => response.json()),
      ).toEqual({ playerId: null, roomCode: null });
      await spectator.reload();
      await expect(spectator.locator('#spectator-table .observer-log h3')).toHaveText(
        '本局公开记录 · 240 条',
      );
      await spectator.getByRole('button', { name: '查看更早记录' }).click();
      await expect(list.locator('li')).toHaveCount(200);
      ended = true;
      for (const listener of listeners) listener({ type: 'ended', roomCode: code });
      await expect(spectator.locator('#spectator-status')).toHaveText('本局已结束');
      await owner.locator('#rematch-button').click();
      await expect(spectator.locator('#spectator-panel')).toBeHidden();
      await expect(spectator.locator('#join-form')).toBeVisible();
      matchId = 'spectator-fixture-2';
      total = 1;
      ended = false;
      await owner.locator('#ready-button').click();
      await owner.locator('#start-button').click();
      await expect(spectator.locator('#spectator-table .observer-log')).toHaveAttribute(
        'data-match-id',
        matchId,
      );
      await expect(list.locator('li')).toHaveCount(1);
      expect(privateRequests).toEqual([]);
      expect(party.lobby.get(code).snapshot().players).toHaveLength(2);
    },
    false,
    adapter,
  );
});

test('手机工具条主动托管与恢复由牌桌确认，公开身份与最近动作安全显示', async ({ browser }) => {
  const listeners = new Set<(event: EngineEvent) => void>();
  const adapter: EngineAdapter = {
    status: () => ({
      id: 'noname',
      ready: true,
      experience: true,
      connectionRecovery: true,
      message: '托管工具条页面测试占位器',
    }),
    start: async () => {},
    matchId: () => 'experience-fixture',
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  await withLobby(
    browser,
    async ({ base, page }) => {
      const phone = await page();
      await phone.route('**/engine/player/experience-fixture', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<p>工具条测试占位牌桌</p><script>
        window.controlRequests = [];
        function control(auto) { parent.postMessage({type:'party-control',matchId:'experience-fixture',auto},location.origin); }
        window.addEventListener('message', event => {
          if (event.source !== parent || event.origin !== location.origin || event.data?.matchId !== 'experience-fixture') return;
          if (['party-auto','party-manual'].includes(event.data.type)) { window.controlRequests.push(event.data.type); control(event.data.type === 'party-auto'); }
        });
        parent.postMessage({type:'party-public-summary',matchId:'experience-fixture',summary:{identityCounts:{zhu:1,zhong:2,fan:4,nei:1},actions:[{sequence:8,text:'旧动作'},{sequence:9,text:'<b>玩家</b>使用了杀'},{sequence:10,text:'玩家响应了闪'},{sequence:11,text:'<img src=x>弃置了红桃7杀'}]}},location.origin);
        control(false);
        parent.postMessage({type:'party-connected',matchId:'experience-fixture'},location.origin);
      </script>`,
        }),
      );
      const code = await createRoom(phone, base, '工具条房主');
      await phone.locator('#fill-bots').click();
      await phone.locator('#ready-button').click();
      await phone.locator('#start-button').click();
      await expect(phone.locator('#match-identities')).toHaveText('剩余身份 · 主 1 忠 2 反 4 内 1');
      await expect(phone.locator('#match-last-action')).toHaveText('<img src=x>弃置了红桃7杀');
      await phone.locator('#match-actions summary').click();
      await expect(phone.locator('#match-actions li')).toHaveCount(3);
      await expect(phone.locator('#match-actions li').first()).toHaveText('<b>玩家</b>使用了杀');
      await expect(phone.locator('#match-experience img, #match-experience b')).toHaveCount(0);
      await phone.evaluate(() =>
        window.postMessage(
          {
            type: 'party-public-summary',
            matchId: 'experience-fixture',
            summary: {
              identityCounts: { zhu: 8, zhong: 8, fan: 8, nei: 8 },
              actions: [{ sequence: 99, text: '伪造公开事件' }],
            },
          },
          location.origin,
        ),
      );
      await expect(phone.locator('#match-identities')).toHaveText('剩余身份 · 主 1 忠 2 反 4 内 1');
      const native = phone.frames().find((frame) => frame.url().includes('/engine/player/'))!;
      for (const type of ['party-checking', 'party-network']) {
        await native.evaluate(
          (type) =>
            parent.postMessage(
              { type, matchId: 'experience-fixture', unstable: true },
              location.origin,
            ),
          type,
        );
        await expect(phone.locator('#match-connection')).toHaveClass(/blocking/);
        await expect(phone.locator('#match-auto')).toBeDisabled();
        await phone
          .locator('#match-auto')
          .evaluate((button) => (button as HTMLButtonElement).click());
        expect(
          await native.evaluate(
            () => (window as Window & { controlRequests?: string[] }).controlRequests,
          ),
        ).toEqual([]);
        await native.evaluate(() =>
          parent.postMessage(
            { type: 'party-control', matchId: 'experience-fixture', auto: false },
            location.origin,
          ),
        );
        await expect(phone.locator('#match-connection')).toBeHidden();
        await expect(phone.locator('#match-auto')).toBeEnabled();
      }
      await phone.locator('#match-more').click();
      await phone.locator('#match-auto').click();
      await expect(phone.locator('#match-auto')).toHaveText('恢复手动操作');
      await expect(phone.locator('#match-auto')).toHaveAttribute('aria-pressed', 'true');
      await expect(phone.locator('#match-control-state')).toHaveText('原生 AI 正在替你操作');
      await phone.locator('#match-auto').click();
      await expect(phone.locator('#match-auto')).toHaveText('主动托管');
      await expect(phone.locator('#match-auto')).toHaveAttribute('aria-pressed', 'false');
      expect(
        await native.evaluate(
          () => (window as Window & { controlRequests?: string[] }).controlRequests,
        ),
      ).toEqual(['party-auto', 'party-manual']);
      for (const listener of listeners) listener({ type: 'ended', roomCode: code });
      await expect(phone.locator('#match-auto')).toBeDisabled();
    },
    false,
    adapter,
  );
});

test('官方将池同步公告/缺项与图鉴；只有房主可换档，点将与准备清除', async ({ browser }) => {
  await withLobby(browser, async ({ party, base, page }) => {
    const owner = await page();
    const code = await createRoom(owner, base, '官方将池房主');
    const member = await page();
    await joinRoom(member, base, code, '朋友');
    await expect(member.locator('#settings-panel')).toBeHidden();
    const denied = await member.request.put(`${base}/api/rooms/${code}`, {
      data: { mode: 'identity', playerCount: 5, generalPreset: 'ol-doudizhu-s15', extensions: [] },
    });
    expect(denied.status()).toBe(403);
    await owner.getByLabel('允许点将').check();
    await waitForSettings(owner);
    await member.getByRole('button', { name: '点将 · 设置第1个候选' }).click();
    await member.locator('[data-general="zhaoyun"]').click();
    await member.getByRole('button', { name: '关闭武将图鉴' }).click();
    await member.getByRole('button', { name: '我准备好了' }).click();
    const officialPresets = GENERAL_PRESETS.filter((entry) => entry.official);
    for (const preset of officialPresets) {
      await owner.getByLabel('武将范围').selectOption(preset.id);
      await expect(owner.locator('#preset-source a')).toHaveAttribute('href', preset.official!.url);
      await waitForSettings(owner);
      await expect(member.locator('#summary-details')).toContainText(preset.name);
      await expect(member.locator('#summary-roster-source')).toContainText(
        `${preset.characterCount}/${preset.official!.announcedCount}`,
      );
      for (const name of preset.official!.missingGenerals)
        await expect(member.locator('#summary-roster-source')).toContainText(name);
      await expect(member.locator('#general-pick-state')).toContainText('未点将');
      await expect(member.getByRole('button', { name: '我准备好了' })).toBeVisible();
      expect(party.lobby.get(code).snapshot().settings.generalPreset).toBe(preset.id);
      await member.getByRole('button', { name: '武将图鉴 · 查看技能' }).click();
      await expect(member.getByLabel('武将档位')).toHaveValue(preset.id);
      await expect(member.locator('#guide-count')).toHaveText(
        `显示 ${preset.characterCount} / ${preset.characterCount} 位武将`,
      );
      await expect(member.locator('#guide-source a')).toHaveAttribute('href', preset.official!.url);
      await expect(member.locator('#guide-list > details')).toHaveCount(preset.characterCount);
      if (preset.id === 'ol-doudizhu-s15') {
        await expect(member.locator('#summary-roster-source')).toContainText(
          /张绣.*额外主公技踞襄/,
        );
        await expect(member.locator('#guide-source')).toContainText(/张绣.*额外主公技踞襄/);
        await member.getByLabel('查找武将或技能').fill('张绣');
        await expect(member.locator('#guide-list > details')).toHaveCount(2);
        await member
          .locator('#guide-list > details')
          .filter({ hasText: '雄乱' })
          .locator('summary')
          .click();
        await expect(member.locator('#guide-list')).toContainText('踞襄');
        await member.getByLabel('查找武将或技能').fill('谋关羽');
        await expect(member.locator('#guide-list > details')).toHaveCount(1);
        await member.locator('#guide-list summary').click();
        await expect(member.locator('#guide-list')).toContainText('威临');
        await expect(member.locator('#guide-list')).toContainText('夺首');
        await member.getByLabel('查找武将或技能').fill('');
        await member.getByLabel('势力', { exact: true }).selectOption('jin');
        await expect(member.locator('#guide-list')).toContainText('羊祜');
        await member.getByLabel('势力', { exact: true }).selectOption('');
      }
      if (preset.id === 'ol-ranked-2026-10-full' || preset.id === 'ol-sgl-2026-stage1') {
        await member.getByLabel('查找武将或技能').fill('曹婴');
        await expect(member.locator('#guide-list > details')).toHaveCount(1);
        await member.locator('#guide-list summary').click();
        await expect(member.locator('#guide-list .guide-version-note')).toBeVisible();
        await expect(member.locator('#guide-list .guide-version-note')).toContainText('伏间');
        await member.getByLabel('查找武将或技能').fill('');
      }
      if (preset.id === 'mobile-time-field-2026-10') {
        await expect(member.locator('#guide-source')).toContainText('目录读取');
        const omissions = member.locator('#guide-source details');
        await expect(omissions.locator('summary')).toHaveText('查看缺少的 68 名武将');
        await expect(omissions).not.toHaveAttribute('open');
        await omissions.locator('summary').click();
        await expect(omissions.locator('p')).toBeVisible();
        await expect(omissions.locator('p')).toContainText('严白虎');
      }
      expect(await member.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await member.getByRole('button', { name: '关闭武将图鉴' }).click();
    }
    await member.reload();
    const lastPreset = officialPresets.at(-1)!;
    await expect(member.locator('#summary-roster-source')).toContainText(
      `${lastPreset.characterCount}/${lastPreset.official!.announcedCount}`,
    );
    await owner.getByLabel('武将范围').selectOption('beginner');
    await waitForSettings(owner);
    await expect(member.locator('#summary-roster-source')).toBeHidden();
  });
});

test('电脑只展示主页码，手机建房参赛，任意成员展示直达房间码，2v2 四真人准备', async ({
  browser,
}) => {
  await withLobby(browser, async ({ party, base, page }) => {
    const computer = await page(true);
    await computer.goto(base + '/server');
    await checkQr(computer);
    expect(party.lobby.list()).toHaveLength(0);
    expect(await computer.getByRole('button', { name: '创建房间并入座' }).count()).toBe(0);
    expect(await computer.getByRole('button', { name: '保存房间设置' }).count()).toBe(0);
    const owner = await page();
    const code = await createRoom(owner, base, '诸葛亮');
    const room = party.lobby.get(code);
    expect(room.snapshot().players).toHaveLength(1);
    expect(
      await computer.request.get(base + '/api/me').then((response) => response.json()),
    ).toEqual({ playerId: null, roomCode: null });
    await owner.getByRole('button', { name: /2v2/ }).click();
    await waitForSettings(owner);
    await expect(owner.locator('#summary-rules')).toBeVisible();
    await expect(owner.locator('#summary-rules')).toContainText('每队共享 10 名候选');
    await expect(owner.locator('#summary-rules')).toContainText('已选武将保留在将池');
    await expect(owner.locator('#summary-rules')).toContainText('1 号位首回合摸牌阶段少摸 1 张');
    await expect(owner.locator('#summary-rules')).toContainText('队友阵亡可摸 1 张');
    await owner.getByRole('button', { name: '展示房间二维码' }).click();
    await checkQr(owner, code);
    await owner.getByRole('button', { name: '关闭房间二维码' }).click();
    const phones = [owner];
    for (const nickname of ['赵云', '黄忠', '<b>乔</b>']) {
      const phone = await page();
      if (nickname === '赵云') {
        let requests = 0;
        let stale: RoomView | undefined;
        const unsubscribe = room.subscribe((snapshot) => {
          if (!stale && snapshot.players.length === 2 && !snapshot.players[1]?.online)
            stale = snapshot;
        });
        await phone.route(`**/api/rooms/${code}`, async (route) => {
          if (route.request().method() === 'GET' && ++requests === 2 && stale) {
            const response = await route.fetch();
            const data = await response.json();
            await expect(phone.getByRole('button', { name: '我准备好了' })).toBeEnabled();
            await route.fulfill({ response, json: { ...data, room: stale } });
            unsubscribe();
          } else await route.continue();
        });
      }
      await joinRoom(phone, base, code, nickname);
      await expect(phone.locator('#summary-rules')).toContainText('起手分别 4/4/4/5 张');
      await phone.getByRole('button', { name: '展示房间二维码' }).click();
      await checkQr(phone, code);
      expect(await phone.getByRole('button', { name: '添加 1 个 AI' }).isVisible()).toBe(false);
      await phone.getByRole('button', { name: '关闭房间二维码' }).click();
      expect(
        await phone.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      phones.push(phone);
    }
    for (const phone of phones) await phone.getByRole('button', { name: '我准备好了' }).click();
    await expect(owner.locator('#player-counter')).toHaveText('4 / 4 席');
    await expect(owner.getByRole('button', { name: '开始对局' })).toBeDisabled();
    await expect(phones[3]!.locator('#my-nickname')).toHaveText('<b>乔</b>');
    expect(await phones[3]!.locator('#my-nickname b').count()).toBe(0);
    await owner.reload();
    await expect(owner.locator('#my-role')).toHaveText('你是房主，也参加这一局');
    expect(room.snapshot().players).toHaveLength(4);
    await owner.getByRole('button', { name: '我准备好了' }).click();
    await expect
      .poll(() => room.snapshot().players.filter((player) => player.ready).length)
      .toBe(4);
    await owner.locator('#room-settings-link').click();
    await owner.getByLabel('武将范围').selectOption('advanced');
    await waitForSettings(owner);
    await expect(phones[1]!.locator('#summary-details')).toHaveText('4 席 · 经典进阶96将');
    expect(room.snapshot().players.some((player) => player.ready)).toBe(false);
    const response = await phones[1]!.request.put(`${base}/api/rooms/${code}`, {
      data: { mode: 'identity', playerCount: 8, generalPreset: 'beginner', extensions: [] },
    });
    expect(response.status()).toBe(403);
    await owner.getByRole('button', { name: '移除 黄忠', exact: true }).click();
    await expect(phones[2]!.getByRole('button', { name: '入座', exact: true })).toBeVisible();
    await expect(owner.locator('#player-counter')).toHaveText('3 / 4 席');
    await mkdir(fileURLToPath(new URL('../../.runtime/previews/', import.meta.url)), {
      recursive: true,
    });
    await computer.screenshot({
      path: `.runtime/previews/server-${Date.now()}.png`,
      fullPage: true,
    });
    await owner.screenshot({ path: `.runtime/previews/owner-${Date.now()}.png`, fullPage: true });
    await phones[1]!.getByRole('button', { name: '展示房间二维码' }).click();
    await phones[1]!.screenshot({
      path: `.runtime/previews/member-qr-${Date.now()}.png`,
      fullPage: true,
    });
  });
});

test('模拟投降界面：先确认、真人表态、冷却和断线锁定，身份局说明与昵称保持安全文本', async ({
  browser,
}) => {
  for (const mode of ['doudizhu', 'identity'] as const) {
    const kind = mode === 'identity' ? 'end' : 'surrender';
    const adapter: EngineAdapter = {
      status: () => ({
        id: 'noname',
        ready: true,
        surrender: true,
        connectionRecovery: true,
        message: '投票UI占位器',
      }),
      start: async () => {},
      matchId: () => 'surrender-fixture',
      release() {},
    };
    await withLobby(
      browser,
      async ({ base, page }) => {
        const phone = await page();
        await phone.route('**/engine/player/surrender-fixture', (route) =>
          route.fulfill({
            contentType: 'text/html',
            body: `<p>原生牌桌占位器</p><script>
          window.commands=[];
          const state={kind:'${kind}',available:true,cooldownMs:0,notice:'',vote:null};
          const publish=()=>parent.postMessage({type:'party-surrender-state',matchId:'surrender-fixture',state},location.origin);
          parent.postMessage({type:'party-connected',matchId:'surrender-fixture'},location.origin);
          parent.postMessage({type:'party-control',matchId:'surrender-fixture',auto:false},location.origin);
          publish();
          addEventListener('message',e=>{
            if(e.data.type!=='party-surrender-action')return;
            commands.push({action:e.data.action,epoch:e.data.epoch});
            state.vote=e.data.action==='request'?{epoch:'vote-1',initiator:'<b>乔</b>',remainingMs:30000,eligible:true,voted:true,participants:[{id:'one',nickname:'<b>乔</b>',approved:true},{id:'two',nickname:'队友',approved:false}]}:null;
            if(!state.vote){state.cooldownMs=60000;state.notice='有玩家选择继续，本局继续。'}
            publish();
          });
        </script>`,
          }),
        );
        await createRoom(phone, base, '投票测试');
        await phone.locator(`[data-mode="${mode}"]`).click();
        await waitForSettings(phone);
        await phone.locator('#fill-bots').click();
        await phone.locator('#ready-button').click();
        await phone.locator('#start-button').click();
        await phone.locator('#match-more').click();
        await expect(phone.locator('#match-surrender')).toBeVisible();
        await expect(phone.locator('#match-surrender')).toHaveText(
          kind === 'end' ? '提前结束' : '投降',
        );
        await phone.locator('#match-surrender').click();
        await expect(phone.locator('#surrender-dialog')).toBeVisible();
        await expect(phone.locator('#surrender-detail')).toContainText(
          kind === 'end' ? '含已阵亡玩家' : '对方获胜',
        );
        for (const width of [320, 390]) {
          await phone.setViewportSize({ width, height: 844 });
          const box = await phone.locator('#surrender-dialog').boundingBox();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        }
        await phone.locator('#surrender-reject').click();
        expect(
          await phone
            .frameLocator('#game-frame')
            .locator('body')
            .evaluate(() => (window as any).commands.length),
        ).toBe(0);
        await phone.locator('#match-more').click();
        await phone.locator('#match-surrender').click();
        await phone.locator('#surrender-confirm').click();
        await expect(phone.locator('#surrender-voters')).toContainText('<b>乔</b> · 已同意');
        expect(await phone.locator('#surrender-voters b').count()).toBe(0);
        await expect(phone.locator('#surrender-confirm')).toBeHidden();
        await phone.locator('#surrender-reject').click();
        await expect(phone.locator('#surrender-dialog')).not.toBeVisible();
        await phone.locator('#match-more').click();
        await expect(phone.locator('#surrender-notice')).toContainText('本局继续');
        const commands = await phone
          .frameLocator('#game-frame')
          .locator('body')
          .evaluate(() => (window as any).commands);
        expect(commands).toEqual([
          { action: 'request', epoch: '' },
          { action: 'reject', epoch: 'vote-1' },
        ]);
        await phone.locator('#match-surrender').click();
        await expect(phone.locator('#surrender-confirm')).toBeDisabled();
        await expect(phone.locator('#surrender-countdown')).toContainText('才能再次发起');
        await phone.locator('#surrender-close').click();
        await phone
          .frameLocator('#game-frame')
          .locator('body')
          .evaluate(() =>
            parent.postMessage(
              { type: 'party-network', matchId: 'surrender-fixture', unstable: true, rtt: 0 },
              location.origin,
            ),
          );
        await expect(phone.locator('#match-surrender')).toBeDisabled();
      },
      false,
      adapter,
    );
  }
});

test('断线提示保持可见并锁住旧牌桌，原生重建确认后才恢复；托管有明确收回入口', async ({
  browser,
}) => {
  const adapter: EngineAdapter = {
    status: () => ({
      id: 'noname',
      ready: true,
      connectionRecovery: true,
      luckCards: true,
      message: '恢复UI占位器',
    }),
    start: async () => {},
    matchId: () => 'connection-fixture',
    release() {},
  };
  await withLobby(
    browser,
    async ({ party, base, page }) => {
      const phone = await page();
      let loads = 0;
      await phone.route('**/engine/player/connection-fixture', (route) => {
        loads++;
        return route.fulfill({
          contentType: 'text/html',
          body: `<button>牌桌操作</button><script>parent.postMessage({type:'party-connected',matchId:'connection-fixture'},location.origin);${loads === 1 ? "parent.postMessage({type:'party-control',matchId:'connection-fixture',auto:false},location.origin);" : ''}addEventListener('message',e=>{if(e.data.type==='party-manual')parent.postMessage({type:'party-control',matchId:'connection-fixture',auto:false},location.origin)});</script>`,
        });
      });
      const code = await createRoom(phone, base, '网络测试');
      await phone.locator('[data-mode="duel"]').click();
      await waitForSettings(phone);
      await expect(phone.locator('#summary-deck')).toContainText('3次');
      await phone.getByRole('button', { name: '补满空位' }).click();
      await phone.locator('#ready-button').click();
      await phone.locator('#start-button').click();
      await expect(phone.frameLocator('#game-frame').getByRole('button')).toBeVisible();
      const seat = party.lobby.get(code).snapshot().players[0]!.id;
      await phone.evaluate(() => window.dispatchEvent(new Event('offline')));
      await expect(phone.locator('#match-connection')).toBeVisible();
      await expect(phone.locator('#match-connection-title')).toContainText('连接中断');
      await expect(phone.locator('#game-frame')).toHaveAttribute('inert', '');
      const token = (await phone.context().cookies()).find(
        (cookie) => cookie.name === 'party_player',
      )!.value;
      const disconnect = party.lobby.get(code).connect(token);
      disconnect();
      await expect(phone.locator('#match-label')).toContainText('连接中断');
      await expect.poll(() => loads).toBe(2);
      await expect(phone.locator('#match-connection')).toBeVisible();
      const send = async (state: any) =>
        phone
          .frameLocator('#game-frame')
          .locator('body')
          .evaluate(
            (_node, state) =>
              parent.postMessage(
                { type: 'party-control', matchId: 'connection-fixture', ...state },
                location.origin,
              ),
            state,
          );
      await send({ auto: false, offline: true });
      await expect(phone.locator('#match-connection-title')).toHaveText('已恢复连接 · 手动操作');
      await expect(phone.locator('#match-connection-detail')).toContainText('AI 可能已行动');
      await expect(phone.locator('#game-frame')).not.toHaveAttribute('inert', '');
      await send({ auto: true });
      await expect(phone.locator('#match-connection-title')).toHaveText('你正在托管');
      await phone.getByRole('button', { name: '恢复手动操作', exact: true }).click();
      await expect(phone.locator('#match-connection')).toBeHidden();
      expect(party.lobby.get(code).snapshot().players[0]!.id).toBe(seat);
      expect(loads).toBe(2);
    },
    false,
    adapter,
  );
});

test('模拟牌桌更新中断：结束后同步最终画面，手动恢复保留房间和座位', async ({ browser }) => {
  const listeners = new Set<(event: EngineEvent) => void>();
  const adapter: EngineAdapter = {
    status: () => ({ id: 'noname', ready: true, message: '页面恢复测试占位器' }),
    start: async () => {},
    matchId: () => 'recovery-fixture',
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    release: () => {},
  };
  await withLobby(
    browser,
    async ({ party, base, page }) => {
      const phone = await page();
      let loads = 0;
      let nativeFinished = false;
      await phone.route('**/engine/player/recovery-fixture', (route) => {
        loads++;
        return route.fulfill({
          contentType: 'text/html',
          body: `<p id="native-state">${loads === 1 ? '旧画面：双方仍有体力' : '已同步牌桌'}</p><script>window.partyEngine={_status:{over:${nativeFinished}}};parent.postMessage({type:'party-connected',matchId:'recovery-fixture'},location.origin);</script>`,
        });
      });
      const code = await createRoom(phone, base, '恢复测试');
      const seatBefore = party.lobby.get(code).snapshot().players[0]!.id;
      await phone.getByRole('button', { name: /单挑/ }).click();
      await waitForSettings(phone);
      await phone.getByRole('button', { name: '补满空位' }).click();
      await phone.locator('#ready-button').click();
      await phone.locator('#start-button').click();
      await expect(phone.frameLocator('#game-frame').locator('#native-state')).toContainText(
        '双方仍有体力',
      );
      expect(loads).toBe(1);
      for (const listener of listeners) listener({ type: 'ended', roomCode: code });
      await expect(phone.locator('#match-label')).toHaveText('本局已结束');
      await expect.poll(() => loads).toBe(2);
      await expect(phone.frameLocator('#game-frame').locator('#native-state')).toHaveText(
        '已同步牌桌',
      );
      // An ordinary lobby update must not restart the final snapshot repeatedly.
      const token = (await phone.context().cookies()).find(
        (cookie) => cookie.name === 'party_player',
      )!.value;
      const disconnect = party.lobby.get(code).connect(token);
      disconnect();
      await phone.waitForTimeout(2200);
      expect(loads).toBe(2);
      await phone.locator('#match-more').click();
      await phone.getByRole('button', { name: '恢复牌桌', exact: true }).click();
      await expect.poll(() => loads).toBe(3);
      expect(party.lobby.get(code).snapshot().phase).toBe('finished');
      expect(party.lobby.get(code).snapshot().players[0]!.id).toBe(seatBefore);

      // A client that already rendered the native end screen retains it.
      nativeFinished = true;
      await phone.reload();
      await expect(phone.locator('#match-label')).toHaveText('本局已结束');
      await expect.poll(() => loads).toBe(4);
      await phone.waitForTimeout(2200);
      expect(loads).toBe(4);
      await phone.locator('#rematch-button').click();
      await expect(phone.locator('#game-frame')).toHaveCount(0);
      await expect(phone.locator('#ready-button')).toBeEnabled();
    },
    false,
    adapter,
  );
});

test('结算先到牌桌：提前点击回房等待服务端结束，原房与席位保留', async ({ browser }) => {
  const listeners = new Set<(event: EngineEvent) => void>();
  const adapter: EngineAdapter = {
    status: () => ({ id: 'noname', ready: true, message: '结算同步测试占位器' }),
    start: async () => {},
    matchId: () => 'return-fixture',
    release: () => {},
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  await withLobby(
    browser,
    async ({ party, base, page }) => {
      const phone = await page();
      await phone.route('**/engine/player/return-fixture', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: "<button id='table-return'>回到房间</button><script>parent.postMessage({type:'party-connected',matchId:'return-fixture'},location.origin);document.querySelector('button').onclick=()=>parent.postMessage({type:'party-return-room',matchId:'return-fixture'},location.origin);</script>",
        }),
      );
      const code = await createRoom(phone, base, '结算同步');
      const seat = party.lobby.get(code).snapshot().ownerId;
      await phone.getByRole('button', { name: /单挑/ }).click();
      await waitForSettings(phone);
      await phone.getByRole('button', { name: '补满空位' }).click();
      await phone.locator('#ready-button').click();
      await phone.locator('#start-button').click();
      const response = phone.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/rooms/${code}`) && response.request().method() === 'GET',
      );
      await phone.frameLocator('#game-frame').locator('#table-return').click();
      await response;
      expect(party.lobby.get(code).snapshot().phase).toBe('playing');
      for (const listener of listeners) listener({ type: 'ended', roomCode: code });
      await expect(phone.locator('#game-frame')).toHaveCount(0);
      await expect(phone.locator('#ready-button')).toBeEnabled();
      expect(party.lobby.get(code).snapshot().phase).toBe('waiting');
      expect(party.lobby.get(code).snapshot().ownerId).toBe(seat);
    },
    false,
    adapter,
  );
});

test('电脑控制台管理两桌，安全显示昵称、移除等待席位和关闭指定房间，不占玩家席位', async ({
  browser,
}) => {
  await withLobby(browser, async ({ party, base, page }) => {
    const computer = await page(true);
    const owner = await page();
    const friend = await page();
    const other = await page();
    await computer.goto(base + '/server');
    const code = await createRoom(owner, base, '<img src=x>');
    await joinRoom(friend, base, code, '朋友');
    const otherCode = await createRoom(other, base, '另一桌');
    await expect(computer.locator('#room-total')).toHaveText('2 间');
    await expect(computer.locator('#console-room-title')).toContainText('<img src=x>');
    expect(await computer.locator('#console-room-title img').count()).toBe(0);
    const session = await computer.request.get(base + '/api/me');
    expect(await session.json()).toEqual({ playerId: null, roomCode: null });
    computer.on('dialog', (dialog) => void dialog.accept());
    await computer
      .locator('.console-player')
      .filter({ hasText: '朋友' })
      .getByRole('button', { name: '移除席位' })
      .click();
    await expect(friend.locator('#my-seat')).toBeHidden();
    expect(party.lobby.get(code).snapshot().players.length).toBe(1);
    await computer.getByRole('button', { name: '关闭房间', exact: true }).click();
    await expect(computer.locator('#room-total')).toHaveText('1 间');
    await expect(owner.locator('#connection')).toHaveText('房间已关闭');
    expect(party.lobby.get(otherCode).snapshot().players.length).toBe(1);
    await mkdir('.runtime/previews', { recursive: true });
    await computer.screenshot({
      path: `.runtime/previews/service-console-${Date.now()}.png`,
      fullPage: true,
    });
  });
});

test('公开记录占位页面：回看整局、实时更新保留阅读位置，换局清空记录与安全文本', async ({
  browser,
}) => {
  await withLobby(browser, async ({ party, base, page }) => {
    const computer = await page(true);
    const created = party.lobby.create('<b>玩家</b>');
    let total = 220;
    let matchId = 'observer-match-1';
    await computer.route('**/api/console', (route) =>
      route.fulfill({
        json: {
          rooms: [
            {
              room: { ...created.room.snapshot(), phase: 'playing', matchId },
              networks: [],
              observer: {
                updatedAt: 1,
                round: 2,
                ended: false,
                currentPlayerId: created.playerId,
                players: [
                  {
                    id: created.playerId,
                    nickname: '<b>玩家</b>',
                    general: '公开武将',
                    identity: '身份未公开',
                    hp: 3,
                    maxHp: 4,
                    armor: 0,
                    handCount: 2,
                    dead: false,
                    linked: false,
                    turnedOver: false,
                    controller: 'human',
                    equipment: [],
                    judgments: [],
                  },
                ],
                recent: Array.from(
                  { length: 100 },
                  (_, offset) => `公开动作 ${total - 99 + offset} <img src=x>`,
                ),
                logStart: total - 99,
                logTotal: total,
                logFirst: 1,
              },
            },
          ],
        },
      }),
    );
    await computer.route('**/api/console/rooms/*/log?*', (route) => {
      const before = Number(new URL(route.request().url()).searchParams.get('before'));
      return route.fulfill({
        json: {
          matchId,
          total,
          first: 1,
          entries: Array.from({ length: Math.min(100, before - 1) }, (_, offset) => ({
            sequence: Math.max(1, before - 100) + offset,
            text: `早期公开动作 ${Math.max(1, before - 100) + offset}`,
          })),
        },
      });
    });
    await computer.goto(`${base}/server`);
    const list = computer.locator('.observer-recent');
    await expect(list.locator('li')).toHaveCount(100);
    await expect(computer.locator('.observer-seat h3')).toHaveText('<b>玩家</b>');
    await expect(computer.locator('.observer-recent img, .observer-seat b')).toHaveCount(0);
    await computer.getByRole('button', { name: '查看更早记录' }).click();
    await expect(list.locator('li')).toHaveCount(200);
    await computer.getByRole('button', { name: '查看更早记录' }).click();
    await expect(list.locator('li')).toHaveCount(220);
    await expect(list.locator('li').first()).toHaveText('早期公开动作 1');
    await list.evaluate((node) => {
      node.scrollTop = 140;
    });
    total = 240;
    await expect(computer.locator('.observer-log h3')).toHaveText('本局公开记录 · 240 条');
    await expect(list.locator('li')).toHaveCount(240);
    expect(await list.evaluate((node) => node.scrollTop)).toBeCloseTo(140, 0);
    await expect(list.locator('li').first()).toHaveText('早期公开动作 1');
    total = 500;
    await expect(list.locator('li')).toHaveCount(500);
    expect(
      await list
        .locator('li')
        .evaluateAll((items) => items.map((item) => (item as HTMLLIElement).value)),
    ).toEqual(Array.from({ length: 500 }, (_, index) => index + 1));
    matchId = 'observer-match-2';
    await expect(computer.locator('.observer-log')).toHaveAttribute('data-match-id', matchId);
    await expect(list.locator('li')).toHaveCount(100);
    await expect(list.locator('li').first()).toHaveText('公开动作 401 <img src=x>');
  });
});

test('双码电脑页立即提供局域网，公网等待验证；公网手机 HTTP 更新、交接和中断保留原码', async ({
  browser,
}) => {
  await withLobby(
    browser,
    async ({ party, base, publicBase, page }) => {
      const computer = await page(true);
      await computer.goto(base + '/server');
      expect(await checkQr(computer)).toBe('http://192.168.1.100:3000/');
      await expect(computer.locator('#internet-qr')).toBeHidden();
      await expect(computer.locator('#entry-status')).toContainText('正在准备');
      const publicUrl = 'https://browser-party.trycloudflare.com/';
      party.setInternetEntry('ready', '跨网络可扫码', publicUrl);
      await expect(computer.locator('#internet-join-url')).toHaveValue(publicUrl);
      await checkQr(computer, undefined, 'internet-');
      await expect(computer.locator('#internet-network-address')).toBeHidden();
      const owner = await page();
      const code = await createRoom(owner, publicBase, '公网房主');
      const friend = await page();
      await joinRoom(friend, publicBase, code, '其他网络朋友');
      await friend.locator('#ready-button').click();
      await expect(owner.locator('#players')).toContainText('已准备');
      await friend.locator('#share-button').click();
      expect(await checkQr(friend, code)).toBe(new URL(`/join/${code}`, publicUrl).href);
      await expect(friend.locator('#save-qr')).toHaveAttribute('href', /\/api\/qr\.png/);
      await friend.locator('#close-share').click();
      await owner.locator('#leave-button').click();
      await expect(friend.locator('#my-role')).toHaveText('你是房主，也参加这一局');
      party.setInternetEntry('unavailable', '公网连接中断');
      expect(await checkQr(computer)).toBe('http://192.168.1.100:3000/');
      await expect(computer.locator('#internet-join-url')).toHaveValue(publicUrl);
      await checkQr(computer, undefined, 'internet-');
      await expect(computer.locator('#internet-qr-hint')).toContainText('原码保留');
      await friend.locator('#share-button').click();
      expect(await checkQr(friend, code)).toBe(new URL(`/join/${code}`, publicUrl).href);
      await expect(friend.locator('#qr-hint')).toContainText('原码保留');
      await friend.locator('#close-share').click();
      party.setInternetEntry('ready', '原入口恢复', publicUrl);
      await expect(computer.locator('#internet-join-url')).toHaveValue(publicUrl);
      await friend.reload();
      await expect(friend.locator('#my-role')).toHaveText('你是房主，也参加这一局');
      await expect(friend.locator('#ready-button')).toBeEnabled();
      const popup = await page();
      await popup.goto(`${publicBase}/join/${code}`);
      await friend.locator('#leave-button').click();
      await expect(popup.locator('#connection')).toHaveText('房间已关闭');
    },
    true,
  );
});

test('四个局域网成员与一个公网成员同桌，切断公网后局域网仍可入座、设置和准备，两码不重载', async ({
  browser,
}) => {
  await withLobby(
    browser,
    async ({ party, base, publicBase, gateway, page }) => {
      const publicUrl = 'https://mixed-party.trycloudflare.com/';
      party.setInternetEntry('ready', '跨网络可扫码', publicUrl);
      const computer = await page(true);
      let qrRequests = 0;
      computer.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/qr.svg') qrRequests++;
      });
      await computer.goto(base + '/server');
      const lanQr = await checkQr(computer);
      expect(await checkQr(computer, undefined, 'internet-')).toBe(publicUrl);
      const owner = await page();
      const code = await createRoom(owner, base, '局域网房主');
      const locals = [owner];
      for (let index = 1; index < 4; index++) {
        const local = await page();
        await joinRoom(local, base, code, `同 Wi-Fi ${index}`);
        locals.push(local);
      }
      const remote = await page();
      await joinRoom(remote, publicBase, code, '另一家 Wi-Fi');
      await expect(owner.locator('#player-counter')).toHaveText('5 / 5 席');
      expect((await owner.request.get(base + '/api/info').then((r) => r.json())).entry.access).toBe(
        'lan',
      );
      expect(
        (await remote.request.get(publicBase + '/api/info').then((r) => r.json())).entry.access,
      ).toBe('internet');
      party.setInternetEntry('unavailable', '跨网络入口暂时中断，局域网继续可用');
      gateway!.close();
      await expect(computer.locator('#entry-status')).toContainText('暂时中断');
      expect(await checkQr(computer)).toBe(lanQr);
      expect(await checkQr(computer, undefined, 'internet-')).toBe(publicUrl);
      await owner.getByLabel('武将范围').selectOption('advanced');
      await waitForSettings(owner);
      await expect(locals[1]!.locator('#summary-details')).toContainText('经典进阶96将');
      await locals.pop()!.getByRole('button', { name: '离开房间', exact: true }).click();
      const replacement = await page();
      await joinRoom(replacement, base, code, '断公网后入座');
      locals.push(replacement);
      for (const local of locals) await local.locator('#ready-button').click();
      await expect
        .poll(
          () =>
            party.lobby
              .get(code)
              .snapshot()
              .players.filter((player) => player.ready).length,
        )
        .toBe(4);
      await replacement.locator('#share-button').click();
      expect(new URL(await checkQr(replacement, code)).hostname).toBe('192.168.1.100');
      await replacement
        .locator('#network-address')
        .selectOption(new URL(`/join/${code}`, publicUrl).href);
      await expect(replacement.locator('#qr-hint')).toContainText('原码保留');
      for (let index = 0; index < 3; index++) await computer.locator('#refresh-address').click();
      expect(qrRequests, '控制台状态刷新不重复下载相同二维码').toBe(2);
      await mkdir('.runtime/previews', { recursive: true });
      await computer.screenshot({
        path: `.runtime/previews/hybrid-console-${Date.now()}.png`,
        fullPage: true,
      });
    },
    true,
  );
});

test('手机房主为 5/8 席补 AI、修改玩法裁掉多余 AI，真人准备与权限受约束', async ({ browser }) => {
  await withLobby(browser, async ({ party, base, page }) => {
    const owner = await page();
    const code = await createRoom(owner, base, '刘备');
    const friend = await page();
    await joinRoom(friend, base, code, '关羽');
    await owner.getByRole('button', { name: '用 AI 补满空位' }).click();
    await expect(owner.locator('#seat-count')).toHaveText('2 位真人 · 3 个 AI');
    await expect(owner.getByRole('button', { name: '添加 1 个 AI' })).toBeDisabled();
    for (const phone of [owner, friend])
      await phone.getByRole('button', { name: '我准备好了' }).click();
    const waiting = await page();
    await waiting.goto(`${base}/join/${code}`);
    await expect(waiting.getByRole('button', { name: '房间已满席', exact: true })).toBeDisabled();
    await owner.getByLabel('总席位（含 AI）').selectOption('8');
    await waitForSettings(owner);
    await expect(friend.getByRole('button', { name: '我准备好了' })).toBeVisible();
    await owner.getByRole('button', { name: '用 AI 补满空位' }).click();
    await expect(owner.locator('#seat-count')).toHaveText('2 位真人 · 6 个 AI');
    expect(
      party.lobby
        .get(code)
        .snapshot()
        .players.filter((seat) => seat.kind === 'bot')
        .every((seat) => seat.ready && seat.online),
    ).toBe(true);
    const rejected = await friend.request.post(`${base}/api/rooms/${code}/bots`, {
      data: { count: 1 },
    });
    expect(rejected.status()).toBe(403);
    await owner.getByRole('button', { name: /斗地主/ }).click();
    await waitForSettings(owner);
    await expect(owner.locator('#seat-count')).toHaveText('2 位真人 · 1 个 AI');
    await owner.getByRole('button', { name: '移除 AI 01', exact: true }).click();
    await expect(waiting.getByRole('button', { name: '入座', exact: true })).toBeEnabled();
    await waiting.getByLabel('怎么称呼你').fill('张飞');
    await waiting.getByRole('button', { name: '入座', exact: true }).click();
    await expect(owner.locator('#seat-count')).toHaveText('3 位真人 · 0 个 AI');
    await expect(owner.getByRole('button', { name: '开始对局' })).toBeDisabled();
    expect(await owner.getByLabel('AI 智力', { exact: true }).count()).toBe(0);
  });
});

test('房主离开由真人接任，两间房独立，空房关闭后旧邀请可返回主页', async ({ browser }) => {
  await withLobby(browser, async ({ party, base, page }) => {
    const owner = await page();
    const code = await createRoom(owner, base, '刘备');
    const friend = await page();
    await joinRoom(friend, base, code, '关羽');
    const other = await page();
    const otherCode = await createRoom(other, base, '曹操');
    const attempt = await other.request.post(`${base}/api/rooms/${code}/bots`, {
      data: { count: 1 },
    });
    expect(attempt.status()).toBe(403);
    await owner.getByRole('button', { name: '离开房间', exact: true }).click();
    await expect(owner.getByRole('button', { name: '创建房间并入座' })).toBeVisible();
    await expect(friend.locator('#my-role')).toHaveText('你是房主，也参加这一局');
    await friend.getByRole('button', { name: '添加 1 个 AI' }).click();
    await friend.reload();
    await expect(friend.locator('#my-role')).toHaveText('你是房主，也参加这一局');
    expect(party.lobby.get(otherCode).snapshot().players).toHaveLength(1);
    await friend.getByRole('button', { name: '离开房间', exact: true }).click();
    await expect(friend.getByRole('button', { name: '创建房间并入座' })).toBeVisible();
    expect(party.lobby.list()).toHaveLength(1);
    await owner.goto(`${base}/join/${code}`);
    await expect(owner.getByText('暂时没找到牌桌')).toBeVisible();
    await owner.getByRole('link', { name: '返回主页', exact: true }).click();
    await expect(owner.getByRole('button', { name: '创建房间并入座' })).toBeVisible();
  });
});

test('房主开放大厅点将，成员搜索和保留首候选，争抢、取消、刷新及换档可恢复', async ({
  browser,
}) => {
  await withLobby(browser, async ({ party, base, page }) => {
    const owner = await page();
    const code = await createRoom(owner, base, '点将房主');
    const member = await page();
    await joinRoom(member, base, code, '点将成员');
    await expect(owner.getByLabel('允许点将')).not.toBeChecked();
    await expect(owner.locator('#summary-selection')).toContainText('主公 5 名候选，其余每人 3 名');
    await expect(member.locator('#general-pick-panel')).toBeHidden();
    await owner.getByRole('button', { name: '用 AI 补满空位' }).click();
    for (const phone of [owner, member])
      await phone.getByRole('button', { name: '我准备好了' }).click();
    await owner.getByLabel('允许点将').check();
    await waitForSettings(owner);
    await expect(member.locator('#summary-selection')).toContainText('点将已开放');
    await expect(member.getByRole('button', { name: '我准备好了' })).toBeVisible();
    await expect(member.locator('#settings-panel')).toBeHidden();
    await owner.getByRole('button', { name: '点将 · 设置第1个候选' }).click();
    await expect(owner.getByLabel('武将档位')).toBeDisabled();
    await owner.getByLabel('查找武将或技能').fill('龙胆');
    await owner.locator('[data-general="zhaoyun"]').click();
    await expect(owner.locator('#general-pick-state')).toContainText('已点将：赵云');
    await owner.getByRole('button', { name: '关闭武将图鉴' }).click();
    await member.getByRole('button', { name: '点将 · 设置第1个候选' }).click();
    await member.getByLabel('查找武将或技能').fill('赵云');
    await expect(member.locator('[data-general="zhaoyun"]')).toBeDisabled();
    const stale = await member.request.put(`${base}/api/rooms/${code}/me/general`, {
      data: { general: 'zhaoyun' },
    });
    expect(stale.status()).toBe(409);
    await owner.reload();
    await expect(owner.locator('#general-pick-state')).toContainText('已点将：赵云');
    await owner.locator('#general-pick').click();
    await owner.getByRole('button', { name: '取消点将，使用随机候选' }).click();
    await expect(member.locator('[data-general="zhaoyun"]')).toBeEnabled();
    await member.locator('[data-general="zhaoyun"]').click();
    await expect(member.locator('#guide-selection-status')).toContainText('已点将：赵云');
    await owner.getByRole('button', { name: '关闭武将图鉴' }).click();
    await owner.locator('#room-settings-link').click();
    await owner.getByLabel('武将范围').selectOption('advanced');
    await waitForSettings(owner);
    await expect(member.locator('#general-pick-state')).toContainText('未点将');
    await expect(member.getByLabel('武将档位')).toHaveValue('advanced');
    await expect(member.locator('#summary-selection')).toContainText(
      '主公 10 名候选，其余每人 6 名',
    );
    await member.getByLabel('查找武将或技能').fill('曹昂');
    await member.locator('[data-general="caoang"]').click();
    await expect(member.locator('#general-pick-state')).toContainText('已点将：曹昂');
    expect(
      await member.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await member.screenshot({
      path: `.runtime/previews/lobby-general-selection-${Date.now()}.png`,
    });
    expect(JSON.stringify(party.lobby.get(code).snapshot())).not.toContain('caoang');
    await owner.getByLabel('允许点将').uncheck();
    await waitForSettings(owner);
    await expect(member.locator('#general-guide-dialog')).toBeHidden();
    await expect(member.locator('#general-pick-panel')).toBeHidden();
    await owner.getByLabel('允许点将').check();
    await waitForSettings(owner);
    await expect(member.locator('#general-pick-state')).toContainText('未点将');
    await owner.getByRole('button', { name: /2v2/ }).click();
    await waitForSettings(owner);
    await expect(member.locator('#summary-rules')).toContainText('每队共享 10 名候选');
    await expect(owner.locator('#general-selection-description')).toContainText('队友也可选择');
    await member.locator('#general-pick').click();
    await expect(member.locator('#guide-title + p')).toContainText('本队共享的 10 将池');
    await member.getByRole('button', { name: '关闭武将图鉴' }).click();
  });
});

test('局外图鉴可查看两档技能、筛选和搜索，保持成员在线与房主设置', async ({ browser }) => {
  await withLobby(browser, async ({ party, base, page }) => {
    const phone = await page();
    await phone.goto(base + '/');
    const catalogRequests: string[] = [];
    phone.on('request', (request) => {
      if (/\/assets\/generals.*\.json$/.test(request.url()))
        catalogRequests.push(new URL(request.url()).pathname);
    });
    await phone.getByRole('button', { name: '武将图鉴 · 查看技能' }).click();
    await expect(phone.locator('#guide-count')).toHaveText('显示 27 / 27 位武将');
    expect(catalogRequests).toEqual(['/assets/generals-beginner.json']);
    await expect(phone.locator('#guide-preset option')).toHaveText(
      GENERAL_PRESETS.map((entry) => entry.name),
    );
    await phone.getByLabel('查找武将或技能').fill('龙胆');
    await expect(phone.locator('.guide-entry')).toHaveCount(1);
    await phone.locator('.guide-entry summary').click();
    await expect(phone.locator('.guide-entry dd')).toContainText('将【杀】当做【闪】');
    await phone.getByRole('button', { name: '关闭武将图鉴' }).click();
    const code = await createRoom(phone, base, '图鉴房主');
    await phone.getByLabel('武将范围').selectOption('advanced');
    await waitForSettings(phone);
    const member = await page();
    await joinRoom(member, base, code, '学技能');
    await member.getByRole('button', { name: '武将图鉴 · 查看技能' }).click();
    await expect(member.locator('#guide-count')).toHaveText('显示 96 / 96 位武将');
    await member.getByLabel('势力', { exact: true }).selectOption('shu');
    await expect(member.locator('#guide-count')).toHaveText('显示 27 / 96 位武将');
    await member.getByLabel('查找武将或技能').fill('不存在的武将');
    await expect(member.locator('#guide-count')).toContainText('没有找到');
    expect(
      party.lobby
        .get(code)
        .snapshot()
        .players.every((player) => player.online),
    ).toBe(true);
    expect(party.lobby.get(code).snapshot().settings.generalPreset).toBe('advanced');
    await member.screenshot({ path: `.runtime/previews/general-guide-search-${Date.now()}.png` });
    await member.getByLabel('查找武将或技能').fill('界徐庶');
    await member.locator('.guide-entry summary').click();
    await expect(member.locator('.guide-entry dl')).toContainText('荐言（关联技能）');
    await member.screenshot({ path: `.runtime/previews/general-guide-${Date.now()}.png` });
    await member.getByRole('button', { name: '关闭武将图鉴' }).click();
    await expect(member.getByRole('button', { name: '我准备好了' })).toBeEnabled();
  });
});
