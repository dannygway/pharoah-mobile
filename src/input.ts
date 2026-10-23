/**
 * Touch and pointer input.
 *
 * The gesture grammar is deliberately unambiguous, because a city builder on a phone
 * lives or dies on this:
 *
 *   - Not building: one finger pans (with momentum), two fingers pan and pinch.
 *   - Building:     one finger positions and paints, two fingers pan and pinch.
 *   - Long press:   inspect whatever is under the finger, in either mode.
 *
 * Mouse and trackpad are supported too, so the game is playable in a desktop browser
 * while you are developing it.
 */

import { clamp } from './core';
import { Camera } from './scene';

export interface InputHandlers {
  /** True while a building or road is armed for placement. */
  isBuilding: () => boolean;
  onCursorMove: (sx: number, sy: number) => void;
  onPaintStart: (sx: number, sy: number) => void;
  onPaintMove: (sx: number, sy: number) => void;
  onPaintEnd: () => void;
  onTap: (sx: number, sy: number) => void;
  onLongPress: (sx: number, sy: number) => void;
  onCancel: () => void;
}

interface Pt {
  id: number;
  x: number;
  y: number;
  sx: number;
  sy: number;
  t: number;
}

const TAP_MS = 260;
const TAP_SLOP = 12;
const LONG_MS = 460;

export class Input {
  private el: HTMLElement;
  private cam: Camera;
  private h: InputHandlers;

  private pts = new Map<number, Pt>();
  private painting = false;
  private panning = false;
  private longTimer: number | null = null;
  private pinchDist = 0;
  private pinchZoom = 1;
  private lastMoveT = 0;
  private lastMoveX = 0;
  private lastMoveY = 0;
  /** Set once a gesture has clearly become a drag, so it cannot also fire a tap. */
  private moved = false;

  /** Viewport size in CSS pixels; kept in sync by the game loop. */
  viewW = 1;
  viewH = 1;
  /** When the player last touched the world, for frame pacing. */
  lastInputTime = 0;
  /** Is a finger on the glass right now? */
  get touching(): boolean {
    return this.pts.size > 0;
  }

  constructor(el: HTMLElement, cam: Camera, handlers: InputHandlers) {
    this.el = el;
    this.cam = cam;
    this.h = handlers;
    this.attach();
  }

  private attach(): void {
    const el = this.el;
    const opts = { passive: false } as AddEventListenerOptions;
    el.addEventListener('pointerdown', this.onDown, opts);
    el.addEventListener('pointermove', this.onMove, opts);
    el.addEventListener('pointerup', this.onUp, opts);
    el.addEventListener('pointercancel', this.onUp, opts);
    el.addEventListener('wheel', this.onWheel, opts);
    // iOS Safari still fires these on some surfaces; suppressing them stops the page
    // from zooming out from under the canvas.
    el.addEventListener('gesturestart', this.prevent as any, opts);
    el.addEventListener('gesturechange', this.prevent as any, opts);
    el.addEventListener('contextmenu', this.prevent as any, opts);
  }

  private prevent = (e: Event) => e.preventDefault();

