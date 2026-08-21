export function parseTimerStartAt(input: string, referenceDate = new Date()): Date {
	const value = input.trim();
	if (!value) throw new Error(`invalid start_at: ${input}`);

	const timeOnly = /^(\d{1,2}):(\d{2})$/.exec(value);
	if (timeOnly) {
		const hour = Number(timeOnly[1]);
		const minute = Number(timeOnly[2]);
		const parsed = buildLocalDateTime(
			referenceDate.getFullYear(),
			referenceDate.getMonth() + 1,
			referenceDate.getDate(),
			hour,
			minute,
			input,
		);
		return rejectFuture(parsed, referenceDate, input);
	}

	const localDateTime = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(value);
	if (localDateTime) {
		const parsed = buildLocalDateTime(
			Number(localDateTime[1]),
			Number(localDateTime[2]),
			Number(localDateTime[3]),
			Number(localDateTime[4]),
			Number(localDateTime[5]),
			input,
		);
		return rejectFuture(parsed, referenceDate, input);
	}

	if (!isIsoDateTime(value)) throw new Error(`invalid start_at: ${input}`);

	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime())) throw new Error(`invalid start_at: ${input}`);
	return rejectFuture(parsed, referenceDate, input);
}

function isIsoDateTime(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value);
}

function buildLocalDateTime(year: number, month: number, day: number, hour: number, minute: number, original: string): Date {
	if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
		throw new Error(`invalid start_at: ${original}`);
	}

	const parsed = new Date(year, month - 1, day, hour, minute, 0, 0);
	if (
		parsed.getFullYear() !== year ||
		parsed.getMonth() + 1 !== month ||
		parsed.getDate() !== day ||
		parsed.getHours() !== hour ||
		parsed.getMinutes() !== minute
	) {
		throw new Error(`invalid start_at: ${original}`);
	}

	return parsed;
}

function rejectFuture(parsed: Date, referenceDate: Date, original: string): Date {
	if (parsed.getTime() > referenceDate.getTime()) {
		throw new Error(`start_at cannot be in the future: ${original}`);
	}
	return parsed;
}
