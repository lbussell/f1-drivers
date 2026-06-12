// The chart itself: an SVG "world" of team-coloured travel lines laid out on
// a horizontally scroll-snapped timeline, with HTML portrait pucks overlaid
// on the selected year. GSAP drives year transitions and sort reflows; D3
// handles the SVG data joins.

import { gsap } from 'gsap';
import { select } from 'd3';
import { colourStart, colourEnd, primaryStint, ringGradient, stintColour } from './data.js';

const AXIS_H = 104;
const PAD_TOP = 34;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const DUR = (s) => (reducedMotion ? 0.01 : s);

export class Viz {
  constructor({ model, onSelectDriver }) {
    this.model = model;
    this.onSelectDriver = onSelectDriver;
    this.mode = 'drivers';
    this.yearIdx = model.years.length - 1;
    this.focusId = null;

    this.viewport = document.getElementById('viewport');
    this.world = document.getElementById('world');
    this.svg = document.getElementById('lines');
    this.pucksEl = document.getElementById('pucks');
    this.axisEl = document.getElementById('year-axis');
    this.tooltip = document.getElementById('tooltip');
    this.navPrev = document.getElementById('nav-prev');
    this.navNext = document.getElementById('nav-next');

    this.computeGeometry();
    this.buildAxis();
    this.buildChart();
    this.updateAxisState();
    this.bindEvents();
    this.centerOnYear(this.yearIdx, { smooth: false });
    this.scrubPucks();
    requestAnimationFrame(() => this.introAnimation());
  }

  // ---------- geometry ----------

  computeGeometry() {
    const vw = this.viewport.clientWidth;
    const vh = this.viewport.clientHeight;
    const mobile = vw < 680;
    const n = this.model.years.length;
    const yearW = mobile
      ? Math.max(240, Math.round(vw * 0.74))
      : Math.round(Math.min(560, Math.max(320, vw * 0.42)));
    const rowH = mobile ? 64 : 78;
    const puck = mobile ? 50 : 64;
    const padX = Math.max(16, Math.round(vw / 2 - yearW / 2));
    const chartH = PAD_TOP + this.model.maxRows * rowH + rowH * 0.5;
    this.geom = {
      vw,
      vh,
      mobile,
      yearW,
      rowH,
      puck,
      padX,
      worldW: padX * 2 + yearW * n,
      worldH: Math.max(chartH + AXIS_H, vh),
      chartH,
    };
    document.documentElement.style.setProperty('--puck-size', `${puck}px`);
    this.world.style.width = `${this.geom.worldW}px`;
    this.world.style.height = `${this.geom.worldH}px`;
    this.world.style.display = 'flex';
    this.world.style.flexDirection = 'column';
    this.world.style.justifyContent = 'flex-end';
  }

  x(yearIdx) {
    return this.geom.padX + yearIdx * this.geom.yearW + this.geom.yearW / 2;
  }

  yOfRank(rank) {
    return PAD_TOP + rank * this.geom.rowH + this.geom.rowH / 2;
  }

  yFor(driverId, yearIdx, mode = this.mode) {
    const season = this.model.seasons[yearIdx];
    const rank = season.rankOf[mode].get(driverId);
    return rank == null ? null : this.yOfRank(rank);
  }

  // ---------- year axis ----------

  buildAxis() {
    const { years, seasons } = this.model;
    this.axisEl.style.paddingLeft = `${this.geom.padX}px`;
    this.axisEl.style.paddingRight = `${this.geom.padX}px`;
    this.axisEl.style.height = `${AXIS_H}px`;
    this.axisEl.innerHTML = '';
    this.axisCells = years.map((year, i) => {
      const season = seasons[i];
      const cell = document.createElement('div');
      cell.className = 'axis-cell';
      cell.style.width = `${this.geom.yearW}px`;
      const champ = season.entries[0];
      const sub = season.inProgress
        ? `Round ${season.racesCompleted} of ${season.racesScheduled}`
        : `♕ ${champ.acronym} · ${champ.points} pts`;
      cell.innerHTML = `<div class="axis-year">${year}</div><div class="axis-sub">${sub}</div>`;
      this.axisEl.appendChild(cell);
      return cell;
    });
  }