  private local(e: PointerEvent): [number, number] {
    const rect = this.el.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  private onDown = (e: PointerEvent): void => {
    e.preventDefault();
    this.lastInputTime = performance.now();
    this.el.setPointerCapture?.(e.pointerId);
    const [x, y] = this.local(e);
    const now = performance.now();
    this.pts.set(e.pointerId, { id: e.pointerId, x, y, sx: x, sy: y, t: now });
    this.moved = false;

    if (this.pts.size === 1) {
      this.cam.vx = 0;
      this.cam.vy = 0;
      this.lastMoveT = now;
      this.lastMoveX = x;
      this.lastMoveY = y;

      if (this.h.isBuilding()) {
        this.painting = true;
        this.h.onCursorMove(x, y);
        this.h.onPaintStart(x, y);
      } else {
        this.panning = true;
      }
      this.longTimer = window.setTimeout(() => {
        this.longTimer = null;
        if (!this.moved && this.pts.size === 1) {
          this.cancelGesture();
          this.h.onLongPress(x, y);
        }
      }, LONG_MS);
    } else if (this.pts.size === 2) {
      // A second finger always means navigate, never build.
      this.clearLong();
      if (this.painting) {
        this.painting = false;
        this.h.onCancel();
      }
      this.panning = true;
      const [a, b] = [...this.pts.values()];
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      this.pinchZoom = this.cam.tzoom;
    }
  };

  private onMove = (e: PointerEvent): void => {
    const p = this.pts.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    this.lastInputTime = performance.now();
    const [x, y] = this.local(e);
    const prevX = p.x;
    const prevY = p.y;
    p.x = x;
    p.y = y;
    if (Math.hypot(x - p.sx, y - p.sy) > TAP_SLOP) {
      this.moved = true;
      this.clearLong();
    }

    if (this.pts.size >= 2) {
      const [a, b] = [...this.pts.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = [(a.x + b.x) / 2, (a.y + b.y) / 2] as [number, number];

      if (this.pinchDist > 0) {
        const targetZoom = clamp(this.pinchZoom * (dist / this.pinchDist), this.cam.minZoom, this.cam.maxZoom);
        // Zoom about the pinch midpoint so the world stays under your fingers.
        const before = this.cam.screenToWorld(mid[0], mid[1], this.viewW, this.viewH);
        this.cam.tzoom = targetZoom;
        this.cam.zoom = targetZoom;
        const after = this.cam.screenToWorld(mid[0], mid[1], this.viewW, this.viewH);
        this.cam.tx += before[0] - after[0];
        this.cam.ty += before[1] - after[1];
        this.cam.x += before[0] - after[0];
        this.cam.y += before[1] - after[1];
      }
      // Two-finger drag also pans, using the midpoint delta of this one pointer.
      const dx = (x - prevX) / this.cam.zoom;
      const dy = (y - prevY) / this.cam.zoom;
      this.cam.tx -= dx / 2;
      this.cam.ty -= dy / 2;
      return;
    }

    if (this.painting) {
      this.h.onCursorMove(x, y);
      this.h.onPaintMove(x, y);
      return;
    }

    if (this.panning) {
      const dx = (x - prevX) / this.cam.zoom;
      const dy = (y - prevY) / this.cam.zoom;
      this.cam.tx -= dx;
      this.cam.ty -= dy;

      const now = performance.now();
      const dt = (now - this.lastMoveT) / 1000;
      if (dt > 0.004) {
        // Velocity for the fling, in world pixels per second.
        this.cam.vx = -((x - this.lastMoveX) / this.cam.zoom) / dt;
        this.cam.vy = -((y - this.lastMoveY) / this.cam.zoom) / dt;
        this.lastMoveT = now;
        this.lastMoveX = x;
        this.lastMoveY = y;
      }
    }
  };

  private onUp = (e: PointerEvent): void => {
    const p = this.pts.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    this.pts.delete(e.pointerId);
    this.clearLong();

    const held = performance.now() - p.t;
    const dist = Math.hypot(p.x - p.sx, p.y - p.sy);

    if (this.painting) {
      this.painting = false;
      this.h.onPaintEnd();
    } else if (this.panning && this.pts.size === 0) {
      this.panning = false;
      if (held < TAP_MS && dist < TAP_SLOP && !this.moved) {
        this.cam.vx = 0;
        this.cam.vy = 0;
        this.h.onTap(p.x, p.y);
      }
    }

    if (this.pts.size < 2) this.pinchDist = 0;
    if (this.pts.size === 0) {
      this.panning = false;
      this.moved = false;
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.lastInputTime = performance.now();
    const rect = this.el.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const before = this.cam.screenToWorld(mx, my, this.viewW, this.viewH);
    const factor = Math.exp(-e.deltaY * 0.0016);
    this.cam.tzoom = clamp(this.cam.tzoom * factor, this.cam.minZoom, this.cam.maxZoom);
    this.cam.zoom = this.cam.tzoom;
    const after = this.cam.screenToWorld(mx, my, this.viewW, this.viewH);
    this.cam.tx += before[0] - after[0];
    this.cam.ty += before[1] - after[1];
    this.cam.x += before[0] - after[0];
    this.cam.y += before[1] - after[1];
  };

  private clearLong(): void {
    if (this.longTimer !== null) {
      clearTimeout(this.longTimer);
      this.longTimer = null;
    }
  }

  private cancelGesture(): void {
    this.clearLong();
    if (this.painting) {
      this.painting = false;
      this.h.onCancel();
    }
    this.panning = false;
  }

  /** Nudge the camera by a screen-space delta, for on-screen controls. */
  nudge(dx: number, dy: number): void {
    this.cam.tx += dx / this.cam.zoom;
    this.cam.ty += dy / this.cam.zoom;
  }

  zoomBy(factor: number): void {
    this.cam.tzoom = clamp(this.cam.tzoom * factor, this.cam.minZoom, this.cam.maxZoom);
  }
}
