// SPDX-License-Identifier: GPL-3.0-only
import { lib, game, ui, get } from 'noname';

const icons = {
  flower:
    '<svg viewBox="0 0 60 60"><path d="M30 28v28M30 47Q13 30 14 47Q20 53 30 51M30 42Q47 26 48 41Q41 49 30 47" fill="#57b56b" stroke="#286a42" stroke-width="3"/><g fill="#ed7892" stroke="#9b324c" stroke-width="2"><ellipse cx="30" cy="17" rx="8" ry="13"/><ellipse cx="30" cy="17" rx="8" ry="13" transform="rotate(72 30 23)"/><ellipse cx="30" cy="17" rx="8" ry="13" transform="rotate(144 30 23)"/><ellipse cx="30" cy="17" rx="8" ry="13" transform="rotate(216 30 23)"/><ellipse cx="30" cy="17" rx="8" ry="13" transform="rotate(288 30 23)"/></g><circle cx="30" cy="23" r="7" fill="#ffe38b"/></svg>',
  egg: '<svg viewBox="0 0 60 60"><path d="M30 5C18 5 10 30 12 42C15 59 45 59 48 42C50 30 42 5 30 5Z" fill="#fff5d9" stroke="#b59a72" stroke-width="3"/><path d="M23 16Q17 25 18 34" fill="none" stroke="white" stroke-width="5" stroke-linecap="round"/></svg>',
  wine: '<svg viewBox="0 0 60 60"><path d="M24 6h12v16Q48 26 45 48H15Q12 26 24 22Z" fill="#ad4348" stroke="#f2d7a1" stroke-width="3"/><path d="M17 34h26v10H17Z" fill="#f2d7a1"/></svg>',
  shoe: '<svg viewBox="0 0 60 60"><path d="M8 15h18l4 17q12 8 23 9v12H7Z" fill="#87715b" stroke="#e7d4b1" stroke-width="3"/><path d="M8 47h45" stroke="#ead9be" stroke-width="4"/></svg>',
};
const names = { flower: '鲜花', egg: '鸡蛋', wine: '美酒', shoe: '拖鞋' };
const interval = 200;

