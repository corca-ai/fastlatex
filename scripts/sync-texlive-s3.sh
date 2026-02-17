#!/usr/bin/env bash
# Extract TeX Live files into flat S3 structure and optionally upload.
# No Docker required — downloads texmf tarball directly from CTAN historic archive.
#
# Usage:
#   ./scripts/sync-texlive-s3.sh            # extract only (to /tmp/texlive-s3/)
#   ./scripts/sync-texlive-s3.sh --upload   # extract + upload to S3
#
# Environment variables:
#   TEXMF_DIST   Use existing texmf-dist directory (skips download)
#   S3_BUCKET    S3 bucket name (default: akcorca-texlive)
#   WORK_DIR     Working directory (default: /tmp/texlive-s3)

set -euo pipefail

TEXLIVE_YEAR=2020
TEXMF_TARBALL="texlive-20200406-texmf.tar.xz"
TEXMF_URL="https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/${TEXLIVE_YEAR}/${TEXMF_TARBALL}"

S3_BUCKET="${S3_BUCKET:-akcorca-texlive}"
WORK_DIR="${WORK_DIR:-/tmp/texlive-s3}"

DO_UPLOAD=false
for arg in "$@"; do
  case "$arg" in
    --upload) DO_UPLOAD=true ;;
    --help|-h)
      sed -n '2,12s/^# //p' "$0"
      exit 0
      ;;
  esac
done

OUT_DIR="$WORK_DIR/pdftex"

# --- Step 1: Get texmf-dist ---

if [ -n "${TEXMF_DIST:-}" ]; then
  echo "Using local texmf-dist: $TEXMF_DIST"
  TEXMF="$TEXMF_DIST"
else
  TEXMF="$WORK_DIR/${TEXMF_TARBALL%.tar.xz}/texmf-dist"
  if [ ! -d "$TEXMF" ]; then
    echo "Downloading TeX Live $TEXLIVE_YEAR texmf (~2.9 GB)..."
    mkdir -p "$WORK_DIR"
    curl -L --progress-bar "$TEXMF_URL" | tar xJ -C "$WORK_DIR"
  else
    echo "Using cached texmf at $TEXMF"
  fi
fi

[ -d "$TEXMF" ] || { echo "Error: texmf-dist not found at $TEXMF"; exit 1; }

# --- Step 2: Extract into flat S3 structure ---

echo "Extracting files from $TEXMF ..."
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"/{3,10,11,26,32,33,44}

# Helper: copy files, skip duplicates (first-found wins)
copy_flat() {
  local src_dir="$1" dst_dir="$2" ext="${3:-}" strip_ext="${4:-false}"
  local n=0
  while IFS= read -r f; do
    local bn
    if [ "$strip_ext" = true ]; then
      bn=$(basename "$f" "$ext")
    else
      bn=$(basename "$f")
    fi
    if [ ! -f "$dst_dir/$bn" ]; then
      cp "$f" "$dst_dir/$bn"
      n=$((n + 1))
    fi
  done < <(find "$src_dir" -name "*${ext}" -type f)
  echo "$n"
}

# Type 26: TeX sources (.sty, .cls, .def, .tex, ...)
n26=0
for dir in "$TEXMF/tex/latex" "$TEXMF/tex/generic" "$TEXMF/tex/plain"; do
  if [ -d "$dir" ]; then
    c=$(copy_flat "$dir" "$OUT_DIR/26" "" false)
    n26=$((n26 + c))
  fi
done
echo "  type 26 (TeX sources): $n26 files"

# Type 3: TFM font metrics (strip .tfm extension)
n3=$(copy_flat "$TEXMF/fonts/tfm" "$OUT_DIR/3" ".tfm" true)
echo "  type  3 (TFM fonts):   $n3 files"

# Type 32: PostScript fonts (.pfb)
n32=$(copy_flat "$TEXMF/fonts/type1" "$OUT_DIR/32" ".pfb" false)
echo "  type 32 (PS fonts):    $n32 files"

# Type 33: Virtual fonts (strip .vf extension)
n33=$(copy_flat "$TEXMF/fonts/vf" "$OUT_DIR/33" ".vf" true)
echo "  type 33 (VF fonts):    $n33 files"

# Type 11: Font maps (.map)
n11=$(copy_flat "$TEXMF/fonts/map" "$OUT_DIR/11" ".map" false)
echo "  type 11 (font maps):   $n11 files"

# Type 44: Encoding files (.enc)
n44=$(copy_flat "$TEXMF/fonts/enc" "$OUT_DIR/44" ".enc" false)
echo "  type 44 (encodings):   $n44 files"

total=$(find "$OUT_DIR" -type f | wc -l | tr -d ' ')
size=$(du -sh "$OUT_DIR" | cut -f1)
echo ""
echo "Total: $total files ($size) in $OUT_DIR"

# --- Step 3: Upload to S3 ---

if [ "$DO_UPLOAD" = true ]; then
  echo ""
  echo "Uploading to s3://$S3_BUCKET/pdftex/ ..."
  aws s3 sync "$OUT_DIR/" "s3://$S3_BUCKET/pdftex/" --size-only
  echo "Done."
else
  echo ""
  echo "Dry run complete. To upload:"
  echo "  $0 --upload"
  echo "  # or manually:"
  echo "  aws s3 sync $OUT_DIR/ s3://$S3_BUCKET/pdftex/ --size-only"
fi
