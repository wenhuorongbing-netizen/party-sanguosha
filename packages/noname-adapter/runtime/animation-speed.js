// SPDX-License-Identifier: GPL-3.0-only
import { game } from 'noname';

/** Scale presentation only. Never replace the rule clock or decision timers. */
export function installAnimationSpeed() {
  const engine = globalThis.partyEngine;
  const valid = (value) => Number.isInteger(value) && value >= 1 && value <= 10;
  let speed = valid(engine.setup.settings.animationSpeed)
    ? engine.setup.settings.animationSpeed
    : 2;
  const delay = game.delay;
  // delayx already delegates to delay; scaling both would compound the multiplier.
  // Keep the original slow/preset baseline so 1x exactly restores the old pacing.
  game.delay = function (time = 1, offset = 0) {
    return delay.call(this, time / speed, offset / speed);
  };
  function scale(animation) {
    if (
      animation.effect?.getTiming().iterations === Infinity ||
      animation.effect?.target?.closest?.('.timerbar, #timer, .party-emotion')
    )
      return;
    animation.playbackRate = speed;
  }
  function animations() {
    for (const animation of document.getAnimations?.() ?? []) scale(animation);
  }
  // Native move/reorder and skill effects use WAAPI without a DOM mutation.
  // Intercept creation inside this engine frame; emotions scale their duration separately.
  const animate = Element.prototype.animate;
  if (typeof animate === 'function') {
    Element.prototype.animate = function (...args) {
      const animation = animate.apply(this, args);
      scale(animation);
      return animation;
    };
  }
  function set(value) {
    if (!valid(value)) return;
    speed = value;
    engine.setup.settings.animationSpeed = speed;
    engine.proof.animationSpeed = speed;
    animations();
  }
  engine.animationSpeed = {
    get value() {
      return speed;
    },
    set,
    milliseconds: (value) => value / speed,
  };
  set(speed);
  const observer = new MutationObserver(animations);
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
  document.addEventListener('animationstart', animations, true);
  document.addEventListener('transitionrun', animations, true);
  window.addEventListener('message', (event) => {
    if (
      event.origin !== location.origin ||
      event.source !== window.parent ||
      event.data?.type !== 'party-animation-speed' ||
      event.data.matchId !== engine.setup.id
    )
      return;
    set(event.data.animationSpeed);
  });
  window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
  parent.postMessage({ type: 'party-animation-ready', matchId: engine.setup.id }, location.origin);
}
