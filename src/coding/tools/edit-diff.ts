import * as Diff from "diff";

export interface TextEdit {
	oldText: string;
	newText: string;
}

interface MatchedEdit extends TextEdit {
	index: number;
	originalIndex: number;
}

export interface AppliedEdits {
	oldContent: string;
	newContent: string;
}

export function stripUtf8Bom(content: string): {
	bom: string;
	text: string;
} {
	return content.startsWith("\uFEFF")
		? { bom: "\uFEFF", text: content.slice(1) }
		: { bom: "", text: content };
}

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const newline = content.indexOf("\n");
	return newline > 0 && content[newline - 1] === "\r" ? "\r\n" : "\n";
}

export function normalizeLineEndings(content: string): string {
	return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(
	content: string,
	lineEnding: "\r\n" | "\n",
): string {
	return lineEnding === "\r\n" ? content.replace(/\n/g, "\r\n") : content;
}

function findOccurrences(content: string, needle: string): number[] {
	const occurrences: number[] = [];
	for (
		let from = 0, index = content.indexOf(needle, from);
		index !== -1;
		index = content.indexOf(needle, from)
	) {
		occurrences.push(index);
		from = index + 1;
	}
	return occurrences;
}

function editLabel(index: number, total: number): string {
	return total === 1 ? "oldText" : `edits[${index}].oldText`;
}

/** Validate every replacement against one immutable base, then apply atomically. */
export function applyExactEdits(
	content: string,
	edits: readonly TextEdit[],
	path: string,
): AppliedEdits {
	if (edits.length === 0) {
		throw new Error(
			"Edit tool input is invalid. edits must contain at least one replacement.",
		);
	}

	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeLineEndings(edit.oldText),
		newText: normalizeLineEndings(edit.newText),
	}));
	const matches: MatchedEdit[] = [];
	for (const [index, edit] of normalizedEdits.entries()) {
		const label = editLabel(index, normalizedEdits.length);
		if (edit.oldText.length === 0) {
			throw new Error(`${label} must not be empty in ${path}.`);
		}
		const occurrences = findOccurrences(content, edit.oldText);
		if (occurrences.length === 0) {
			throw new Error(
				`Could not find ${label} in ${path}. It must match exactly, including whitespace and newlines.`,
			);
		}
		if (occurrences.length > 1) {
			throw new Error(
				`Found ${occurrences.length} occurrences of ${label} in ${path}. It must match exactly once.`,
			);
		}
		matches.push({ ...edit, index: occurrences[0] ?? 0, originalIndex: index });
	}

	matches.sort((left, right) => left.index - right.index);
	for (let index = 1; index < matches.length; index += 1) {
		const previous = matches[index - 1];
		const current = matches[index];
		if (
			previous &&
			current &&
			previous.index + previous.oldText.length > current.index
		) {
			throw new Error(
				`edits[${previous.originalIndex}] and edits[${current.originalIndex}] overlap in ${path}.`,
			);
		}
	}

	let result = content;
	for (let index = matches.length - 1; index >= 0; index -= 1) {
		const match = matches[index];
		if (!match) {
			continue;
		}
		result =
			result.slice(0, match.index) +
			match.newText +
			result.slice(match.index + match.oldText.length);
	}
	if (result === content) {
		throw new Error(
			`No changes made to ${path}. The replacement${edits.length === 1 ? "" : "s"} produced identical content.`,
		);
	}
	return { oldContent: content, newContent: result };
}

export function generateUnifiedPatch(
	path: string,
	oldContent: string,
	newContent: string,
	contextLines = 4,
): string {
	return Diff.createTwoFilesPatch(
		path,
		path,
		oldContent,
		newContent,
		undefined,
		undefined,
		{ context: contextLines, headerOptions: Diff.FILE_HEADERS_ONLY },
	);
}

/** Produce a compact display diff and the first changed line in the new file. */
export function generateDisplayDiff(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];
	const numberWidth = String(
		Math.max(oldContent.split("\n").length, newContent.split("\n").length),
	).length;
	let oldLine = 1;
	let newLine = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index];
		if (!part) {
			continue;
		}
		const rawLines = part.value.split("\n");
		if (rawLines.at(-1) === "") {
			rawLines.pop();
		}
		if (part.added || part.removed) {
			firstChangedLine ??= newLine;
			for (const line of rawLines) {
				if (part.added) {
					output.push(`+${String(newLine).padStart(numberWidth, " ")} ${line}`);
					newLine += 1;
				} else {
					output.push(`-${String(oldLine).padStart(numberWidth, " ")} ${line}`);
					oldLine += 1;
				}
			}
			lastWasChange = true;
			continue;
		}

		const next = parts[index + 1];
		const nextIsChange = Boolean(next?.added || next?.removed);
		if (lastWasChange && nextIsChange) {
			if (rawLines.length <= contextLines * 2) {
				for (const line of rawLines) {
					output.push(` ${String(oldLine).padStart(numberWidth, " ")} ${line}`);
					oldLine += 1;
					newLine += 1;
				}
			} else {
				const leading = rawLines.slice(0, contextLines);
				const trailing = rawLines.slice(-contextLines);
				for (const line of leading) {
					output.push(` ${String(oldLine).padStart(numberWidth, " ")} ${line}`);
					oldLine += 1;
					newLine += 1;
				}
				const skipped = rawLines.length - leading.length - trailing.length;
				output.push(` ${"".padStart(numberWidth, " ")} ...`);
				oldLine += skipped;
				newLine += skipped;
				for (const line of trailing) {
					output.push(` ${String(oldLine).padStart(numberWidth, " ")} ${line}`);
					oldLine += 1;
					newLine += 1;
				}
			}
		} else if (lastWasChange) {
			const shown = rawLines.slice(0, contextLines);
			for (const line of shown) {
				output.push(` ${String(oldLine).padStart(numberWidth, " ")} ${line}`);
				oldLine += 1;
				newLine += 1;
			}
			const skipped = rawLines.length - shown.length;
			if (skipped > 0) {
				output.push(` ${"".padStart(numberWidth, " ")} ...`);
				oldLine += skipped;
				newLine += skipped;
			}
		} else if (nextIsChange) {
			const skipped = Math.max(0, rawLines.length - contextLines);
			if (skipped > 0) {
				output.push(` ${"".padStart(numberWidth, " ")} ...`);
				oldLine += skipped;
				newLine += skipped;
			}
			for (const line of rawLines.slice(skipped)) {
				output.push(` ${String(oldLine).padStart(numberWidth, " ")} ${line}`);
				oldLine += 1;
				newLine += 1;
			}
		} else {
			oldLine += rawLines.length;
			newLine += rawLines.length;
		}
		lastWasChange = false;
	}

	return { diff: output.join("\n"), firstChangedLine };
}
