import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rankMovies,
  groupScore,
  genreScore,
  weightedRating,
  strictestRuntime,
  minMaxNormalize,
  explainResult,
  diagnoseEmpty,
  describeEmpty,
  mean,
  NEUTRAL_GENRE_SCORE,
} from '../src/scoring.js';

// TMDB genre ids
const ACTION = 28;
const COMEDY = 35;
const DRAMA = 18;
const HORROR = 27;
const ROMANCE = 10749;
const NETFLIX = 8;
const PRIME = 119;

let nextId = 1;
const movie = (overrides = {}) => ({
  id: nextId++,
  title: `Movie ${nextId}`,
  runtime: 100,
  genres: [COMEDY],
  rating: 7,
  votes: 1000,
  providers: [],
  ...overrides,
});
const person = (name, overrides = {}) => ({ name, liked: [], refused: [], maxRuntime: null, text: '', ...overrides });
const titles = (ranking) => ranking.results.map((r) => r.movie.title);

test('a refused genre vetoes the movie for the whole group', () => {
  const movies = [movie({ title: 'Scary', genres: [HORROR, COMEDY] }), movie({ title: 'Funny', genres: [COMEDY] })];
  const people = [person('Lea', { liked: [HORROR, COMEDY] }), person('Tom', { refused: [HORROR] })];
  const ranking = rankMovies(movies, people);
  assert.deepEqual(titles(ranking), ['Funny']);
  assert.equal(ranking.eliminated.veto, 1);
});

test('runtime elimination uses the strictest limit in the group', () => {
  const movies = [
    movie({ title: 'Short', runtime: 85 }),
    movie({ title: 'Medium', runtime: 100 }),
    movie({ title: 'Long', runtime: 140 }),
  ];
  const people = [person('Lea', { maxRuntime: 150 }), person('Tom', { maxRuntime: 90 }), person('Sam')];
  assert.equal(strictestRuntime(people), 90);
  const ranking = rankMovies(movies, people);
  assert.deepEqual(titles(ranking), ['Short']);
  assert.equal(ranking.eliminated.runtime, 2);
  assert.equal(strictestRuntime([person('Sam')]), Infinity);
});

test('provider filter keeps only movies on at least one selected provider', () => {
  const movies = [
    movie({ title: 'OnNetflix', providers: [NETFLIX] }),
    movie({ title: 'OnPrime', providers: [PRIME] }),
    movie({ title: 'Nowhere', providers: [] }),
  ];
  const people = [person('Lea')];
  assert.deepEqual(titles(rankMovies(movies, people, { providers: [NETFLIX] })).sort(), ['OnNetflix']);
  assert.deepEqual(titles(rankMovies(movies, people, { providers: [NETFLIX, PRIME] })).sort(), ['OnNetflix', 'OnPrime']);
  // No provider selected = no filter, movies without streaming included.
  assert.equal(rankMovies(movies, people, { providers: [] }).results.length, 3);
});

test('mean + min (least misery) beats a polarizing movie that mean-only would pick', () => {
  const polarizing = movie({ title: 'Polarizing', genres: [HORROR] });
  const consensus = movie({ title: 'Consensus', genres: [HORROR, COMEDY] });
  const people = [person('Lea', { liked: [HORROR] }), person('Tom', { liked: [HORROR] }), person('Sam', { liked: [COMEDY] })];
  const ranking = rankMovies([polarizing, consensus], people);
  const byTitle = Object.fromEntries(ranking.results.map((r) => [r.movie.title, r]));
  const meanOnly = (r) => mean(r.perPerson.map((p) => p.score));

  // Mean only: 2/3 vs 1/2, the polarizing movie would win.
  assert.ok(meanOnly(byTitle.Polarizing) > meanOnly(byTitle.Consensus));
  // Mean + min: 0.33 vs 0.5, the consensus movie wins.
  assert.equal(byTitle.Polarizing.group, 0.33);
  assert.equal(byTitle.Consensus.group, 0.5);
  assert.deepEqual(titles(ranking), ['Consensus', 'Polarizing']);
});

test('ties on group score are broken by weighted rating, then vote count', () => {
  const C = 7;
  const fewVotesHighRating = movie({ title: 'Niche', rating: 9, votes: 50 }); // WR ≈ 7.18
  const manyVotesGoodRating = movie({ title: 'Popular', rating: 8, votes: 5000 }); // WR ≈ 7.91
  const people = [person('Lea', { liked: [COMEDY] })];

  assert.ok(weightedRating(manyVotesGoodRating, C) > weightedRating(fewVotesHighRating, C));
  const ranking = rankMovies([fewVotesHighRating, manyVotesGoodRating], people, { meanRating: C });
  assert.deepEqual(titles(ranking), ['Popular', 'Niche']);
  assert.equal(ranking.results[0].group, ranking.results[1].group);

  // Same group score and same weighted rating (R = C): the vote count is the last word.
  const a = movie({ title: 'More votes', rating: 7, votes: 4000 });
  const b = movie({ title: 'Fewer votes', rating: 7, votes: 900 });
  assert.ok(Math.abs(weightedRating(a, 7) - weightedRating(b, 7)) < 1e-9); // R = C makes WR equal
  assert.deepEqual(titles(rankMovies([b, a], people, { meanRating: 7 })), ['More votes', 'Fewer votes']);
});