  updateAxisState() {
    this.axisCells.forEach((cell, i) => cell.classList.toggle('is-current', i === this.yearIdx));
    this.navPrev.disabled = this.yearIdx === 0;
    this.navNext.disabled = this.yearIdx === this.model.years.length - 1;
  }

  // proximity scaling of year labels while scrolling
  updateAxisProximity() {
    const center = this.viewport.scrollLeft + this.geom.vw / 2;
    this.axisCells.forEach((cell, i) => {
      const d = Math.min(1, Math.abs(this.x(i) - center) / this.geom.yearW);
      const label = cell.firstElementChild;
      label.style.transform = `scale(${1 + 0.22 * (1 - d)})`;
      label.style.opacity = `${0.55 + 0.45 * (1 - d)}`;
    });
  }

  // ---------- chart (SVG) ----------

  buildChart() {
    const { model, geom } = this;
    const svg = select(this.svg)
      .attr('width', geom.worldW)
      .attr('height', geom.worldH)
      .attr('viewBox', `0 0 ${geom.worldW} ${geom.worldH}`);
    svg.selectAll('*').remove();

    const defs = svg.append('defs');
    const grid = svg.append('g').attr('class', 'grid');
    model.years.forEach((_, i) => {
      grid
        .append('line')
        .attr('class', 'grid-line')
        .attr('x1', this.x(i))
        .attr('x2', this.x(i))
        .attr('y1', PAD_TOP - 14)
        .attr('y2', geom.chartH);
    });

    // node positions per driver: runs -> [{yearIdx, x, y}]
    this.runNodes = new Map();
    const driversG = svg.append('g').attr('class', 'drivers');
    this.driverGroups = new Map();
    this.driverPaths = new Map(); // driverId -> [{type, el, run, k}] for redraw

    for (const [driverId, runs] of model.runs) {
      if (!runs.length) continue;
      const g = driversG.append('g').attr('class', 'driver').attr('data-driver', driverId);
      this.driverGroups.set(driverId, g.node());
      const paths = [];
      const nodeRuns = [];

      runs.forEach((run, runIdx) => {
        const nodes = run.map((yearIdx) => ({
          yearIdx,
          x: this.x(yearIdx),
          y: this.yFor(driverId, yearIdx),
          entry: model.seasons[yearIdx].entryBy.get(driverId),
        }));
        nodeRuns.push(nodes);

        // one continuous path per run (separate segments would double up
        // alpha where their round caps overlap), with a single gradient
        // carrying both the team-colour transitions and the tail fades
        const tailIn = run[0] !== 0;
        const tailOut = run[run.length - 1] !== model.years.length - 1;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        const tailLen = geom.yearW * 0.5;
        // single season with no tails would have no geometry: draw a stub
        const stub = nodes.length === 1 && !tailIn && !tailOut;
        const x0 = tailIn || stub ? first.x - (stub ? geom.yearW * 0.18 : tailLen) : first.x;
        const x1 = tailOut || stub ? last.x + (stub ? geom.yearW * 0.18 : tailLen) : last.x;

        const gradId = `run-${driverId}-${runIdx}`;
        const grad = defs
          .append('linearGradient')
          .attr('id', gradId)
          .attr('gradientUnits', 'userSpaceOnUse')
          .attr('x1', x0)
          .attr('x2', x1)
          .attr('y1', 0)
          .attr('y2', 0);
        const off = (x) => `${(((x - x0) / (x1 - x0)) * 100).toFixed(2)}%`;
        const stop = (x, colour, opacity) =>
          grad
            .append('stop')
            .attr('offset', off(x))
            .attr('stop-color', colour)
            .attr('stop-opacity', opacity);
        if (tailIn || stub) stop(x0, colourStart(first.entry), 0);
        stop(first.x, colourStart(first.entry), 1);
        for (let k = 0; k < nodes.length - 1; k++) {
          const ca = colourEnd(nodes[k].entry);
          const cb = colourStart(nodes[k + 1].entry);
          if (ca !== cb) {
            const span = nodes[k + 1].x - nodes[k].x;
            stop(nodes[k].x + span * 0.38, ca, 1);
            stop(nodes[k].x + span * 0.62, cb, 1);
          }
        }
        stop(last.x, colourEnd(last.entry), 1);
        if (tailOut || stub) stop(x1, colourEnd(last.entry), 0);

        const el = g.append('path').attr('class', 'seg').attr('stroke', `url(#${gradId})`).node();

        // year dots riding on top of the line
        nodes.forEach((node) => {
          node.circle = g
            .append('circle')
            .attr('class', 'node')
            .attr('r', geom.mobile ? 7 : 9)
            .attr('fill', colourEnd(node.entry))
            .node();
        });

        const hit = g.append('path').attr('class', 'hit').node();
        hit.dataset.driver = driverId;
        paths.push({ el, hit, nodes, tailIn, tailOut, stub });
      });

      this.driverPaths.set(driverId, paths);
      this.runNodes.set(driverId, nodeRuns);
    }

    this.redrawPaths();
  }

