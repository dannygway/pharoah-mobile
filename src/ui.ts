/**
 * User interface.
 *
 * The UI is DOM rather than canvas-drawn. On iOS that buys native momentum scrolling,
 * real accessibility, correct safe-area handling and text that stays crisp at any pixel
 * ratio — all things that are painful to reimplement inside WebGL, and none of which
 * cost anything at 120Hz because the DOM only touches the compositor when it changes.
 */

import { clamp, money, plural } from './core';
import {
  BUILDINGS, BUILDING_BY_ID, CATEGORY_META, CATEGORY_ORDER, BuildCategory, BuildingDef,
  GOODS, GoodId, GOD_IDS, GODS, GodId, HOUSING, FOOD_IDS, HOUSEHOLD_GOODS, MONTHS,
  SEASONS, RELIGION_SERVICE, ALL_GOOD_IDS, LaborSector,
} from './data';
import { Game, SPEEDS, DEMOLISH, listSaves, readSave, deleteSave, loadUnlocked, SaveInfo } from './game';
import { OVERLAYS, OverlayId, tileToWorld } from './scene';
import { MISSIONS, SANDBOX, ALL_MISSIONS, Mission } from './missions';
import { TICKS_PER_YEAR } from './consts';
import { Terrain } from './world';

// ---------------------------------------------------------------------------
// Tiny DOM helpers
// ---------------------------------------------------------------------------

type Attrs = Record<string, any>;
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Attrs = {}, ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style') Object.assign(n.style, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      n.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'html') n.innerHTML = v;
    else n.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c == null) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
}

const clear = (n: HTMLElement) => {
  while (n.firstChild) n.removeChild(n.firstChild);
};

function bar(frac: number, color: string): HTMLElement {
  return el('div', { class: 'bar' },
    el('i', { style: { width: `${clamp(frac, 0, 1) * 100}%`, background: color } }));
}

function row(label: string, value: string | Node, cls = ''): HTMLElement {
  return el('div', { class: `row ${cls}` },
    el('span', { class: 'k' }, label),
    typeof value === 'string' ? el('span', { class: 'v' }, value) : value);
}

// ---------------------------------------------------------------------------

export class UI {
  game: Game;
  root: HTMLElement;

  private topBar!: HTMLElement;
  private bottomBar!: HTMLElement;
  private sheet!: HTMLElement;
  private sheetBody!: HTMLElement;
  private sheetTitle!: HTMLElement;
  private card!: HTMLElement;
  private toastWrap!: HTMLElement;
  private modal!: HTMLElement;
  private minimap!: HTMLCanvasElement;
  private minimapWrap!: HTMLElement;
  private goalsPanel!: HTMLElement;

  private sheetView: string | null = null;
  private activeCategory: BuildCategory | null = null;
  private lastMessageId = 0;
  private minimapTimer = 0;

  onNewGame: ((missionId: string) => void) | null = null;
  onLoadGame: ((slot: string) => void) | null = null;

