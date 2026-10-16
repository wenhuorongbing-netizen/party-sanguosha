import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { RoomStore } from '../apps/server/src/room.js';
import { createPartyServer } from '../apps/server/src/server.js';
import type { EngineAdapter, MatchSetup } from '../packages/noname-adapter/src/index.js';

test('动画默认2倍、范围1至10；房主仅在等待厅调整，管理员可在局中调整', async () => {
  let started!: MatchSetup;
  let confirm!: () => void;
  const updates: unknown[] = [];
  const engine: EngineAdapter = {
    status: () => ({ id: 'noname', ready: true, message: 'speed fixture' }),
    start: (setup) => {
      started = setup;
      return new Promise<void>((resolve) => {
        confirm = resolve;
      });
    },
    setAnimationSpeed: (code, speed) => {
      updates.push([code, speed]);
    },
  };
  const room = new RoomStore(engine);
  const owner = room.join('房主');
  const member = room.join('朋友');
  room.connect(owner.token);
  room.connect(member.token);
  room.addBots(3, owner.token);
  room.setReady(owner.token, true);
  room.setReady(member.token, true);
  assert.equal(room.snapshot().settings.animationSpeed, 2);
  const before = room.snapshot();
  for (const invalid of [0, 11, -1, 1.5, '2', null, NaN, Infinity])
    assert.throws(() => room.setAnimationSpeed(invalid, owner.token), /1–10/);
  assert.throws(() => room.setAnimationSpeed(10, member.token), /房主/);
  assert.equal(room.snapshot().revision, before.revision);
  room.setAnimationSpeed(5, owner.token);
  assert.deepEqual(room.snapshot().players, before.players);
  const starting = room.start(owner.token);
  assert.equal(started.settings.animationSpeed, 5);
  const lockedRevision = room.snapshot().revision;
  assert.throws(() => room.setAnimationSpeed(10, owner.token), /等待大厅/);
  assert.equal(room.snapshot().revision, lockedRevision);
  room.consoleSetAnimationSpeed(10);
  assert.equal(room.snapshot().phase, 'starting');
  assert.deepEqual(updates.at(-1), [room.code, 10]);
  confirm();
  await starting;
  assert.throws(() => room.setAnimationSpeed(1, owner.token), /等待大厅/);
  assert.equal(room.snapshot().settings.animationSpeed, 10);
  room.consoleSetAnimationSpeed(1);
  assert.equal(room.snapshot().phase, 'playing');
  assert.deepEqual(room.snapshot().players, before.players);
  room.consoleReset();
  room.updateSettings(
    { mode: 'duel', playerCount: 2, generalPreset: 'beginner', extensions: [] },
    owner.token,
  );
  assert.equal(room.snapshot().settings.animationSpeed, 1, 'unrelated settings cannot reset speed');
  room.setAnimationSpeed(2, owner.token);
  assert.equal(room.snapshot().settings.animationSpeed, 2);
  room.consoleClose();
  assert.throws(() => room.consoleSetAnimationSpeed(2), /关闭/);
});

test('动画接口：房主与独立本机管理员可调整；成员、公网、旧管理请求及另一桌隔离', async (t) => {
  const party = createPartyServer({
    port: 0,
    webRoot: fileURLToPath(new URL('../apps/web', import.meta.url)),
  });
  party.server.listen(0, '127.0.0.1');
  await once(party.server, 'listening');
  const address = party.server.address();
  assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(() => {
    party.stop();
    party.server.closeAllConnections();
  });
  const owner = party.lobby.create('房主');
  const member = party.lobby.join(owner.room.code, '朋友');
  const other = party.lobby.create('另一桌');
  const operator = await fetch(base + '/server');
  const consoleCookie = operator.headers.get('set-cookie')!.split(';')[0]!;
  const endpoint = `/api/rooms/${owner.room.code}/animation-speed`;
  const update = (path: string, cookie: string, animationSpeed: unknown, headers = {}) =>
    fetch(base + path, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ animationSpeed }),
    });
  assert.equal((await update(endpoint, `party_player=${member.token}`, 10)).status, 403);
  assert.equal((await update(endpoint, consoleCookie, 10)).status, 403);
  assert.equal((await update(endpoint, `party_player=${owner.token}`, 11)).status, 400);
  assert.equal((await update(endpoint, `party_player=${owner.token}`, 10)).status, 200);
  const management = `/api/console/rooms/${owner.room.code}/animation-speed`;
  const revision = () => ({ 'X-Party-Revision': String(owner.room.snapshot().revision) });
  assert.equal(
    (await update(management, `party_player=${owner.token}`, 1, revision())).status,
    403,
  );
  assert.equal(
    (await update(management, consoleCookie, 1, { ...revision(), 'X-Party-Ingress': 'public' }))
      .status,
    403,
  );
  assert.equal(
    (await update(management, consoleCookie, 1, { 'X-Party-Revision': '0' })).status,
    409,
  );
  assert.equal((await update(management, consoleCookie, 0, revision())).status, 400);
  assert.equal((await update(management, consoleCookie, 1, revision())).status, 200);
  assert.equal(owner.room.snapshot().settings.animationSpeed, 1);
  assert.equal(other.room.snapshot().settings.animationSpeed, 2);
  assert.equal(owner.room.snapshot().ownerId, owner.playerId);
});