test('a 1-person group: group score equals the individual score', () => {
  const movies = [movie({ title: 'Half', genres: [COMEDY, DRAMA] }), movie({ title: 'Full', genres: [COMEDY] })];
  const ranking = rankMovies(movies, [person('Lea', { liked: [COMEDY] })]);
  assert.deepEqual(titles(ranking), ['Full', 'Half']);
  assert.equal(ranking.results[0].group, 1);
  assert.equal(ranking.results[1].group, 0.5);
  const why = explainResult(ranking.results[0], [person('Lea', { liked: [COMEDY] })], () => 'Comedy');
  assert.match(why, /^Lea loves Comedy\./);
  assert.doesNotMatch(why, /Least happy/);
});

test('a group without any text ranks on genres only', () => {
  const movies = [
    movie({ title: 'Action comedy', genres: [ACTION, COMEDY] }),
    movie({ title: 'Romance', genres: [ROMANCE] }),
  ];
  const people = [person('Lea', { liked: [ACTION] }), person('Tom', { liked: [COMEDY] }), person('Sam')];
  const ranking = rankMovies(movies, people, { similarities: [null, null, null] });
  for (const r of ranking.results) {
    for (const p of r.perPerson) {
      assert.equal(p.text, null);
      assert.equal(p.score, p.genre);
    }
  }
  assert.equal(genreScore(movies[0], people[2]), NEUTRAL_GENRE_SCORE);
  assert.deepEqual(titles(ranking), ['Action comedy', 'Romance']);
});

test('text similarity is min-max normalized across survivors and weighted 0.6 / 0.4', () => {
  const movies = [
    movie({ title: 'Vetoed', genres: [HORROR] }),
    movie({ title: 'Close', genres: [COMEDY] }),
    movie({ title: 'Far', genres: [COMEDY] }),
  ];
  const people = [person('Lea', { liked: [COMEDY], refused: [HORROR], text: 'a tense survival story' })];
  // The vetoed movie has the highest similarity but must not affect normalization.
  const ranking = rankMovies(movies, people, { similarities: [[0.99, 0.6, 0.2]] });
  const [first, second] = ranking.results;
  assert.equal(first.movie.title, 'Close');
  assert.equal(first.perPerson[0].text, 1);
  assert.equal(second.perPerson[0].text, 0);
  assert.equal(first.group, 1); // 0.6 * 1 + 0.4 * 1
  assert.equal(second.group, 0.6); // 0.6 * 1 + 0.4 * 0
  assert.match(explainResult(first, people, () => 'Comedy'), /Closest to Lea's description: 'a tense survival story'/);
  assert.deepEqual(minMaxNormalize([0.4, 0.4]), [0.5, 0.5]);
});

test('empty result: diagnosis points at the constraint to relax', () => {
  const movies = [movie({ runtime: 130, genres: [COMEDY] }), movie({ runtime: 140, genres: [DRAMA] })];
  const people = [person('Lea', { maxRuntime: 90 }), person('Tom', { refused: [DRAMA] })];
  const ranking = rankMovies(movies, people);
  assert.equal(ranking.results.length, 0);

  const diagnosis = diagnoseEmpty(movies, people, []);
  assert.equal(diagnosis.suggestions[0].type, 'runtime');
  assert.equal(diagnosis.suggestions[0].count, 1);
  assert.deepEqual(diagnosis.suggestions[0].people, ['Lea']);
  const { tips } = describeEmpty(diagnosis);
  assert.match(tips[0], /Lea's 90 min runtime limit is the strictest/);

  // Nothing at all in the catalog: still a friendly message, never a crash.
  assert.deepEqual(rankMovies([], people).results, []);
  assert.ok(describeEmpty(diagnoseEmpty([], people, [])).tips.length > 0);
});

test('group score formula', () => {
  assert.equal(groupScore([1, 0.5]), 0.5 * 0.75 + 0.5 * 0.5);
  assert.equal(groupScore([]), 0);
});

test('explanation mentions fans, neutral members, vetoes and the least happy person', () => {
  const m = movie({ genres: [COMEDY] });
  const people = [
    person('Lea', { liked: [COMEDY] }),
    person('Tom', { liked: [COMEDY] }),
    person('Sam', { liked: [DRAMA], refused: [HORROR] }),
  ];
  const [result] = rankMovies([m], people).results;
  const why = explainResult(result, people, (id) => ({ [COMEDY]: 'Comedy' })[id]);
  assert.match(why, /^Lea and Tom love Comedy, Sam is fine with it, nobody vetoed anything\./);
  assert.match(why, /Least happy: Sam \(0%\)/);
});
