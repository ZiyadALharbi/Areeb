#!/bin/sh

set -eu

AREEB_PACKAGE="@ziyad_1440/areeb"
BUN_INSTALLER_URL="https://bun.sh/install"
original_path=${PATH:-}

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

bun_dir=$(dirname "$bun_bin")
case ":$PATH:" in
    *":$bun_dir:"*) ;;
    *)
        PATH="$bun_dir:$PATH"
        export PATH
        ;;
esac

printf '%s\n' "Installing Areeb with $bun_bin ..."
"$bun_bin" add --global "$AREEB_PACKAGE"

tool_bin=$("$bun_bin" pm bin --global)
if [ -z "$tool_bin" ]; then
    printf '%s\n' "Error: Bun returned an empty global executable directory." >&2
    exit 1
fi

case ":$PATH:" in
    *":$tool_bin:"*) ;;
    *)
        PATH="$tool_bin:$PATH"
        export PATH
        ;;
esac

areeb_bin="$tool_bin/areeb"
if [ ! -x "$areeb_bin" ]; then
    printf '%s\n' "Error: Areeb was installed but $areeb_bin was not found." >&2
    exit 1
fi

"$areeb_bin" --help >/dev/null
printf '%s\n' "Areeb is installed. Run: areeb"

case ":$original_path:" in
    *":$tool_bin:"*) ;;
    *)
        shell_config=
        if [ -n "${HOME:-}" ] && [ "$tool_bin" = "$HOME/.bun/bin" ]; then
            case "${SHELL:-}" in
                */zsh) shell_config="$HOME/.zshrc" ;;
                */bash)
                    if [ "$platform" = "Darwin" ]; then
                        shell_config="$HOME/.bash_profile"
                    else
                        shell_config="$HOME/.bashrc"
                    fi
                    ;;
            esac
        fi

        path_persisted=false
        if [ -n "$shell_config" ] && { [ ! -e "$shell_config" ] || [ -w "$shell_config" ]; }; then
            bun_install_line='export BUN_INSTALL="$HOME/.bun"'
            bun_path_line='export PATH="$BUN_INSTALL/bin:$PATH"'
            if [ ! -f "$shell_config" ] || ! grep -Fqx "$bun_install_line" "$shell_config"; then
                printf '\n%s\n' "$bun_install_line" >> "$shell_config"
            fi
            if ! grep -Fqx "$bun_path_line" "$shell_config"; then
                printf '%s\n' "$bun_path_line" >> "$shell_config"
            fi
            path_persisted=true
        fi

        if [ "$path_persisted" = true ]; then
            printf '%s\n' "Bun's PATH entry is present in $shell_config."
            printf '%s\n' "Restart your terminal, then run: areeb"
        else
            printf '%s\n' "Add Areeb to PATH, then restart your terminal:"
            printf '  export PATH="%s:$PATH"\n' "$tool_bin"
        fi
        ;;
esac