test('原生等待、CSS和移牌动画只缩放一次，操作倒计时及全局计时器保持', async (t) => {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const callbacks: Record<string, (event?: any) => void> = {};
  let mutation!: () => void;
  const delayCalls: number[] = [];
  const nativeTimer = globalThis.setTimeout;
  class Animation {
    playbackRate = 1;
    effect: any;
    constructor(timer = false, iterations = 1, emotion = false) {
      this.effect = {
        target: {
          closest: (selector: string) =>
            timer || (emotion && selector.includes('.party-emotion')) ? {} : null,
        },
        getTiming: () => ({ iterations }),
      };
    }
  }
  class CSSAnimation extends Animation {}
  const card = new CSSAnimation(),
    countdown = new CSSAnimation(true),
    pulse = new CSSAnimation(false, Infinity),
    movingCard = new Animation(),
    emotion = new Animation(false, 1, true);
  const animations = [card, countdown, pulse, movingCard, emotion];
  class Element {
    animation = new Animation();
    animate(..._args: any[]) {
      return this.animation;
    }
  }
  const game: any = {
    delay(time = 1, offset = 0) {
      const ms = time * 1000 + offset;
      delayCalls.push(ms);
      return ms;
    },
    delayx(time = 1, offset = 0) {
      return this.delay(time * 1.5, offset);
    },
  };
  const setup: { id: string; settings: { animationSpeed?: number } } = {
    id: 'match-speed',
    settings: {},
  };
  const engine: any = { setup, proof: {} };
  const parentWindow = {};
  const doc = { getAnimations: () => animations, addEventListener() {}, documentElement: {} };
  const values = {
    nativeFixture: { game, lib: { config: { duration: 1000, game_speed: 'slow' } } },
    partyEngine: engine,
    document: doc,
    CSSAnimation,
    CSSTransition: CSSAnimation,
    Element,
    location: { origin: 'http://party.test' },
    parent: { postMessage() {} },
    window: {
      parent: parentWindow,
      addEventListener: (name: string, callback: any) => {
        callbacks[name] = callback;
      },
    },
    MutationObserver: class {
      constructor(callback: () => void) {
        mutation = callback;
      }
      observe() {}
      disconnect() {}
    },
  };
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  t.after(() => {
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  });
  const source = (
    await readFile(
      new URL('../packages/noname-adapter/runtime/animation-speed.js', import.meta.url),
      'utf8',
    )
  ).replace(/import \{([^}]+)\} from 'noname';/, 'const {$1} = globalThis.nativeFixture;');
  const runtime = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  );
  runtime.installAnimationSpeed();
  assert.equal(engine.animationSpeed.value, 2);
  for (let speed = 1; speed <= 10; speed++) {
    engine.animationSpeed.set(speed);
    assert(Math.abs(game.delay(1, 100) - 1100 / speed) < 0.000001);
    assert(Math.abs(game.delayx(1, 100) - 1600 / speed) < 0.000001);
    mutation();
    assert.equal(card.playbackRate, speed);
    assert.equal(movingCard.playbackRate, speed);
    const node = new Element();
    assert.equal(node.animate([], { duration: 300 }), node.animation);
    assert.equal(node.animation.playbackRate, speed, 'new native WAAPI requires no DOM mutation');
    assert.equal(countdown.playbackRate, 1);
    assert.equal(pulse.playbackRate, 1);
    assert.equal(emotion.playbackRate, 1, 'emotions already scale their duration');
  }
  const packet = {
    origin: 'http://party.test',
    source: parentWindow,
    data: { type: 'party-animation-speed', matchId: setup.id, animationSpeed: 3 },
  };
  callbacks.message!({ ...packet, origin: 'http://attacker.invalid' });
  callbacks.message!({ ...packet, source: {} });
  callbacks.message!({ ...packet, data: { ...packet.data, matchId: 'other-match' } });
  callbacks.message!({ ...packet, data: { ...packet.data, animationSpeed: 11 } });
  assert.equal(engine.animationSpeed.value, 10);
  callbacks.message!(packet);
  assert.equal(engine.animationSpeed.value, 3);
  assert.equal(setup.settings.animationSpeed, 3);
  assert.equal(engine.proof.animationSpeed, 3);
  assert.equal(globalThis.setTimeout, nativeTimer);
  assert.equal(delayCalls.length, 20);
});