  segCurve(a, b) {
    const mx = (a.x + b.x) / 2;
    return `C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`;
  }

  tailCurve(node, dir) {
    // a curve that "falls away" — used for debuts, returns, exits
    const { yearW, rowH } = this.geom;
    const xFar = node.x + dir * yearW * 0.5;
    const yFar = node.y + rowH * 2.1;
    const cx1 = node.x + dir * yearW * 0.3;
    const cx2 = node.x + dir * yearW * 0.42;
    return { xFar, yFar, cx1, cx2 };
  }

  runPath(p) {
    const first = p.nodes[0];
    const last = p.nodes[p.nodes.length - 1];
    let d;
    if (p.stub) {
      const w = this.geom.yearW * 0.18;
      d = `M${first.x - w},${first.y} L${first.x + w},${first.y}`;
      return d;
    }
    if (p.tailIn) {
      const t = this.tailCurve(first, -1);
      d = `M${t.xFar},${t.yFar} C${t.cx2},${t.yFar - this.geom.rowH * 1.1} ${t.cx1},${first.y} ${first.x},${first.y}`;
    } else {
      d = `M${first.x},${first.y}`;
    }
    for (let k = 0; k < p.nodes.length - 1; k++) d += ` ${this.segCurve(p.nodes[k], p.nodes[k + 1])}`;
    if (p.tailOut) {
      const t = this.tailCurve(last, 1);
      d += ` C${t.cx1},${last.y} ${t.cx2},${t.yFar - this.geom.rowH * 1.1} ${t.xFar},${t.yFar}`;
    }
    return d;
  }

  redrawPaths() {
    for (const paths of this.driverPaths.values()) {
      for (const p of paths) {
        const d = this.runPath(p);
        p.el.setAttribute('d', d);
        p.hit.setAttribute('d', d);
        for (const node of p.nodes) {
          node.circle.setAttribute('cx', node.x);
          node.circle.setAttribute('cy', node.y);
        }
      }
    }
  }

  // ---------- pucks ----------

  // Write the per-season visuals (ring, team colour, number/acronym, label)
  // onto a puck element. The portrait only needs creating once per element; on
  // reuse we just refresh the bits that can change when a driver switches team
  // between years.
  fillPuck(el, driverId, entry, season, { createImg } = {}) {
    const driver = this.model.drivers[driverId];
    const ring = ringGradient(entry, season.racesCompleted);
    const teamColour = stintColour(primaryStint(entry));
    el.style.setProperty('--ring', ring);
    el.style.setProperty('--team', teamColour);
    el.style.setProperty('--glow', `color-mix(in srgb, ${teamColour} 45%, transparent)`);
    el.setAttribute(
      'aria-label',
      `${driver.name}, ${primaryStint(entry).team}, ${entry.points} points`
    );
    if (createImg) {
      const img = driver.portrait
        ? `<img class="puck-img" src="${import.meta.env.BASE_URL}${driver.portrait}" alt="" loading="lazy" draggable="false">`
        : `<span class="puck-fallback">${driver.acronym ?? '?'}</span>`;
      el.innerHTML = `<span class="puck-photo">${img}</span><span class="puck-tag"></span>`;
      el._tagKey = null;
    }
    this.setPuckTag(el, entry, driver, { animate: !createImg });
  }

