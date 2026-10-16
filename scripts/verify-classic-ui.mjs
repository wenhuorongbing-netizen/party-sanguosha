import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createPartyServer } from '../apps/server/src/server.ts';
import { NativeNonameService } from '../packages/noname-adapter/src/service.ts';

// Visual and geometry checks own their server and browser; no existing room is touched.
const root = fileURLToPath(new URL('../', import.meta.url));
const options = {
  webRoot: `${root}/dist/web`,
  port: 0,
  adapter: new NativeNonameService(root),
};
const party = createPartyServer(options);
await new Promise((resolve) => party.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${party.server.address().port}`;
const output = `${root}/.runtime/classic-ui/${new Date().toISOString().replaceAll(':', '-')}`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL ?? 'msedge' });
const contexts = [],
  errors = [],
  missing = new Set(),
  screenshots = [];
async function newPage() {
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    hasTouch: true,
  });
  contexts.push(context);
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) missing.add(new URL(response.url()).pathname);
  });
  return page;
}
async function shot(page, name, fullPage = true) {
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
  const geometry = await page.evaluate(() => ({
    width: innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    theme: document.documentElement.dataset.theme,
  }));
  assert.ok(
    geometry.document <= geometry.width,
    `${name}: horizontal document overflow ${JSON.stringify(geometry)}`,
  );
  assert.ok(
    geometry.body <= geometry.width,
    `${name}: horizontal body overflow ${JSON.stringify(geometry)}`,
  );
  await page.screenshot({ path: `${output}/${name}.png`, fullPage });
  screenshots.push({ name, ...geometry });
}
async function theme(page, value) {
  await page.locator('#lobby-theme').selectOption(value);
  assert.equal(await page.locator('html').getAttribute('data-theme'), value);
}
try {
  const owner = await newPage(),
    friend = await newPage(),
    visitor = await newPage(),
    computer = await newPage();
  await owner.goto(base);
  await owner.locator('#nickname').fill('子龙');
  await owner.locator('#create-button').click();
  await owner.locator('#my-role').waitFor({ state: 'visible' });
  const code = owner.url().split('/').at(-1);
  const room = party.lobby.get(code);
  await friend.goto(`${base}/join/${code}`);
  await friend.locator('#nickname').fill('孔明');
  await friend.locator('#join-button').click();
  await owner.locator('#add-bot').click();
  await owner.locator('#add-bot').click();
  await friend.locator('#ready-button').click();
  await owner.locator('#ready-button').click();
  await owner.waitForFunction(() =>
    document.querySelector('#start-blockers')?.textContent.includes('还差 1 个席位'),
  );
  await visitor.goto(base);
  await visitor.locator('#nickname').fill('保留这个昵称');
  await computer.goto(base + '/server');
  await computer.locator('#console-animation-speed').waitFor({ state: 'visible' });
  const viewports = [
    { name: 'desktop', width: 1366, height: 768 },
    { name: 'phone', width: 390, height: 844 },
    { name: 'landscape', width: 844, height: 390 },
  ];
  for (const value of ['camp', 'ink']) {
    for (const viewport of viewports) {
      const { name, width, height } = viewport;
      for (const page of [owner, visitor]) await page.setViewportSize({ width, height });
      const settingsOpen = await owner.locator('#settings-panel').evaluate((panel) => panel.open);
      if (settingsOpen !== (name === 'desktop'))
        await owner.locator('#settings-panel > summary').click();
      const revision = room.snapshot().revision;
      await theme(owner, value);
      assert.equal(room.snapshot().revision, revision, 'theme must not change room state');
      assert.ok(
        room
          .snapshot()
          .players.filter((player) => player.kind === 'human')
          .every((player) => player.ready),
      );
      await shot(owner, `${value}-waiting-${name}`);
      if (name !== 'landscape') {
        const ready = await owner.locator('#ready-button').boundingBox();
        const check = await owner.locator('#start-check').boundingBox();
        assert.ok(
          ready.y >= 0 && ready.y + ready.height <= height,
          `${value}/${name}: ready must be on first screen`,
        );
        assert.ok(
          check.y >= 0 && check.y + check.height <= height,
          `${value}/${name}: blockers must be on first screen`,
        );
      }
      await theme(visitor, value);
      assert.equal(await visitor.locator('#nickname').inputValue(), '保留这个昵称');
      await shot(visitor, `${value}-home-${name}`);
    }
    await owner.setViewportSize({ width: 1366, height: 768 });
    await owner.locator('#share-button').click();
    // Loopback-only previews intentionally do not advertise an unusable phone invite.
    await owner.waitForFunction(() =>
      document.querySelector('#qr-placeholder')?.textContent.includes('暂未检测到局域网'),
    );
    await shot(owner, `${value}-share-desktop`, false);
    await owner.locator('#close-share').click();
    await owner.locator('#room-rules-summary > summary').click();
    await owner.locator('#general-guide').click();
    await owner.locator('.guide-entry').first().waitFor({ state: 'visible' });
    await shot(owner, `${value}-guide-desktop`, false);
    await owner.setViewportSize({ width: 390, height: 844 });
    await shot(owner, `${value}-guide-phone`, false);
    await owner.locator('#guide-close').click();
    await owner.locator('#room-rules-summary > summary').click();
    await theme(computer, value);
    await shot(computer, `${value}-console-desktop`);
  }
  const invited = await newPage();
  await invited.goto(`${base}/join/${code}`);
  await invited.locator('#nickname').fill('新来的朋友');
  for (const value of ['camp', 'ink']) {
    await theme(invited, value);
    for (const { name, width, height } of viewports) {
      await invited.setViewportSize({ width, height });
      await shot(invited, `${value}-join-${name}`);
      assert.equal(await invited.locator('#nickname').inputValue(), '新来的朋友');
      assert.equal(await invited.locator('#settings-panel').isVisible(), false);
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual([...missing], []);
  const result = { passed: true, screenshots, errors, missing: [...missing], physicalPhone: false };
  await writeFile(`${output}/result.json`, JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ output, ...result }));
} catch (error) {
  await writeFile(
    `${output}/failure.json`,
    JSON.stringify(
      { error: String(error.stack ?? error), errors, missing: [...missing], screenshots },
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
