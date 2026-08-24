import {
	type Component,
	CURSOR_MARKER,
	decodeKittyPrintable,
	type Focusable,
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AuthPrompt, AuthType } from "../../ai/auth.ts";
import { createAuthAbortError } from "../../ai/auth.ts";
import type { ProviderAuthView } from "../provider-runtime.ts";
import type { TuiTheme } from "./theme.ts";

export type ProviderPickerMode = "login" | "logout";

export interface AuthDialogOptions {
	readonly title: string;
	readonly subtitle: string;
	readonly authType: AuthType;
	readonly onCancel: () => void;
	readonly onCopyUrl?: (url: string) => void;
}

export class ProviderPicker implements Component, Focusable {
	focused = false;
	onSelect?: (provider: ProviderAuthView) => void;
	onCancel?: () => void;

	private filter = "";
	private selectedIndex = 0;

	constructor(
		private readonly providers: readonly ProviderAuthView[],
		_mode: ProviderPickerMode,
		private readonly theme: TuiTheme,
		private readonly maxVisible = 8,
	) {}

	render(width: number): string[] {
		const filtered = this.filteredProviders();
		this.clampSelection(filtered.length);
		const start = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(this.maxVisible / 2),
				Math.max(0, filtered.length - this.maxVisible),
			),
		);
		const visible = filtered.slice(start, start + this.maxVisible);
		const lines = [
			this.theme.muted(
				this.filter ? `Search  ${this.filter}` : "Search  Type to filter",
			),
		];
		if (visible.length === 0) {
			lines.push(this.theme.error("No matching providers"));
			return lines;
		}

		for (let index = 0; index < visible.length; index += 1) {
			const provider = visible[index];
			if (provider === undefined) {
				continue;
			}
			const selected = start + index === this.selectedIndex;
			const prefix = selected ? "› " : "  ";
			const status =
				provider.source === "environment"
					? `${provider.status} (environment)`
					: provider.status;
			const statusStyle =
				provider.status === "connected"
					? this.theme.assistant
					: provider.status === "expired"
						? this.theme.warning
						: this.theme.muted;
			const right = statusStyle(status);
			const available = Math.max(
				1,
				width - visibleWidth(prefix) - visibleWidth(right) - 1,
			);
			const left = truncateToWidth(provider.displayName, available);
			const padding = " ".repeat(
				Math.max(
					1,
					width -
						visibleWidth(prefix) -
						visibleWidth(left) -
						visibleWidth(right),
				),
			);
			lines.push(
				`${selected ? this.theme.assistant(prefix) : prefix}${this.theme.markdown.bold(
					selected ? this.theme.primary(left) : this.theme.muted(left),
				)}${padding}${right}`,
			);
			lines.push(
				this.theme.muted(
					`  ${provider.authType === "oauth" ? "OAuth" : "API key"} · ${provider.authLabel}`,
				),
			);
		}
		if (filtered.length > this.maxVisible) {
			lines.push(
				this.theme.muted(
					`${this.selectedIndex + 1}/${filtered.length} · Up/Down move · Enter select · Esc close`,
				),
			);
		}
		return lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.onCancel?.();
			return;
		}
		const filtered = this.filteredProviders();
		if (matchesKey(data, Key.enter)) {
			const provider = filtered[this.selectedIndex];
			if (provider !== undefined) {
				this.onSelect?.(provider);
			}
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selectedIndex = Math.min(
				Math.max(0, filtered.length - 1),
				this.selectedIndex + 1,
			);
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			if (this.filter) {
				this.filter = Array.from(this.filter).slice(0, -1).join("");
				this.selectedIndex = 0;
			}
			return;
		}
		const printable =
			decodeKittyPrintable(data) ??
			(Array.from(data).length === 1 && data >= " " && data !== "\u007f"
				? data
				: undefined);
		if (printable?.trim()) {
			this.filter += printable;
			this.selectedIndex = 0;
		}
	}

	invalidate(): void {}

	private filteredProviders(): readonly ProviderAuthView[] {
		const query = this.filter.trim().toLocaleLowerCase();
		if (!query) {
			return this.providers;
		}
		return this.providers.filter((provider) =>
			[provider.displayName, provider.id, provider.authLabel, provider.status]
				.join(" ")
				.toLocaleLowerCase()
				.includes(query),
		);
	}

	private clampSelection(length: number): void {
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, length - 1));
	}
}

