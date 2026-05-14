const fs = require("fs");
const CONFIG = require("./config");

async function log(message, level = "INFO") {
	const entry = `${new Date().toISOString()} [${level}] ${message}`;
	
	// Прямой вывод в стандартный поток (stdout) для Render.com
	process.stdout.write(entry + "\n");

	try {
		await fs.promises.appendFile(CONFIG.LOG_FILE, entry + "\n");
	} catch (err) {
		process.stderr.write(`Ошибка записи в лог: ${err.message}\n`);
	}
}
module.exports = log;
