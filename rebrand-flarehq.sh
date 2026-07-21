#!/usr/bin/env bash

set -e

echo "========================================"
echo " FlareHQ → New Brand Replacer"
echo "========================================"
echo

read -p "New brand name (example: FlareHQ): " NEW_BRAND

if [ -z "$NEW_BRAND" ]; then
  echo "No brand supplied."
  exit 1
fi

UPPER=$(echo "$NEW_BRAND" | tr '[:lower:]' '[:upper:]')

echo
echo "Replacing visible branding with:"
echo "  FlareHQ -> $NEW_BRAND"
echo "  FLAREHQ -> $UPPER"
echo
read -p "Continue? (y/N): " CONFIRM

[[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]] && exit

echo
echo "Updating files..."
echo

find . \
    -type f \
    ! -path "./.git/*" \
    ! -path "./node_modules/*" \
    ! -path "./.next/*" \
    ! -path "./dist/*" \
    ! -path "./build/*" \
    ! -path "./coverage/*" \
    ! -name "*.png" \
    ! -name "*.jpg" \
    ! -name "*.jpeg" \
    ! -name "*.gif" \
    ! -name "*.ico" \
    ! -name "*.svg" \
    ! -name "*.pdf" \
    ! -name "*.lock" \
| while read file
do

python3 - "$file" "$NEW_BRAND" "$UPPER" <<'PY'
import sys

path=sys.argv[1]
brand=sys.argv[2]
upper=sys.argv[3]

try:
    text=open(path,"r",encoding="utf-8").read()
except:
    sys.exit()

original=text

# -------------------------------------------------
# PROTECTED INTERNALS
# -------------------------------------------------

protected={}

def protect(s):
    key=f"__KEEP_{len(protected)}__"
    protected[key]=s
    return key

import re

patterns=[
r'FLAREHQ_[A-Z0-9_]+',
r'NEXT_PUBLIC_FLAREHQ_[A-Z0-9_]+',
r'https://flarehq-gateway\.onrender\.com',
r'flarehq-gateway\.onrender\.com',
r'ArcFlareEscrow\.sol',
r'ArcFlareStream\.sol',
r'contract ArcFlareEscrow',
r'contract ArcFlareStream',
r'arcflare-backend',
r'ArcFlareEscrow',
r'ArcFlareStream',
r'arcflare-layout',
r'arcflare-sidebar',
r'arcflare-main',
r'arcflare-grid-2',
r'arcflare-grid-3',
r'arcflare-grid-4',
r'arcflare-table-wrap',
r'arcflare-card',
r'arcflare-chart-row',
r'arcflare-stat-card',
r'arcflare-btn-row',
r'arcflare-table-col-hide',
r'flarehq-logo\.png',
r'flarehq-logo\.png\.png',
r'arcflare-validation',
r'source:\s*[\'"]flarehq[\'"]',
r'prefix:\s*[\'"]flarehq[\'"]',
r'x-arcflare-tx-hash'
]

for p in patterns:
    text=re.sub(
        p,
        lambda m: protect(m.group(0)),
        text
    )

# -------------------------------------------------
# SAFE BRAND REPLACEMENTS
# -------------------------------------------------

text=text.replace("FLAREHQ",upper)
text=text.replace("FlareHQ",brand)
text=text.replace("flarehq",brand.lower())

# -------------------------------------------------
# RESTORE INTERNALS
# -------------------------------------------------

for k,v in protected.items():
    text=text.replace(k,v)

if text!=original:
    open(path,"w",encoding="utf-8").write(text)
    print(path)

PY

done

echo
echo "========================================"
echo "Finished."
echo "========================================"
echo
echo "Now run:"
echo
echo "git diff"
echo
echo "Review the changes before committing."