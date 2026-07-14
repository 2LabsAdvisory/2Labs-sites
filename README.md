# 2Labs Sites — Phase 0 scaffold

This is the pilot: rebuilding **2labs.ca itself** (currently on Base44) as the
first real client of the AI website builder, before onboarding any NFP
clients. Goal of this phase: prove the core loop —

  prompt → Claude edits a component → static build → staging preview

works end to end, reliably, before adding multi-tenancy, onboarding, or the
dashboard UI on top.

## What's here

```
src/
  layouts/BaseLayout.astro   Injects brand tokens + SEO/schema.org tags on every page
  components/Header.astro    STRUCTURAL — locked from casual prompt edits
  components/Footer.astro    STRUCTURAL — locked from casual prompt edits
  pages/index.astro          CONTENT — the file the AI edit endpoint modifies
  styles/tokens.css          Reference copy of the CSS variable names used everywhere
site-config/
  brand.json                 Colors, fonts, logo description, voice
  org-context.json           Mission, offerings, audience, CTAs
  edit-policy.json           Which files are structural vs. freely editable
api/
  edit-site/                 The Azure Function: prompt -> commit to staging
.github/workflows/
  azure-static-web-apps.yml  Deploys `staging` branch to a preview env, `main` to production
```

Verified locally: `npm install && npm run build` produces real static HTML in
`dist/` — a single page load, one `<script>` tag (the schema.org JSON-LD
block), correct `<title>`/`<meta description>`, and brand colors baked into
the CSS. No SPA shell, fully crawlable.

## What's deliberately NOT here yet

- **Multi-tenancy.** `edit-site` is hardcoded to one repo and one file
  (`src/pages/index.astro`). Don't generalize this until the single-client
  loop is boring and reliable.
- **The editor UI** (chat + preview mockup). Once `edit-site` works from
  curl/Postman, wire it to the UI.
- **OTP login.** Reuse the PassCard flow rather than rebuilding it — not
  needed to validate the core loop.
- **Model routing, SEO review, GA4, Command Centre dashboard.** All
  additive once Phase 0 is solid.

## Setup steps

1. **Create the GitHub repo** and push this scaffold to it.
   ```
   git init
   git add .
   git commit -m "Phase 0 scaffold"
   git branch staging
   git remote add origin <your-repo-url>
   git push -u origin main staging
   ```

2. **Create the Azure Static Web App** (Standard plan — Free tier doesn't
   support the co-located API function you'll need later, though it's fine
   to start on it for Phase 0 if you want to save cost):
   - In the Azure Portal, "Create a resource" → Static Web App
   - Connect it to your GitHub repo
   - Build presets: Astro / app location `/` / output location `dist`
   - This automatically adds `AZURE_STATIC_WEB_APPS_API_TOKEN` as a GitHub
     secret and the workflow file above will pick it up

3. **Set Function App settings** (Azure Portal → your Static Web App →
   Configuration, or via `local.settings.json` for local testing — copy
   `api/local.settings.json.example` to `api/local.settings.json` and fill
   in real values, this file is gitignored):
   - `ANTHROPIC_API_KEY`
   - `GITHUB_TOKEN` (a token scoped to this one repo, repo-contents write)
   - `GITHUB_OWNER`, `GITHUB_REPO`

4. **Test the loop directly**, before touching any UI:
   ```
   curl -X POST https://<your-app>.azurestaticapps.net/api/edit-site \
     -H "Content-Type: application/json" \
     -d '{"prompt": "Change the hero subheading to mention we now specialize in AI websites for non-profits"}'
   ```
   Watch: does it commit to `staging`? Does the GitHub Action fire? Does the
   staging preview URL show the change within a minute or two?

5. Once that's boring and reliable, move to the editor UI mockup and wire
   its chat input to this same endpoint.

## Notes

- `brand.json` and `org-context.json` here reflect 2Labs' *own* real brand
  (pulled from the live 2labs.base44.app site) and mission — this is the
  live business site, not a throwaway test fixture, so `edit-site` treats
  it that way (see the system prompt in `api/edit-site/index.js`).
- Keep Base44 live until this reaches parity. Cut DNS over only once
  staging looks right.
