# 🎬 MovieMatch

**MovieMatch helps a group of 1 to 4 people pick a movie everyone will enjoy.**
Each person says which genres they like and refuse, how long they can sit still and, optionally, what they feel like watching in their own words.
MovieMatch ranks ~1,700 movies released since 2022 by *group* fit, using a Hugging Face sentence-embedding model for the free text, and explains every pick.

It is a fully static site (HTML/CSS/JS modules, no backend): the AI model runs in the browser.

---

## Run it locally

You need [Node.js](https://nodejs.org/) 18 or newer (only to serve the files; there is nothing to build).

```bash
npm start
```

Then open http://localhost:3000. (`npm start` runs `npx serve`; any static server works. Opening `index.html` by double-click does **not** work, because browsers block ES modules on `file://`.)

Run the unit tests (Node's built-in test runner, no dependencies):

```bash
npm test
```

## Refresh the movie data (optional)

The generated files in `data/` are committed, so you only need this to update the catalog.

1. Create a free account on [themoviedb.org](https://www.themoviedb.org/signup), then go to **Settings → API** and request an API key (choose "Developer", any description works).
2. Copy the **API Read Access Token** (the long one starting with `eyJ…`).
3. Create your `.env` from the template and paste the token:
   ```bash
   cp .env.example .env
   ```
   ```
   TMDB_TOKEN=eyJhbGciOi...
   ```
   `.env` is git-ignored. The token is only used by the build script and never reaches the browser.
4. Install the build dependency (transformers.js for Node) and run the build:
   ```bash
   npm install
   npm run build:data
   ```
   For a quick check first, run on 50 movies: `npm run build:data -- --sample 50`.

The script fetches movies released since 2022-01-01 with at least 200 votes (about 1,700 today; the script keeps every match, with a safety cap of 2,500), their French subscription streaming providers, computes the embeddings and writes `data/movies.json` and `data/embeddings.bin`. TMDB responses are cached in `.cache/` for 7 days, so reruns are fast (`--no-cache` to force a refresh). Commit the two files in `data/` afterwards.

## Deploy on GitHub Pages

1. Create a GitHub repository named `moviematch` and push this folder to the `main` branch (with the `data/` files):
   ```bash
   git init
   git add .
   git commit -m "MovieMatch"
   git branch -M main
   git remote add origin https://github.com/USER/moviematch.git
   git push -u origin main
   ```
2. On GitHub, open the repository → **Settings** → **Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
4. Choose branch **main** and folder **/ (root)**, then click **Save**.
5. After a minute, the site is live at `https://USER.github.io/moviematch/`.

All paths in the app are relative (`./src/…`, `../data/…`), so it works from that sub-path, from Netlify, or from any static host. Check that `.env` was **not** pushed (`git ls-files | grep .env` should only show `.env.example`).

## How it works

**1. Filters (vetoes).** A movie is eliminated if any person refuses one of its genres, if it is longer than the *strictest* runtime limit in the group, or, when streaming services are selected, if it is not included in any of them.

**2. Genre score** for each person: the share of the movie's genres they like, `g = |genres ∩ liked| / |genres|`. Someone who picked no favourite genre gets a neutral 0.5.

**3. Text score (the AI part).** Each movie is turned into a 384-dimension vector by the sentence-embedding model [`all-MiniLM-L6-v2`](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) applied to *"title. synopsis"* (pre-computed once, stored as 8-bit integers to keep the download small). When someone describes what they feel like watching, the same model runs **in the browser** with [Transformers.js](https://huggingface.co/docs/transformers.js) to embed their sentence. The cosine similarity between the two vectors measures how close the meaning is, even without shared words ("a tense survival story" finds movies about being stranded, hunted or trapped). Similarities are rescaled to [0, 1] across the remaining movies: `t`.

**4. Individual score:** `s = 0.6 × g + 0.4 × t` if the person wrote something, otherwise `s = g`.

**5. Group score, "least misery":** `G = 0.5 × mean(s) + 0.5 × min(s)`. The average alone would happily pick a movie two people love and the third hates; adding the minimum makes sure nobody is left unhappy.

**6. Quality.** Group fit alone can crown a movie nobody actually enjoyed (in testing, a 4.6/10 comedy came first). So each movie also gets a weighted rating `WR = v/(v+m) × R + m/(v+m) × C` (R = TMDB rating, v = votes, m = 500, C = mean rating of the catalog), which pulls movies with few votes towards the average. `WR` is rescaled to [0, 1] across the remaining movies: `q`.

**7. Final score and ranking:** `S = 0.8 × G + 0.2 × q`, rounded to 2 decimals and shown on each card. Fit stays the main driver: the rating reorders movies that fit almost equally well, but cannot rescue a poor fit. Ties are broken by `WR`, then by vote count.

Each result comes with a deterministic explanation built from these numbers (who loves which genre, whose description it matches, whether it is especially well or poorly rated, who is the least happy). No chatbot involved. If no movie survives the filters, MovieMatch tries relaxing each constraint on its own and tells you which one would help most.

If the model cannot load (offline, old browser), MovieMatch keeps working on genres only.

## Project structure

```
index.html              single page
src/main.js             state, events, search flow
src/ui.js               DOM rendering
src/scoring.js          pure scoring + explanations (unit-tested)
src/model.js            lazy Transformers.js loader (CDN) and text embedding
src/data.js             loads data/ and computes cosine similarities
src/styles.css
scripts/build-data.mjs  TMDB + embeddings → data/
data/                   movies.json, embeddings.bin (committed)
tests/scoring.test.mjs  node --test
```

## Credits

This product uses the TMDB API but is not endorsed or certified by TMDB. Streaming availability data provided by JustWatch (through TMDB). Embedding model: sentence-transformers/all-MiniLM-L6-v2 (ONNX conversion by Xenova), run with Hugging Face Transformers.js.
