// MovieMatch scoring: pure functions only (no DOM, no fetch), so they run the
// same in the browser and in Node tests.
//
// Shapes used throughout:
//   person = { name, liked: number[]|Set, refused: number[]|Set, maxRuntime: number|null, text?: string }
//   movie  = { id, title, runtime, genres: number[], rating, votes, providers: number[] }
//   similarities[k] = raw cosine of person k's text with every movie (aligned
//   with the movies array), or null when person k wrote nothing / no model.

export const GENRE_WEIGHT = 0.6; // s_p = GENRE_WEIGHT * g_p + TEXT_WEIGHT * t_p
export const TEXT_WEIGHT = 0.4;
export const MEAN_WEIGHT = 0.5; // G = MEAN_WEIGHT * mean(s_p) + MIN_WEIGHT * min(s_p)
export const MIN_WEIGHT = 0.5;
export const WR_MIN_VOTES = 500; // m in the weighted rating
export const NEUTRAL_GENRE_SCORE = 0.5; // person who liked no genre
export const NEUTRAL_TEXT_SCORE = 0.5; // all surviving movies equally similar

// Explanation thresholds (normalized text score, group score delta).
const CLOSE_TEXT_SCORE = 0.7;
const TEXT_BOOST_DELTA = 0.05;
const QUOTE_MAX_LENGTH = 60;

// ---------------------------------------------------------------- helpers

const toSet = (values) => (values instanceof Set ? values : new Set(values ?? []));

export const round2 = (x) => Math.round(x * 100) / 100;
export const pct = (x) => Math.round(x * 100);

export function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

/** Lowest max runtime in the group, Infinity when nobody set a limit. */
export function strictestRuntime(people) {
  let limit = Infinity;
  for (const p of people) {
    if (p.maxRuntime != null && Number.isFinite(p.maxRuntime)) limit = Math.min(limit, p.maxRuntime);
  }
  return limit;
}

export function meanRating(movies) {
  return mean(movies.map((m) => m.rating));
}

/** IMDb-style weighted rating: pulls movies with few votes towards the mean C. */
export function weightedRating(movie, C, m = WR_MIN_VOTES) {
  const v = movie.votes;
  return (v / (v + m)) * movie.rating + (m / (v + m)) * C;
}

// ---------------------------------------------------------------- step 1: filters

/** Returns why a movie is eliminated ({type: 'veto'|'runtime'|'provider', ...}) or null if it survives. */
export function eliminationReason(movie, people, providers = []) {
  for (const p of people) {
    const refused = toSet(p.refused);
    const genre = movie.genres.find((g) => refused.has(g));
    if (genre !== undefined) return { type: 'veto', person: p.name, genre };
  }
  if (movie.runtime > strictestRuntime(people)) return { type: 'runtime' };
  const selected = toSet(providers);
  if (selected.size && !movie.providers.some((id) => selected.has(id))) return { type: 'provider' };
  return null;
}

/** Indices of the movies that pass every person's vetoes, the runtime limit and the provider filter. */
export function survivingIndices(movies, people, providers = []) {
  const prepared = people.map((p) => ({ ...p, refused: toSet(p.refused) }));
  const selected = toSet(providers);
  const out = [];
  movies.forEach((movie, i) => {
    if (!eliminationReason(movie, prepared, selected)) out.push(i);
  });
  return out;
}

// ---------------------------------------------------------------- steps 2-5: scores

/** g_p = |genres(f) ∩ liked_p| / |genres(f)|, or NEUTRAL_GENRE_SCORE if p liked nothing. */
export function genreScore(movie, person) {
  const liked = toSet(person.liked);
  if (liked.size === 0) return NEUTRAL_GENRE_SCORE;
  if (movie.genres.length === 0) return 0;
  return movie.genres.filter((g) => liked.has(g)).length / movie.genres.length;
}

/** Min-max normalization to [0, 1]; a constant list maps to NEUTRAL_TEXT_SCORE. */
export function minMaxNormalize(values) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const range = hi - lo;
  return values.map((v) => (range > 1e-9 ? (v - lo) / range : NEUTRAL_TEXT_SCORE));
}

export function individualScore(genre, text) {
  return text == null ? genre : GENRE_WEIGHT * genre + TEXT_WEIGHT * text;
}