  // Update the number / acronym / team-name text. When the team name changes
  // on a live puck the old name slides out to the left while the new one
  // slides in from the right, and the pill width eases between the two.
  setPuckTag(el, entry, driver, { animate = false } = {}) {
    const num = entry.number ?? '';
    const abbr = entry.acronym ?? driver.acronym ?? '';
    const team = primaryStint(entry).team;
    const key = `${num}|${abbr}|${team}`;
    if (el._tagKey === key) return;
    const hadTeam = el._tagKey != null;
    el._tagKey = key;

    const tag = el.querySelector('.puck-tag');
    const idHtml = `<span class="puck-id"><b class="num">${num}</b><span class="abbr">${abbr}</span></span>`;
    if (!animate || !hadTeam || reducedMotion) {
      tag.innerHTML = `${idHtml}<span class="puck-team"><span class="puck-team-text">${team}</span></span>`;
      return;
    }

    tag.querySelector('.puck-id').outerHTML = idHtml;
    const teamEl = tag.querySelector('.puck-team');
    // a rapid second change mid-animation: drop any ghost still on its way out
    for (const ghost of teamEl.querySelectorAll('.is-out')) ghost.remove();
    const oldText = teamEl.querySelector('.puck-team-text');
    if (oldText.textContent === team) return;
    const w0 = teamEl.offsetWidth;

    const newText = document.createElement('span');
    newText.className = 'puck-team-text';
    newText.textContent = team;
    teamEl.appendChild(newText);
    oldText.classList.add('is-out'); // out of flow so the new name takes over layout
    gsap.killTweensOf([oldText, teamEl]);
    gsap.to(oldText, {
      x: -9,
      autoAlpha: 0,
      duration: DUR(0.22),
      ease: 'power2.in',
      onComplete: () => oldText.remove(),
    });
    gsap.fromTo(
      newText,
      { x: 9, autoAlpha: 0 },
      { x: 0, autoAlpha: 1, duration: DUR(0.26), ease: 'power2.out', delay: DUR(0.08) }
    );
    gsap.fromTo(
      teamEl,
      { width: w0 },
      { width: newText.offsetWidth, duration: DUR(0.3), ease: 'power2.inOut', clearProps: 'width' }
    );
  }

  // Blend the puck's team colours (ring, border, glow, text) between two
  // seasons, matching the line gradient which crossfades across the middle
  // 38–62% of the span between adjacent years.
  blendPuckColours(el, driverId, i0, i1, f) {
    const { seasons } = this.model;
    const a = seasons[i0].entryBy.get(driverId);
    const b = seasons[i1].entryBy.get(driverId);
    const ta = stintColour(primaryStint(a));
    const tb = stintColour(primaryStint(b));
    const ca = colourEnd(a);
    const cb = colourStart(b);
    if (ta === tb && ca === cb) return; // same team both years: nothing to fade
    const t = Math.max(0, Math.min(1, (f - 0.38) / 0.24));
    const key = `${i0}:${t.toFixed(3)}`;
    if (el._colourKey === key) return;
    el._colourKey = key;
    let team, ring;
    if (t <= 0) {
      team = ta;
      ring = ringGradient(a, seasons[i0].racesCompleted);
    } else if (t >= 1) {
      team = tb;
      ring = ringGradient(b, seasons[i1].racesCompleted);
    } else {
      const pct = `${(t * 100).toFixed(1)}%`;
      team = ta === tb ? ta : `color-mix(in srgb, ${tb} ${pct}, ${ta})`;
      ring = `color-mix(in srgb, ${cb} ${pct}, ${ca})`;
    }
    el.style.setProperty('--team', team);
    el.style.setProperty('--ring', ring);
    el.style.setProperty('--glow', `color-mix(in srgb, ${team} 45%, transparent)`);
  }