  constructor(game: Game, root: HTMLElement) {
    this.game = game;
    this.root = root;
    this.build();
    game.onChange = () => this.refresh();
    game.onStatusChange = (s) => this.showOutcome(s);
    game.onInspect = (id) => {
      if (id >= 0) this.openBuildingDetail(id);
    };
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  private build(): void {
    this.topBar = el('div', { class: 'top-bar' });
    this.goalsPanel = el('div', { class: 'goals-panel hidden' });
    this.minimapWrap = el('div', { class: 'minimap hidden' });
    this.minimap = el('canvas', { width: 180, height: 180 });
    this.minimapWrap.appendChild(this.minimap);
    this.minimapWrap.addEventListener('pointerdown', (e) => this.minimapJump(e));

    this.card = el('div', { class: 'card hidden' });
    this.toastWrap = el('div', { class: 'toasts' });

    this.sheetTitle = el('div', { class: 'sheet-title' });
    this.sheetBody = el('div', { class: 'sheet-body' });
    this.sheet = el('div', { class: 'sheet hidden' },
      el('div', { class: 'sheet-head' },
        this.sheetTitle,
        el('button', { class: 'x', onclick: () => this.closeSheet() }, '✕')),
      this.sheetBody);

    this.bottomBar = el('div', { class: 'bottom-bar' });
    this.modal = el('div', { class: 'modal hidden' });

    this.root.append(
      this.topBar, this.goalsPanel, this.minimapWrap, this.card,
      this.toastWrap, this.sheet, this.bottomBar, this.modal,
    );

    this.buildBottomBar();
    this.refresh();
  }

  private buildBottomBar(): void {
    clear(this.bottomBar);

    const tools = el('div', { class: 'tools' });
    tools.append(
      this.toolButton('☰', 'Menu', () => this.openMenu()),
      this.toolButton('🎨', 'Overlays', () => this.openSheet('overlays')),
      this.toolButton('👤', 'Advisors', () => this.openSheet('advisors')),
      this.toolButton('✉️', 'Messages', () => this.openSheet('messages'), 'msg-btn'),
      this.toolButton('⛏️', 'Demolish', () => this.toggleDemolish(), 'demolish-btn'),
    );

    const cats = el('div', { class: 'cats' });
    for (const cat of CATEGORY_ORDER) {
      const meta = CATEGORY_META[cat];
      const available = BUILDINGS.some((b) => b.cat === cat && this.game.isUnlocked(b.id));
      if (!available) continue;
      const btn = el('button', {
        class: 'cat',
        'data-cat': cat,
        onclick: () => this.openCategory(cat),
      },
        el('span', { class: 'glyph', style: { color: meta.color } }, meta.glyph),
        el('span', { class: 'lbl' }, meta.name));
      cats.appendChild(btn);
    }

    this.bottomBar.append(cats, tools);
  }

  private toolButton(glyph: string, label: string, fn: () => void, cls = ''): HTMLElement {
    return el('button', { class: `tool ${cls}`, onclick: fn, 'aria-label': label },
      el('span', { class: 'glyph' }, glyph),
      el('span', { class: 'lbl' }, label));
  }

  // -------------------------------------------------------------------------
  // Refresh
  // -------------------------------------------------------------------------

  refresh(): void {
    this.refreshTopBar();
    this.refreshCard();
    this.refreshGoals();
    this.refreshToasts();
    const msgBtn = this.bottomBar.querySelector('.msg-btn');
    const unread = this.game.city.unreadMessages;
    if (msgBtn) msgBtn.classList.toggle('badge', unread > 0);
    const demoBtn = this.bottomBar.querySelector('.demolish-btn');
    if (demoBtn) demoBtn.classList.toggle('active', this.game.armed === DEMOLISH);
    for (const b of this.bottomBar.querySelectorAll('.cat')) {
      const cat = b.getAttribute('data-cat');
      b.classList.toggle('active', this.activeCategory === cat && this.sheetView === 'build');
    }
    if (this.sheetView === 'build' && this.activeCategory) this.renderBuildList(this.activeCategory);
  }

  /** Called every frame from the game loop for the cheap, always-changing bits. */
  tick(dt: number): void {
    const c = this.game.city;
    const dateEl = this.topBar.querySelector('.date-line');
    if (dateEl) dateEl.textContent = `${MONTHS[c.month]} · Year ${c.year + 1} · ${SEASONS[c.season].name}`;
    const floodEl = this.topBar.querySelector('.flood');
    if (floodEl) floodEl.textContent = `💧 ${Math.round(c.floodLevel * 100)}%`;
    const fundsEl = this.topBar.querySelector('.funds .v');
    if (fundsEl) fundsEl.textContent = money(c.funds);
    const popEl = this.topBar.querySelector('.pop .v');
    if (popEl) popEl.textContent = String(c.population);

    this.minimapTimer += dt;
    if (this.minimapTimer > 0.5 && !this.minimapWrap.classList.contains('hidden')) {
      this.minimapTimer = 0;
      this.drawMinimap();
    }
    this.refreshToasts();
  }

  /**
   * Two rows, because a phone is 400 points wide: the date and the running totals on
   * top, the four ratings and the controls beneath. Speed is a pause button plus one
   * button that cycles, rather than five buttons nobody has room for.
   */
  private refreshTopBar(): void {
    const c = this.game.city;
    clear(this.topBar);

    const rowOne = el('div', { class: 'tb-row one' },
      el('div', { class: 'date-line' }, `${MONTHS[c.month]} · Year ${c.year + 1} · ${SEASONS[c.season].name}`),
      el('div', { class: 'stat-line' },
        el('span', { class: 'funds' }, '🪙 ', el('span', { class: 'v' }, money(c.funds))),
        el('span', { class: 'pop' }, '👥 ', el('span', { class: 'v' }, String(c.population))),
        el('span', { class: 'flood', title: 'Nile level' }, `💧 ${Math.round(c.floodLevel * 100)}%`)));

    const ratings = el('div', { class: 'ratings' });
    const pills: [string, number, string][] = [
      ['Cul', c.ratings.culture, '#c9564a'],
      ['Pro', c.ratings.prosperity, '#c9a24a'],
      ['Mon', c.ratings.monument, '#ded3b0'],
      ['Kng', c.ratings.kingdom, '#8f7fc0'],
    ];
    for (const [name, v, col] of pills) {
      ratings.appendChild(el('button', { class: 'pill', onclick: () => this.openSheet('advisors') },
        el('span', { class: 'pn' }, name),
        el('span', { class: 'pv', style: { color: col } }, String(Math.round(v)))));
    }

    const paused = this.game.speedIndex === 0;
    const rowTwo = el('div', { class: 'tb-row two' },
      ratings,
      el('div', { class: 'tb-ctl' },
        el('button', {
          class: 'icon', 'aria-label': 'Minimap',
          onclick: () => { this.minimapWrap.classList.toggle('hidden'); this.drawMinimap(); },
        }, '🗺️'),
        el('button', {
          class: 'icon', 'aria-label': 'Objectives',
          onclick: () => this.goalsPanel.classList.toggle('hidden'),
        }, '🎯'),
        el('button', {
          class: `icon sp ${paused ? 'on' : ''}`, 'aria-label': 'Pause',
          onclick: () => this.game.setSpeed(paused ? 1 : 0),
        }, paused ? '▶' : '❙❙'),
        el('button', {
          class: 'icon sp', 'aria-label': 'Game speed',
          onclick: () => {
            // Cycle through the running speeds, never back into pause.
            const next = this.game.speedIndex >= SPEEDS.length - 1 ? 1 : Math.max(1, this.game.speedIndex + 1);
            this.game.setSpeed(next);
          },
        }, `${SPEEDS[Math.max(1, this.game.speedIndex)]}×`)));

    this.topBar.append(rowOne, rowTwo);
  }

  private refreshGoals(): void {
    const g = this.game.goalProgress();
    clear(this.goalsPanel);
    if (!g.length) {
      this.goalsPanel.appendChild(el('div', { class: 'goal-none' }, 'Sandbox — build as you please.'));
      return;
    }
    this.goalsPanel.appendChild(el('div', { class: 'goal-head' }, this.game.mission.name));
    for (const p of g) {
      this.goalsPanel.appendChild(el('div', { class: `goal ${p.met ? 'met' : ''}` },
        el('span', { class: 'gl' }, p.label),
        bar(p.current / Math.max(1, p.target), p.met ? '#6fbf6f' : '#c9a24a'),
        el('span', { class: 'gv' }, `${p.current}/${p.target}`)));
    }
  }

  // -------------------------------------------------------------------------
  // Selection card
  // -------------------------------------------------------------------------

  private refreshCard(): void {
    const b = this.game.selectedBuilding();
    if (!b) {
      this.card.classList.add('hidden');
      return;
    }
    const def = BUILDING_BY_ID[b.defId];
    const c = this.game.city;
    clear(this.card);
    this.card.classList.remove('hidden');

    const title = b.house
      ? (b.house.level === 0 || b.house.people === 0 ? 'Empty housing lot' : HOUSING[b.house.level].name)
      : def.name;

    const head = el('div', { class: 'card-head' },
      el('div', { class: 'ct' }, title),
      el('button', { class: 'x', onclick: () => { this.game.scene.selected = -1; this.refresh(); } }, '✕'));

    const body = el('div', { class: 'card-body' });

    if (b.house) {
      const h = b.house;
      body.append(
        row('Residents', `${h.people} / ${HOUSING[h.level].capacity}`),
        row('Health', `${Math.round(h.health)}%`),
        row('Desirability', String(c.world.desirability[c.world.idx(b.x, b.y)])),
      );
      if (h.blocker) body.append(el('div', { class: 'blocker' }, `Cannot advance: ${h.blocker}`));
      const foods = FOOD_IDS.filter((f) => (h.foods[f] ?? 0) > 0.05);
      if (foods.length) {
        body.append(row('Food', foods.map((f) => `${GOODS[f].glyph}${Math.floor(h.foods[f]!)}`).join(' ')));
      }
      const goods = HOUSEHOLD_GOODS.filter((g) => (h.goods[g] ?? 0) > 0.05);
      if (goods.length) {
        body.append(row('Goods', goods.map((g) => `${GOODS[g].glyph}${Math.floor(h.goods[g]!)}`).join(' ')));
      }
    } else {
      if (def.workers) {
        body.append(row('Workers', `${b.workers} / ${def.workers}`, b.staffing < 0.6 ? 'warn' : ''));
      }
      if (!b.hasRoad && def.needsRoad) {
        body.append(el('div', { class: 'blocker' }, 'No road access — this building does nothing.'));
      }
      if (b.monument && !b.monument.complete) {
        const p = this.game.systems.monumentProgress(b);
        body.append(
          row('Stage', `${p.stage} of ${p.total}`),
          el('div', { class: 'stage-label' }, p.label),
          bar(p.frac, '#c9a24a'),
        );
        const stage = def.monument!.stages[b.monument.stage];
        for (const [g, need] of Object.entries(stage.materials)) {
          const have = b.monument.delivered[g as GoodId] ?? 0;
          body.append(row(GOODS[g as GoodId].name, `${Math.floor(have)} / ${need}`));
        }
        body.append(row('Labour', `${Math.floor(b.monument.laborDone)} / ${stage.labor}`));
      }
      const stored = Object.entries(b.store).filter(([, v]) => (v ?? 0) > 0.5);
      if (stored.length) {
        body.append(row('Stored', stored.slice(0, 8)
          .map(([g, v]) => `${GOODS[g as GoodId].glyph}${Math.floor(v as number)}`).join(' ')));
      }
      if (b.garrison) {
        body.append(
          row('Company', `${b.garrison.strength} / ${b.garrison.maxStrength}`),
          row('Morale', `${Math.round(b.garrison.morale)}%`),
          row('Training', `${Math.round(b.garrison.training)}%`),
        );
      }
      if (def.fireRisk || b.fire > 10) body.append(row('Fire risk', `${Math.round(b.fire)}%`, b.fire > 60 ? 'warn' : ''));
      if (b.damage > 10) body.append(row('Damage', `${Math.round(b.damage)}%`, b.damage > 60 ? 'warn' : ''));
    }

    const actions = el('div', { class: 'card-actions' },
      el('button', { onclick: () => this.openBuildingDetail(b.id) }, 'Details'),
      def.workers > 0 || def.produces ? el('button', {
        onclick: () => { b.enabled = !b.enabled; this.refresh(); },
      }, b.enabled ? 'Mothball' : 'Reopen') : null,
      el('button', {
        class: 'danger',
        onclick: () => {
          this.game.city.demolish(b.x, b.y, true);
          this.game.audio.demolish();
          this.game.scene.selected = -1;
          this.game.city.markDirty();
          this.refresh();
        },
      }, 'Demolish'));

    this.card.append(head, body, actions);
  }

  private openBuildingDetail(id: number): void {
    const b = this.game.city.buildings[id];
    if (!b) return;
    const def = BUILDING_BY_ID[b.defId];
    const body = el('div', { class: 'detail' });
    body.append(el('p', { class: 'desc' }, def.desc));

    if (b.house) {
      const h = b.house;
      const lvl = HOUSING[h.level];
      body.append(el('h4', {}, `${lvl.name} · level ${h.level} of 20`));
      body.append(row('Residents', `${h.people} / ${lvl.capacity}`));
      body.append(row('Tax yield', `${(h.people * lvl.taxPerPerson).toFixed(1)} deben/month`));
      body.append(row('Assessed', h.taxFresh > 0 ? 'Yes' : 'No — no tax collector has called'));
      body.append(el('h4', {}, 'Services received'));
      const svc: [string, boolean][] = [
        ['Water supply', !!h.services.water],
        ['Well water', !!h.services.wellWater],
        ...GOD_IDS.map((g) => [GODS[g].name, !!h.services[RELIGION_SERVICE[g]]] as [string, boolean]),
        ['Scribal school', !!h.services.school],
        ['Library', !!h.services.library],
        ['Booth', !!h.services.booth],
        ['Bandstand', !!h.services.bandstand],
        ['Pavilion', !!h.services.pavilion],
        ['Senet house', !!h.services.senet],
        ['Apothecary', !!h.services.apothecary],
        ['Physician', !!h.services.physician],
        ['Dentist', !!h.services.dentist],
        ['Mortuary', !!h.services.mortuary],
      ];
      const grid = el('div', { class: 'svc-grid' });
      for (const [n, ok] of svc) {
        grid.appendChild(el('div', { class: `svc ${ok ? 'on' : 'off'}` }, `${ok ? '✓' : '·'} ${n}`));
      }
      body.append(grid);
      if (h.level < 20) {
        const next = HOUSING[h.level + 1];
        body.append(el('h4', {}, `To become a ${next.name.toLowerCase()}`));
        body.append(el('p', { class: 'blocker' }, h.blocker || 'All requirements met — it will advance shortly.'));
      }
    } else {
      if (def.workers) body.append(row('Workers', `${b.workers} of ${def.workers} (${def.sector})`));
      if (def.consumes) {
        body.append(el('h4', {}, 'Consumes'));
        for (const [g, q] of Object.entries(def.consumes)) {
          body.append(row(GOODS[g as GoodId].name, `${q} per cycle · ${Math.floor(b.store[g as GoodId] ?? 0)} in store`));
        }
      }
      if (def.produces) {
        body.append(el('h4', {}, 'Produces'));
        body.append(row(GOODS[def.produces].name, `${def.produceQty} per cycle`));
        body.append(bar(b.progress / (def.cycleTicks ?? 600), '#8aa84c'));
      }
      if (def.storage) {
        const used = Object.values(b.store).reduce((a: number, v) => a + (v ?? 0), 0);
        body.append(el('h4', {}, `Storage — ${Math.floor(used)} of ${def.storage}`));
        const list = el('div', { class: 'store-grid' });
        for (const g of ALL_GOOD_IDS) {
          const q = b.store[g] ?? 0;
          if (q < 0.5) continue;
          list.appendChild(el('div', { class: 'store-item' }, `${GOODS[g].glyph} ${GOODS[g].name}: ${Math.floor(q)}`));
        }
        body.append(list);
      }
      if (def.desirability) {
        body.append(row('Desirability', `${def.desirability.value > 0 ? '+' : ''}${def.desirability.value} over ${def.desirability.range} tiles`));
      }
      body.append(row('Upkeep', `${def.upkeep} deben/month`));
    }

    this.openSheetCustom(def.name, body);
  }

  // -------------------------------------------------------------------------
  // Sheet
  // -------------------------------------------------------------------------

  private openSheetCustom(title: string, body: HTMLElement): void {
    this.sheetTitle.textContent = title;
    clear(this.sheetBody);
    this.sheetBody.appendChild(body);
    this.sheet.classList.remove('hidden');
    this.sheetView = 'custom';
  }

  closeSheet(): void {
    this.sheet.classList.add('hidden');
    this.sheetView = null;
    this.activeCategory = null;
    this.refresh();
  }

  private openSheet(view: string): void {
    this.sheetView = view;
    this.sheet.classList.remove('hidden');
    switch (view) {
      case 'overlays': this.renderOverlays(); break;
      case 'advisors': this.renderAdvisors(); break;
      case 'messages': this.renderMessages(); break;
    }
    this.refresh();
  }

  private openCategory(cat: BuildCategory): void {
    if (this.activeCategory === cat && this.sheetView === 'build') {
      this.closeSheet();
      return;
    }
    this.activeCategory = cat;
    this.sheetView = 'build';
    this.sheet.classList.remove('hidden');
    this.renderBuildList(cat);
    this.refresh();
  }

  private renderBuildList(cat: BuildCategory): void {
    const meta = CATEGORY_META[cat];
    this.sheetTitle.textContent = meta.name;
    clear(this.sheetBody);
    const grid = el('div', { class: 'build-grid' });

    for (const def of BUILDINGS) {
      if (def.cat !== cat) continue;
      if (!this.game.isUnlocked(def.id)) continue;
      const affordable = this.game.city.funds >= def.cost;
      const armed = this.game.armed === def.id;
      const btn = el('button', {
        class: `build-item ${armed ? 'armed' : ''} ${affordable ? '' : 'poor'}`,
        onclick: () => {
          this.game.arm(armed ? null : def.id);
          this.game.audio.tap();
          this.refresh();
        },
      },
        el('div', { class: 'bi-name' }, def.name),
        el('div', { class: 'bi-meta' },
          el('span', { class: 'cost' }, `𓋞 ${def.cost}`),
          def.workers ? el('span', { class: 'wk' }, `👤 ${def.workers}`) : null,
          def.size > 1 ? el('span', { class: 'sz' }, `${def.size}×${def.size}`) : null),
        el('div', { class: 'bi-desc' }, def.desc));
      grid.appendChild(btn);
    }
    this.sheetBody.appendChild(grid);
  }

  private renderOverlays(): void {
    this.sheetTitle.textContent = 'Overlays';
    clear(this.sheetBody);
    const grid = el('div', { class: 'chip-grid' });
    for (const o of OVERLAYS) {
      grid.appendChild(el('button', {
        class: `chip ${this.game.scene.overlay === o.id ? 'on' : ''}`,
        onclick: () => { this.game.setOverlay(o.id); this.renderOverlays(); },
      }, o.name));
    }
    this.sheetBody.append(
      el('p', { class: 'hint' }, 'Overlays colour the map by one measure so you can see at a glance which districts are being served.'),
      grid,
    );
  }

  private renderMessages(): void {
    this.sheetTitle.textContent = 'Messages';
    clear(this.sheetBody);
    const c = this.game.city;
    if (!c.messages.length) {
      this.sheetBody.appendChild(el('p', { class: 'hint' }, 'Nothing to report.'));
      return;
    }
    const list = el('div', { class: 'msg-list' });
    for (const m of c.messages) {
      const item = el('div', { class: `msg ${m.kind} ${m.read ? '' : 'unread'}` },
        el('div', { class: 'msg-h' },
          el('span', { class: 'msg-t' }, m.title),
          el('span', { class: 'msg-d' }, `Yr ${Math.floor(m.tick / TICKS_PER_YEAR) + 1}`)),
        el('div', { class: 'msg-b' }, m.body));
      item.addEventListener('click', () => {
        m.read = true;
        if (m.tile !== undefined) this.game.centreOnTile(m.tile);
        this.refresh();
      });
      list.appendChild(item);
    }
    for (const m of c.messages) m.read = true;
    this.sheetBody.appendChild(list);
  }

  // -------------------------------------------------------------------------
  // Advisors
  // -------------------------------------------------------------------------

  private renderAdvisors(): void {
    this.sheetTitle.textContent = 'Advisors';
    clear(this.sheetBody);
    const tabs = el('div', { class: 'chip-grid' });
    const panel = el('div', { class: 'advisor-panel' });
    const names: [string, () => HTMLElement][] = [
      ['Overview', () => this.advisorOverview()],
      ['Labour', () => this.advisorLabour()],
      ['Population', () => this.advisorPopulation()],
      ['Religion', () => this.advisorReligion()],
      ['Trade', () => this.advisorTrade()],
      ['Imperial', () => this.advisorImperial()],
      ['Military', () => this.advisorMilitary()],
      ['Finance', () => this.advisorFinance()],
    ];
    let current = 0;
    const show = (i: number) => {
      current = i;
      clear(panel);
      panel.appendChild(names[i][1]());
      for (const [k, b] of [...tabs.children].entries()) b.classList.toggle('on', k === i);
    };
    names.forEach(([n], i) => {
      tabs.appendChild(el('button', { class: 'chip', onclick: () => show(i) }, n));
    });
    this.sheetBody.append(tabs, panel);
    show(0);
  }

  private advisorOverview(): HTMLElement {
    const c = this.game.city;
    const box = el('div', {});
    const foodMonths = c.foodMonthsRemaining();
    box.append(
      el('h4', {}, 'The state of the city'),
      row('Population', `${c.population} in ${c.liveBuildings.filter((i) => c.buildings[i]?.house).length} houses`),
      row('Housing capacity', String(c.stats.capacity)),
      row('Food in store', `${c.stats.foodStored} — about ${foodMonths.toFixed(1)} months`, foodMonths < 2 ? 'warn' : ''),
      row('Average health', `${c.stats.avgHealth}%`, c.stats.avgHealth < 50 ? 'warn' : ''),
      row('Literacy', `${c.stats.literacy}%`),
      row('Unemployment', `${Math.round(c.unemployment * 100)}%`, c.unemployment > 0.15 ? 'warn' : ''),
      row('Migration', c.stats.immigrationRate > 0.4 ? 'People are arriving' :
        c.stats.immigrationRate < -1.2 ? 'People are leaving' : 'Settled'),
      el('h4', {}, 'Ratings'),
    );
    const rt: [string, number][] = [
      ['Culture', c.ratings.culture], ['Prosperity', c.ratings.prosperity],
      ['Monuments', c.ratings.monument], ['Kingdom', c.ratings.kingdom],
    ];
    for (const [n, v] of rt) {
      box.append(el('div', { class: 'row' }, el('span', { class: 'k' }, n),
        bar(v / 100, '#c9a24a'), el('span', { class: 'v' }, String(Math.round(v)))));
    }
    return box;
  }

  private advisorLabour(): HTMLElement {
    const c = this.game.city;
    const box = el('div', {});
    box.append(
      el('p', { class: 'hint' }, 'Workers are handed out in this order. Drag a sector up to serve it first when labour is short.'),
      row('Workforce', String(c.workforce)),
      row('Employed', String(c.employed)),
      row('Jobs needing workers', String(c.stats.workersNeeded)),
      row('Unemployed', String(c.stats.unemployed), c.stats.unemployed > c.workforce * 0.15 ? 'warn' : ''),
    );
    const list = el('div', { class: 'prio-list' });
    c.laborPriority.forEach((sector, i) => {
      list.appendChild(el('div', { class: 'prio' },
        el('span', { class: 'pn' }, `${i + 1}. ${sector}`),
        el('span', { class: 'pbtns' },
          el('button', {
            onclick: () => {
              if (i === 0) return;
              const a = c.laborPriority;
              [a[i - 1], a[i]] = [a[i], a[i - 1]];
              this.renderAdvisors();
            },
          }, '▲'),
          el('button', {
            onclick: () => {
              const a = c.laborPriority;
              if (i >= a.length - 1) return;
              [a[i + 1], a[i]] = [a[i], a[i + 1]];
              this.renderAdvisors();
            },
          }, '▼'))));
    });
    box.append(list);
    return box;
  }

  private advisorPopulation(): HTMLElement {
    const c = this.game.city;
    const box = el('div', {});
    const byLevel = new Map<number, number>();
    for (const id of c.liveBuildings) {
      const b = c.buildings[id];
      if (!b?.house || b.house.people === 0) continue;
      byLevel.set(b.house.level, (byLevel.get(b.house.level) ?? 0) + b.house.people);
    }
    box.append(el('h4', {}, 'Where your people live'));
    if (!byLevel.size) {
      box.append(el('p', { class: 'hint' }, 'Nobody has settled yet. Lay roads and mark out housing.'));
      return box;
    }
    const max = Math.max(...byLevel.values());
    for (const [lvl, n] of [...byLevel.entries()].sort((a, b) => b[0] - a[0])) {
      box.append(el('div', { class: 'row' },
        el('span', { class: 'k' }, HOUSING[lvl].name),
        bar(n / max, '#c08a4e'),
        el('span', { class: 'v' }, String(n))));
    }
    return box;
  }

  private advisorReligion(): HTMLElement {
    const c = this.game.city;
    const sys = this.game.systems;
    const box = el('div', {});
    box.append(el('p', { class: 'hint' }, 'A god with a falling mood will eventually act on it. Temples raise worship steadily; a festival raises it at once.'));
    for (const g of GOD_IDS) {
      const god = GODS[g];
      const mood = c.godMood[g];
      const label = mood > 60 ? 'delighted' : mood > 20 ? 'content' : mood > -20 ? 'indifferent' :
        mood > -60 ? 'displeased' : 'furious';
      box.append(el('div', { class: 'god' },
        el('div', { class: 'god-h' },
          el('span', { class: 'gg', style: { color: god.color } }, god.glyph),
          el('span', { class: 'gn' }, god.name),
          el('span', { class: 'gm' }, label)),
        bar((mood + 100) / 200, god.color),
        el('div', { class: 'gd' }, god.domain)));
    }
    const canFest = c.countOf('festival_square') > 0;
    box.append(el('h4', {}, 'Festivals'));
    if (!canFest) {
      box.append(el('p', { class: 'hint' }, 'You need a festival square before you can hold one.'));
    } else if (sys.festival) {
      box.append(el('p', { class: 'hint' }, `A ${sys.festival.scale} festival for ${GODS[sys.festival.god].name} is being prepared.`));
    } else {
      const godSel = el('select', { class: 'sel' });
      for (const g of GOD_IDS) godSel.appendChild(el('option', { value: g }, GODS[g].name));
      const scaleSel = el('select', { class: 'sel' });
      for (const [v, l] of [['modest', 'Modest — 150'], ['lavish', 'Lavish — 400'], ['grand', 'Grand — 900']]) {
        scaleSel.appendChild(el('option', { value: v }, l));
      }
      box.append(el('div', { class: 'fest-row' }, godSel, scaleSel,
        el('button', {
          onclick: () => {
            const ok = sys.holdFestival(godSel.value as GodId, scaleSel.value as any);
            ok ? this.game.audio.chime(true) : this.game.audio.error();
            this.renderAdvisors();
          },
        }, 'Proclaim')));
    }
    return box;
  }

  private advisorTrade(): HTMLElement {
    const c = this.game.city;
    const sys = this.game.systems;
    const box = el('div', {});
    box.append(el('h4', {}, 'Trade routes'));
    for (const r of c.trade) {
      const sells = Object.keys(r.sells).map((g) => GOODS[g as GoodId].name).join(', ') || '—';
      const buys = Object.keys(r.buys).map((g) => GOODS[g as GoodId].name).join(', ') || '—';
      box.append(el('div', { class: 'route' },
        el('div', { class: 'rh' },
          el('b', {}, r.city),
          el('span', { class: 'rk' }, r.kind === 'sea' ? 'river route' : 'land route'),
          r.open ? el('span', { class: 'open' }, 'open')
            : el('button', {
              onclick: () => {
                sys.openRoute(r.city) ? this.game.audio.chime(true) : this.game.audio.error();
                this.renderAdvisors();
              },
            }, `Open — ${r.cost}`)),
        el('div', { class: 'rd' }, `Sells you: ${sells}`),
        el('div', { class: 'rd' }, `Buys from you: ${buys}`)));
    }
    box.append(el('h4', {}, 'What to import and export'));
    box.append(el('p', { class: 'hint' }, 'Exports are sold from your storage yards each month; imports are bought into them.'));
    const grid = el('div', { class: 'trade-grid' });
    const relevant = new Set<GoodId>();
    for (const r of c.trade) {
      for (const g of Object.keys(r.sells)) relevant.add(g as GoodId);
      for (const g of Object.keys(r.buys)) relevant.add(g as GoodId);
    }
    for (const g of [...relevant]) {
      const cur = sys.tradePolicy[g] ?? 'none';
      const cycle = () => {
        const order: any[] = ['none', 'import', 'export'];
        sys.setTradePolicy(g, order[(order.indexOf(cur) + 1) % 3]);
        this.renderAdvisors();
      };
      grid.appendChild(el('button', { class: `tg ${cur}`, onclick: cycle },
        el('span', {}, `${GOODS[g].glyph} ${GOODS[g].name}`),
        el('span', { class: 'tp' }, cur === 'none' ? 'ignore' : cur),
        el('span', { class: 'ts' }, `have ${Math.floor(c.totalStored(g))}`)));
    }
    box.append(grid);
    return box;
  }

  private advisorImperial(): HTMLElement {
    const c = this.game.city;
    const sys = this.game.systems;
    const box = el('div', {});
    box.append(row('Standing with Pharaoh', String(Math.round(c.ratings.kingdom))));
    box.append(el('h4', {}, 'Requests'));
    const pending = c.requests.filter((r) => r.resolved === 'pending');
    if (!pending.length) {
      box.append(el('p', { class: 'hint' }, 'Pharaoh asks nothing of you at present.'));
    }
    for (const req of pending) {
      const what = req.good === 'deben' ? 'deben' : req.good === 'troops' ? 'soldiers' : GOODS[req.good as GoodId].name;
      const monthsLeft = Math.max(0, Math.ceil((req.dueTick - c.tick) / (TICKS_PER_YEAR / 12)));
      box.append(el('div', { class: 'request' },
        el('div', {}, `${req.amount} ${what} — ${req.delivered} sent, ${monthsLeft} ${plural(monthsLeft, 'month')} left`),
        bar(req.delivered / req.amount, '#8f7fc0'),
        el('button', {
          onclick: () => {
            const before = req.delivered;
            sys.fulfilRequest(req);
            req.delivered > before ? this.game.audio.chime(true) : this.game.audio.error();
            this.renderAdvisors();
            this.refresh();
          },
        }, 'Send what we have')));
    }
    box.append(el('h4', {}, 'Taxation'));
    const tax = el('input', {
      type: 'range', min: '0', max: '20', step: '1',
      value: String(Math.round(c.taxRate * 100)),
    }) as HTMLInputElement;
    const taxLabel = el('span', { class: 'v' }, `${Math.round(c.taxRate * 100)}%`);
    tax.addEventListener('input', () => {
      c.taxRate = Number(tax.value) / 100;
      taxLabel.textContent = `${tax.value}%`;
    });
    box.append(el('div', { class: 'row' }, el('span', { class: 'k' }, 'Tax rate'), tax, taxLabel));
    box.append(el('p', { class: 'hint' }, 'Above about 12% people begin to resent it and stop arriving.'));
    return box;
  }

  private advisorMilitary(): HTMLElement {
    const c = this.game.city;
    const sys = this.game.systems;
    const box = el('div', {});
    const forts = c.liveBuildings.map((i) => c.buildings[i]).filter((b) => b?.garrison);
    if (!forts.length) {
      box.append(el('p', { class: 'hint' }, 'You have no forts. A recruiter and a fort are needed before you have any army at all.'));
    }
    for (const b of forts) {
      if (!b?.garrison) continue;
      const def = BUILDING_BY_ID[b.defId];
      box.append(el('div', { class: 'fort' },
        el('b', {}, def.name),
        row('Strength', `${b.garrison.strength} / ${b.garrison.maxStrength}`),
        row('Morale', `${Math.round(b.garrison.morale)}%`),
        row('Training', `${Math.round(b.garrison.training)}%`)));
    }
    const upcoming = c.invasions.filter((i) => !i.landed);
    if (upcoming.length) {
      box.append(el('h4', {}, 'Expected attacks'));
      for (const inv of upcoming) {
        const yrs = Math.max(0, (inv.arrivalTick - c.tick) / TICKS_PER_YEAR);
        box.append(row(inv.enemy, `strength ${inv.strength} · about ${yrs.toFixed(1)} years`));
      }
    }
    box.append(el('button', {
      class: 'wide',
      onclick: () => {
        const cam = this.game.scene.camera;
        const [tx, ty] = [cam.x, cam.y];
        // Rally to the centre of the current view.
        const a = tx / (32);
        const b2 = ty / (16);
        const gx = Math.round((b2 + a) / 2);
        const gy = Math.round((b2 - a) / 2);
        const sent = sys.rallyTo(clamp(gx, 0, c.world.size - 1), clamp(gy, 0, c.world.size - 1));
        sent ? this.game.audio.chime(true) : this.game.audio.error();
        c.pushMessage('Companies mustered', `${sent} units are marching to the point you indicated.`, 'info');
        this.refresh();
      },
    }, 'Rally all companies to the centre of the view'));
    return box;
  }

  private advisorFinance(): HTMLElement {
    const c = this.game.city;
    const box = el('div', {});
    box.append(
      row('Treasury', money(c.funds)),
      row('Monthly tax income', money(c.stats.monthlyIncome)),
      row('Monthly expenses', money(c.stats.monthlyExpense)),
      row('Net', money(c.stats.monthlyIncome - c.stats.monthlyExpense),
        c.stats.monthlyIncome < c.stats.monthlyExpense ? 'warn' : ''),
      row('Your personal savings', money(c.savings)),
      row('Your salary', `${c.salary} deben/year`),
    );
    box.append(el('p', { class: 'hint' }, 'Trade is where real money comes from. Tax alone will not build a pyramid.'));
    return box;
  }

  // -------------------------------------------------------------------------
  // Minimap
  // -------------------------------------------------------------------------

  drawMinimap(): void {
    const c = this.game.city;
    const w = c.world;
    const cv = this.minimap;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const N = w.size;
    if (cv.width !== N) {
      cv.width = N;
      cv.height = N;
    }
    const img = ctx.createImageData(N, N);
    const d = img.data;
    for (let i = 0; i < w.area; i++) {
      let r = 0, g = 0, b = 0;
      const bId = w.building[i];
      if (bId >= 0) {
        const bl = c.buildings[bId];
        r = 240; g = 210; b = 150;
        if (bl?.house) { r = 200; g = 140; b = 80; }
      } else if (w.road[i]) {
        r = 165; g = 138; b = 93;
      } else {
        switch (w.terrain[i]) {
          case Terrain.Water: r = 63; g = 125; b = 150; break;
          case Terrain.Floodplain: r = w.flooded[i] ? 110 : 125; g = w.flooded[i] ? 138 : 112; b = w.flooded[i] ? 134 : 66; break;
          case Terrain.Marsh: r = 95; g = 107; b = 69; break;
          case Terrain.Rock: r = 168; g = 151; b = 127; break;
          case Terrain.Dune: r = 224; g = 199; b = 149; break;
          case Terrain.Grass: r = 147; g = 163; b = 94; break;
          default: r = 216; g = 189; b = 138;
        }
      }
      const o = i * 4;
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);

    // Viewport rectangle.
    const cam = this.game.scene.camera;
    const half = [this.game.renderer.viewW / 2 / cam.zoom, this.game.renderer.viewH / 2 / cam.zoom];
    ctx.strokeStyle = 'rgba(255,240,190,0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const pts: [number, number][] = [
      [cam.x - half[0], cam.y - half[1]],
      [cam.x + half[0], cam.y - half[1]],
      [cam.x + half[0], cam.y + half[1]],
      [cam.x - half[0], cam.y + half[1]],
    ];
    pts.forEach(([wx, wy], i) => {
      const tx = (wy / 16 + wx / 32) / 2;
      const ty = (wy / 16 - wx / 32) / 2;
      i ? ctx.lineTo(tx, ty) : ctx.moveTo(tx, ty);
    });
    ctx.closePath();
    ctx.stroke();
  }

