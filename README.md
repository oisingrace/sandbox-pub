# My Games

One website for all my little HTML games and experiments.

## Adding a game

1. Put the game's `.html` file in the [`games/`](games/) folder
   (on GitHub: open `games/` → **Add file** → **Upload files**).
2. Commit. That's it — the site rebuilds itself in about a minute.

The card name comes from the game's `<title>` tag (or the file name if there isn't one).
Each game gets its own link, e.g. `https://<username>.github.io/sandbox-pub/#example-clicker`.

Games that use extra files (images, sounds, scripts) can live in a subfolder next to
them, e.g. `games/assets/...`, and reference them with relative paths.

## One-time setup

Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
The site is published from the `main` branch.
