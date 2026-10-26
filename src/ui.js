// DOM building and rendering. No app state lives here: main.js owns state and
// calls these functions. User text is always inserted as text, never as HTML.

import { pct, QUALITY_WEIGHT } from './scoring.js';

export const MAX_PEOPLE = 4;
export const PERSON_COLORS = ['#ff7a7a', '#5cb8ff', '#ffc94d', '#5be3b0'];
export const RUNTIME_OPTIONS = [
  { value: '', label: 'No limit' },
  { value: '90', label: '90 min' },
  { value: '105', label: '105 min' },
  { value: '120', label: '120 min' },
  { value: '150', label: '150 min' },
  { value: '180', label: '180 min' },
];
const VISIBLE_PROVIDERS = 12;
const POSTER_BASE = 'https://image.tmdb.org/t/p/';
const SHORT_GENRE = { 'Science Fiction': 'Sci-Fi' };

// ---------------------------------------------------------------- helpers

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') {
      for (const [prop, v] of Object.entries(value)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, v);
        else el.style[prop] = v;
      }
    }
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'value') el.value = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const ICONS = {
  film: '<path d="M4 5h16v14H4z M8 5v14 M16 5v14 M4 9h4 M4 15h4 M16 9h4 M16 15h4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  shuffle: '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  alert: '<path d="M12 3 2 21h20z"/><path d="M12 10v4M12 17h.01"/>',
};