  // Continuous "scrub": pucks are positioned every scroll frame straight from
  // the live scroll position rather than tweened after the scroll settles. Each
  // driver rides its own line, so the portraits stay glued to the timeline and
  // remain centred while you scroll or drag — on mobile they track the drag
  // continuously instead of rushing to catch up once a year snaps into place.
  //
  // For the fractional year `yf` under the screen centre we bracket the two
  // integer years i0..i1 (f = yf - i0). A driver on the grid in both years
  // slides along the same bezier the line uses between those seasons; a driver
  // only on one side fades in / out as we approach the year they (dis)appear.

  // Ensure a puck element exists for every driver on the grid in either bracket
  // year: create new arrivals, drop the ones that have scrolled out of range,
  // and refresh team colour / number for the rest.
  rebuildActivePucks(i0, i1, f) {
    const { model } = this;
    const active = (this._activePucks ??= new Map());
    const want = new Set([
      ...model.seasons[i0].orders[this.mode],
      ...model.seasons[i1].orders[this.mode],
    ]);

    for (const [driverId, el] of active) {
      if (!want.has(driverId)) {
        el.remove();
        active.delete(driverId);
      }
    }

    for (const driverId of want) {
      // anchor content to the nearest season the driver appears in, so
      // entering a new bracket (in either scroll direction) doesn't swap the
      // tag away from what's currently displayed
      const inA = this.yFor(driverId, i0) != null;
      const inB = this.yFor(driverId, i1) != null;
      const near = inA && inB ? (f < 0.5 ? i0 : i1) : inA ? i0 : i1;
      const season = model.seasons[near];
      const entry = season.entryBy.get(driverId);
      let el = active.get(driverId);
      if (el) {
        this.fillPuck(el, driverId, entry, season, { createImg: false });
      } else {
        el = document.createElement('button');
        el.className = 'puck';
        el.dataset.driver = driverId;
        this.fillPuck(el, driverId, entry, season, { createImg: true });
        this.pucksEl.appendChild(el);
        active.set(driverId, el);
      }
      el._dispYear = near;
    }
  }

  // Position every active puck for the current scroll position.
  scrubPucks() {
    const { geom, model } = this;
    const n = model.years.length;
    const half = geom.puck / 2;
    const center = this.viewport.scrollLeft + geom.vw / 2;
    let yf = (center - geom.padX - geom.yearW / 2) / geom.yearW;
    yf = Math.max(0, Math.min(n - 1, yf));
    const i0 = Math.floor(yf);
    const i1 = Math.min(i0 + 1, n - 1);
    const f = yf - i0;

    if (i0 !== this._scrubI0) {
      this.rebuildActivePucks(i0, i1, f);
      this._scrubI0 = i0;
    }

    const bez = (p0, p1, p2, p3, t) => {
      const u = 1 - t;
      return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
    };

    const { yearW, rowH } = geom;
    for (const [driverId, el] of this._activePucks) {
      const ay = this.yFor(driverId, i0);
      const by = this.yFor(driverId, i1);
      let px, py, opacity;
      if (ay != null && by != null) {
        const ax = this.x(i0);
        const bx = this.x(i1);
        const mx = (ax + bx) / 2;
        px = bez(ax, mx, mx, bx, f);
        py = bez(ay, ay, by, by, f);
        opacity = 1;
        this.blendPuckColours(el, driverId, i0, i1, f);
      } else if (ay != null) {
        // exiting the grid: ride the same fall-away bezier the line's
        // tailCurve draws, fading out on the way down
        const x0 = this.x(i0);
        px = bez(x0, x0 + yearW * 0.3, x0 + yearW * 0.42, x0 + yearW * 0.5, f);
        py = bez(ay, ay, ay + rowH, ay + rowH * 2.1, f);
        opacity = 1 - f;
      } else {
        // debuting / returning: rise up the incoming tail toward the node
        const x1 = this.x(i1);
        px = bez(x1 - yearW * 0.5, x1 - yearW * 0.42, x1 - yearW * 0.3, x1, f);
        py = bez(by + rowH * 2.1, by + rowH, by, by, f);
        opacity = f;
      }

      // the displayed season (tag text) flips at the midpoint between years
      const di = ay != null && by != null ? (f < 0.5 ? i0 : i1) : ay != null ? i0 : i1;
      if (el._dispYear !== di) {
        el._dispYear = di;
        const entry = model.seasons[di].entryBy.get(driverId);
        this.setPuckTag(el, entry, model.drivers[driverId], { animate: true });
      }
      el.style.left = `${px - half}px`;
      el.style.top = `${py - half}px`;
      el.style.opacity = opacity;
      // don't let an all-but-invisible puck intercept hover / clicks
      el.style.pointerEvents = opacity > 0.5 ? 'auto' : 'none';
    }
  }

