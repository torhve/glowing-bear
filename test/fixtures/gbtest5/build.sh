#!/usr/bin/env bash
# Build a WeeChat 5 headless relay from upstream source.
#
# Why a script rather than a block of CI steps: the same recipe has to run on a
# runner and on a laptop, and every claim in the api-dossier about 5.0 is only
# as good as the build it was measured against. Keeping the flags in one file
# also lets CI key its cache on that file's contents.
#
# Usage: GB_WEECHAT5_REF=<commit|tag|branch> [GB_WEECHAT5_SRC=dir] [GB_WEECHAT5_BUILD=dir] build.sh
set -euo pipefail

# Upstream has no v5.0.0 tag — the newest tag is v4.10.1 and the 5.0 line lives
# on main as 5.0.0-dev — so the default pin is a commit. Move it deliberately:
# a build that tracks main HEAD reports a different wire shape every week.
REF="${GB_WEECHAT5_REF:-44e149b12830c8ffa98a5b2a4aafaf97e06e4477}"
SRC="${GB_WEECHAT5_SRC:-/tmp/weechat5-src}"
BUILD="${GB_WEECHAT5_BUILD:-/tmp/weechat5-build}"
LOG="${GB_WEECHAT5_BUILD_LOG:-/tmp/weechat5-build.log}"
BIN="$BUILD/src/gui/curses/headless/weechat-headless"

if [ ! -d "$SRC/.git" ]; then
	echo "  cloning upstream into $SRC"
	git clone --no-checkout https://github.com/weechat/weechat.git "$SRC"
fi
git -C "$SRC" fetch --quiet origin
git -C "$SRC" checkout --quiet --detach "$REF"
echo "  ref: $(git -C "$SRC" describe --tags 2>/dev/null || git -C "$SRC" rev-parse HEAD)"

# Only what the fixture needs: relay API, IRC, FIFO, logger, headless curses.
# Scripting languages are off, which is why the endpoint matrix's
# `GET /api/scripts` sample comes back empty — an empty array says nothing about
# script item shape. libgcrypt, GnuTLS, zlib and libcurl are REQUIRED by
# upstream CMakeLists.txt whatever these flags say.
cmake -S "$SRC" -B "$BUILD" \
	-DCMAKE_BUILD_TYPE=Release \
	-DENABLE_DOC=OFF -DENABLE_MAN=OFF -DENABLE_NLS=OFF -DENABLE_TESTS=OFF \
	-DENABLE_ZSTD=OFF -DENABLE_SPELL=OFF -DENABLE_SCRIPT=OFF \
	-DENABLE_GUILE=OFF -DENABLE_JAVASCRIPT=OFF -DENABLE_LUA=OFF \
	-DENABLE_PERL=OFF -DENABLE_PHP=OFF -DENABLE_PYTHON=OFF \
	-DENABLE_RUBY=OFF -DENABLE_TCL=OFF \
	-DENABLE_XFER=OFF -DENABLE_TRIGGER=OFF -DENABLE_TYPING=OFF 2>&1 | tee "$LOG"

JOBS="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)"
cmake --build "$BUILD" -j "$JOBS" 2>&1 | tee -a "$LOG"

if [ ! -x "$BIN" ]; then
	echo "ERROR: build finished without producing $BIN (see $LOG)"
	exit 1
fi
echo "  built $BIN"
