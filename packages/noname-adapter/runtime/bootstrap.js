// SPDX-License-Identifier: GPL-3.0-only

const [, , role, id] = location.pathname.split('/');
const proof = { booted: false, started: false, ended: false, errors: [], loading: [] };
const loading = document.querySelector('#engine-loading');
const status = document.querySelector('#loading-status');
const detail = document.querySelector('#loading-detail');
const retry = document.querySelector('#loading-retry');
const beganAt = performance.now();
let failed = false;
let stageNumber = 0;
let stageMessage = '正在准备对局…';
let resourceCount = 0;
let resourceBytes = 0;
const stages = ['setup', 'modules', 'filesystem', 'boot', 'packs', 'ready'];
function publishProgress() {
  const seconds = Math.floor((performance.now() - beganAt) / 1000);
  const count = `第 ${stageNumber} / 6 步 · 已载入 ${resourceCount} 项资源 · ${(resourceBytes / 1024 / 1024).toFixed(1)} MB · ${seconds} 秒`;
  document.querySelector('#loading-count').textContent = count;
  document.querySelector('#loading-progress').value = stageNumber;
  if (role === 'player')
    parent.postMessage(
      {
        type: 'party-loading',
        matchId: id,
        step: stageNumber,
        message: stageMessage,
        detail: count,
        failed,
      },
      location.origin,
    );
}
const resourceObserver = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    resourceCount++;
    resourceBytes += entry.encodedBodySize || entry.decodedBodySize || 0;
  }
  if (!proof.booted) publishProgress();
});
resourceObserver.observe({ type: 'resource', buffered: true });
const progressTimer = setInterval(publishProgress, 1000);
function progress(stage, message) {
  proof.loading.push({ stage, elapsedMs: Math.round(performance.now() - beganAt) });
  if (!failed) {
    status.textContent = stageMessage = message;
    stageNumber = stages.indexOf(stage) + 1;
    publishProgress();
  }
}
const fail = (error) => {
  if (proof.errors.length < 10) proof.errors.push(String(error?.stack ?? error));
  if (failed) return;
  failed = true;
  if ((role === 'player' || role === 'view') && proof.booted) {
    // A runtime error must restore this client's authoritative snapshot rather
    // than leave a frozen table while the rule worker continues the match.
    parent.postMessage(
      { type: role === 'view' ? 'party-view-failed' : 'party-disconnected', matchId: id },
      location.origin,
    );
    globalThis.partyEngine.game.ws?.close(4000, '正在恢复牌桌');
    return;
  }
  clearTimeout(deadline);
  loading.hidden = false;
  loading.dataset.state = 'failed';
  status.textContent = '对局未能载入';
  detail.textContent = `${error?.message ?? String(error)}\n重试会保留房间和座位。`;
  retry.hidden = false;
  clearInterval(progressTimer);
  resourceObserver.disconnect();
  publishProgress();
  globalThis.partyEngine?.signal?.('failed');
};
retry.addEventListener('click', () => location.reload());
// LAN startup includes module download, parsing and IndexedDB. Never clear a
// player's storage or reload automatically because a phone exceeded ten seconds.
const deadline = setTimeout(
  () => fail(new Error('载入超过两分钟，请检查 Wi-Fi 和电脑服务页后重试。')),
  120000,
);
window.addEventListener(
  'pagehide',
  () => {
    clearTimeout(deadline);
    clearInterval(progressTimer);
    resourceObserver.disconnect();
  },
  { once: true },
);
function handleError(event, error) {
  if ((role === 'player' || role === 'view') && proof.booted) {
    // The upstream reporter opens a blocking alert. Let the outer page restore
    // this client while retaining diagnostics in its private proof object.
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  fail(error);
}
window.addEventListener('error', (event) => handleError(event, event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => handleError(event, event.reason));

try {
  progress('setup', '正在读取房间设置…');
  const response = await fetch(
    `/engine/setup/${id}?role=${role}${role === 'view' ? `&seat=${encodeURIComponent(new URLSearchParams(location.search).get('seat') ?? '')}` : ''}`,
  );
  if (!response.ok) throw new Error('你的对局座位已失效，请返回房间。');
  const setup = await response.json();
  if (role === 'worker' && setup.serverVersion && parent !== window) {
    const pageVersion = parent.document
      .querySelector('footer')
      ?.textContent?.match(/聚会三国杀 v([\d.]+)/)?.[1];
    const active = [...parent.document.querySelectorAll('.engine-worker')].some((frame) => {
      const state = frame.contentWindow?.partyEngine?.proof;
      return state?.started && !state.ended;
    });
    const serverVersion = setup.serverVersion.split('.').map(Number);
    const browserVersion = (pageVersion ?? '').split('.').map(Number);
    const difference = serverVersion.findIndex((part, index) => part !== browserVersion[index]);
    const pageIsOlder =
      pageVersion && difference >= 0 && browserVersion[difference] < serverVersion[difference];
    if (pageIsOlder && !active) {
      // A service restart can leave its old supervisor tab alive. Refresh it
      // before connecting a rule worker, so the new LAN receiver is installed.
      // Newer web assets can also be served by an older running Node instance;
      // reloading those backwards would loop and prevent preserved rooms starting.
      clearTimeout(deadline);
      clearInterval(progressTimer);
      resourceObserver.disconnect();
      parent.location.reload();
      await new Promise(() => {});
    }
  }
  globalThis.partyAssetBase = setup.assetBase ?? '/engine/core/';
  if (role === 'worker' && setup.ruleClock) {
    // Install before the engine/sandbox capture timer functions. Phone timers
    // stay native, and older running services keep their existing protocol.
    const { connectRuleClock } = await import('./rule-clock.js');
    const clock = await connectRuleClock(id, setup.ruleRecovery === true);
    proof.ruleClock = clock.proof;
    clock.socket.addEventListener('close', () => fail(new Error('电脑规则计时连接已中断')));
  }
  progress('modules', '正在载入游戏引擎，首次进入可能需要稍等…');
  // Dynamic imports keep the initial status and retry UI alive even when the
  // module graph fails to download or the browser lacks required features.
  const engine = await import('noname');
  const { lib, game, get, ui, ai, _status } = engine;
  // Keep already running older services usable until the next full stop/start.
  const { browserReady, boot, device, loadBuildInfo } = engine.browserReady
    ? engine
    : await Promise.all([
        import('/engine/core/noname/init/browser.js'),
        import('/engine/core/noname/init/index.js'),
        import('/engine/core/noname/util/index.js'),
        import('/engine/core/noname/util/meta.js'),
      ]).then(([browser, init, util, meta]) => ({
        browserReady: browser.default,
        boot: init.boot,
        device: util.device,
        loadBuildInfo: meta.loadBuildInfo,
      }));
  globalThis.partyEngine = { lib, game, get, ui, ai, _status, setup, proof };
  const [{ installPrivacy }, { installControls }, { installAudio }, { installPrompts }] =
    await Promise.all([
      import('./privacy.js'),
      import('./controls.js'),
      setup.audioFiles ? import('./audio.js') : Promise.resolve({ installAudio: () => {} }),
      setup.choicePrompts ? import('./prompts.js') : Promise.resolve({ installPrompts: () => {} }),
    ]);
  if (failed) throw new Error('载入已中断，请重试。');
  lib.assetURL = setup.assetBase ?? '/engine/core/';
  lib.device = device;
  // Computer mirrors share one browser origin. Native connect writes mode and
  // preferences to storage, so each executor/view needs its own namespace.
  lib.configprefix = `party_match_${id}_${role}${role === 'view' ? `_${setup.playerId}` : ''}_`;
  localStorage.setItem(`${lib.configprefix}directstart`, 'true');
  localStorage.setItem(`${lib.configprefix}loadtime`, '120000');
  lib.init.reset = () => fail(new Error('引擎载入超时，请检查 Wi-Fi 和电脑服务页后重试。'));
  const config = setup.config;
  const legacyPacks = [
    ...new Set([
      ...setup.preset.completePacks,
      ...Object.keys(setup.preset.packGroups),
      ...(setup.preset.additionalCharacters.length ? ['extra'] : []),
    ]),
  ];
  const packs = setup.rosterPolicy ? (setup.preset.enabledPacks ?? legacyPacks) : legacyPacks;
  const mode = setup.settings.mode === 'duel' ? 'single' : setup.settings.mode;
  const definitions = setup.preset.definitionPacks ?? { characters: packs, cards: ['standard'] };
  // Old running services retain standard108 and cannot serve this module.
  const cardPacks = setup.cardPilePolicy
    ? (await import('./card-pile.js')).validateCardPile(setup.preset).packs
    : ['standard'];
  Object.assign(config, {
    mode,
    characters: packs,
    cards: cardPacks,
    extensions: [],
    extension_auto_import: false,
    plays: [],
    show_splash: 'off',
    totouched: true,
    // Native cards/buttons bind only one input event. A desktop mouse must
    // receive click handlers; phone/tablet touch keeps the original gestures.
    touchscreen: navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches,
    phonelayout: true,
    compatible: false,
    background_music: 'music_off',
    background_audio: role !== 'worker',
    background_speak: role !== 'worker',
    volumn_audio: 6,
    animation: role === 'player' && !setup.tableView,
    low_performance: role !== 'player' || Boolean(setup.tableView),
    game_speed: 'slow',
    duration: setup.settings.generalPreset === 'beginner' ? 1000 : 500,
    sync_speed: true,
    swipe: false,
    swipe_up: 'off',
    swipe_down: 'off',
    swipe_left: 'off',
    swipe_right: 'off',
    show_disclaimer: false,
    new_tutorial: true,
    video: '0',
    card_style: 'default',
    hp_style: 'default',
    name_font: 'default',
    identity_font: 'default',
    cardtext_font: 'default',
    global_font: 'default',
    card_font: 'default',
    version: '1.11.6',
    auto_confirm: false,
    wuxie_self: false,
    glow_phase: 'yellow',
    identity_mode: 'normal',
    doudizhu_mode: 'normal',
    versus_mode: '2v2',
    single_mode: 'dianjiang',
    show_config: false,
    show_cardpile_number: true,
  });
  Object.assign(config.mode_config.global, {
    player_number: setup.settings.playerCount,
    free_choose: false,
    change_identity: false,
    swap: false,
    save_progress: false,
    choose_group: true,
  });
  config.mode_config.single = { single_mode: 'dianjiang', change_card: false };
  config.mode_config.identity = {
    ...config.mode_config.identity,
    identity_mode: 'normal',
    double_character: false,
  };
  config.mode_config.doudizhu = {
    ...config.mode_config.doudizhu,
    doudizhu_mode: 'normal',
    feiyang_version: 'online',
    enhance_dizhu: 'none',
    enhance_nongmin: 'default',
  };
  config.mode_config.versus = {
    ...config.mode_config.versus,
    versus_mode: '2v2',
    replacetwo: false,
  };
  const readJson = lib.init.promises.json;
  lib.init.promises.json = function (url, ...args) {
    if (String(url).endsWith('/game/config.json')) return Promise.resolve(structuredClone(config));
    return readJson.call(this, url, ...args);
  };
  // Upstream imports every entry in game/package.js even when config.characters
  // enables only one pack. Narrow discovery before boot builds its import list.
  const readScript = lib.init.promises.js;
  lib.init.promises.js = async function (url, name, ...args) {
    const result = await readScript.call(this, url, name, ...args);
    if (name === 'package' && String(url).replace(/\/$/, '').endsWith('game')) {
      const catalog = window.noname_package;
      for (const pack of definitions.characters)
        if (!catalog.character[pack]) throw new Error(`缺少房间所需武将包：${pack}`);
      catalog.character = Object.fromEntries(
        definitions.characters.map((pack) => [pack, catalog.character[pack]]),
      );
      catalog.card = Object.fromEntries(
        definitions.cards.map((pack) => [pack, catalog.card[pack]]),
      );
      catalog.mode = { [mode]: catalog.mode[mode] };
      catalog.play = {};
      // The native Chinese font alone is 7.5 MiB and competes with the
      // first portraits, health and audio on mobile data. Use device fonts;
      // keep native suit glyphs without registering the large font packs.
      catalog.font = {};
      catalog.submode = { [mode]: catalog.submode[mode] ?? {} };
      progress('packs', '正在准备本房间的武将和卡牌…');
    }
    return result;
  };
  progress('filesystem', '正在检查本地游戏资源…');
  await browserReady({ lib, game, get, ui, ai, _status });
  if (setup.animationSpeedControl) (await import('./animation-speed.js')).installAnimationSpeed();
  lib.buildInfo = await loadBuildInfo();
  installPrivacy();
  installControls();
  installAudio();
  if (setup.experience) (await import('./public-summary.js')).installPublicSummary();
  if (setup.emotions) (await import('./emotions.js')).installEmotions();
  if (role !== 'worker' && setup.connectionRecovery)
    (await import('./connection-recovery.js')).installConnectionRecovery();
  if (role !== 'worker' && setup.luckCards) (await import('./luck-cards.js')).installLuckCards();
  if (role !== 'worker' && setup.surrender) (await import('./surrender.js')).installSurrender();
  if (role === 'worker' && setup.tablePresentation)
    (await import('./table-presentation.js')).installTablePresentation();
  installPrompts();
  // A rule worker has no participating viewpoint, and always uses native AI
  // for AI seats. Human clients make their choices in the upstream interface.
  _status.auto = role === 'worker';
  if (role !== 'worker') game.onlineID = setup.playerId;
  lib.onover.push(() => {
    proof.ended = true;
    globalThis.partyEngine.signal?.('ended');
  });
  progress('boot', '正在初始化对局…');
  await boot();
  if (failed) throw new Error('载入已中断，请重试。');
  proof.booted = true;
  globalThis.partyEngine.audio?.warm();
  progress('ready', '对局已载入');
  clearTimeout(deadline);
  clearTimeout(window.resetGameTimeout);
  clearInterval(progressTimer);
  resourceObserver.disconnect();
  loading.hidden = true;
  if (role === 'player')
    parent.postMessage({ type: 'party-connected', matchId: id }, location.origin);
} catch (error) {
  fail(error);
  console.error(error);
}
