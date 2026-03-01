# Deployment

## GitHub Pages

The documentation site is configured for GitHub Pages project page deployment with `base: '/context-evalver/'` in `docs/.vitepress/config.ts`.

### GitHub Actions Workflow

Create `.github/workflows/docs.yml` to auto-deploy on every push to `main`:

```yaml
name: Deploy Docs

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install docs dependencies
        working-directory: docs
        run: bun install

      - name: Build docs
        working-directory: docs
        run: bun run build

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: docs/.vitepress/dist

  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

### Enable GitHub Pages

1. Go to your repository **Settings → Pages**
2. Under **Source**, select **GitHub Actions**
3. Push to `main` to trigger the first deployment

The site will be available at `https://{username}.github.io/context-evalver/`.

## Local Preview

```bash
cd docs
bun install
bun run dev       # development server with hot reload
bun run build     # production build → .vitepress/dist/
bun run preview   # preview the production build locally
```
