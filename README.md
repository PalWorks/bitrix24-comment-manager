# Website

This branch holds the one page site for
[Bitrix24 Comment Manager](https://github.com/PalWorks/bitrix24-comment-manager),
served by GitHub Pages at
<https://palworks.github.io/bitrix24-comment-manager/>.

It is an orphan branch. It shares no history with `main` and contains no
application code, so the site can be edited without touching a release.

## Structure

```
index.html          the whole site, styles inline
assets/             logo at 64, 192, and 512 px
.nojekyll           serve files as-is, no Jekyll build
```

Everything is static. There is no build step, no dependency, and no JavaScript:
open `index.html` in a browser and what you see is what deploys.

## Editing

Content and styles both live in `index.html`. Design tokens sit in the `:root`
block at the top, with the dark palette redefined twice below it, once for the
`prefers-color-scheme` default and once for an explicit `data-theme` choice.
Change a colour there and it propagates.

The palette is taken from bitrix24.com's own stylesheet so the page reads as a
neighbour of the platform it plugs into. The orange is the exception, lifted
from the checkmark in the product mark and used only for the audit motif.

Work on it in a worktree so `main` stays checked out:

```bash
git worktree add ../site gh-pages
cd ../site
python3 -m http.server 8080   # then open http://localhost:8080
```

## Deploying

Pushing this branch publishes. Pages is configured under
**Settings > Pages > Source: Deploy from a branch > gh-pages / (root)**.
No GitHub Actions workflow is involved.
