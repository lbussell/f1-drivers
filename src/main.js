import '@fontsource-variable/archivo';
import './styles.css';
import { gsap } from 'gsap';
import { loadData } from './data.js';
import { Viz } from './viz.js';
import { Flyout } from './flyout.js';

const loading = document.getElementById('loading');

function positionSortPill() {
  const active = document.querySelector('.sort-btn.is-active');
  const pill = document.querySelector('.sort-pill');
  if (!active || !pill) return;
  pill.style.left = `${active.offsetLeft}px`;
  pill.style.width = `${active.offsetWidth}px`;
}

async function boot() {
  try {
    window.__gsap = gsap; // handy for debugging in devtools
    const model = await loadData();
    const flyout = new Flyout(model);
    const viz = new Viz({ model, onSelectDriver: (id) => flyout.open(id) });

    for (const btn of document.querySelectorAll('.sort-btn')) {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('is-active')) return;
        for (const b of document.querySelectorAll('.sort-btn')) {
          b.classList.toggle('is-active', b === btn);
          b.setAttribute('aria-checked', String(b === btn));
        }
        positionSortPill();
        viz.setMode(btn.dataset.mode);
      });
    }
    positionSortPill();
    window.addEventListener('resize', positionSortPill);

    document.getElementById('viewport').focus({ preventScroll: true });

    gsap.to(loading, {
      opacity: 0,
      duration: 0.45,
      delay: 0.25,
      onComplete: () => loading.remove(),
    });
    loading.classList.add('is-done');
  } catch (err) {
    console.error(err);
    loading.innerHTML = `
      <div class="boot-error">
        <p>Couldn&rsquo;t load the dataset.</p>
        <p>Run <code>npm run fetch-data</code> to generate <code>public/data/f1.json</code>, then reload.</p>
      </div>`;
  }
}

boot();
