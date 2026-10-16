import { APP_VERSION, type ApiError } from '../../../packages/shared/src/contracts.js';
import { bindClassicTheme, themeControls } from './classic-ui.js';

export const app = document.querySelector<HTMLElement>('#app')!;

function requestDeadline(parent: AbortSignal | undefined, milliseconds: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  const abort = () => controller.abort();
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    },
  };
}

export function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const result = app.querySelector<T>(selector);
  if (!result) throw new Error(`Missing element: ${selector}`);
  return result;
}

export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
  timeoutMs = path.endsWith('/start') ? 190000 : 20000,
): Promise<T> {
  const deadline = requestDeadline(undefined, timeoutMs);
  try {
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      signal: deadline.signal,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data: T | ApiError = await response.json();
    if (!response.ok)
      throw new Error((data as ApiError).error?.message ?? '连接失败，请稍后再试。');
    return data as T;
  } catch (error) {
    if (deadline.signal.aborted) throw new Error('请求超时，请检查连接后重试。');
    throw error;
  } finally {
    deadline.clear();
  }
}

export function frame(
  layout: string,
  eyebrow: string,
  title: string,
  subtitle: string,
  body: string,
): void {
  app.className = layout;
  app.innerHTML = `
    <a class="skip-link" href="#lobby-content">跳到主要内容</a>
    <header class="masthead"><a class="brand" href="/" aria-label="聚会三国杀首页"><span class="seal">杀</span><span>聚会三国杀<small>以牌会友 · 尽兴而归</small></span></a><nav class="masthead-nav" aria-label="大厅导航"><a href="/" ${layout.includes('home-layout') ? 'aria-current="page"' : ''}>聚会大厅</a>${layout.includes('home-layout') ? '<a href="#lobby-guide">玩法与武将</a>' : ''}</nav>${themeControls()}<span id="connection" class="connection" role="status">正在连接</span></header>
    <section class="page-hero"><div class="intro"><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p>${subtitle}</p></div><span class="classic-motto" aria-hidden="true">群英相聚<br />以牌会友</span></section>
    <div id="lobby-content" tabindex="-1">
    <div id="message" class="message" role="alert" hidden></div>
    ${body}
    </div>
    <footer><span>聚会三国杀 v${APP_VERSION}</span><span>扫码入席 · 以牌会友</span></footer>`;
  bindClassicTheme(app);
}

export function message(text: string, success = false): void {
  const target = element('#message');
  target.textContent = text;
  target.classList.toggle('success', success);
  target.hidden = !text;
}

export function disable(button: HTMLButtonElement, disabled: boolean): void {
  button.disabled = disabled || button.dataset.busy === 'true';
}

export async function perform(
  button: HTMLButtonElement,
  callback: () => Promise<void>,
  render: () => void = () => {},
): Promise<void> {
  button.dataset.busy = 'true';
  button.setAttribute('aria-busy', 'true');
  button.disabled = true;
  message('');
  try {
    await callback();
  } catch (error) {
    message(error instanceof Error ? error.message : '操作失败，请重试。');
  } finally {
    delete button.dataset.busy;
    button.removeAttribute('aria-busy');
    button.disabled = false;
    render();
  }
}

export function action(
  button: HTMLButtonElement,
  callback: () => Promise<void>,
  render?: () => void,
): void {
  button.addEventListener('click', () => {
    void perform(button, callback, render);
  });
}

export function connection(online: boolean, text: string): void {
  const target = element('#connection');
  target.textContent = text;
  target.classList.toggle('online', online);
}

export function watchEvents(
  url: string,
  name: string,
  update: (data: unknown) => void,
  poll = false,
): { close(): void } {
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) location.reload();
  });
  if (poll) {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last: unknown;
    const close = () => {
      abort.abort();
      clearTimeout(timer);
    };
    async function refresh() {
      const deadline = requestDeadline(abort.signal, 12000);
      try {
        const response = await fetch(`${url}?transport=poll`, {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: deadline.signal,
        });
        if (response.status === 404 && name === 'room') {
          if (last) update({ ...last, phase: 'closed', revision: Number.MAX_SAFE_INTEGER });
          connection(false, '房间已关闭');
          close();
          return;
        }
        if (!response.ok) throw new Error('Connection unavailable');
        last = await response.json();
        if (abort.signal.aborted) return;
        update(last);
        connection(true, name === 'room' ? '已连接牌桌' : '服务在线');
      } catch {
        if (!abort.signal.aborted) connection(false, '连接断开，正在重连');
      } finally {
        deadline.clear();
        if (!abort.signal.aborted) timer = setTimeout(refresh, 1200);
      }
    }
    void refresh();
    window.addEventListener('pagehide', close, { once: true });
    return { close };
  }
  const events = new EventSource(url);
  events.addEventListener('open', () =>
    connection(true, name === 'room' ? '已连接牌桌' : '服务在线'),
  );
  events.addEventListener(name, (event) =>
    update(JSON.parse((event as MessageEvent<string>).data)),
  );
  events.addEventListener('error', () => connection(false, '连接断开，正在重连'));
  window.addEventListener('pagehide', () => events.close(), { once: true });
  return events;
}
