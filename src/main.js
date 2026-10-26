// App entry point: owns the state, wires events, runs the ranking.

import { loadData } from './data.js';
import { loadModel, embedTexts, onModelStatus, getModelStatus } from './model.js';
import { rankMovies, explainResult, diagnoseEmpty, describeEmpty } from './scoring.js';
import * as ui from './ui.js';

const STORAGE_KEY = 'moviematch:form:v1';

const $ = (selector) => document.querySelector(selector);
const els = {
  sizePicker: $('#size-picker'),
  people: $('#people'),
  providers: $('#providers'),
  providerStatus: $('#provider-status'),
  find: $('#find'),
  modelStatus: $('#model-status'),
  results: $('#results'),
  footerStats: $('#data-stats'),
};

const defaultName = (i) => `Person ${i + 1}`;
const makePerson = (i) => ({ name: defaultName(i), liked: new Set(), refused: new Set(), maxRuntime: null, text: '' });

const state = {
  size: 2,
  people: Array.from({ length: ui.MAX_PEOPLE }, (_, i) => makePerson(i)),
  providers: new Set(),
  providersExpanded: false,
  // Last search: the inputs as they were on click, plus how results are displayed.
  query: null,
  ranking: null,
  textMode: 'none', // none | used | pending | unavailable
  offset: 0,
  expanded: false,
  stale: false,
};
let data = null;
let cards = [];

// ---------------------------------------------------------------- persistence (per-browser convenience only)

function save() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        size: state.size,
        providers: [...state.providers],
        people: state.people.map((p) => ({ ...p, liked: [...p.liked], refused: [...p.refused] })),
      }),
    );
  } catch {
    /* storage unavailable: nothing to do */
  }
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!saved) return;
    const genres = new Set(data.genres.map((g) => g.id));
    const providers = new Set(data.providers.map((p) => p.id));
    const runtimes = new Set(ui.RUNTIME_OPTIONS.map((o) => Number(o.value)).filter(Boolean));
    state.size = Math.min(ui.MAX_PEOPLE, Math.max(1, Number(saved.size) || 2));
    state.providers = new Set((saved.providers ?? []).filter((id) => providers.has(id)));
    (saved.people ?? []).slice(0, ui.MAX_PEOPLE).forEach((p, i) => {
      const liked = new Set((p.liked ?? []).filter((id) => genres.has(id)));
      state.people[i] = {
        name: typeof p.name === 'string' ? p.name.slice(0, 24) : defaultName(i),
        liked,
        refused: new Set((p.refused ?? []).filter((id) => genres.has(id) && !liked.has(id))),
        maxRuntime: runtimes.has(p.maxRuntime) ? p.maxRuntime : null,
        text: typeof p.text === 'string' ? p.text.slice(0, 200) : '',
      };
    });
  } catch {
    /* corrupted or blocked storage: start fresh */
  }
}

// ---------------------------------------------------------------- form

function personIndex(target) {
  return Number(target.closest('.person')?.dataset.index);
}

function inputsChanged() {
  save();
  if (state.ranking && !state.stale) {
    state.stale = true;
    render();
  }
}

function buildForm() {
  cards = state.people.map((p, i) => ui.buildPersonCard(i, p, data.genres));
  els.people.replaceChildren(...cards);
  cards.forEach((card, i) => ui.syncPersonCard(card, state.people[i]));
  ui.syncGroupSize(els.sizePicker, cards, state.size);
  ui.buildProviderPicker(els.providers, data.providers, { expanded: state.providersExpanded });
  ui.syncProviders(els.providers, state.providers, els.providerStatus);
  if (state.people.some((p, i) => i < state.size && p.text.trim())) loadModel();
}

function setGroupSize(size) {
  state.size = size;
  ui.syncGroupSize(els.sizePicker, cards, size);
  inputsChanged();
}

els.sizePicker.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-size]');
  if (button) setGroupSize(Number(button.dataset.size));
});

// Arrow keys move between sizes, like a native radio group.
els.sizePicker.addEventListener('keydown', (event) => {
  const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
  if (!delta) return;
  event.preventDefault();
  const size = Math.min(ui.MAX_PEOPLE, Math.max(1, state.size + delta));
  setGroupSize(size);
  els.sizePicker.querySelector(`[data-size="${size}"]`).focus();
});

els.people.addEventListener('click', (event) => {
  const chip = event.target.closest('.chip[data-genre]');
  if (!chip || chip.disabled) return;
  const i = personIndex(chip);
  const person = state.people[i];
  const genre = Number(chip.dataset.genre);
  const own = chip.dataset.kind === 'liked' ? person.liked : person.refused;
  const other = chip.dataset.kind === 'liked' ? person.refused : person.liked;
  if (other.has(genre)) return; // a genre can't be both liked and refused
  if (own.has(genre)) own.delete(genre);
  else own.add(genre);
  ui.syncPersonCard(cards[i], person);
  inputsChanged();
});

els.people.addEventListener('input', (event) => {
  const field = event.target.dataset.field;
  const i = personIndex(event.target);
  if (!field || Number.isNaN(i)) return;
  const person = state.people[i];
  if (field === 'name') {
    person.name = event.target.value;
    ui.syncPersonCard(cards[i], person);
  } else if (field === 'text') {
    person.text = event.target.value;
    if (person.text.trim()) loadModel(); // lazy: only when someone starts describing
  } else if (field === 'maxRuntime') {
    person.maxRuntime = event.target.value ? Number(event.target.value) : null;
  }
  inputsChanged();
});

