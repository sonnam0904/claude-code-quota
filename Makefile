UUID    := claude-code-quota@gnome-extension
SRC     := $(UUID)
DEST    := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SCHEMA  := org.gnome.shell.extensions.claude-code-quota.gschema.xml
DIST    := dist
BINDIR  ?= $(HOME)/.local/bin

.PHONY: all schemas test lint pack install install-cli uninstall clean prefs

all: schemas

schemas: $(SRC)/schemas/gschemas.compiled

$(SRC)/schemas/gschemas.compiled: $(SRC)/schemas/$(SCHEMA)
	glib-compile-schemas --strict $(SRC)/schemas

test:
	node --test tests/*.mjs
	python3 -m py_compile cli/claude-quota

lint:
	@for f in $(SRC)/*.js $(SRC)/lib/*.js; do node --check --input-type=module < $$f || exit 1; done
	@echo "syntax OK"

# Zip suitable for extensions.gnome.org or `gnome-extensions install`.
pack: schemas
	mkdir -p $(DIST)
	gnome-extensions pack $(SRC) --force --out-dir=$(DIST) \
		--extra-source=lib \
		--schema=schemas/$(SCHEMA)
	@ls -la $(DIST)

# Development install: symlink so edits apply after reloading the shell.
install: schemas
	./install.sh

install-cli:
	install -Dm755 cli/claude-quota $(BINDIR)/claude-quota
	@echo "Installed $(BINDIR)/claude-quota"

uninstall:
	-gnome-extensions disable $(UUID)
	rm -rf $(DEST)

prefs:
	gnome-extensions prefs $(UUID)

clean:
	rm -rf $(DIST) $(SRC)/schemas/gschemas.compiled
