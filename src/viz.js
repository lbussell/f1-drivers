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
    this.renderPucks({ animate: false });
    this.updateAxisState();
    this.bindEvents();
    this.centerOnYear(this.yearIdx, { smooth: false });
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

  renderPucks({ animate = true } = {}) {
    const { model, geom } = this;
    const season = model.seasons[this.yearIdx];
    const yearIdx = this.yearIdx;

    // animate out the existing pucks
    const old = [...this.pucksEl.children];
    if (old.length) {
      if (animate) {
        gsap.to(old, {
          scale: 0.2,
          opacity: 0,
          duration: DUR(0.28),
          ease: 'power2.in',
          stagger: 0.008,
          onComplete: () => old.forEach((el) => el.remove()),
        });
      } else {
        old.forEach((el) => el.remove());
      }
    }

    const frag = document.createDocumentFragment();
    const created = [];
    for (const driverId of season.orders[this.mode]) {
      const entry = season.entryBy.get(driverId);
      const driver = model.drivers[driverId];
      const ring = ringGradient(entry, season.racesCompleted);
      const teamColour = stintColour(primaryStint(entry));
      const el = document.createElement('button');
      el.className = 'puck';
      el.dataset.driver = driverId;
      el.style.setProperty('--ring', ring);
      el.style.setProperty('--team', teamColour);
      el.style.setProperty('--glow', `color-mix(in srgb, ${teamColour} 45%, transparent)`);
      el.setAttribute('aria-label', `${driver.name}, ${primaryStint(entry).team}, ${entry.points} points`);
      const img = driver.portrait
        ? `<img class="puck-img" src="${import.meta.env.BASE_URL}${driver.portrait}" alt="" loading="lazy" draggable="false">`
        : `<span class="puck-fallback">${driver.acronym ?? '?'}</span>`;
      el.innerHTML = `${img}<span class="puck-tag"><b class="num">${entry.number ?? ''}</b><span class="abbr">${entry.acronym ?? driver.acronym ?? ''}</span></span>`;
      const y = this.yFor(driverId, yearIdx);
      el.style.left = `${this.x(yearIdx) - geom.puck / 2}px`;
      el.style.top = `${y - geom.puck / 2}px`;
      frag.appendChild(el);
      created.push(el);
    }
    this.pucksEl.appendChild(frag);

    if (animate && created.length) {
      gsap.fromTo(
        created,
        { scale: 0.2, opacity: 0 },
        {
          scale: 1,
          opacity: 1,
          duration: DUR(0.45),
          ease: 'back.out(1.7)',
          stagger: 0.014,
          delay: DUR(0.08),
          clearProps: 'scale,opacity',
        }
      );
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
      });
      this.hideTooltip();
    });

    const onSettled = () => {
      const idx = Math.round(
        (this.viewport.scrollLeft + this.geom.vw / 2 - this.geom.padX - this.geom.yearW / 2) /
          this.geom.yearW
      );
      const clamped = Math.max(0, Math.min(this.model.years.length - 1, idx));
      if (clamped !== this.yearIdx) this.setYear(clamped, { scroll: false });
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
    // scroll vertically, or when hovering the year axis
    let wheelAcc = 0;
    let wheelLock = 0;
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
        if (now < wheelLock) return;
        wheelAcc += e.deltaY;
        if (Math.abs(wheelAcc) > 40) {
          this.step(Math.sign(wheelAcc));
          wheelAcc = 0;
          wheelLock = now + 450;
        }
      },
      { passive: false }
    );

    this.navPrev.addEventListener('click', () => this.step(-1));
    this.navNext.addEventListener('click', () => this.step(1));
    this.viewport.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') this.step(-1);
      if (e.key === 'ArrowRight') this.step(1);
    });

    // hover + click on lines and pucks (event delegation)
    this.svg.addEventListener('pointermove', (e) => {
      const hit = e.target.closest?.('.hit, .node') ?? null;
      const g = e.target.closest?.('.driver');
      if (hit || g) {
        const driverId = g?.dataset.driver;
        if (driverId) {
          this.setFocus(driverId);
          this.showLineTooltip(driverId, e);
          return;
        }
      }
      this.setFocus(null);
      this.hideTooltip();
    });
    this.svg.addEventListener('pointerleave', () => {
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
    this.svg.classList.toggle('has-focus', !!driverId);
    this.pucksEl.classList.toggle('has-focus', !!driverId);
    for (const [id, g] of this.driverGroups) {
      g.classList.toggle('is-focus', id === driverId);
    }
    for (const puck of this.pucksEl.children) {
      puck.classList.toggle('is-focus', puck.dataset.driver === driverId);
    }
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
    this.viewport.scrollTo({
      left: this.x(idx) - this.geom.vw / 2,
      behavior: smooth && !reducedMotion ? 'smooth' : 'auto',
    });
  }

  setYear(idx, { scroll = true } = {}) {
    if (idx === this.yearIdx) return;
    this.yearIdx = idx;
    this.updateAxisState();
    this.renderPucks({ animate: true });
    this.hideTooltip();
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
    const pucks = [...this.pucksEl.children].map((el) => ({
      el,
      to: this.yFor(el.dataset.driver, this.yearIdx, mode) - this.geom.puck / 2,
    }));

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
    this.renderPucks({ animate: false });
    this.updateAxisState();
    this.updateAxisProximity();
    this.centerOnYear(idx, { smooth: false });
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
