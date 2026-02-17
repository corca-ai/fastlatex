# Development Guide

## Quick Start

```bash
npm run dev
# App: http://localhost:5555
```

No Docker required. TeX packages are fetched on demand from CloudFront CDN.

## Prerequisites

- Node.js (see `.nvmrc`)
- WASM engine files in `public/swiftlatex/` (see Engine Setup below)

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite dev server (hot reload) |
| `npm run build` | Type check + production build |
| `npm run check` | TypeScript type check only |
| `npm run test` | Unit tests (vitest, single run) |
| `npm run test:watch` | Unit tests in watch mode |
| `npm run test:e2e` | E2E tests (Playwright, requires Docker) |
| `npm run lint` | Lint check (Biome) |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm run format` | Format code (Biome) |
| `npm run download-engine` | Download/setup WASM engine |

## Architecture

```
Browser
├── Monaco Editor (code editing)
├── PDF.js (PDF rendering)
└── SwiftLaTeX WASM Worker (pdfTeX 1.40.22)
      └── fetches packages on demand from CloudFront CDN
```

- **No framework** — vanilla TypeScript + Vite
- WASM engine runs in a Web Worker, communicates via `postMessage`
- SyncTeX provides bidirectional PDF ↔ source navigation
- All TeX Live packages (~120k files) served from S3/CloudFront on demand

## Project Structure

```
src/
├── engine/           # WASM engine wrapper, compile scheduler
├── editor/           # Monaco editor setup
├── viewer/           # PDF.js viewer, page renderer
├── synctex/          # SyncTeX parser + text-based fallback mapper
├── lsp/              # LaTeX language services (completion, hover, diagnostics, etc.)
├── fs/               # Virtual filesystem
├── ui/               # File tree, error log, layout, error markers
├── perf/             # Performance metrics + debug overlay
├── latex-editor.ts   # Component API (LatexEditor class)
├── main.ts           # Standalone app entry point
└── types.ts          # Shared types

public/swiftlatex/    # WASM engine files (not in git)
wasm-build/           # pdfTeX WASM build pipeline (Docker)
scripts/              # Helper scripts
e2e/                  # Playwright E2E tests
docs/                 # Documentation
texlive-server/       # Docker texlive (S3 extraction only, not needed for dev)
```

## Engine Setup

The WASM engine files (`swiftlatexpdftex.js`, `.wasm`) must be in `public/swiftlatex/`.

### Option A: Download pre-built (fast)

```bash
npm run download-engine
```

Downloads from SwiftLaTeX GitHub releases. Does **not** include SyncTeX support.

### Option B: Build from source with SyncTeX (slow)

```bash
cd wasm-build
docker build --platform linux/amd64 -t pdftex-wasm .
docker run --platform linux/amd64 -v "$(pwd)/dist:/dist" pdftex-wasm
cp dist/swiftlatexpdftex.js dist/swiftlatexpdftex.wasm ../public/swiftlatex/
```

<details><summary>Build time expectations</summary>

The WASM build is a two-phase process and is **extremely slow** on ARM Macs (Apple Silicon) because it runs x86_64 emulation via QEMU/Rosetta.

| Phase | ARM Mac (QEMU) | x86_64 Linux |
|-------|---------------|--------------|
| Docker image build | ~15 min (first), ~1 min (cached) | ~5 min (first) |
| Phase 1: Native configure | ~10–15 min | ~2 min |
| Phase 1: Native compile (libs + web2c) | ~30–60 min | ~5–10 min |
| Phase 2: WASM configure (emconfigure) | ~10–15 min | ~2 min |
| Phase 2: WASM compile (emmake + emcc) | ~20–40 min | ~5–10 min |
| **Total** | **~1.5–2.5 hours** | **~15–30 min** |

The bottleneck is `libs/icu/` (ICU C++ library, ~200 source files) and `texk/web2c/` (pdfTeX C generation via tangle). On ARM Mac the Docker container runs under QEMU emulation for x86_64 which makes everything ~5–10x slower.

**Recommendation**: If possible, run the WASM build on an x86_64 Linux machine or CI server.

**Build phases:**

1. **Phase 1 — Native build**: Compiles TeX Live natively to generate pdfTeX C source files (`pdftex0.c`, `pdftexini.c`, etc.) using the `tangle` tool. These tools can only run natively, not under Emscripten.

2. **Phase 2 — WASM build**: Configures TeX Live through `emconfigure`, copies the natively-generated C files, then compiles everything with `emcc` to produce the `.wasm` + `.js` output.

The full build may show errors for luajittex (missing `hb.h`) — this is expected and ignored. Only pdfTeX is needed.

</details>

## TexLive Package Serving

The WASM worker fetches LaTeX packages on demand during compilation via synchronous XHR.

### How it works (S3 + CloudFront)

All packages are served from S3 via CloudFront. This is used for **both development and production** — no local server needed.

| Resource | Value |
|----------|-------|
| S3 bucket | `akcorca-texlive` (ap-northeast-2) |
| CloudFront | `dwrg2en9emzif.cloudfront.net` (distribution `EZLBEEMI7TKVN`) |
| Files | ~120,000 files, ~1.7 GB |
| CORS | `Access-Control-Allow-Origin: *`, exposes `fileid`/`pkid` headers |

The URL is configured via:
- **`npm run dev`**: defaults to `${location.origin}${BASE_URL}texlive/`, which proxies to CloudFront via Vite config, or set `VITE_TEXLIVE_URL`
- **Production build**: `VITE_TEXLIVE_URL=https://dwrg2en9emzif.cloudfront.net/` (set in CI)
- **Embedding API**: `new LatexEditor({ texliveUrl: 'https://dwrg2en9emzif.cloudfront.net/' })`

