const fs = require("fs");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
// После обрезки оставляем файл заметно меньше лимита, чтобы ротация случалась редко
const TRIM_TARGET_RATIO = 0.8;

// Запись лога начинается со штампа времени из new Date().toISOString()
const ENTRY_START = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/;

/**
 * Разбивает содержимое файла на записи. Запись может занимать несколько строк
 * (например, отформатированный JSON), поэтому продолжением считается любая
 * строка, не начинающаяся со штампа времени.
 */
function splitEntries(content) {
	const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
	if (normalized.length === 0) return [];

	const entries = [];
	for (const line of normalized.split("\n")) {
		if (ENTRY_START.test(line)) {
			entries.push(line);
		} else if (entries.length > 0) {
			entries[entries.length - 1] += `\n${line}`;
		}
	}
	return entries;
}

function parseTimestamp(entry) {
	const match = ENTRY_START.exec(entry);
	return match ? Date.parse(match[1]) : NaN;
}

function byteSize(entries) {
	return Buffer.byteLength(entries.join("\n"), "utf8");
}

/**
 * Оставляет самые свежие записи, укладываясь в targetBytes.
 * Самая свежая запись сохраняется всегда, даже если превышает лимит.
 */
function keepNewest(entries, targetBytes) {
	const kept = [];
	let total = 0;

	for (let i = entries.length - 1; i >= 0; i--) {
		const size = Buffer.byteLength(entries[i], "utf8") + 1; // +1 на перевод строки
		if (kept.length > 0 && total + size > targetBytes) break;
		kept.unshift(entries[i]);
		total += size;
	}
	return kept;
}

async function writeAtomic(filePath, data) {
	const tmpPath = `${filePath}.tmp`;
	await fs.promises.writeFile(tmpPath, data, "utf8");
	await fs.promises.rename(tmpPath, filePath);
}

/**
 * Применяет политику хранения логов: удаляет записи старше retentionDays и,
 * если файл превышает maxBytes, обрезает его до самых свежих записей.
 * @returns {Promise<{size: number, removed: number}>} новый размер в байтах и число удалённых записей
 */
async function enforceRetention(logFile, options = {}) {
	const retentionDays = options.retentionDays || DEFAULT_RETENTION_DAYS;
	const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;

	let content;
	try {
		content = await fs.promises.readFile(logFile, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") return { size: 0, removed: 0 };
		throw err;
	}

	const entries = splitEntries(content);
	const cutoff = Date.now() - retentionDays * DAY_MS;

	let kept = entries.filter((entry) => {
		const timestamp = parseTimestamp(entry);
		return Number.isNaN(timestamp) || timestamp >= cutoff;
	});

	if (byteSize(kept) > maxBytes) {
		kept = keepNewest(kept, Math.floor(maxBytes * TRIM_TARGET_RATIO));
	}

	const removed = entries.length - kept.length;
	if (removed === 0) return { size: Buffer.byteLength(content, "utf8"), removed: 0 };

	const next = kept.length > 0 ? `${kept.join("\n")}\n` : "";
	await writeAtomic(logFile, next);
	return { size: Buffer.byteLength(next, "utf8"), removed };
}

module.exports = { enforceRetention };
