/** Presentation only: no room commands and no access to the native rule worker. */
const themeKey = 'party_classic_theme';
type Theme = 'camp' | 'ink';
const validTheme = (value: string | null | undefined): Theme => (value === 'ink' ? 'ink' : 'camp');

const iconPaths = {
  sound: '<path d="M11 4 6 8H3v8h3l5 4V4Z"/><path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  more: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  theme: '<path d="M5 4h14v16H5zM8 8h8M8 12h5"/><path d="m14 16 2 2 4-5"/>',
} as const;

function icon(name: keyof typeof iconPaths): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name]}</svg>`;
}

export function themeControls(id = 'lobby-theme'): string {
  return `<label class="theme-picker" for="${id}">${icon('theme')}<span class="sr-only">界面风格</span><select id="${id}" data-theme-select><option value="camp">铜雀军帐</option><option value="ink">宣纸墨局</option></select></label>`;
}

let storageBound = false;
export function bindClassicTheme(root: ParentNode): void {
  let theme = validTheme(document.documentElement.dataset.theme);
  try {
    theme = validTheme(localStorage.getItem(themeKey));
  } catch {
    /* Private mode can refuse storage. */
  }
  const apply = (value: Theme) => {
    document.documentElement.dataset.theme = value;
    document.querySelectorAll<HTMLSelectElement>('[data-theme-select]').forEach((control) => {
      control.value = value;
    });
  };
  apply(theme);
  root.querySelectorAll<HTMLSelectElement>('[data-theme-select]').forEach((control) => {
    if (control.dataset.bound) return;
    control.dataset.bound = 'true';
    control.addEventListener('change', () => {
      const next = validTheme(control.value);
      apply(next);
      try {
        localStorage.setItem(themeKey, next);
      } catch {
        /* Keep the current page usable. */
      }
    });
  });
  if (!storageBound) {
    storageBound = true;
    window.addEventListener('storage', (event) => {
      if (event.key === themeKey) apply(validTheme(event.newValue));
    });
  }
}

/** Move existing controls, including their listeners, into accessible disclosures. */
export function bindClassicToolbar(root: HTMLElement) {
  const find = <T extends HTMLElement = HTMLElement>(selector: string) =>
    root.querySelector<T>(selector)!;
  const toolbar = find('.match-toolbar');
  const status = document.createElement('div');
  status.className = 'match-status';
  status.append(find('#match-label'), find('#match-network'));
  const tools = document.createElement('div');
  tools.className = 'match-tools';
  const priority = document.createElement('div');
  priority.className = 'match-priority';
  const record = find<HTMLButtonElement>('#match-records');
  record.textContent = '记录';
  record.setAttribute('aria-label', '本局记录');
  tools.append(record);
  const disclosures: { button: HTMLButtonElement; panel: HTMLElement; wrapper: HTMLElement }[] = [];
  function disclosure(id: string, title: string, glyph: keyof typeof iconPaths) {
    const wrapper = document.createElement('div');
    wrapper.className = 'toolbar-disclosure';
    wrapper.innerHTML = `<button id="${id}" class="button toolbar-trigger" type="button" aria-label="${title}" aria-expanded="false" aria-controls="${id}-panel">${icon(glyph)}<span>${title}</span></button><section id="${id}-panel" class="toolbar-popover" aria-label="${title}" hidden></section>`;
    const button = wrapper.querySelector<HTMLButtonElement>('button')!;
    const panel = wrapper.querySelector<HTMLElement>('section')!;
    const item = { button, panel, wrapper };
    const close = (focus = false) => {
      panel.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      if (focus) button.focus();
    };
    button.addEventListener('click', () => {
      const opening = panel.hidden;
      disclosures.forEach((other) => {
        other.panel.hidden = true;
        other.button.setAttribute('aria-expanded', 'false');
      });
      panel.hidden = !opening;
      button.setAttribute('aria-expanded', String(opening));
      if (opening)
        panel
          .querySelector<HTMLElement>('button:not([hidden]):not(:disabled), select, input')
          ?.focus();
    });
    wrapper.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
      }
    });
    wrapper.addEventListener('focusout', (event) => {
      if (event.relatedTarget) {
        if (!wrapper.contains(event.relatedTarget as Node)) close();
        return;
      }
      // A microtask can run before the browser focuses the next control.
      // Wait for that focus transaction before treating a null target as an exit.
      requestAnimationFrame(() => {
        if (!wrapper.contains(document.activeElement)) close();
      });
    });
    disclosures.push(item);
    tools.append(wrapper);
    return { button, panel, close };
  }
  const sound = disclosure('match-sound-menu', '声音', 'sound');
  sound.panel.innerHTML =
    '<p class="popover-title">声音设置</p><p class="hint">牌声与技能音效，仅影响你的设备。</p>';
  sound.panel.append(find('#match-sound'), find('.match-volume'));
  const more = disclosure('match-more', '更多', 'more');
  more.panel.innerHTML = '<p class="popover-title">牌桌操作</p><div class="more-actions"></div>';
  const moreActions = more.panel.querySelector<HTMLElement>('.more-actions')!;
  const auto = find<HTMLButtonElement>('#match-auto');
  const restore = find<HTMLButtonElement>('#match-restore');
  moreActions.append(
    find('#match-share'),
    find('#match-orientation'),
    find('#orientation-hint'),
    auto,
    restore,
    find('#match-leave'),
  );
  more.panel.insertAdjacentHTML(
    'beforeend',
    `<div class="popover-theme">${themeControls('match-theme')}</div><div class="danger-actions"></div>`,
  );
  more.panel
    .querySelector('.danger-actions')!
    .append(find('#match-surrender'), find('#surrender-notice'));
  const rematch = find('#rematch-button');
  priority.append(rematch, find('#finished-hint'));
  toolbar.replaceChildren(status, priority, tools);
  const closeAfterAction = (event: Event) => {
    // The accepted action may already have disabled its button while awaiting a request.
    if (!(event.target as Element).closest('button')) return;
    const dialog = root.querySelector<HTMLDialogElement>('dialog[open]');
    more.close(!dialog);
    if (dialog)
      dialog.addEventListener(
        'close',
        () => {
          if (!root.querySelector('dialog[open]') && !find('#match-panel').hidden)
            more.button.focus();
        },
        { once: true },
      );
  };
  moreActions.addEventListener('click', closeAfterAction);
  more.panel.querySelector('.danger-actions')!.addEventListener('click', closeAfterAction);
  document.addEventListener('pointerdown', (event) => {
    for (const item of disclosures)
      if (!item.wrapper.contains(event.target as Node)) {
        item.panel.hidden = true;
        item.button.setAttribute('aria-expanded', 'false');
      }
  });
  const promoteAuto = () => {
    const target =
      auto.getAttribute('aria-pressed') === 'true' && !auto.hidden ? priority : moreActions;
    if (auto.parentElement !== target) target.append(auto);
  };
  const observer = new MutationObserver(promoteAuto);
  observer.observe(auto, { attributes: true, attributeFilter: ['aria-pressed', 'hidden'] });
  window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
  bindClassicTheme(root);
  return {
    update(connected: boolean, finished: boolean) {
      const target = !connected && !finished && !restore.hidden ? priority : moreActions;
      if (restore.parentElement !== target) target.append(restore);
      promoteAuto();
      if (root.querySelector('#match-panel')?.hasAttribute('hidden')) {
        sound.close();
        more.close();
      }
    },
  };
}