els.people.addEventListener('focusout', (event) => {
  if (event.target.dataset.field !== 'name' || event.target.value.trim()) return;
  const i = personIndex(event.target);
  state.people[i].name = defaultName(i);
  event.target.value = state.people[i].name;
  ui.syncPersonCard(cards[i], state.people[i]);
  save();
});

els.providers.addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  if (chip.dataset.action === 'more-providers') {
    state.providersExpanded = true;
    ui.buildProviderPicker(els.providers, data.providers, { expanded: true });
  } else {
    const id = Number(chip.dataset.provider);
    if (state.providers.has(id)) state.providers.delete(id);
    else state.providers.add(id);
    inputsChanged();
  }
  ui.syncProviders(els.providers, state.providers, els.providerStatus);
});

// ---------------------------------------------------------------- search

function snapshotQuery() {
  return {
    people: state.people.slice(0, state.size).map((p, i) => {
      const name = p.name.trim() || defaultName(i);
      if (name !== p.name) {
        p.name = name;
        cards[i].querySelector('.name-input').value = name;
        ui.syncPersonCard(cards[i], p);
      }
      return { name, liked: [...p.liked], refused: [...p.refused], maxRuntime: p.maxRuntime, text: p.text.trim() };
    }),
    providers: [...state.providers],
  };
}

async function similaritiesFor(query) {
  const texts = query.people.map((p) => p.text);
  const none = texts.map(() => null);
  if (!texts.some(Boolean)) return { similarities: none, textMode: 'none' };

  const status = getModelStatus();
  if (status === 'error') return { similarities: none, textMode: 'unavailable' };
  if (status !== 'ready') {
    loadModel(); // never block: rank on genres now, refine when the model is ready
    return { similarities: none, textMode: 'pending' };
  }
  try {
    const vectors = await embedTexts(texts);
    if (!vectors) return { similarities: none, textMode: 'unavailable' };
    return { similarities: vectors.map((v) => (v ? data.similarities(v) : null)), textMode: 'used' };
  } catch (err) {
    console.warn('MovieMatch: embedding failed, using genres only.', err);
    return { similarities: none, textMode: 'unavailable' };
  }
}

async function runQuery(query, { resetView }) {
  const { similarities, textMode } = await similaritiesFor(query);
  if (query !== state.query) return; // a newer search started meanwhile
  state.ranking = rankMovies(data.movies, query.people, {
    providers: query.providers,
    similarities,
    meanRating: data.meanRating,
  });
  state.textMode = textMode;
  if (resetView) {
    state.offset = 0;
    state.expanded = false;
  }
  render();
}

async function onFind() {
  state.query = snapshotQuery();
  state.stale = false;
  save();
  els.find.disabled = true;
  els.find.classList.add('is-busy');
  try {
    await runQuery(state.query, { resetView: true });
  } finally {
    els.find.disabled = false;
    els.find.classList.remove('is-busy');
  }
  els.results.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

els.find.addEventListener('click', onFind);

// When the model finishes loading, refine results that were ranked on genres only.
onModelStatus((model) => {
  ui.renderModelStatus(els.modelStatus, model, { onRetry: () => loadModel() });
  if (!state.query || state.textMode !== 'pending') return;
  if (model.status === 'ready') runQuery(state.query, { resetView: true });
  else if (model.status === 'error') {
    state.textMode = 'unavailable';
    render();
  }
});

// ---------------------------------------------------------------- results

function render() {
  if (!state.ranking) return;
  const query = state.query;
  const genreName = (id) => data.genreById.get(id)?.name ?? 'Other';
  const notes = [];
  if (state.textMode === 'pending') {
    notes.push({ kind: 'info', text: 'The AI model is still loading: these picks use genres only and will refine automatically.' });
  } else if (state.textMode === 'unavailable') {
    notes.push({ kind: 'warn', text: "The AI model couldn't load, so descriptions were ignored and picks use genres only." });
  }

  ui.renderResults(els.results, {
    ranking: state.ranking,
    offset: state.offset,
    expanded: state.expanded,
    stale: state.stale,
    notes,
    empty: state.ranking.results.length ? null : describeEmpty(diagnoseEmpty(data.movies, query.people, query.providers)),
    explain: (result) => explainResult(result, query.people, genreName),
    genreName,
    providerById: data.providerById,
    selectedProviders: new Set(query.providers),
    onShowMore: () => {
      state.expanded = !state.expanded;
      render();
    },
    onShowAnother: () => {
      state.offset += 3;
      render();
      els.results.scrollIntoView({ block: 'start' });
    },
    onBackToTop: () => {
      state.offset = 0;
      render();
      els.results.scrollIntoView({ block: 'start' });
    },
  });
}

// ---------------------------------------------------------------- boot

async function boot() {
  try {
    data = await loadData();
  } catch (err) {
    console.error(err);
    ui.renderLoadError(els.results, err);
    els.find.disabled = true;
    return;
  }
  restore();
  buildForm();
  els.find.disabled = false;
  const updated = new Date(data.generatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  els.footerStats.textContent = `${data.count} movies released since ${data.releasedFrom.slice(0, 4)}, updated ${updated}.`;
}

boot();