  private minimapJump(e: PointerEvent): void {
    const rect = this.minimap.getBoundingClientRect();
    const tx = ((e.clientX - rect.left) / rect.width) * this.game.world.size;
    const ty = ((e.clientY - rect.top) / rect.height) * this.game.world.size;
    this.game.scene.camera.centreOnTile(tx, ty);
  }

  // -------------------------------------------------------------------------
  // Toasts
  // -------------------------------------------------------------------------

  private refreshToasts(): void {
    const c = this.game.city;
    const newest = c.messages[0];
    if (!newest || newest.id === this.lastMessageId) return;
    this.lastMessageId = newest.id;
    if (newest.read) return;

    const t = el('div', { class: `toast ${newest.kind}` },
      el('div', { class: 'tt' }, newest.title),
      el('div', { class: 'tb' }, newest.body));
    t.addEventListener('click', () => {
      newest.read = true;
      if (newest.tile !== undefined) this.game.centreOnTile(newest.tile);
      t.remove();
      this.refresh();
    });
    this.toastWrap.appendChild(t);
    if (newest.kind === 'bad' || newest.kind === 'warn') this.game.audio.chime(false);
    setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 400);
    }, 7000);
    while (this.toastWrap.children.length > 3) this.toastWrap.firstChild!.remove();
  }

  private toggleDemolish(): void {
    this.game.arm(this.game.armed === DEMOLISH ? null : DEMOLISH);
    this.game.audio.tap();
    this.refresh();
  }

  // -------------------------------------------------------------------------
  // Modal: main menu, mission select, settings, outcome
  // -------------------------------------------------------------------------

  /**
   * The first thing the player sees. Offers to pick up where they left off, and
   * otherwise leads with the mission briefing rather than a wall of menu buttons.
   */
  openStart(auto: any | null): void {
    const body = el('div', { class: 'menu' });
    body.append(
      el('h2', {}, 'KEMET'),
      el('p', { class: 'sub' }, 'Lord of the Two Lands'),
    );
    if (auto) {
      const m = ALL_MISSIONS.find((x) => x.id === auto.mission);
      body.append(el('button', {
        class: 'wide', onclick: () => { this.closeModal(); this.onLoadGame?.('autosave'); },
      }, `Resume ${m?.place ?? 'your city'} — Year ${Math.floor((auto.city?.tick ?? 0) / TICKS_PER_YEAR) + 1}`));
    }
    body.append(
      el('button', { class: 'wide', onclick: () => this.openBriefing() }, auto ? 'Start over' : 'Begin'),
      el('button', { class: 'wide', onclick: () => this.openMissionSelect() }, 'Missions'),
      el('button', { class: 'wide', onclick: () => this.openHelp() }, 'How to play'),
      el('button', { class: 'wide', onclick: () => this.openSettings() }, 'Settings'),
    );
    this.showModal(body);
  }

  openMenu(): void {
    const g = this.game;
    g.suspended = true;
    const body = el('div', { class: 'menu' });
    body.append(
      el('h2', {}, 'KEMET'),
      el('p', { class: 'sub' }, `${g.mission.name} · ${g.mission.place}`),
      el('button', { class: 'wide', onclick: () => this.closeModal() }, 'Resume'),
      el('button', {
        class: 'wide', onclick: () => {
          g.save('manual') ? g.audio.chime(true) : g.audio.error();
          this.closeModal();
        },
      }, 'Save game'),
      el('button', { class: 'wide', onclick: () => this.openLoadMenu() }, 'Load game'),
      el('button', { class: 'wide', onclick: () => this.openMissionSelect() }, 'Missions'),
      el('button', { class: 'wide', onclick: () => this.openBriefing() }, 'Mission briefing'),
      el('button', { class: 'wide', onclick: () => this.openSettings() }, 'Settings'),
      el('button', { class: 'wide', onclick: () => this.openHelp() }, 'How to play'),
    );
    this.showModal(body);
  }

  private openMissionSelect(): void {
    const unlocked = new Set(loadUnlocked());
    const body = el('div', { class: 'menu' });
    body.append(el('h2', {}, 'Missions'));
    for (const m of MISSIONS) {
      const open = unlocked.has(m.id);
      body.append(el('button', {
        class: `mission ${open ? '' : 'locked'}`,
        onclick: () => {
          if (!open) return;
          this.closeModal();
          this.onNewGame?.(m.id);
        },
      },
        el('div', { class: 'mn' }, m.name),
        el('div', { class: 'mp' }, `${m.place} · ${m.era}`),
        open ? null : el('div', { class: 'ml' }, 'Locked')));
    }
    body.append(el('button', {
      class: 'mission', onclick: () => { this.closeModal(); this.onNewGame?.('sandbox'); },
    },
      el('div', { class: 'mn' }, SANDBOX.name),
      el('div', { class: 'mp' }, SANDBOX.brief)));
    body.append(el('button', { class: 'wide', onclick: () => this.openMenu() }, 'Back'));
    this.showModal(body);
  }

  private openLoadMenu(): void {
    const saves = listSaves();
    const body = el('div', { class: 'menu' });
    body.append(el('h2', {}, 'Load game'));
    if (!saves.length) body.append(el('p', { class: 'sub' }, 'No saved games yet.'));
    for (const s of saves) {
      body.append(el('div', { class: 'save-row' },
        el('button', {
          class: 'save', onclick: () => { this.closeModal(); this.onLoadGame?.(s.slot); },
        },
          el('div', { class: 'mn' }, `${s.place} — Year ${s.year + 1}`),
          el('div', { class: 'mp' }, `${s.slot} · ${s.population} people · ${new Date(s.savedAt).toLocaleString()}`)),
        el('button', {
          class: 'danger small',
          onclick: () => { deleteSave(s.slot); this.openLoadMenu(); },
        }, '🗑')));
    }
    body.append(el('button', { class: 'wide', onclick: () => this.openMenu() }, 'Back'));
    this.showModal(body);
  }

  private openBriefing(): void {
    const m = this.game.mission;
    const body = el('div', { class: 'menu brief' });
    body.append(
      el('h2', {}, m.name),
      el('p', { class: 'sub' }, `${m.place} · ${m.era}`),
      el('p', {}, m.brief),
      el('h4', {}, 'Advice'),
      el('p', {}, m.hint),
      el('h4', {}, 'Objectives'),
    );
    for (const g of this.game.goalProgress()) {
      body.append(el('div', { class: `goal ${g.met ? 'met' : ''}` },
        el('span', { class: 'gl' }, g.label),
        el('span', { class: 'gv' }, `${g.current} / ${g.target}`)));
    }
    body.append(el('button', { class: 'wide', onclick: () => this.closeModal() }, 'Begin'));
    this.showModal(body);
  }

  private openSettings(): void {
    const a = this.game.audio;
    const body = el('div', { class: 'menu' });
    body.append(el('h2', {}, 'Settings'));

    const soundBtn = el('button', { class: 'wide' }, a.enabled ? 'Sound: on' : 'Sound: off');
    soundBtn.addEventListener('click', () => {
      a.setEnabled(!a.enabled);
      soundBtn.textContent = a.enabled ? 'Sound: on' : 'Sound: off';
    });

    const musicSlider = el('input', {
      type: 'range', min: '0', max: '100', value: String(Math.round(a.musicVolume * 100)),
    }) as HTMLInputElement;
    musicSlider.addEventListener('input', () => a.setMusicVolume(Number(musicSlider.value) / 100));

    const perf = el('div', { class: 'perf' });
    const updatePerf = () => {
      perf.textContent = `${this.game.scene.fps.toFixed(0)} fps · ${this.game.renderer.lastSpriteCount} sprites · ${this.game.city.walkers.count} walkers`;
    };
    const iv = setInterval(updatePerf, 400);
    updatePerf();
    (body as any).__iv = iv;

    body.append(
      soundBtn,
      el('div', { class: 'row' }, el('span', { class: 'k' }, 'Music'), musicSlider),
      el('h4', {}, 'Performance'),
      perf,
      el('button', {
        class: 'wide', onclick: () => {
          if (confirm('Erase all saved games and campaign progress?')) {
            for (let i = localStorage.length - 1; i >= 0; i--) {
              const k = localStorage.key(i);
              if (k?.startsWith('kemet.')) localStorage.removeItem(k);
            }
            location.reload();
          }
        },
      }, 'Erase all data'),
      el('button', { class: 'wide', onclick: () => { clearInterval(iv); this.openMenu(); } }, 'Back'),
    );
    this.showModal(body);
  }

  private openHelp(): void {
    const body = el('div', { class: 'menu brief' });
    body.append(
      el('h2', {}, 'How to play'),
      el('h4', {}, 'Getting around'),
      el('p', {}, 'One finger pans the map. Two fingers pinch to zoom and drag to pan. Tap a building to select it; press and hold for full details.'),
      el('h4', {}, 'Building'),
      el('p', {}, 'Pick a category along the bottom, then a building. While a building is armed, one finger positions it and lifting places it — two fingers still pan. Roads, walls, gardens and housing can be dragged out in a run.'),
      el('h4', {}, 'The thing that matters most'),
      el('p', {}, 'Nearly every service in this city is delivered by a person who walks out of a building, along a road, past your houses, and back. If there is no road, or the road leads somewhere else, the service never arrives. Compact loops of housing around a service block work; long ribbons do not.'),
      el('h4', {}, 'The flood'),
      el('p', {}, 'The year has three seasons. During Akhet the Nile covers the floodplain and your farms stop entirely — you live on what is in the granary. When the water falls it leaves silt behind, and fertility recovers. A neglected Osiris means a poor flood and a hungry year.'),
      el('h4', {}, 'Housing'),
      el('p', {}, 'Houses climb twenty levels. Each level wants more: water, then a second food, pottery, a god, a school, entertainment, medicine, linen, beer, jewellery. Select a house to see exactly what is blocking it.'),
      el('h4', {}, 'Monuments'),
      el('p', {}, 'A monument needs work camps for labour and guilds to haul materials from your storage yards. It is built in stages; each stage needs both. Plan the quarries and the trade routes before you lay the first stone.'),
      el('button', { class: 'wide', onclick: () => this.openMenu() }, 'Back'),
    );
    this.showModal(body);
  }

  private showOutcome(status: 'won' | 'lost' | 'playing'): void {
    if (status === 'playing') return;
    const won = status === 'won';
    const body = el('div', { class: 'menu' });
    body.append(
      el('h2', {}, won ? 'Pharaoh is pleased' : 'You have failed'),
      el('p', {}, won
        ? `${this.game.mission.place} has met every objective. A greater city awaits you.`
        : 'Your city could not be saved. You may load an earlier save or begin again.'),
      el('button', { class: 'wide', onclick: () => this.openMissionSelect() }, 'Missions'),
      el('button', { class: 'wide', onclick: () => this.openLoadMenu() }, 'Load game'),
      el('button', { class: 'wide', onclick: () => this.closeModal() }, 'Keep looking around'),
    );
    this.showModal(body);
  }

  showModal(body: HTMLElement): void {
    this.game.suspended = true;
    clear(this.modal);
    const sheet = el('div', { class: 'modal-sheet' }, body);
    this.modal.appendChild(sheet);
    this.modal.classList.remove('hidden');
  }

  closeModal(): void {
    this.modal.classList.add('hidden');
    clear(this.modal);
    this.game.suspended = false;
    this.refresh();
  }

  /** Swap in a fresh game (after loading or starting a mission). */
  rebind(game: Game): void {
    this.game = game;
    game.onChange = () => this.refresh();
    game.onStatusChange = (s) => this.showOutcome(s);
    game.onInspect = (id) => { if (id >= 0) this.openBuildingDetail(id); };
    this.activeCategory = null;
    this.sheetView = null;
    this.sheet.classList.add('hidden');
    this.buildBottomBar();
    this.refresh();
  }
}
