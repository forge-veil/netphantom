# NetPhantom — build & publish targets
#
# Usage:
#   make            build geoip data and create the upload zip
#   make pack       zip only (skip geoip rebuild)
#   make geoip      regenerate devtools/panel/geoip-data.js from DB-IP Lite
#   make validate   check all required files exist before packaging
#   make clean      remove dist/
#   make version V=1.2.0   bump version in manifest.json

VERSION := $(shell node -p "require('./manifest.json').version" 2>/dev/null || echo "0.0.0")
DIST    := dist
ZIP     := $(DIST)/netphantom-$(VERSION).zip

# Files/dirs included in the Chrome Web Store upload
PACK_INCLUDES := \
  manifest.json \
  background    \
  devtools      \
  icons         \
  popup

.PHONY: all pack geoip validate test clean version help

all: geoip validate pack

# ── Pack ──────────────────────────────────────────────────────────────────────

pack: validate
	@mkdir -p $(DIST)
	@rm -f $(ZIP)
	zip -r $(ZIP) $(PACK_INCLUDES) \
	  --exclude "*.DS_Store" \
	  --exclude "__pycache__/*" \
	  --exclude "*.map" \
	  --exclude "icons/generate-icons.js" \
	  --exclude "icons/make-icons.html"
	@echo ""
	@echo "  Ready to upload: $(ZIP)"
	@echo "  Size: $$(du -sh $(ZIP) | cut -f1)"
	@echo ""
	@echo "  Chrome Web Store:"
	@echo "  https://chrome.google.com/webstore/devconsole"

# ── Test ──────────────────────────────────────────────────────────────────────

test:
	node --test tests/*.test.js

# ── GeoIP ─────────────────────────────────────────────────────────────────────

geoip:
	node tools/build-geoip.js

# ── Validate ──────────────────────────────────────────────────────────────────

REQUIRED_FILES := \
  manifest.json \
  background/service-worker.js \
  devtools/devtools.html \
  devtools/devtools.js \
  devtools/panel/panel.html \
  devtools/panel/panel.css \
  devtools/panel/panel.js \
  devtools/panel/graph.js \
  devtools/panel/worldmap.js \
  devtools/panel/annotations.js \
  devtools/panel/geoip-data.js \
  icons/icon16.png \
  icons/icon48.png \
  icons/icon128.png \
  popup/popup.html \
  popup/popup.css \
  popup/popup.js

validate:
	@echo "Validating required files…"
	@ok=1; \
	for f in $(REQUIRED_FILES); do \
	  if [ ! -f "$$f" ]; then \
	    echo "  MISSING: $$f"; ok=0; \
	  fi; \
	done; \
	if [ "$$ok" = "0" ]; then exit 1; fi
	@node -e "require('./manifest.json')" 2>&1 && echo "  manifest.json  OK" || (echo "  manifest.json  INVALID JSON"; exit 1)
	@echo "  All files present — version $(VERSION)"

# ── Version bump ──────────────────────────────────────────────────────────────

version:
ifndef V
	$(error Usage: make version V=1.2.0)
endif
	node -e "\
	  const fs = require('fs'); \
	  const m  = JSON.parse(fs.readFileSync('manifest.json','utf8')); \
	  m.version = '$(V)'; \
	  fs.writeFileSync('manifest.json', JSON.stringify(m, null, 2) + '\n'); \
	  console.log('manifest.json → version $(V)'); \
	"

# ── Clean ─────────────────────────────────────────────────────────────────────

clean:
	rm -rf $(DIST)
	@echo "Removed $(DIST)/"

# ── Help ──────────────────────────────────────────────────────────────────────

help:
	@echo ""
	@echo "  make              validate + rebuild geoip + zip for upload"
	@echo "  make test         run unit tests"
	@echo "  make pack         zip only (skips geoip rebuild)"
	@echo "  make geoip        regenerate geoip-data.js from DB-IP Lite"
	@echo "  make validate     check all required files exist"
	@echo "  make version V=x  bump version in manifest.json"
	@echo "  make clean        remove dist/"
	@echo ""
