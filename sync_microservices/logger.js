const fs = require("fs");
const CONFIG = require("./config");
const logMaintenance = require("./logMaintenance");

const MAX_LOG_BYTES = CONFIG.LOG_MAX_SIZE_MB * 1024 * 1024;

// Все операции с файлом логов идут через одну цепочку, чтобы запись и очистка не конфликтовали
let pending = Promise.resolve();
let currentSize = null;

function enqueue(task) {
	const run = pending.then(task);
	pending = run.catch(() => {});
	return run;
}

function formatEntry(message, level = "INFO") {
	return `${new Date().toISOString()} [${level}] ${message}`;
}

async function ensureSize() {
	if (currentSize !== null) return;
	try {
		currentSize = (await fs.promises.stat(CONFIG.LOG_FILE)).size;
	} catch (err) {
		if (err.code !== "ENOENT") throw err;
		currentSize = 0;
	}
}

async function appendLine(line) {
	await fs.promises.appendFile(CONFIG.LOG_FILE, line + "\n");
	currentSize = (currentSize || 0) + Buffer.byteLength(line, "utf8") + 1;
}

/**
 * Применяет политику хранения логов (срок + размер) и сообщает об очистке в лог.
 */
async function prune() {
	const { size, removed } = await logMaintenance.enforceRetention(CONFIG.LOG_FILE, {
		retentionDays: CONFIG.LOG_RETENTION_DAYS,
		maxBytes: MAX_LOG_BYTES,
	});
	currentSize = size;

	if (removed > 0) {
		const notice = formatEntry(
			`[LOG-CLEANUP] Удалено записей: ${removed}. Текущий размер: ${(size / 1024 / 1024).toFixed(2)} МБ`
		);
		process.stdout.write(notice + "\n");
		await appendLine(notice);
	}
}

async function log(message, level = "INFO") {
	const entry = formatEntry(message, level);

	// Прямой вывод в стандартный поток (stdout) для Render.com
	process.stdout.write(entry + "\n");

	try {
		await enqueue(async () => {
			await ensureSize();
			await appendLine(entry);

			if (currentSize > MAX_LOG_BYTES) {
				await prune();
			}
		});
	} catch (err) {
		process.stderr.write(`Ошибка записи в лог: ${err.message}\n`);
	}
}

/**
 * Полностью очищает файл логов (используется админским эндпоинтом).
 */
async function clear() {
	await enqueue(async () => {
		await fs.promises.writeFile(CONFIG.LOG_FILE, "");
		currentSize = 0;
	});
}

/**
 * Запускает немедленную и периодическую очистку устаревших логов.
 * @returns {NodeJS.Timeout} таймер периодической очистки
 */
function startMaintenance() {
	const run = () =>
		enqueue(async () => {
			await ensureSize();
			await prune();
		}).catch((err) => process.stderr.write(`Ошибка обслуживания логов: ${err.message}\n`));

	run();
	const timer = setInterval(run, CONFIG.LOG_CLEANUP_INTERVAL_MS);
	if (typeof timer.unref === "function") timer.unref();
	return timer;
}

module.exports = log;
module.exports.clear = clear;
module.exports.startMaintenance = startMaintenance;