export class AuthDialog implements Component, Focusable {
	focused = false;

	private readonly input = new Input();
	private url: string | undefined;
	private prompt: AuthPrompt | undefined;
	private resolvePrompt: ((value: string) => void) | undefined;
	private rejectPrompt: ((error: unknown) => void) | undefined;
	private removeAbortListener: (() => void) | undefined;
	private status: string | undefined;

	constructor(
		private readonly options: AuthDialogOptions,
		private readonly theme: TuiTheme,
	) {
		this.input.onSubmit = (value) => {
			if (this.resolvePrompt === undefined) {
				return;
			}
			const resolve = this.resolvePrompt;
			this.clearPromptHandlers();
			resolve(value);
		};
	}

	setUrl(url: string): void {
		this.url = url;
	}

	setStatus(status: string | undefined): void {
		this.status = status;
	}

	requestInput(prompt: AuthPrompt): Promise<string> {
		this.rejectPrompt?.(createAuthAbortError());
		this.clearPromptHandlers();
		this.prompt = prompt;
		this.input.setValue("");
		return new Promise<string>((resolve, reject) => {
			this.resolvePrompt = resolve;
			this.rejectPrompt = reject;
			const onAbort = (): void => {
				this.clearPromptHandlers();
				reject(createAuthAbortError());
			};
			prompt.signal?.addEventListener("abort", onAbort, { once: true });
			this.removeAbortListener = () =>
				prompt.signal?.removeEventListener("abort", onAbort);
			if (prompt.signal?.aborted) {
				onAbort();
			}
		});
	}

	cancel(): void {
		const reject = this.rejectPrompt;
		this.clearPromptHandlers();
		reject?.(createAuthAbortError());
		this.options.onCancel();
	}

	close(): void {
		const reject = this.rejectPrompt;
		this.clearPromptHandlers();
		reject?.(createAuthAbortError());
	}

	render(width: number): string[] {
		const lines: string[] = [];
		if (this.url !== undefined) {
			lines.push(this.theme.primary("Browser sign-in"));
			lines.push(
				...wrapTextWithAnsi(
					this.theme.muted(
						"The sign-in page should already be opening. If it did not open, use the link below.",
					),
					Math.max(1, width),
				),
			);
			lines.push("", this.theme.muted("Sign-in link"));
			lines.push(
				...wrapTextWithAnsi(this.theme.assistant(this.url), Math.max(1, width)),
			);
			lines.push(this.theme.muted("Option+C copy · Esc/Ctrl+C cancel"));
			lines.push(
				"",
				this.theme.muted("Next step"),
				...wrapTextWithAnsi(
					this.theme.primary(
						"Complete login in your browser. If the browser is on another machine, paste the final redirect URL below.",
					),
					Math.max(1, width),
				),
			);
		}
		if (this.prompt !== undefined) {
			lines.push(
				"",
				this.theme.primary(
					this.prompt.type === "manual_code" ? "Manual fallback" : "API key",
				),
				this.theme.muted(this.prompt.label),
			);
			if (this.prompt.type === "text" && this.prompt.secret === true) {
				const bullets = "•".repeat(Array.from(this.input.getValue()).length);
				lines.push(`  ${this.theme.primary(bullets)}${CURSOR_MARKER}`);
			} else {
				lines.push(...this.input.render(Math.max(1, width)));
			}
			lines.push(this.theme.muted("Esc/Ctrl+C cancel"));
		}
		if (this.status !== undefined) {
			lines.push("", this.theme.muted(this.status));
		}
		return lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.cancel();
			return;
		}
		if (
			this.url !== undefined &&
			matchesKey(data, Key.alt("c")) &&
			this.options.onCopyUrl !== undefined
		) {
			this.options.onCopyUrl(this.url);
			return;
		}
		if (this.prompt !== undefined) {
			this.input.focused = this.focused;
			this.input.handleInput(data);
		}
	}

	invalidate(): void {
		this.input.invalidate();
	}

	private clearPromptHandlers(): void {
		this.removeAbortListener?.();
		this.removeAbortListener = undefined;
		this.resolvePrompt = undefined;
		this.rejectPrompt = undefined;
	}
}
