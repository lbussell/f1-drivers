// Driver detail flyout: career milestones plus a card per season.
// Slides in from the right on desktop, rises as a bottom sheet on mobile.

import { gsap } from 'gsap';
import { primaryStint, ringGradient, stintColour } from './data.js';

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const shortGP = (meeting) => esc(meeting).replace(' Grand Prix', ' GP');

export class Flyout {
  constructor(model) {
    this.model = model;
    this.el = document.getElementById('flyout');
    this.content = document.getElementById('flyout-content');
    this.backdrop = document.getElementById('flyout-backdrop');
    this.isOpen = false;

    document.getElementById('flyout-close').addEventListener('click', () => this.close());
    this.backdrop.addEventListener('click', () => this.close());
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
  }

  mobile() {
    return window.innerWidth < 680;
  }

  open(driverId) {
    const { model } = this;
    const driver = model.drivers[driverId];
    if (!driver) return;

    const seasonRows = model.seasons
      .map((season) => ({ season, entry: season.entryBy.get(driverId) }))
      .filter((r) => r.entry);
    const latest = seasonRows[seasonRows.length - 1];
    const teamColour = stintColour(primaryStint(latest.entry));
    const ring = ringGradient(latest.entry, latest.season.racesCompleted);
    const m = driver.milestones ?? {};

    const mile = (label, v) =>
      v
        ? `<div class="mile"><div class="mile-k">${label}</div><div class="mile-v">${shortGP(v.meeting)} <small>· ${v.year}</small></div></div>`
        : `<div class="mile"><div class="mile-k">${label}</div><div class="mile-v"><small>—</small></div></div>`;

    const yearsSpan =
      seasonRows.length > 1
        ? `${seasonRows[0].season.year}–${latest.season.year}`
        : `${latest.season.year}`;

    const portrait = driver.portrait
      ? `<img src="${import.meta.env.BASE_URL}${driver.portrait}" alt="${esc(driver.name)}">`
      : `<span class="puck-fallback">${esc(driver.acronym ?? '?')}</span>`;

    const cards = seasonRows
      .map(({ season, entry }) => {
        const stints = entry.stints
          .map((s) => {
            const range =
              entry.stints.length > 1
                ? `<small>R${s.fromRound}–R${s.toRound} · ${s.points} pts</small>`
                : `<small>${esc(this.constructorLine(season, s.team))}</small>`;
            return `<div class="team-chip" style="--c:${stintColour(s)}"><i></i>${esc(s.team)} ${range}</div>`;
          })
          .join('');
        const chipClass = entry.standing === 1 && !season.inProgress ? 'standing-chip p1' : 'standing-chip';
        const soFar = season.inProgress ? ' <small>so far</small>' : '';
        return `
          <div class="season-card">
            <div class="season-head">
              <span class="sy">${season.year}${season.inProgress ? ' ·' : ''}${season.inProgress ? '<small style="font-size:11px;font-style:normal;color:var(--ink-dim)"> in progress</small>' : ''}</span>
              <span class="${chipClass}">P${entry.standing}${soFar}</span>
            </div>
            <div class="season-teams">${stints}</div>
            <div class="season-stats">
              <div class="st"><b>${entry.points}</b><span>Points</span></div>
              <div class="st"><b>${entry.wins}</b><span>Wins</span></div>
              <div class="st"><b>${entry.podiums}</b><span>Podiums</span></div>
              <div class="st"><b>${entry.poles}</b><span>Poles</span></div>
            </div>
          </div>`;
      })
      .reverse()
      .join('');

    this.content.innerHTML = `
      <div class="fly-hero" style="--team:${teamColour}; --ring:${ring}">
        <div class="fly-portrait">${portrait}</div>
        <div class="fly-id">
          <div class="fly-number">${latest.entry.number ?? ''}</div>
          <h2>${esc(driver.name)}</h2>
          <div class="fly-meta">${[driver.country, latest.entry.acronym ?? driver.acronym, yearsSpan]
            .filter(Boolean)
            .map(esc)
            .join(' · ')}</div>
        </div>
      </div>
      <div class="fly-section">
        <h3>Milestones</h3>
        <div class="mile-grid">
          ${mile('First race', m.firstRace)}
          ${mile('Latest race', m.lastRace)}
          ${mile('First win', m.firstWin)}
          ${mile('Latest win', m.lastWin)}
          ${mile('First pole', m.firstPole)}
          ${mile('Latest pole', m.lastPole)}
        </div>
      </div>
      <div class="fly-section">
        <h3>Season by season</h3>
      </div>
      ${cards}
      <p class="fly-note">Covers ${model.years[0]}–present. Data: Jolpica F1 (1990–2022) &amp; OpenF1 (2023–). Careers before ${model.years[0]} not shown.</p>
    `;
    this.content.scrollTop = 0;

    this.el.classList.add('is-open');
    this.el.setAttribute('aria-hidden', 'false');
    this.backdrop.hidden = false;
    const mobile = this.mobile();
    if (!this.isOpen) {
      gsap.set(this.el, { xPercent: mobile ? 0 : 105, yPercent: mobile ? 105 : 0 });
    }
    gsap.to(this.el, {
      xPercent: 0,
      yPercent: 0,
      duration: reducedMotion ? 0.01 : 0.45,
      ease: 'power3.out',
      overwrite: true,
    });
    gsap.fromTo(this.backdrop, { opacity: 0 }, { opacity: 1, duration: 0.3, overwrite: true });
    this.isOpen = true;
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.setAttribute('aria-hidden', 'true');
    const axis = this.mobile() ? 'yPercent' : 'xPercent';
    gsap.to(this.el, {
      [axis]: 105,
      duration: reducedMotion ? 0.01 : 0.35,
      ease: 'power3.in',
      overwrite: true,
      onComplete: () => this.el.classList.remove('is-open'),
    });
    gsap.to(this.backdrop, {
      opacity: 0,
      duration: 0.25,
      overwrite: true,
      onComplete: () => (this.backdrop.hidden = true),
    });
  }

  constructorLine(season, team) {
    const c = season.constructors.find((x) => x.team === team);
    return c ? `P${c.rank} in constructors’ · ${c.points} pts` : '';
  }
}
