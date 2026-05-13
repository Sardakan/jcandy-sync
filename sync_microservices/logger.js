const fs = require("fs");
const CONFIG = require("./config");

async function log(message, level = "INFO") {
	const entry = `${new Date().toISOString()} [${level}] ${message}\n`;
	console.log(entry.trim());
	try {
		await fs.promises.appendFile(CONFIG.LOG_FILE, entry);
	} catch (err) {
		console.error(`Ошибка записи в лог: ${err.message}`);
	}
}

module.exports = log;
