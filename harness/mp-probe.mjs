/**
 * Multiplayer end-to-end probe.
 *
 * Boots two real browser contexts against a running dev server, drives the
 * menu through HOST → JOIN → START, and checks both clients reach a racing
 * phase seeing each other's boats move. Also re-proves solo mode still boots.
 *
 * Usage: node harness/mp-probe.mjs [--port=5173]
 */

import { chromium } from 'playwright';

const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) ?? 5173);
const URL = `http://localhost:${PORT}/`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launchArgs() {
  const angle =
    process.platform === 'darwin' ? 'metal' : process.platform === 'win32' ? 'd3d11' : 'vulkan';
  return [
    '--use-gl=angle',
    `--use-angle=${angle}`,
    '--ignore-gpu-blocklist',
    '--disable-frame-rate-limit',
    '--hide-scrollbars',
    '--mute-audio',
  ];
}

async function newPage(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  return page;
}

async function clickButton(page, id) {
  await page.click(`#${id}`);
}

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

async function main() {
  const browser = await chromium.launch({ headless: true, args: launchArgs() });

  // ── 1. Solo regression via the menu ──────────────────────────────────────
  console.log('▸ solo boot through the menu');
  const solo = await newPage(browser, URL);
  await solo.waitForSelector('#menu:not(.hidden)', { timeout: 15000 });
  check('menu visible on boot', true);
  await clickButton(solo, 'm-solo');
  await solo.waitForFunction(
    () => window.__CONTRIL__ && document.getElementById('menu').classList.contains('hidden'),
    null,
    { timeout: 10000 },
  );
  const soloState = await solo.evaluate(() => ({
    phase: window.__CONTRIL__.stats().phase,
    ready: window.__CONTRIL__.ready,
  }));
  check('solo race starts in countdown', soloState.phase === 'countdown', `phase=${soloState.phase}`);
  // Nobody holds W in a headless browser — drive through the harness API.
  await solo.evaluate(() => window.__CONTRIL__.setControls({ throttle: 1 }));
  await solo.waitForFunction(() => window.__CONTRIL__.stats().speed > 2, null, {
    timeout: 15000,
  });
  check('solo boat gathers speed', true);
  check('no page errors (solo)', solo.errors.length === 0, solo.errors.join(' | '));
  await solo.context().close();

  // ── 2. Host + join over real WebRTC ──────────────────────────────────────
  console.log('▸ multiplayer: host + join + start');
  const host = await newPage(browser, URL);
  await host.waitForSelector('#menu:not(.hidden)');
  await host.fill('#m-name', 'ALPHA');
  await clickButton(host, 'm-host');
  await host.waitForFunction(() => {
    const t = document.getElementById('m-room-code').textContent;
    return t && t.length === 5 && t !== '·····';
  }, null, { timeout: 20000 });
  const code = await host.evaluate(() => document.getElementById('m-room-code').textContent);
  check('host opened room', /^[A-Z2-9]{5}$/.test(code), `code=${code}`);

  const guest = await newPage(browser, URL);
  await guest.waitForSelector('#menu:not(.hidden)');
  await guest.fill('#m-name', 'BRAVO');
  await guest.fill('#m-code', code);
  await clickButton(guest, 'm-join');

  // Wait for actual WebRTC connectivity in both directions — rendering four
  // lobby rows is unconditional, so only the session state proves anything.
  await host.waitForFunction(
    () => window.__CONTRIL__._game.session.peerCount() >= 1,
    null,
    { timeout: 40000 },
  );
  await guest.waitForFunction(
    () => window.__CONTRIL__._game.session.mySlot >= 0,
    null,
    { timeout: 40000 },
  );
  // And the roster converged with the hello name attached.
  await host.waitForFunction(
    () => document.getElementById('m-roster').textContent.includes('BRAVO'),
    null,
    { timeout: 20000 },
  );

  const rosterText = await host.evaluate(() =>
    Array.from(document.querySelectorAll('#m-roster li')).map((li) => li.textContent.trim()),
  );
  check('roster shows 2 humans + AI fill', rosterText.length === 4 && rosterText[1].includes('BRAVO'), rosterText.join(' / '));

  // Host starts. Both pages must land in racing and stay in sync.
  await clickButton(host, 'm-start');
  const waitRacing = async (page, tag) => {
    try {
      await page.waitForFunction(
        () => window.__CONTRIL__?.stats()?.phase === 'racing',
        null,
        { timeout: 20000 },
      );
      check(`${tag} reached racing`, true);
    } catch {
      const s = await page.evaluate(() => ({
        phase: window.__CONTRIL__?.stats()?.phase,
        paused: window.__CONTRIL__._game.race.paused,
        menuHidden: document.getElementById('menu').classList.contains('hidden'),
        status: document.querySelector('.status')?.textContent ?? '',
        slot: window.__CONTRIL__._game.session.mySlot,
      })).catch(() => null);
      check(`${tag} reached racing`, false, JSON.stringify(s) + ` | errors: ${page.errors.join(' | ')}`);
      throw new Error('abort');
    }
  };
  await Promise.all([waitRacing(host, 'host'), waitRacing(guest, 'guest')]);

  // Give them ~6 s of racing — with the throttle pinned, so the sync checks
  // mean something. (Nobody holds W in a headless browser.)
  await Promise.all(
    [host, guest].map((p) => p.evaluate(() => window.__CONTRIL__.setControls({ throttle: 1 }))),
  );
  await sleep(6000);

  const dump = async (page) =>
    page.evaluate(() => {
      const G = window.__CONTRIL__;
      return {
        probe: G.probe(),
        me: { place: G.stats().place, speed: G.stats().speed, lap: G.stats().lap },
      };
    });

  const hDump = await dump(host);
  const gDump = await dump(guest);

  // Each client's own boat must be a different slot…
  const mySlot = (probe) => probe.find((p) => p.name === 'YOU');
  const hostSlot = mySlot(hDump.probe)?.id;
  const guestSlot = mySlot(gDump.probe)?.id;
  check('distinct player slots', hostSlot !== guestSlot, `host=${hostSlot} guest=${guestSlot}`);

  // …and each client must see the other's boat actually moving.
  const remoteSpeedFor = (probe, slot) => probe.find((p) => p.id === slot)?.speed ?? -1;
  const hSeesGuest = remoteSpeedFor(hDump.probe, guestSlot);
  const gSeesHost = remoteSpeedFor(gDump.probe, hostSlot);
  check('host sees guest moving', hSeesGuest > 5, `${hSeesGuest.toFixed(1)} m/s`);
  check('guest sees host moving', gSeesHost > 5, `${gSeesHost.toFixed(1)} m/s`);

  // Positions of the same slot on both clients should roughly agree (<25 m).
  const posOf = (probe, slot) => probe.find((p) => p.id === slot)?.pos;
  const [hx, , hz] = posOf(hDump.probe, hostSlot);
  const [gx, , gz] = posOf(gDump.probe, hostSlot);
  const drift = Math.hypot(hx - gx, hz - gz);
  check('host position agrees across clients', drift < 25, `${drift.toFixed(1)} m apart`);

  check('no page errors (host)', host.errors.length === 0, host.errors.join(' | '));
  check('no page errors (guest)', guest.errors.length === 0, guest.errors.join(' | '));

  // ── 3. Restart propagates from a guest ───────────────────────────────────
  console.log('▸ guest-triggered restart');
  // R is only live on the results screen (by design), and a real race takes
  // minutes — fabricate one via the harness, then press it.
  await guest.evaluate(() => window.__CONTRIL__.setPhase('results'));
  await sleep(500);
  await guest.keyboard.press('KeyR');
  await Promise.all([
    host.waitForFunction(() => window.__CONTRIL__.stats().phase === 'countdown', null, {
      timeout: 8000,
    }),
    guest.waitForFunction(() => window.__CONTRIL__.stats().phase === 'countdown', null, {
      timeout: 8000,
    }),
  ]);
  check('guest restart reached both clients', true);
  const lapsReset = await host.evaluate(() => window.__CONTRIL__.stats().lap === 0);
  check('field reset on restart', lapsReset);

  await browser.close();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('probe crashed:', err);
  process.exit(1);
});
