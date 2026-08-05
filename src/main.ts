/**
 * Boot.
 *
 * Builds the procedural atlas, brings up WebGL, wires the game to the UI, and handles
 * the iOS-specific viewport and lifecycle details that decide whether this feels like
 * an app or like a web page pretending to be one.
 */

import { buildAtlas } from './atlas';
import { Game, readSave, loadUnlocked } from './game';
import { UI } from './ui';
import { AudioEngine } from './audio';
import { MISSIONS } from './missions';
import './styles.css';

const boot = document.getElementById('boot')!;
const bootBar = document.getElementById('boot-bar')!;
const bootMsg = document.getElementById('boot-msg')!;
const canvas = document.getElementById('view') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui')!;

function setBoot(frac: number, msg?: string): void {
  bootBar.style.width = `${Math.round(frac * 100)}%`;
  if (msg) bootMsg.textContent = msg;
}

/** Give the browser a frame so the boot bar actually paints between stages. */
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

async function main(): Promise<void> {
  try {
    setBoot(0.05, 'Mixing pigment…');
    await nextFrame();

    const atlas = buildAtlas((f) => setBoot(0.05 + f * 0.6));
    setBoot(0.68, 'Surveying the river…');
    await nextFrame();

    const audio = new AudioEngine();

    let game = new Game(canvas, atlas, audio, MISSIONS[0].id);
    setBoot(0.9, 'Laying out the city…');
    await nextFrame();

    const ui = new UI(game, uiRoot);

    // ---------------------------------------------------------------------
    // Viewport
    // ---------------------------------------------------------------------

    const applySize = () => {
      // visualViewport is the only reliable size on iOS once the URL bar collapses.
      const vv = window.visualViewport;
      const w = Math.round(vv?.width ?? window.innerWidth);
      const h = Math.round(vv?.height ?? window.innerHeight);
      // Cap the backing store: above 3x there is no visible gain and real thermal cost.
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      game.resize(w, h, dpr);
      document.documentElement.style.setProperty('--vh', `${h}px`);
    };
    applySize();
    window.addEventListener('resize', applySize);
    window.visualViewport?.addEventListener('resize', applySize);
    window.addEventListener('orientationchange', () => setTimeout(applySize, 120));

    // ---------------------------------------------------------------------
    // Game lifecycle
    // ---------------------------------------------------------------------

    const startGame = (g: Game) => {
      game.stop();
      game = g;
      ui.rebind(game);
      applySize();
      game.start();
    };

    ui.onNewGame = (missionId) => {
      const g = new Game(canvas, atlas, audio, missionId);
      startGame(g);
    };

    ui.onLoadGame = (slot) => {
      const data = readSave(slot);
      if (!data) return;
      const g = new Game(canvas, atlas, audio, data.mission);
      if (g.load(data)) startGame(g);
    };

    // Drive the cheap per-frame UI updates from the same clock as the renderer.
    let lastUiTick = performance.now();
    const uiLoop = () => {
      const now = performance.now();
      ui.tick(Math.min(0.25, (now - lastUiTick) / 1000));
      lastUiTick = now;
      requestAnimationFrame(uiLoop);
    };
    requestAnimationFrame(uiLoop);

    // Pause the simulation and the audio when the app goes to the background, so a
    // phone in a pocket is not burning battery on a city nobody is watching.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        game.save('autosave');
        audio.suspend();
      } else {
        audio.resume();
      }
    });
    window.addEventListener('pagehide', () => game.save('autosave'));

    // ---------------------------------------------------------------------
    // Audio unlock — iOS requires a real gesture.
    // ---------------------------------------------------------------------

    const unlock = () => {
      audio.unlock();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('touchstart', unlock);
    };
    window.addEventListener('pointerdown', unlock, { once: false });
    window.addEventListener('touchstart', unlock, { once: false });

    // Block the double-tap-to-zoom and rubber-band scroll that make a full-screen
    // canvas feel broken on iOS.
    document.addEventListener('touchmove', (e) => {
      if ((e as any).scale !== 1 && e.cancelable) e.preventDefault();
    }, { passive: false });
    document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

    setBoot(1, 'Ready');
    await nextFrame();

    game.start();
    boot.classList.add('gone');
    setTimeout(() => boot.remove(), 700);

    // Offer to resume rather than silently restoring — losing a session to an
    // unexpected autoload is far more annoying than one extra tap. Shown synchronously
    // so nothing can race with it.
    const auto = readSave('autosave');
    ui.openStart(auto && (auto.city?.tick ?? 0) > 600 ? auto : null);

    // Expose a handle for debugging from Safari's inspector.
    (window as any).kemet = { get game() { return game; }, ui, atlas };
  } catch (err: any) {
    console.error(err);
    bootMsg.textContent = `Could not start: ${err?.message ?? err}`;
    bootBar.style.background = '#c9564a';
  }
}

// ---------------------------------------------------------------------------
// Service worker
// ---------------------------------------------------------------------------

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    // Relative paths keep this working whether the game is served from a domain root
    // or from a subdirectory such as a GitHub Pages project site.
    navigator.serviceWorker
      .register('./sw.js', { scope: './' })
      .catch((e) => console.warn('Service worker registration failed', e));
  });
}

main();
