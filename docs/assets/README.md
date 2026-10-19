# Project imagery

## `tinkit-banner.png` (README cover)

1920 × 960 pixels (a 1280 × 640 layout rendered at 1.5× pixel density), 2:1, so it also works as the GitHub social preview image (Settings → General → Social preview).

The source is [`banner.html`](./banner.html): HTML and inline SVG (the smiling pastel block, the navy `#0c1935` wordmark, the purple and blue accents), set in Inter Display and DejaVu Sans Mono. To change it, edit the HTML, then render it with Chromium, for example with Playwright:

```js
const { chromium } = require('playwright');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1.5 });
await page.goto(`file://${process.cwd()}/docs/assets/banner.html`);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: 'docs/assets/tinkit-banner.png' });
await browser.close();
```

The facts under the install command are deliberately free of counts (no number of helpers or modules), so the image does not go stale as the library grows; keep it that way. Re-save the PNG losslessly optimised (palette quantisation visibly shifts the pastel gradients). The README links the image by its absolute raw GitHub URL so that it also renders on npmjs.com, which does not resolve paths relative to the repository. None of these files are published to npm: the `files` allowlist in `package.json` excludes `docs/`.