#### URL structure

The worker requests files as `{texliveUrl}pdftex/{format}/{filename}`:

| Format | Content | Example |
|--------|---------|---------|
| 3 | TFM font metrics (no extension) | `pdftex/3/cmr10` |
| 10 | Format files | `pdftex/10/swiftlatexpdftex.fmt` |
| 11 | Font maps | `pdftex/11/pdftex.map` |
| 26 | TeX sources (.sty, .cls, .def, ...) | `pdftex/26/geometry.sty` |
| 32 | PostScript fonts (.pfb) | `pdftex/32/cmr10.pfb` |
| 33 | Virtual fonts (no extension) | `pdftex/33/cmr10` |
| 44 | Encoding files (.enc) | `pdftex/44/cm-super-ts1.enc` |

Missing files must return 404 (not 403). The worker caches both hits and misses in memory.

### Docker texlive server (S3 extraction only)

The Docker texlive server (`texlive-server/`) is **not needed for development or production**. Its only remaining purpose is as a source for extracting files to upload to S3.

The server has no computation logic — it only maps filenames to files via `libkpathsea` and serves them over HTTP. This is fully replaced by the flat S3 file structure.

<details><summary>Rebuilding the S3 content</summary>

To extract files from the Docker texlive image and upload to S3:

```bash
# 1. Start the texlive container
docker compose up -d texlive

# 2. Extract files into flat structure inside the container
docker exec latex-texlive-1 bash -c '
mkdir -p /tmp/texlive-s3/pdftex/{3,10,11,26,32,33,44}

# Both texmf trees contain files — search both (texmf-dist first, texmf second)
TEXMF_DIRS="/usr/share/texlive/texmf-dist /usr/share/texmf"

# Type 26: TeX sources (latex/ takes priority over latex-dev/)
for dir in \
    /usr/share/texlive/texmf-dist/tex/latex \
    /usr/share/texlive/texmf-dist/tex/generic \
    /usr/share/texlive/texmf-dist/tex/plain; do
    [ -d "$dir" ] && find "$dir" -type f | while read f; do
        bn=$(basename "$f")
        dst="/tmp/texlive-s3/pdftex/26/$bn"
        [ ! -f "$dst" ] && cp "$f" "$dst"
    done
done

# Type 3: TFM fonts (strip .tfm extension)
for base in $TEXMF_DIRS; do
    [ -d "$base/fonts/tfm" ] && find "$base/fonts/tfm" -name "*.tfm" | while read f; do
        bn=$(basename "$f" .tfm)
        dst="/tmp/texlive-s3/pdftex/3/$bn"
        [ ! -f "$dst" ] && cp "$f" "$dst"
    done
done

# Type 32: PostScript fonts
for base in $TEXMF_DIRS; do
    [ -d "$base/fonts/type1" ] && find "$base/fonts/type1" -name "*.pfb" | while read f; do
        bn=$(basename "$f")
        dst="/tmp/texlive-s3/pdftex/32/$bn"
        [ ! -f "$dst" ] && cp "$f" "$dst"
    done
done

# Type 33: Virtual fonts (strip .vf extension)
for base in $TEXMF_DIRS; do
    [ -d "$base/fonts/vf" ] && find "$base/fonts/vf" -name "*.vf" | while read f; do
        bn=$(basename "$f" .vf)
        dst="/tmp/texlive-s3/pdftex/33/$bn"
        [ ! -f "$dst" ] && cp "$f" "$dst"
    done
done

# Type 11: Font maps
for base in $TEXMF_DIRS; do
    [ -d "$base/fonts/map" ] && find "$base/fonts/map" -name "*.map" | while read f; do
        bn=$(basename "$f")
        dst="/tmp/texlive-s3/pdftex/11/$bn"
        [ ! -f "$dst" ] && cp "$f" "$dst"
    done
done

# Type 44: Encoding files
for base in $TEXMF_DIRS; do
    [ -d "$base/fonts/enc" ] && find "$base/fonts/enc" -name "*.enc" | while read f; do
        bn=$(basename "$f")
        dst="/tmp/texlive-s3/pdftex/44/$bn"
        [ ! -f "$dst" ] && cp "$f" "$dst"
    done
done
'

# 3. Copy to local filesystem
mkdir -p /tmp/texlive-s3
docker cp latex-texlive-1:/tmp/texlive-s3/pdftex /tmp/texlive-s3/pdftex

# 4. Upload to S3
aws s3 sync /tmp/texlive-s3/pdftex/ s3://akcorca-texlive/pdftex/
```

