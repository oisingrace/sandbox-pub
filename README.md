# My Projects
Access here
https://oisingrace.github.io/sandbox-pub/#

One website for all my little HTML games and experiments.

## Adding a game

1. Put the game's `.html` file in the [`games/`](games/) folder
   (on GitHub: open `games/` → **Add file** → **Upload files**).
2. Commit. That's it — the site rebuilds itself in about a minute.

The card name comes from the game's `<title>` tag (or the file name if there isn't one).
Each game gets its own link, e.g. `https://<username>.github.io/sandbox-pub/#example-clicker`.

Experiments, demos and toys go in the [`experiments/`](experiments/) folder instead, the
same way. They show up under **Experiments** on the site, with links like `#experiments/<name>`.

Each card on the home page shows a screenshot from
`screenshots/games/<name>.jpg` (or `screenshots/experiments/<name>.jpg`), named after
the game's file, e.g. `screenshots/games/smash-lot.jpg` for `smash-lot.html`.
A game without one gets an emoji instead.

Games that use extra files (images, sounds, scripts) can live in a subfolder next to
them, e.g. `games/assets/...`, and reference them with relative paths.

## Patch notes

The home page has a **Patch notes** section that fills itself in. Every time you
add, update or delete a game, it gets an entry with the date and time and which games
changed. To add your own note, type it in the commit message box when you upload
(**Commit changes** on GitHub). GitHub's default messages like "Add files via upload"
are left out.

A game or experiment can also bring its own patch notes, with versions and bullet points (Smash Lot
does). Put a block like this anywhere in the game's HTML, newest version first:

```html
<script type="application/json" id="patch-notes">
[
  { "version": "1.1", "date": "2026-10-06", "title": "Faster cars", "notes": ["Cars are faster.", "New map."] },
  { "version": "1.0", "date": "2026-10-01", "title": "First release", "notes": ["The game."] }
]
</script>
```

Each version then shows as its own entry, and that game's upload commits are left out
so it isn't listed twice.

## Search engines

`sitemap.xml` is rebuilt on every push and lists the home page plus every game and
experiment page. It's submitted in Google Search Console as
`https://oisingrace.github.io/sandbox-pub/sitemap.xml`.

## One-time setup

Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
The site is published from the `main` branch.