  // ---------- interactions ----------

  bindEvents() {
    // scroll: proximity styling + snapped year detection
    let scrollRaf = null;
    this.viewport.addEventListener('scroll', () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = null;
        this.updateAxisProximity();
        this.scrubPucks();
      });
      this.hideTooltip();
    });

    const onSettled = () => {
      // Snap puck positions to the resting scroll position.
      this.scrubPucks();
      // Ignore the settle that our own programmatic centring produces — the
      // year is already set by the wheel/keys/nav; only react to the user
      // panning the timeline horizontally by hand.
      if (this._autoScroll) {
        this._autoScroll = false;
        return;
      }
      const idx = Math.round(
        (this.viewport.scrollLeft + this.geom.vw / 2 - this.geom.padX - this.geom.yearW / 2) /
          this.geom.yearW
      );
      const clamped = Math.max(0, Math.min(this.model.years.length - 1, idx));
      if (clamped !== this.yearIdx) {
        this.yearIdx = clamped;
        this.updateAxisState();
        this.hideTooltip();
      }
    };
    if ('onscrollend' in window) {
      this.viewport.addEventListener('scrollend', onSettled);
    } else {
      let t = null;
      this.viewport.addEventListener('scroll', () => {
        clearTimeout(t);
        t = setTimeout(onSettled, 140);
      });
    }

    // wheel: vertical wheel steps between years when there is nothing to
    // scroll vertically, or when hovering the year axis. Each notch changes the
    // year by exactly one (immediately) and the horizontal centring animation
    // catches up. A short cooldown caps the rate so a single notch — or a
    // trackpad's momentum burst — can't jump several years at once. We only use
    // the wheel direction, so it behaves the same regardless of how Firefox or
    // a trackpad reports the delta magnitude.
    const WHEEL_COOLDOWN = 110;
    let wheelLockUntil = 0;
    this.viewport.addEventListener(
      'wheel',
      (e) => {
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // horizontal pans natively
        const rect = this.viewport.getBoundingClientRect();
        const overAxis = e.clientY > rect.bottom - AXIS_H;
        const hasVScroll = this.viewport.scrollHeight > this.viewport.clientHeight + 2;
        if (!overAxis && hasVScroll) return; // plain vertical scrolling
        e.preventDefault();
        const now = performance.now();
        if (now < wheelLockUntil) return;
        const dir = e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0;
        if (!dir) return;
        wheelLockUntil = now + WHEEL_COOLDOWN;
        this.step(dir);
      },
      { passive: false }
    );

    this.navPrev.addEventListener('click', () => this.step(-1));
    this.navNext.addEventListener('click', () => this.step(1));
    this.viewport.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') this.step(-1);
      if (e.key === 'ArrowRight') this.step(1);
    });

    // hover + click on lines (event delegation). The hit-test is throttled to
    // one resolve per frame and uses "sticky focus": while the cursor is still
    // over the currently focused driver's line we keep it, even if another
    // line is painted on top. Without this, the densely overlapping 30px hit
    // strokes make the topmost driver flip every few pixels, which restarted
    // transitions across the whole SVG and made every line flicker.
    let hoverRaf = null;
    let hoverEvent = null;
    const resolveHover = () => {
      hoverRaf = null;
      const e = hoverEvent;
      if (!e) return;
      // The year axis (big year numbers) is sticky to the bottom of the
      // viewport with pointer-events:none, so lines drawn behind it would
      // otherwise still take focus. Ignore hovers inside that band.
      const vpRect = this.viewport.getBoundingClientRect();
      if (e.clientY > vpRect.bottom - AXIS_H) {
        this.setFocus(null);
        this.hideTooltip();
        return;
      }
      const stack = document.elementsFromPoint(e.clientX, e.clientY);
      let topDriver = null;
      let keepCurrent = false;
      for (const el of stack) {
        const g = el.closest?.('.driver');
        if (!g) continue;
        const id = g.dataset.driver;
        if (!topDriver) topDriver = id;
        if (id === this.focusId) {
          keepCurrent = true;
          break;
        }
      }
      const driverId = keepCurrent ? this.focusId : topDriver;
      if (driverId) {
        this.setFocus(driverId);
        this.showLineTooltip(driverId, e);
      } else {
        this.setFocus(null);
        this.hideTooltip();
      }
    };
    this.svg.addEventListener('pointermove', (e) => {
      hoverEvent = e;
      if (hoverRaf == null) hoverRaf = requestAnimationFrame(resolveHover);
    });
    this.svg.addEventListener('pointerleave', () => {
      hoverEvent = null;
      if (hoverRaf != null) {
        cancelAnimationFrame(hoverRaf);
        hoverRaf = null;
      }
      this.setFocus(null);
      this.hideTooltip();
    });
    this.svg.addEventListener('click', (e) => {
      const g = e.target.closest?.('.driver');
      if (g?.dataset.driver) this.onSelectDriver(g.dataset.driver);
    });

    this.pucksEl.addEventListener('pointerover', (e) => {
      const puck = e.target.closest('.puck');
      if (puck) {
        this.setFocus(puck.dataset.driver);
        this.showPuckTooltip(puck.dataset.driver, puck);
      }
    });
    this.pucksEl.addEventListener('pointerout', (e) => {
      if (!e.relatedTarget?.closest?.('.puck')) {
        this.setFocus(null);
        this.hideTooltip();
      }
    });
    this.pucksEl.addEventListener('click', (e) => {
      const puck = e.target.closest('.puck');
      if (puck) this.onSelectDriver(puck.dataset.driver);
    });

    // resize
    let resizeT = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeT);
      resizeT = setTimeout(() => this.handleResize(), 160);
    });
  }

  setFocus(driverId) {
    if (driverId === this.focusId) return;
    this.focusId = driverId;

    // Only restyle the line/puck that actually changed. Previously this toggled
    // `has-focus` on the whole SVG (dimming all ~1200 paths + nodes through CSS
    // transitions) and looped over every driver group — so a single hover flip
    // repainted the entire 20000px chart. Now a focus change touches at most
    // two line groups and two pucks.
    if (this._focusGroup) this._focusGroup.classList.remove('is-focus');
    const g = driverId ? this.driverGroups.get(driverId) : null;
    if (g) g.classList.add('is-focus');
    this._focusGroup = g;

    if (this._focusPuck) this._focusPuck.classList.remove('is-focus');
    const puck = driverId
      ? this.pucksEl.querySelector(`.puck[data-driver="${driverId}"]`)
      : null;
    if (puck) puck.classList.add('is-focus');
    this._focusPuck = puck;
  }

  // ---------- tooltip ----------

  tooltipHtml(driverId, yearIdx) {
    const season = this.model.seasons[yearIdx];
    const entry = season.entryBy.get(driverId);
    if (!entry) return null;
    const driver = this.model.drivers[driverId];
    const teams = entry.stints.map((s) => s.team).join(' → ');
    const standing = `P${entry.standing}${season.inProgress ? ' so far' : ''}`;
    return {
      html: `
        <div class="tt-name">${driver.name}</div>
        <div class="tt-line">${season.year} · ${teams}</div>
        <div class="tt-line"><strong>${entry.points} pts</strong> · ${standing}</div>`,
      colour: stintColour(primaryStint(entry)),
    };
  }

  showLineTooltip(driverId, event) {
    // nearest season the driver actually appears in, by cursor x
    const world = this.world.getBoundingClientRect();
    const xWorld = event.clientX - world.left;
    let best = null;
    for (const nodes of this.runNodes.get(driverId) ?? []) {
      for (const node of nodes) {
        const d = Math.abs(node.x - xWorld);
        if (!best || d < best.d) best = { d, yearIdx: node.yearIdx };
      }
    }
    if (!best) return;
    this.showTooltipAt(driverId, best.yearIdx, event.clientX, event.clientY);
  }

  showPuckTooltip(driverId, puckEl) {
    const r = puckEl.getBoundingClientRect();
    this.showTooltipAt(driverId, this.yearIdx, r.right + 4, r.top + r.height / 2);
  }

  showTooltipAt(driverId, yearIdx, cx, cy) {
    const tt = this.tooltipHtml(driverId, yearIdx);
    if (!tt) return;
    this.tooltip.innerHTML = tt.html;
    this.tooltip.style.setProperty('--team', tt.colour);
    this.tooltip.hidden = false;
    const { width, height } = this.tooltip.getBoundingClientRect();
    const x = Math.min(window.innerWidth - width - 10, cx + 16);
    const y = Math.max(10, Math.min(window.innerHeight - height - 10, cy - height - 14));
    this.tooltip.style.left = `${x}px`;
    this.tooltip.style.top = `${y}px`;
  }

  hideTooltip() {
    this.tooltip.hidden = true;
  }

  // ---------- year + mode state ----------

  step(dir) {
    const next = Math.max(0, Math.min(this.model.years.length - 1, this.yearIdx + dir));
    if (next !== this.yearIdx) this.setYear(next, { scroll: true });
  }

  centerOnYear(idx, { smooth = true } = {}) {
    // Flag this as a programmatic scroll so the settle handler doesn't treat
    // the resulting scrollend as a manual pan and re-set the year.
    this._autoScroll = true;
    this.viewport.scrollTo({
      left: this.x(idx) - this.geom.vw / 2,
      behavior: smooth && !reducedMotion ? 'smooth' : 'auto',
    });
  }

  setYear(idx, { scroll = true } = {}) {
    if (idx === this.yearIdx) return;
    this.yearIdx = idx;
    this.updateAxisState();
    this.hideTooltip();
    // The pucks are driven continuously by the scroll position (scrubPucks),
    // so we only need to start the horizontal animation; the portraits ride
    // their lines toward the new year as the scroll catches up.
    if (scroll) this.centerOnYear(idx);
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;

    // capture old → new y for every node, then drive one tween
    const moves = [];
    for (const [driverId, nodeRuns] of this.runNodes) {
      for (const nodes of nodeRuns) {
        for (const node of nodes) {
          moves.push({ node, from: node.y, to: this.yFor(driverId, node.yearIdx, mode) });
        }
      }
    }
    const pucks = [...this._activePucks]
      .map(([driverId, el]) => ({ el, to: this.yFor(driverId, this.yearIdx, mode) }))
      .filter((p) => p.to != null)
      .map((p) => ({ el: p.el, to: p.to - this.geom.puck / 2 }));

    const proxy = { t: 0 };
    gsap.to(proxy, {
      t: 1,
      duration: DUR(0.85),
      ease: 'power3.inOut',
      onUpdate: () => {
        for (const m of moves) m.node.y = m.from + (m.to - m.from) * proxy.t;
        this.redrawPaths();
      },
    });
    for (const p of pucks) {
      gsap.to(p.el, { top: p.to, duration: DUR(0.85), ease: 'power3.inOut' });
    }
  }

  handleResize() {
    const idx = this.yearIdx;
    this.computeGeometry();
    this.buildAxis();
    this.buildChart();
    this.updateAxisState();
    this.updateAxisProximity();
    this.centerOnYear(idx, { smooth: false });
    this.scrubPucks();
  }

  // ---------- intro ----------

  introAnimation() {
    if (reducedMotion) {
      this.updateAxisProximity();
      return;
    }
    const segs = this.svg.querySelectorAll('.seg');
    segs.forEach((seg) => {
      const len = seg.getTotalLength();
      seg.style.strokeDasharray = `${len}`;
      seg.style.strokeDashoffset = `${len}`;
    });
    gsap.to(segs, {
      strokeDashoffset: 0,
      duration: 1.1,
      ease: 'power2.out',
      stagger: { each: 0.003, from: 'end' },
      delay: 0.15,
      onComplete: () => {
        segs.forEach((seg) => {
          seg.style.strokeDasharray = '';
          seg.style.strokeDashoffset = '';
        });
      },
    });
    this.updateAxisProximity();
  }
}