export function icon(name, className = 'icon') {
  const span = document.createElement('span');
  span.className = className;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

export function formatRuntime(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours}h${String(rest).padStart(2, '0')}` : `${rest} min`;
}

const initial = (name) => (name.trim()[0] ?? '?').toUpperCase();

// ---------------------------------------------------------------- group size

export function syncGroupSize(picker, cards, size) {
  for (const button of picker.querySelectorAll('button')) {
    const active = Number(button.dataset.size) === size;
    button.setAttribute('aria-checked', String(active));
    button.tabIndex = active ? 0 : -1;
  }
  cards.forEach((card, i) => {
    card.hidden = i >= size;
  });
}

// ---------------------------------------------------------------- person cards

function genreChips(index, kind, genres) {
  return h(
    'div',
    { class: 'chips', role: 'group', 'aria-label': kind === 'liked' ? 'Genres they like' : 'Genres they refuse' },
    genres.map((g) =>
      h(
        'button',
        { type: 'button', class: `chip chip--${kind}`, dataset: { kind, genre: g.id }, 'aria-pressed': 'false' },
        SHORT_GENRE[g.name] ?? g.name,
      ),
    ),
  );
}

export function buildPersonCard(index, person, genres) {
  const id = (field) => `p${index}-${field}`;
  return h(
    'article',
    { class: 'person', dataset: { index }, style: { '--accent': PERSON_COLORS[index] } },
    h(
      'div',
      { class: 'person-head' },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, initial(person.name)),
      h('label', { class: 'sr-only', for: id('name') }, `First name of person ${index + 1}`),
      h('input', {
        id: id('name'),
        class: 'name-input',
        type: 'text',
        dataset: { field: 'name' },
        value: person.name,
        placeholder: `Person ${index + 1}`,
        maxlength: 24,
        required: true,
        autocomplete: 'off',
        spellcheck: 'false',
      }),
    ),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Likes'), genreChips(index, 'liked', genres)),
    h(
      'div',
      { class: 'field' },
      h('span', { class: 'field-label' }, 'Refuses ', h('span', { class: 'muted' }, '(veto)')),
      genreChips(index, 'refused', genres),
    ),
    h(
      'div',
      { class: 'field field--inline' },
      h('label', { class: 'field-label', for: id('runtime') }, 'Max runtime'),
      h(
        'select',
        { id: id('runtime'), class: 'select', dataset: { field: 'maxRuntime' } },
        RUNTIME_OPTIONS.map((o) => h('option', { value: o.value }, o.label)),
      ),
    ),
    h(
      'div',
      { class: 'field' },
      h(
        'label',
        { class: 'field-label', for: id('text') },
        'Describe what you feel like watching ',
        h('span', { class: 'muted' }, '(optional)'),
      ),
      h('textarea', {
        id: id('text'),
        class: 'textarea',
        dataset: { field: 'text' },
        rows: 2,
        maxlength: 200,
        placeholder: 'e.g. "a tense survival story" or "a feel-good movie that cheers me up"',
        value: person.text,
      }),
    ),
  );
}

/** Reflects a person's state on their card (chips, avatar, runtime). */
export function syncPersonCard(card, person) {
  card.querySelector('.avatar').textContent = initial(person.name || `P${Number(card.dataset.index) + 1}`);
  for (const chip of card.querySelectorAll('.chip')) {
    const genre = Number(chip.dataset.genre);
    const mine = chip.dataset.kind === 'liked' ? person.liked : person.refused;
    const other = chip.dataset.kind === 'liked' ? person.refused : person.liked;
    const blocked = other.has(genre);
    chip.setAttribute('aria-pressed', String(mine.has(genre)));
    chip.disabled = blocked;
    chip.title = blocked ? (chip.dataset.kind === 'liked' ? 'Already refused' : 'Already liked') : '';
  }
  card.querySelector('select').value = person.maxRuntime == null ? '' : String(person.maxRuntime);
}

// ---------------------------------------------------------------- providers

export function buildProviderPicker(container, providers, { expanded = false } = {}) {
  container.replaceChildren(
    ...providers.map((p, i) =>
      h(
        'button',
        {
          type: 'button',
          class: 'chip chip--provider',
          dataset: { provider: p.id },
          'aria-pressed': 'false',
          hidden: !expanded && i >= VISIBLE_PROVIDERS,
          title: `${p.name}: ${p.count} movie${p.count === 1 ? '' : 's'}`,
        },
        p.logo
          ? h('img', { src: `${POSTER_BASE}w45${p.logo}`, alt: '', width: 20, height: 20, loading: 'lazy' })
          : null,
        p.name,
      ),
    ),
  );
  if (providers.length > VISIBLE_PROVIDERS && !expanded) {
    container.append(
      h('button', { type: 'button', class: 'chip chip--more', dataset: { action: 'more-providers' } }, `+ ${providers.length - VISIBLE_PROVIDERS} more`),
    );
  }
}

export function syncProviders(container, selected, status) {
  for (const chip of container.querySelectorAll('[data-provider]')) {
    const on = selected.has(Number(chip.dataset.provider));
    chip.setAttribute('aria-pressed', String(on));
    if (on) chip.hidden = false;
  }
  status.textContent = selected.size
    ? `Only movies on ${selected.size === 1 ? 'this service' : `one of these ${selected.size} services`} (subscription).`
    : 'None selected: any movie, including ones not on streaming.';
}

// ---------------------------------------------------------------- model status

export function renderModelStatus(el, { status, progress }, { onRetry }) {
  el.hidden = status === 'idle';
  el.dataset.status = status;
  if (status === 'loading') {
    el.replaceChildren(
      h('span', { class: 'spinner', 'aria-hidden': 'true' }),
      `Loading AI model, first time only${progress != null ? ` (${progress}%)` : '…'}`,
    );
  } else if (status === 'ready') {
    el.replaceChildren(icon('sparkle'), 'AI model ready: descriptions are understood');
  } else if (status === 'error') {
    el.replaceChildren(
      icon('alert'),
      'AI model unavailable, matching on genres only. ',
      h('button', { type: 'button', class: 'link-button', onclick: onRetry }, 'Retry'),
    );
  }
}

// ---------------------------------------------------------------- results

function poster(movie, size) {
  const placeholder = () =>
    h('div', { class: 'poster poster--empty', role: 'img', 'aria-label': `No poster for ${movie.title}` }, icon('film', 'icon icon--lg'));
  if (!movie.poster) return placeholder();
  const img = h('img', {
    class: 'poster',
    src: `${POSTER_BASE}${size}${movie.poster}`,
    alt: `Poster of ${movie.title}`,
    loading: 'lazy',
    decoding: 'async',
  });
  img.addEventListener('error', () => img.replaceWith(placeholder()), { once: true });
  return img;
}

const SCORE_TITLE = `Score: ${pct(1 - QUALITY_WEIGHT)}% group fit + ${pct(QUALITY_WEIGHT)}% TMDB rating`;

function scoreRing(score) {
  const value = pct(score);
  return h(
    'div',
    { class: 'ring', style: { '--value': value }, role: 'img', 'aria-label': `Score ${value}%`, title: SCORE_TITLE },
    h('span', { class: 'ring-value' }, `${value}%`),
    h('span', { class: 'ring-label' }, 'score'),
  );
}

function providerLogos(movie, providerById, selected) {
  const list = movie.providers.map((id) => providerById.get(id)).filter(Boolean);
  if (!list.length) return h('p', { class: 'providers providers--none' }, 'Not on subscription streaming in France');
  return h(
    'ul',
    { class: 'providers', 'aria-label': 'Streaming in France' },
    list.map((p) =>
      h(
        'li',
        { class: selected.has(p.id) ? 'is-selected' : null, title: p.name },
        p.logo ? h('img', { src: `${POSTER_BASE}w45${p.logo}`, alt: p.name, width: 28, height: 28, loading: 'lazy' }) : h('span', {}, p.name),
      ),
    ),
  );
}

function personBars(result) {
  return h(
    'ul',
    { class: 'bars', 'aria-label': 'Match per person' },
    result.perPerson.map((p, i) =>
      h(
        'li',
        { style: { '--accent': PERSON_COLORS[i] } },
        h('span', { class: 'bar-name' }, p.name),
        h('span', { class: 'bar-track' }, h('span', { class: 'bar-fill', style: { width: `${pct(p.score)}%` } })),
        h('span', { class: 'bar-value' }, `${pct(p.score)}%`),
      ),
    ),
  );
}

function metaLine(movie, genreName) {
  return h(
    'p',
    { class: 'meta' },
    h('span', {}, icon('clock'), formatRuntime(movie.runtime)),
    h('span', {}, icon('star'), movie.rating.toFixed(1)),
    h('span', {}, movie.genres.map(genreName).join(', ')),
  );
}

const tmdbLink = (movie, ...children) =>
  h('a', { href: `https://www.themoviedb.org/movie/${movie.id}`, target: '_blank', rel: 'noopener' }, ...children);

function resultCard(result, rank, view) {
  const { movie } = result;
  return h(
    'article',
    { class: 'movie-card' },
    h(
      'div',
      { class: 'poster-wrap', style: movie.poster ? { '--poster': `url("${POSTER_BASE}w342${movie.poster}")` } : null },
      poster(movie, 'w342'),
      h('span', { class: 'rank-badge' }, `#${rank}`),
    ),
    h(
      'div',
      { class: 'movie-body' },
      h(
        'div',
        { class: 'movie-head' },
        h('h3', { class: 'movie-title' }, tmdbLink(movie, movie.title), movie.year ? h('span', { class: 'year' }, ` ${movie.year}`) : null),
        scoreRing(result.score),
      ),
      metaLine(movie, view.genreName),
      h('p', { class: 'why' }, icon('sparkle'), view.explain(result)),
      personBars(result),
      providerLogos(movie, view.providerById, view.selectedProviders),
      movie.overview ? h('p', { class: 'overview' }, movie.overview) : null,
    ),
  );
}

function resultRow(result, rank, view) {
  const { movie } = result;
  return h(
    'li',
    { class: 'row' },
    h('span', { class: 'row-rank' }, rank),
    h('div', { class: 'row-thumb' }, poster(movie, 'w92')),
    h(
      'div',
      { class: 'row-body' },
      h('p', { class: 'row-title' }, tmdbLink(movie, movie.title), movie.year ? h('span', { class: 'year' }, ` ${movie.year}`) : null),
      metaLine(movie, view.genreName),
      h('p', { class: 'why why--small' }, view.explain(result)),
    ),
    h('span', { class: 'row-pct', title: SCORE_TITLE }, `${pct(result.score)}%`),
  );
}

function notice(kind, text) {
  return h('p', { class: `notice notice--${kind}` }, icon(kind === 'warn' ? 'alert' : 'info'), text);
}

/**
 * view = { ranking, offset, expanded, stale, notes: [{kind, text}], empty: {title, tips} | null,
 *          explain(result), genreName(id), providerById, selectedProviders,
 *          onShowMore, onShowAnother, onBackToTop }
 */
export function renderResults(el, view) {
  const { ranking } = view;
  const survivors = ranking.results.length;
  const filtered = ranking.total - survivors;
  const parts = [];

  parts.push(
    h(
      'div',
      { class: 'results-head' },
      h('h2', {}, survivors ? 'Your movie night' : 'Hmm…'),
      h(
        'p',
        { class: 'muted' },
        `${survivors} of ${ranking.total} movies pass everyone's filters`,
        filtered ? ` (${[
          ranking.eliminated.veto && `${ranking.eliminated.veto} vetoed`,
          ranking.eliminated.runtime && `${ranking.eliminated.runtime} too long`,
          ranking.eliminated.provider && `${ranking.eliminated.provider} not on your services`,
        ]
          .filter(Boolean)
          .join(', ')})` : '',
        '.',
      ),
    ),
  );
  if (view.stale) parts.push(notice('info', 'You changed something: click "Find our movie" to update.'));
  for (const note of view.notes) parts.push(notice(note.kind, note.text));

  if (!survivors) {
    parts.push(
      h(
        'div',
        { class: 'empty' },
        icon('search', 'icon icon--lg'),
        h('h3', {}, view.empty.title),
        h('ul', {}, view.empty.tips.map((tip) => h('li', {}, tip))),
      ),
    );
    el.replaceChildren(...parts);
    return;
  }

  const top = ranking.results.slice(view.offset, view.offset + 3);
  parts.push(h('div', { class: 'top-picks' }, top.map((r, i) => resultCard(r, view.offset + i + 1, view))));

  const more = ranking.results.slice(view.offset + 3, view.offset + 10);
  const actions = h('div', { class: 'results-actions' });
  if (more.length) {
    actions.append(
      h(
        'button',
        { type: 'button', class: 'btn btn--ghost', 'aria-expanded': String(view.expanded), onclick: view.onShowMore },
        view.expanded ? 'Show less' : `Show more (#${view.offset + 4}–${view.offset + 3 + more.length})`,
        icon('chevron', `icon chevron${view.expanded ? ' is-open' : ''}`),
      ),
    );
  }
  if (view.offset + 3 < survivors) {
    actions.append(h('button', { type: 'button', class: 'btn btn--ghost', onclick: view.onShowAnother }, icon('shuffle'), 'Not feeling it? Show another'));
  }
  if (view.offset > 0) {
    actions.append(h('button', { type: 'button', class: 'btn btn--link', onclick: view.onBackToTop }, 'Back to the top picks'));
  }
  parts.push(actions);
  if (view.expanded && more.length) {
    parts.push(h('ol', { class: 'rows' }, more.map((r, i) => resultRow(r, view.offset + 4 + i, view))));
  }
  el.replaceChildren(...parts);
}

export function renderLoadError(el, err) {
  el.replaceChildren(
    h(
      'div',
      { class: 'empty' },
      icon('alert', 'icon icon--lg'),
      h('h3', {}, "Couldn't load the movie catalog"),
      h('p', {}, String(err.message ?? err)),
      h(
        'p',
        { class: 'muted' },
        'Serve the folder over HTTP (npm start) instead of opening index.html directly, and make sure data/ has been built.',
      ),
    ),
  );
}