/** "Least misery" blend: the average happiness, but nobody should be left unhappy. */
export function groupScore(scores) {
  if (scores.length === 0) return 0;
  return MEAN_WEIGHT * mean(scores) + MIN_WEIGHT * Math.min(...scores);
}

export function compareResults(a, b) {
  if (b.group !== a.group) return b.group - a.group;
  const dwr = b.wr - a.wr;
  if (Math.abs(dwr) > 1e-9) return dwr; // ignore floating-point noise
  return b.movie.votes - a.movie.votes;
}

/**
 * Full ranking. Returns { results, eliminated: {veto, runtime, provider}, total }.
 * Each result: { index, movie, group, rawGroup, genreOnlyGroup, wr, perPerson: [{name, genre, text, score}] }.
 */
export function rankMovies(movies, people, { providers = [], similarities = [], meanRating: C } = {}) {
  const prepared = people.map((p) => ({ ...p, liked: toSet(p.liked), refused: toSet(p.refused) }));
  const selected = toSet(providers);
  const eliminated = { veto: 0, runtime: 0, provider: 0 };
  const survivors = [];
  movies.forEach((movie, i) => {
    const reason = eliminationReason(movie, prepared, selected);
    if (reason) eliminated[reason.type]++;
    else survivors.push(i);
  });

  // Text scores are normalized across the survivors only, per person.
  const textScores = prepared.map((_, k) => {
    const sims = similarities[k];
    return sims ? minMaxNormalize(survivors.map((i) => sims[i])) : null;
  });

  const ratingMean = C ?? meanRating(movies);
  const results = survivors.map((index, j) => {
    const movie = movies[index];
    const perPerson = prepared.map((p, k) => {
      const genre = genreScore(movie, p);
      const text = textScores[k] ? textScores[k][j] : null;
      return { name: p.name, genre, text, score: individualScore(genre, text) };
    });
    const rawGroup = groupScore(perPerson.map((x) => x.score));
    return {
      index,
      movie,
      perPerson,
      rawGroup,
      group: round2(rawGroup),
      genreOnlyGroup: groupScore(perPerson.map((x) => x.genre)),
      wr: weightedRating(movie, ratingMean),
    };
  });
  results.sort(compareResults);
  return { results, eliminated, total: movies.length };
}

// ---------------------------------------------------------------- explanations

