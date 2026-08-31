# Sliver GUI build helpers - cross-platform.
# Requires: Go 1.22+, the Wails v2 CLI, and (on Linux) WebKit dev headers.
#
# Works from both Unix shells (bash/zsh) and Windows cmd.exe. GNU Make picks
# the branch by looking at the `OS` environment variable - set to
# `Windows_NT` on every supported Windows. Recipes on the Windows side use
# cmd control-flow (`if exist`, `xcopy`, `rmdir`) and skip POSIX-only glue.
#
# Override any of TAGS / VERSION / COMMIT / DATE on the command line:
#     make build VERSION=1.2.3 TAGS=
# Common uses of TAGS:
#     Linux (Ubuntu 24.04 / Kali): TAGS=webkit2_41   (the default)
#     Linux with older WebKit 4.0: TAGS=             (empty)
#     Windows / macOS:             TAGS=             (empty; the default here)

ifeq ($(OS),Windows_NT)
  # ── Windows (cmd.exe) ────────────────────────────────────────────────
  # Lock the recipe shell so an MSYS bash on PATH cannot hijack it halfway
  # through and break the cmd-syntax recipes below.
  SHELL       := cmd.exe
  .SHELLFLAGS := /C

  # Wails' bindings-generator writes an intermediate exe to os.TempDir() and
  # executes it. On boxes where TMP/TEMP point at C:\WINDOWS\TEMP, that lands
  # outside any per-user Defender exclusion and gets quarantined as Sliver.
  # We redirect BUILD_TMP under the project tree so an exclusion on the
  # project dir (which most operators already have) covers the whole chain.
  # Override BUILD_TMP on the command line to relocate elsewhere.
  BUILD_TMP  ?= $(CURDIR)\build\tmp
  # xcopy flags: /E recurse (incl. empty), /I assume dest is a dir, /Q quiet,
  # /Y no overwrite prompt. The outer `if not exist` skips the copy once the
  # icons are already staged so repeat builds don't spam.
  COPY_ICONS   = if not exist frontend\dist\icons if exist frontend\icons xcopy /E /I /Q /Y frontend\icons frontend\dist\icons >nul
  RM_BIN       = if exist build\bin rmdir /s /q build\bin
  RM_DIST      = if exist dist rmdir /s /q dist
  # webkit2_41 is a Linux-only build tag; leave TAGS empty on Windows unless
  # the operator explicitly sets it on the command line.
  TAGS        ?=
  # Cmd has no portable equivalent of `git … 2>/dev/null || echo fallback`,
  # so default to static values. Override with `make build VERSION=…`.
  VERSION     ?= dev
  COMMIT      ?= unknown
  DATE        ?= unknown
else
  # ── Unix (macOS / Linux, POSIX sh) ───────────────────────────────────
  SHELL       := /bin/sh
  COPY_ICONS   = cp -r frontend/icons frontend/dist/icons 2>/dev/null || true
  RM_BIN       = rm -rf build/bin
  RM_DIST      = rm -rf dist
  TAGS        ?= webkit2_41
  # Derive version metadata from git; fall back to static defaults if this
  # isn't a git checkout (e.g. a source tarball).
  VERSION     ?= $(shell git describe --tags --always 2>/dev/null || echo dev)
  COMMIT      ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
  DATE        ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
endif

TAGARG   = $(if $(TAGS),-tags $(TAGS),)
LDFLAGS  = -X main.Version=$(VERSION) -X main.GitCommit=$(COMMIT) -X main.BuildDate=$(DATE)

.PHONY: build dev test lint vet icons clean help

## build: compile the GUI with version metadata baked in
build: icons
ifeq ($(OS),Windows_NT)
	@if not exist "$(BUILD_TMP)" mkdir "$(BUILD_TMP)"
	@set TMP=$(BUILD_TMP)&& set TEMP=$(BUILD_TMP)&& set GOTMPDIR=$(BUILD_TMP)&& wails build $(TAGARG) -ldflags "$(LDFLAGS)"
else
	wails build $(TAGARG) -ldflags "$(LDFLAGS)"
endif

## dev: run with hot reload
dev: icons
ifeq ($(OS),Windows_NT)
	@if not exist "$(BUILD_TMP)" mkdir "$(BUILD_TMP)"
	@set TMP=$(BUILD_TMP)&& set TEMP=$(BUILD_TMP)&& set GOTMPDIR=$(BUILD_TMP)&& wails dev $(TAGARG) -ldflags "$(LDFLAGS)"
else
	wails dev $(TAGARG) -ldflags "$(LDFLAGS)"
endif

## icons: copy source icons into the embedded frontend (first build only)
icons:
	@$(COPY_ICONS)

## test: run unit tests
test:
	go test $(TAGARG) -race -count=1 ./...

## vet: run go vet
vet:
	go vet $(TAGARG) ./...

## lint: run golangci-lint (must be installed)
lint:
	golangci-lint run --build-tags "$(TAGS)"

## clean: remove build output
clean:
	@$(RM_BIN)
	@$(RM_DIST)

## help: list targets (Unix only - cmd.exe can't do the awk trick)
help:
	@awk 'BEGIN{FS=": "}/^## /{sub(/^## /,"",$$0);print "  "$$0}' $(MAKEFILE_LIST)
