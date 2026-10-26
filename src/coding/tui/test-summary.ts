import type { TuiTestSummary } from "./state.ts";

/**
 * Read pass and fail counts from the final summary of common test runners:
 * bun, jest, vitest, pytest, cargo, mocha, and verbose go test.
 */
export function parseTestSummary(text: string): TuiTestSummary | undefined {
	const lines = text.split(/\r\n|\r|\n/);
	const summary =
		bunSummary(lines) ??
		jestSummary(lines) ??
		pytestSummary(lines) ??
		cargoSummary(lines) ??
		mochaSummary(lines) ??
		goSummary(lines);
	return summary !== undefined && summary.passed + summary.failed > 0
		? summary
		: undefined;
}

// " 38 pass" and " 0 fail" lines, confirmed by "Ran 38 tests across 4 files."
function bunSummary(lines: readonly string[]): TuiTestSummary | undefined {
	if (!lines.some((line) => /^Ran \d+ tests? across /.test(line))) {
		return undefined;
	}
	return {
		passed: lastCount(lines, /^\s*(\d+) pass$/),
		failed: lastCount(lines, /^\s*(\d+) fail$/),
	};
}

// jest "Tests:  1 failed, 37 passed, 38 total" and vitest "Tests  37 passed (38)".
function jestSummary(lines: readonly string[]): TuiTestSummary | undefined {
	const line = lines.findLast((candidate) =>
		/^\s*Tests:?\s+.*\b(?:passed|failed)\b/.test(candidate),
	);
	return line === undefined
		? undefined
		: { passed: count(line, "passed"), failed: count(line, "failed") };
}

// "===== 1 failed, 37 passed in 0.12s =====", where errors count as failures.
function pytestSummary(lines: readonly string[]): TuiTestSummary | undefined {
	const line = lines.findLast((candidate) =>
		/^=+ .*\b(?:passed|failed|errors?)\b.* in [\d.]+s\b.*=+$/.test(candidate),
	);
	return line === undefined
		? undefined
		: {
				passed: count(line, "passed"),
				failed:
					count(line, "failed") + count(line, "error") + count(line, "errors"),
			};
}

// "test result: ok. 38 passed; 0 failed; ..." once per test binary.
function cargoSummary(lines: readonly string[]): TuiTestSummary | undefined {
	const results = lines.flatMap((line) => {
		const match = /^test result: \w+\. (\d+) passed; (\d+) failed;/.exec(line);
		return match === null ? [] : [match];
	});
	if (results.length === 0) {
		return undefined;
	}
	return {
		passed: results.reduce((sum, match) => sum + Number(match[1]), 0),
		failed: results.reduce((sum, match) => sum + Number(match[2]), 0),
	};
}

// "  37 passing (20ms)" and "  1 failing".
function mochaSummary(lines: readonly string[]): TuiTestSummary | undefined {
	const passed = lastCount(lines, /^\s*(\d+) passing\b/);
	const failed = lastCount(lines, /^\s*(\d+) failing\b/);
	return passed + failed > 0 ? { passed, failed } : undefined;
}

// go test -v prints "--- PASS: TestName" and "--- FAIL: TestName" per test.
function goSummary(lines: readonly string[]): TuiTestSummary | undefined {
	const passed = lines.filter((line) => /^\s*--- PASS: /.test(line)).length;
	const failed = lines.filter((line) => /^\s*--- FAIL: /.test(line)).length;
	return passed + failed > 0 ? { passed, failed } : undefined;
}

function lastCount(lines: readonly string[], pattern: RegExp): number {
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const match = pattern.exec(lines[index] ?? "");
		if (match !== null) {
			return Number(match[1]);
		}
	}
	return 0;
}

function count(line: string, word: string): number {
	return Number(new RegExp(`(\\d+) ${word}\\b`).exec(line)?.[1] ?? 0);
}