</details>

<details><summary>Setting up a new S3 + CloudFront deployment from scratch</summary>

```bash
BUCKET=akcorca-texlive
REGION=ap-northeast-2

# Create bucket
aws s3 mb s3://$BUCKET --region $REGION

# Allow public access
aws s3api put-public-access-block --bucket $BUCKET \
  --public-access-block-configuration \
  BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false

aws s3api put-bucket-policy --bucket $BUCKET --policy "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Sid\": \"PublicReadGetObject\",
    \"Effect\": \"Allow\",
    \"Principal\": \"*\",
    \"Action\": \"s3:GetObject\",
    \"Resource\": \"arn:aws:s3:::$BUCKET/*\"
  }]
}"

# Enable static website hosting (returns 404 instead of 403 for missing files)
aws s3 website s3://$BUCKET --index-document index.html

# CORS on S3 (needed for worker XHR)
aws s3api put-bucket-cors --bucket $BUCKET --cors-configuration '{
  "CORSRules": [{
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["fileid", "pkid"],
    "MaxAgeSeconds": 86400
  }]
}'

# Create CloudFront CORS response headers policy
POLICY_ID=$(aws cloudfront create-response-headers-policy --response-headers-policy-config '{
  "Name": "texlive-cors-policy",
  "Comment": "CORS for TeX Live static files",
  "CorsConfig": {
    "AccessControlAllowOrigins": { "Quantity": 1, "Items": ["*"] },
    "AccessControlAllowMethods": { "Quantity": 1, "Items": ["GET"] },
    "AccessControlAllowHeaders": { "Quantity": 1, "Items": ["*"] },
    "AccessControlExposeHeaders": { "Quantity": 2, "Items": ["fileid", "pkid"] },
    "AccessControlAllowCredentials": false,
    "AccessControlMaxAgeSec": 86400,
    "OriginOverride": true
  }
}' --query 'ResponseHeadersPolicy.Id' --output text)

# Create CloudFront distribution
# Uses S3 website endpoint as custom origin (not S3 origin) for proper 404 handling
aws cloudfront create-distribution --cli-input-json "{
  \"DistributionConfig\": {
    \"CallerReference\": \"$BUCKET-$(date +%s)\",
    \"Comment\": \"TeX Live static file serving\",
    \"Enabled\": true,
    \"Origins\": {
      \"Quantity\": 1,
      \"Items\": [{
        \"Id\": \"S3-Website-$BUCKET\",
        \"DomainName\": \"$BUCKET.s3-website.$REGION.amazonaws.com\",
        \"CustomOriginConfig\": {
          \"HTTPPort\": 80, \"HTTPSPort\": 443,
          \"OriginProtocolPolicy\": \"http-only\",
          \"OriginSslProtocols\": { \"Quantity\": 1, \"Items\": [\"TLSv1.2\"] }
        }
      }]
    },
    \"DefaultCacheBehavior\": {
      \"TargetOriginId\": \"S3-Website-$BUCKET\",
      \"ViewerProtocolPolicy\": \"redirect-to-https\",
      \"ResponseHeadersPolicyId\": \"$POLICY_ID\",
      \"AllowedMethods\": { \"Quantity\": 2, \"Items\": [\"GET\", \"HEAD\"],
        \"CachedMethods\": { \"Quantity\": 2, \"Items\": [\"GET\", \"HEAD\"] } },
      \"ForwardedValues\": { \"QueryString\": false,
        \"Cookies\": { \"Forward\": \"none\" }, \"Headers\": { \"Quantity\": 0 } },
      \"Compress\": true,
      \"MinTTL\": 86400, \"DefaultTTL\": 2592000, \"MaxTTL\": 31536000
    },
    \"PriceClass\": \"PriceClass_200\",
    \"ViewerCertificate\": { \"CloudFrontDefaultCertificate\": true },
    \"HttpVersion\": \"http2and3\"
  }
}"
```

</details>

### Version constraint

The WASM binary is pdfTeX **1.40.22**. Format files (`.fmt`) must be built by this exact version. Do **not** use Ubuntu 20.04's system `pdflatex.fmt` (built by 1.40.20) — it produces "Fatal format file error; I'm stymied".

## Tests

### Unit tests

```bash
npm run test          # single run
npm run test:watch    # watch mode
```

Test files live next to source: `src/**/*.test.ts`

### E2E tests

```bash
# Requires the full stack running
docker compose up -d
npm run test:e2e
```

E2E tests use Playwright and live in `e2e/`.

## Troubleshooting

### WASM worker caches 404s

If a file was temporarily missing and the worker cached the 404, the cache persists across recompiles. Fix: hard refresh the browser (Cmd+Shift+R) to clear the worker's `texlive404_cache`.

### l3backend errors

Newer `l3backend` packages (2023+) require `\__kernel_dependency_version_check:nn` which doesn't exist in the pdfTeX 1.40.22 format. The S3 deployment ships Ubuntu 20.04's `l3backend-pdfmode.def` (2020-02-03) which has no version check and works fine.
