import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createPartyServer } from '../apps/server/src/server.ts';
import { NativeNonameService } from '../packages/noname-adapter/src/service.ts';
import { chooseGeneral, playOneAction } from './native-ui-actions.mjs';

// Always owns an isolated server and browser. Never points at a running game.
const root = fileURLToPath(new URL('../', import.meta.url));
const engine = new NativeNonameService(root);
const party = createPartyServer({ webRoot: `${root}/dist/web`, port: 0, adapter: engine });
await new Promise((resolve) => party.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${party.server.address().port}`;
const output = `${root}/.runtime/native-animation-speed/${new Date().toISOString().replaceAll(':', '-')}`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: process.env.E2E_BROWSER_CHANNEL ?? 'msedge',
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const errors = [],
  missing = new Set(),
  contexts = [],
  timings = [];
async function page(mobile) {
  const context = await browser.newContext(
    mobile
      ? { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true }
      : { viewport: { width: 1366, height: 900 } },
  );
  contexts.push(context);
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) missing.add(new URL(response.url()).pathname);
  });
  return page;
}
async function request(page, path, method, body) {
  const response = await page.request.fetch(base + path, { method, data: body });
  assert.equal(response.ok(), true, `${method} ${path}: ${response.status()}`);
  return response.json();
}
async function table(page) {
  await page.waitForFunction(
    () => document.querySelector('#game-frame')?.contentWindow?.partyEngine?.proof.booted,
    {},
    { timeout: 120000 },
  );
  return page.frames().find((frame) => frame.url().includes('/engine/player/'));
}
async function speedEverywhere(frames, value) {
  await Promise.all(
    frames.map((frame) =>
      frame.waitForFunction((value) => partyEngine.animationSpeed?.value === value, value, {
        timeout: 15000,
      }),
    ),
  );
}
async function deadlines(worker) {
  return worker.evaluate(() =>
    Object.fromEntries(
      Object.entries(partyEngine.lib.node.torespondtimeout).filter(([id]) =>
        partyEngine.setup.seats.some((seat) => seat.id === id && seat.kind === 'human'),
      ),
    ),
  );
}
try {
  const computer = await page(false),
    owner = await page(true),
    member = await page(true);
  await computer.goto(base + '/server');
  await owner.goto(base);
  const created = await request(owner, '/api/rooms', 'POST', { nickname: '动画速度验证' });
  const code = created.room.code;
  assert.equal(created.room.settings.animationSpeed, 2);
  await request(owner, `/api/rooms/${code}`, 'PUT', {
    mode: 'doudizhu',
    playerCount: 3,
    generalPreset: 'beginner',
    extensions: [],
  });
  await owner.goto(`${base}/join/${code}`);
  await member.goto(`${base}/join/${code}`);
  await member.locator('#nickname').fill('另一位玩家');
  await member.locator('#join-button').tap();
  await owner.locator('#add-bot').tap();
  for (const phone of [owner, member]) {
    await phone.waitForFunction(() => !document.querySelector('#ready-button').disabled);
    await phone.locator('#ready-button').tap();
  }
  const readyPlayers = party.lobby
    .get(code)
    .snapshot()
    .players.filter((player) => player.ready)
    .map((player) => player.id);
  await owner.locator('#room-animation-speed').selectOption('3');
  await owner.waitForFunction(
    () =>
      document.querySelector('#room-animation-speed')?.value === '3' &&
      !document.querySelector('#room-animation-speed').disabled,
  );
  assert.equal(party.lobby.get(code).snapshot().settings.animationSpeed, 3);
  assert.deepEqual(
    party.lobby
      .get(code)
      .snapshot()
      .players.filter((player) => player.ready)
      .map((player) => player.id),
    readyPlayers,
  );
  await owner.locator('#room-animation-speed').selectOption('2');
  await owner.waitForFunction(
    () =>
      document.querySelector('#room-animation-speed')?.value === '2' &&
      !document.querySelector('#room-animation-speed').disabled,
  );
  await owner.screenshot({ path: `${output}/waiting-owner.png`, fullPage: true });
  await owner.waitForFunction(() => !document.querySelector('#start-button').disabled);
  await owner.locator('#start-button').tap();
  let frames = await Promise.all([owner, member].map(table));
  const matchId = party.lobby.get(code).snapshot().matchId;
  await computer.waitForFunction(
    (id) =>
      [...document.querySelectorAll('.engine-worker')].some(
        (frame) =>
          frame.src.endsWith('/engine/worker/' + id) &&
          frame.contentWindow?.partyEngine?.proof.booted,
      ),
    matchId,
    { timeout: 120000 },
  );
  const worker = computer
    .frames()
    .find((frame) => frame.url().endsWith(`/engine/worker/${matchId}`));
  await Promise.all(
    frames.map((frame) =>
      frame.waitForFunction(
        () => partyEngine._status.event?.name === 'chooseButton' && partyEngine._status.paused,
      ),
    ),
  );
  await speedEverywhere([worker, ...frames], 2);
  assert.equal(await owner.locator('#match-animation-speed').count(), 0);
  assert.equal(await owner.locator('#room-speed-control').isVisible(), false);
  const staleHost = await owner.request.put(`${base}/api/rooms/${code}/animation-speed`, {
    data: { animationSpeed: 10 },
    headers: { 'X-Party-Player': created.room.ownerId },
  });
  assert.equal(staleHost.status(), 409);
  assert.match((await staleHost.json()).error.message, /等待大厅/);
  assert.equal(party.lobby.get(code).snapshot().settings.animationSpeed, 2);
  const originalDeadlines = await deadlines(worker);
  assert.equal(Object.keys(originalDeadlines).length, 2);
  for (const speed of [1, 2, 10]) {
    await computer.locator('#console-animation-speed').selectOption(String(speed));
    await speedEverywhere([worker, ...frames], speed);
    assert.deepEqual(
      await deadlines(worker),
      originalDeadlines,
      'speed cannot renew or shorten choices',
    );
    const waitMs = await worker.evaluate(async () => {
      const began = performance.now();
      await partyEngine.game.delay(0, 600);
      return performance.now() - began;
    });
    const visual = await frames[0].evaluate(async () => {
      const node = document.createElement('div');
      node.style.cssText =
        'position:absolute;width:20px;height:20px;transition:transform 600ms linear';
      partyEngine.ui.arena.append(node);
      node.getBoundingClientRect();
      const began = performance.now();
      node.style.transform = 'translateX(100px)';
      node.getBoundingClientRect();
      await Promise.resolve();
      const animation = node.getAnimations()[0];
      if (!animation) throw new Error('CSS transition did not start');
      const playbackRate = animation.playbackRate;
      await animation.finished;
      const elapsedMs = performance.now() - began;
      node.remove();
      return { playbackRate, elapsedMs };
    });
    const nativeMove = await frames[0].evaluate(async () => {
      const stage = document.createElement('div');
      stage.style.cssText = 'position:absolute;left:0;top:0;width:300px;height:30px';
      const from = document.createElement('div'),
        to = document.createElement('div'),
        node = document.createElement('div');
      from.style.cssText = 'position:absolute;left:0;width:30px;height:30px;overflow:visible';
      to.style.cssText = 'position:absolute;left:200px;width:30px;height:30px;overflow:visible';
      node.style.cssText = 'width:20px;height:20px';
      from.append(node);
      stage.append(from, to);
      partyEngine.ui.arena.append(stage);
      const began = performance.now();
      const finished = partyEngine.game.$elementGoto(node, to, 'last', 600);
      let animation;
      while (!(animation = partyEngine.game.$elementGotoAnimData.invertingAnimations.get(node)))
        await new Promise(requestAnimationFrame);
      const playbackRate = animation.playbackRate;
      await finished;
      const elapsedMs = performance.now() - began;
      const released = !partyEngine.game.$elementGotoAnimData.animationResolver.has(node);
      stage.remove();
      return { playbackRate, elapsedMs, released };
    });
    assert.equal(visual.playbackRate, speed);
    assert.equal(nativeMove.playbackRate, speed);
    assert.equal(nativeMove.released, true, 'native move unlocks at animation completion');
    assert(Math.abs(waitMs - 600 / speed) < 180, `native wait ${waitMs}ms at ${speed}x`);
    assert(
      Math.abs(visual.elapsedMs - 600 / speed) < 180,
      `CSS ${visual.elapsedMs}ms at ${speed}x`,
    );
    assert(
      Math.abs(nativeMove.elapsedMs - 600 / speed) < 180,
      `native move ${nativeMove.elapsedMs}ms at ${speed}x`,
    );
    timings.push({ speed, waitMs, ...visual, nativeMove });
  }
  assert(timings[0].waitMs > timings[1].waitMs * 1.5);
  assert(timings[0].waitMs > timings[2].waitMs * 5);
  const countdownRate = await frames[0].evaluate(async () => {
    const timer = document.createElement('div');
    timer.className = 'timerbar';
    const bar = document.createElement('div');
    bar.style.cssText = 'width:100px;height:5px;transition:transform 60s linear';
    timer.append(bar);
    partyEngine.ui.arena.append(timer);
    bar.getBoundingClientRect();
    bar.style.transform = 'scaleX(0)';
    bar.getBoundingClientRect();
    await Promise.resolve();
    const rate = bar.getAnimations()[0]?.playbackRate;
    timer.remove();
    return rate;
  });
  assert.equal(countdownRate, 1);
  await owner.reload();
  frames[0] = await table(owner);
  await speedEverywhere([worker, ...frames], 10);
  assert.deepEqual(
    await deadlines(worker),
    originalDeadlines,
    'refresh retains the original choice deadline',
  );
  await Promise.all(frames.map((frame) => chooseGeneral(frame, worker)));
  await worker.waitForFunction(() => partyEngine.proof.started, {}, { timeout: 120000 });
  await Promise.all(
    frames.map((frame) => frame.waitForFunction(() => partyEngine.game.me?.countCards('h') > 0)),
  );
  await playOneAction(frames, worker);
  await computer.waitForFunction(
    () => document.querySelector('#console-animation-speed')?.value === '10',
  );
  await computer.locator('#console-animation-speed').selectOption('3');
  await speedEverywhere([worker, ...frames], 3);
  assert.equal(party.lobby.get(code).snapshot().matchId, matchId);
  assert.equal(party.lobby.get(code).snapshot().phase, 'playing');
  await computer.locator('#console-animation-speed').selectOption('2');
  await speedEverywhere([worker, ...frames], 2);
  for (const theme of ['camp', 'ink']) {
    const frameBefore = owner.frames().find((frame) => frame.url().includes('/engine/player/'));
    await owner.locator('#match-more').tap();
    await owner.locator('#match-theme').selectOption(theme);
    assert.equal(
      owner.frames().find((frame) => frame.url().includes('/engine/player/')),
      frameBefore,
    );
    await owner.screenshot({ path: `${output}/table-${theme}-more.png` });
    await owner.locator('#match-theme').press('Escape');
    await owner.locator('#match-sound-menu').tap();
    assert.equal(await owner.locator('#match-volume').isVisible(), true);
    await owner.screenshot({ path: `${output}/table-${theme}-sound.png` });
    await owner.locator('#match-volume').press('Escape');
    await owner.screenshot({ path: `${output}/table-${theme}.png` });
  }
  const proofErrors = await Promise.all(
    [worker, ...frames].map((frame) => frame.evaluate(() => partyEngine.proof.errors)),
  );
  assert.deepEqual(proofErrors, [[], [], []]);
  assert.deepEqual(errors, []);
  assert.deepEqual([...missing], []);
  await owner.screenshot({ path: `${output}/owner.png` });
  await computer.screenshot({ path: `${output}/console.png`, fullPage: true });
  const result = {
    passed: true,
    defaultSpeed: 2,
    timings,
    countdownRate,
    realGeneralSelection: true,
    realDeal: true,
    realHumanAction: true,
    ownerWaitingOnly: true,
    liveOperator: true,
    refreshRetainsSpeedAndDeadline: true,
    errors,
    proofErrors,
    missing: [...missing],
    desktopTouchSimulation: true,
    physicalPhone: false,
  };
  await writeFile(`${output}/result.json`, JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ output, ...result }));
} catch (error) {
  await writeFile(
    `${output}/failure.json`,
    JSON.stringify(
      { error: String(error.stack ?? error), errors, missing: [...missing], timings },
      null,
      2,
    ),
    { flag: 'wx' },
  );
  throw error;
} finally {
  for (const { code } of party.lobby.list()) party.lobby.get(code).consoleClose();
  for (const context of contexts) await context.close();
  await browser.close();
  party.stop();
  party.server.closeAllConnections();
}