export function installEmotions() {
  let sentAt = -Infinity;
  if (globalThis.partyEngine.setup.role !== 'worker') {
    const intro = ui.click.intro;
    ui.click.intro = function (...args) {
      // Native intros also scan optional skin directories. This project serves
      // fixed verified portraits and provides no filesystem browsing endpoint.
      const changeSkin = lib.config.change_skin;
      const skins = lib.skin;
      let dialog;
      try {
        lib.config.change_skin = false;
        lib.skin = undefined;
        dialog = intro.apply(this, args);
      } finally {
        lib.config.change_skin = changeSkin;
        lib.skin = skins;
      }
      const layer = dialog?.nextElementSibling;
      if (
        layer?.classList.contains('poplayer') &&
        ui.throwEmotion?.some((button) => dialog.contains(button))
      ) {
        // Native emotion buttons invoke dialog._close(), but that callback
        // expects the poplayer as `this`. Without it an invisible touch shield
        // remains after the first throw and intercepts the next long press.
        const close = dialog._close;
        dialog._close = (...values) => close.apply(layer, values);
        const target = this.closest?.('.player');
        for (const button of ui.throwEmotion) {
          if (!dialog.contains(button) || !icons[button.link]) continue;
          // Replace the native touch-only, close-after-one handler. Both
          // desktop clicks and phone taps keep this menu open for repeat gifts.
          const name = button.link;
          const repeated = button.cloneNode(true);
          repeated.link = name;
          repeated.classList.remove('exclude');
          repeated.setAttribute(
            'aria-label',
            `向${target?.nickname || get.translation(target?.name)}赠送${names[name]}`,
          );
          const send = (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (!target || Date.now() - sentAt < interval) return;
            sentAt = Date.now();
            if (game.online) game.send('throwEmotion', target, name);
            else game.me.throwEmotion(target, name);
          };
          repeated.addEventListener('touchend', send, { passive: false });
          repeated.addEventListener('click', send);
          button.replaceWith(repeated);
        }
      }
      return dialog;
    };
  }
  const nodes = new Set();
  let notice;
  let noticeTimer;
  let recent;
  const clear = () => {
    for (const node of nodes) node.remove();
    nodes.clear();
    notice?.remove();
    notice = undefined;
    recent = undefined;
    clearTimeout(noticeTimer);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clear();
  });
  window.addEventListener('pagehide', clear, { once: true });
  // Native broadcasts and audio remain; all four existing menu items use small
  // inline vectors, avoiding missing upstream PNGs and extra resource requests.
  lib.element.Player.prototype.$throwEmotion = function (target, name) {
    if (
      !icons[name] ||
      !target ||
      document.hidden ||
      globalThis.partyEngine.setup.role === 'worker'
    )
      return;
    if (globalThis.partyEngine.deliveryAge > 3000) return;
    const layer = ui.window;
    const key = `${this.playerid}:${target.playerid}:${name}`;
    const count = recent?.key === key && Date.now() - recent.at < 2500 ? recent.count + 1 : 1;
    recent = { key, count, at: Date.now() };
    if (!notice?.isConnected) {
      notice = document.createElement('div');
      notice.className = 'party-emotion-notice';
      notice.setAttribute('role', 'status');
      notice.style.cssText =
        'position:absolute;left:8px;top:8px;max-width:45%;width:auto;height:auto;z-index:100;pointer-events:none;background:#172723e8;color:#fff4cd;padding:5px 9px;border-radius:6px;font:13px/1.4 system-ui;overflow-wrap:anywhere';
      layer.append(notice);
    }
    const label = (player) => player.nickname || get.translation(player.name);
    notice.textContent = `${label(this)} → ${label(target)}：${names[name]}${count > 1 ? ` ×${count}` : ''}`;
    notice.dataset.from = this.playerid;
    notice.dataset.to = target.playerid;
    notice.dataset.count = String(count);
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      notice?.remove();
      notice = undefined;
    }, 2500);
    const scale = layer.getBoundingClientRect().width / layer.offsetWidth || 1;
    const center = (player) => {
      const rect = (player === game.me ? player.node.avatar : player).getBoundingClientRect();
      const base = layer.getBoundingClientRect();
      return [
        (rect.left + rect.width / 2 - base.left) / scale,
        (rect.top + rect.height / 2 - base.top) / scale,
      ];
    };
    const [x, y] = center(this),
      [tx, ty] = center(target);
    const node = document.createElement('div');
    node.className = 'party-emotion';
    node.dataset.emotion = name;
    node.setAttribute('aria-hidden', 'true');
    node.innerHTML = icons[name];
    node.style.cssText = `position:absolute;left:${x - 27}px;top:${y - 27}px;width:54px;height:54px;z-index:100;pointer-events:none;filter:drop-shadow(0 2px 3px #0009)`;
    layer.append(node);
    nodes.add(node);
    if (nodes.size > 12) {
      const oldest = nodes.values().next().value;
      oldest.remove();
      nodes.delete(oldest);
    }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const destination = `translate(${tx - x}px,${ty - y}px)`;
    const milliseconds = (value) =>
      globalThis.partyEngine.animationSpeed?.milliseconds(value) ?? value;
    const duration = milliseconds(reduced ? 140 : 850);
    // Use the browser API directly: native divs can install their own animate
    // method. An explicit middle frame also makes the flight visible on desktop.
    const animate = Element.prototype.animate;
    if (!reduced && typeof animate === 'function')
      animate.call(
        node,
        [
          { transform: 'translate(0,0) rotate(0deg)' },
          { transform: `translate(${(tx - x) / 2}px,${(ty - y) / 2 - 60}px) rotate(180deg)` },
          { transform: `${destination} rotate(360deg)` },
        ],
        { duration, easing: 'ease-in-out', fill: 'forwards' },
      );
    else {
      node.style.transform = destination;
      if (typeof animate === 'function')
        animate.call(node, [{ opacity: 0 }, { opacity: 1 }], { duration, fill: 'forwards' });
    }
    if (lib.config.background_audio) game.playAudio('effect', `throw_${name}${get.rand(1, 2)}`);
    setTimeout(() => {
      if (!nodes.has(node)) return;
      if (name === 'egg')
        node.innerHTML =
          '<svg viewBox="0 0 60 60"><path d="M4 32L16 24L12 8L27 19L42 4L40 23L57 28L45 39L54 53L33 46L18 58L19 43L4 45Z" fill="#fff5d9"/><circle cx="30" cy="32" r="12" fill="#f5bc38"/></svg>';
      if (!reduced && typeof animate === 'function')
        animate.call(
          node.firstElementChild,
          [{ transform: 'scale(1)' }, { transform: 'scale(1.3)' }, { transform: 'scale(1)' }],
          { duration: milliseconds(300) },
        );
      setTimeout(() => {
        node.remove();
        nodes.delete(node);
      }, milliseconds(1000));
    }, duration);
  };
  if (globalThis.partyEngine.setup.role === 'worker') {
    const last = new Map();
    lib.message.server.throwEmotion = function (target, name) {
      const player = lib.playerOL[this.id];
      if (
        !player ||
        player.ws !== this ||
        ![...game.players, ...game.dead].includes(target) ||
        target === player ||
        !icons[name] ||
        Date.now() - (last.get(this.id) ?? 0) < interval
      )
        return;
      last.set(this.id, Date.now());
      player.throwEmotion(target, name);
    };
  }
}
