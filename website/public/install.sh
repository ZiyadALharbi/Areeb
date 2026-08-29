#!/bin/sh

set -eu

AREEB_PACKAGE="@ziyad_1440/areeb"
BUN_INSTALLER_URL="https://bun.sh/install"

find_bun() {
    if command -v bun >/dev/null 2>&1; then
        command -v bun
        return
    fi

    if [ -n "${BUN_INSTALL:-}" ] && [ -x "$BUN_INSTALL/bin/bun" ]; then
        printf '%s\n' "$BUN_INSTALL/bin/bun"
        return
    fi

    if [ -n "${HOME:-}" ] && [ -x "$HOME/.bun/bin/bun" ]; then
        printf '%s\n' "$HOME/.bun/bin/bun"
        return
    fi

    return 1
}

platform=$(uname -s)
case "$platform" in
    Darwin | Linux) ;;
    *)
        printf '%s\n' "Error: this installer supports macOS and Linux." >&2
        exit 1
        ;;
esac

bun_bin=$(find_bun || true)
if [ -z "$bun_bin" ]; then
    printf '%s\n' "Areeb requires Bun."
    printf '%s\n' "Bun was not found, so the official Bun installer will run now."

    if ! command -v bash >/dev/null 2>&1; then
        printf '%s\n' "Error: installing Bun requires bash." >&2
        exit 1
    fi

    if [ "$platform" = "Linux" ] && ! command -v unzip >/dev/null 2>&1; then
        printf '%s\n' "Error: installing Bun on Linux requires unzip." >&2
        exit 1
    fi

    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$BUN_INSTALLER_URL" | bash
    elif command -v wget >/dev/null 2>&1; then
        wget -qO- "$BUN_INSTALLER_URL" | bash
    else
        printf '%s\n' "Error: installing Bun requires curl or wget." >&2
        exit 1
    fi

    bun_bin=$(find_bun || true)
    if [ -z "$bun_bin" ]; then
        printf '%s\n' "Error: Bun was installed but its executable could not be found." >&2
        printf '%s\n' "Restart your terminal, then run: bun add --global $AREEB_PACKAGE" >&2
        exit 1
    fi
fi

printf '%s\n' "Installing Areeb with $bun_bin ..."
"$bun_bin" add --global "$AREEB_PACKAGE"

tool_bin=$("$bun_bin" pm bin --global)
if [ -z "$tool_bin" ]; then
    printf '%s\n' "Error: Bun returned an empty global executable directory." >&2
    exit 1
fi

areeb_bin="$tool_bin/areeb"
if [ ! -x "$areeb_bin" ]; then
    printf '%s\n' "Error: Areeb was installed but $areeb_bin was not found." >&2
    exit 1
fi

"$areeb_bin" --help >/dev/null
printf '%s\n' "Areeb is installed. Run: areeb"

case ":$PATH:" in
    *":$tool_bin:"*) ;;
    *)
        printf '%s\n' "Restart your shell if 'areeb' is not found."
        printf '%s\n' "The directory $tool_bin must be on PATH."
        ;;
esac