function joinNames(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function quote(text) {
  const clean = text.trim().replace(/\s+/g, ' ');
  return `'${clean.length > QUOTE_MAX_LENGTH ? `${clean.slice(0, QUOTE_MAX_LENGTH - 1).trimEnd()}…` : clean}'`;
}

/**
 * One-line, deterministic explanation of a result built from the scoring data.
 * `genreName` maps a genre id to its label.
 */
export function explainResult(result, people, genreName = String) {
  const { movie, perPerson } = result;
  const prepared = people.map((p) => ({ ...p, liked: toSet(p.liked), refused: toSet(p.refused) }));
  const sentences = [];

  // Who loves which of the movie's genres; group genres sharing the same fans.
  const fansByGenre = movie.genres
    .map((g) => ({ g, fans: prepared.filter((p) => p.liked.has(g)).map((p) => p.name) }))
    .filter((x) => x.fans.length > 0)
    .sort((a, b) => b.fans.length - a.fans.length);
  const anyVetoes = prepared.some((p) => p.refused.size > 0);
  const clauses = [];

  if (fansByGenre.length) {
    const top = fansByGenre[0];
    const sameFans = fansByGenre.filter((x) => x.fans.join('|') === top.fans.join('|')).map((x) => genreName(x.g));
    clauses.push(`${joinNames(top.fans)} ${top.fans.length === 1 ? 'loves' : 'love'} ${joinNames(sameFans)}`);
    for (const p of prepared) {
      if (top.fans.includes(p.name)) continue;
      const theirs = movie.genres.filter((g) => p.liked.has(g)).map(genreName);
      if (theirs.length) clauses.push(`${p.name} likes ${joinNames(theirs)}`);
    }
    const fine = prepared.filter((p) => !movie.genres.some((g) => p.liked.has(g))).map((p) => p.name);
    if (fine.length) clauses.push(`${joinNames(fine)} ${fine.length === 1 ? 'is' : 'are'} fine with it`);
    if (anyVetoes) clauses.push('nobody vetoed anything');
  } else if (prepared.some((p) => p.liked.size > 0)) {
    clauses.push(`Not in anyone's favourite genres, but ${anyVetoes ? 'nobody vetoed it' : 'it clears every filter'}`);
  } else if (anyVetoes) {
    clauses.push('Nobody vetoed it');
  }
  if (clauses.length) sentences.push(`${clauses.join(', ')}.`);

  // Did a free-text description drive the pick?
  const withText = perPerson.map((x, k) => ({ ...x, k })).filter((x) => x.text != null);
  if (withText.length) {
    const best = withText.reduce((a, b) => (b.text > a.text ? b : a));
    const boosted = result.rawGroup - result.genreOnlyGroup >= TEXT_BOOST_DELTA;
    if (best.text >= CLOSE_TEXT_SCORE) {
      const lead = best.text >= 0.999 ? 'Closest to' : 'Close to';
      const tail = boosted ? ', which pushed it up the ranking' : '';
      sentences.push(`${lead} ${best.name}'s description: ${quote(prepared[best.k].text ?? '')}${tail}.`);
    } else {
      sentences.push(`Not a close match to ${withText.length === 1 ? `${best.name}'s description` : 'the descriptions'}.`);
    }
  }

  // Who is happiest / least happy.
  if (perPerson.length > 1) {
    const sorted = [...perPerson].sort((a, b) => b.score - a.score);
    const hi = sorted[0];
    const lo = sorted[sorted.length - 1];
    if (pct(hi.score) === pct(lo.score)) sentences.push(`Everyone matches equally (${pct(lo.score)}%).`);
    else sentences.push(`Best match: ${hi.name} (${pct(hi.score)}%). Least happy: ${lo.name} (${pct(lo.score)}%).`);
  } else if (!sentences.length) {
    sentences.push('No genre preference given, so it ranks on its TMDB rating.');
  }

  return sentences.join(' ');
}

// ---------------------------------------------------------------- empty results

/**
 * When nothing survives, try relaxing one constraint at a time and count how
 * many movies would come back. Suggestions are sorted by that count.
 */
export function diagnoseEmpty(movies, people, providers = []) {
  const prepared = people.map((p) => ({ ...p, refused: toSet(p.refused) }));
  const count = (ppl, prov) => survivingIndices(movies, ppl, prov).length;
  const suggestions = [];

  const limit = strictestRuntime(prepared);
  if (Number.isFinite(limit)) {
    suggestions.push({
      type: 'runtime',
      limit,
      people: prepared.filter((p) => p.maxRuntime === limit).map((p) => p.name),
      count: count(prepared.map((p) => ({ ...p, maxRuntime: null })), providers),
    });
  }
  if (toSet(providers).size) {
    suggestions.push({ type: 'provider', count: count(prepared, []) });
  }
  prepared.forEach((p, k) => {
    if (!p.refused.size) return;
    const relaxed = prepared.map((q, j) => (j === k ? { ...q, refused: new Set() } : q));
    suggestions.push({ type: 'veto', person: p.name, refusedCount: p.refused.size, count: count(relaxed, providers) });
  });

  suggestions.sort((a, b) => b.count - a.count);
  const totalRefused = new Set(prepared.flatMap((p) => [...p.refused])).size;
  return { suggestions, totalRefused };
}

/** Turns diagnoseEmpty() output into a friendly title + tips. */
export function describeEmpty({ suggestions, totalRefused }) {
  const movies = (n) => `${n} movie${n === 1 ? '' : 's'}`;
  const tips = [];
  for (const s of suggestions) {
    if (s.count === 0) continue;
    if (s.type === 'runtime') {
      const who = s.people.length === 1 ? `${s.people[0]}'s` : `The`;
      tips.push(`${who} ${s.limit} min runtime limit is the strictest: without it, ${movies(s.count)} would match.`);
    } else if (s.type === 'provider') {
      tips.push(`Without the streaming filter, ${movies(s.count)} would match.`);
    } else if (s.type === 'veto') {
      tips.push(`${s.person} refuses ${s.refusedCount} genre${s.refusedCount === 1 ? '' : 's'}: dropping those vetoes would bring back ${movies(s.count)}.`);
    }
  }
  if (!tips.length) {
    tips.push(
      totalRefused > 0
        ? `Together you refuse ${totalRefused} genres. Try un-vetoing a few and relaxing the runtime or streaming filters at the same time.`
        : 'Try relaxing the runtime limit and the streaming filter together.',
    );
  }
  return { title: 'No movie fits everyone… yet', tips: tips.slice(0, 3) };
}
