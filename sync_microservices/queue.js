const fs = require("fs");
const CONFIG = require("./config");
const log = require("./logger");
const syncProcessor = require("./processor");

class SyncQueue {
	constructor() {
		this.queue = [];
		this.failedTasks = [];
		this.isProcessing = false;
		this.isSaving = false;
		this.init();
	}

	async init() {
		this.queue = await this.load(CONFIG.QUEUE_FILE);
		this.failedTasks = await this.load(CONFIG.FAILED_QUEUE_FILE);
		if (this.queue.length > 0 && !this.isProcessing) {
			this.process();
		}
	}

	async load(filePath) {
		try {
			const data = await fs.promises.readFile(filePath, "utf-8");
			return JSON.parse(data);
		} catch (err) {
			if (err.code === 'ENOENT') return [];
			log(`Ошибка чтения очереди ${filePath}: ${err.message}`, "ERROR");
			return [];
		}
	}

	async save() {
		if (this.isSaving) return;
		this.isSaving = true;
		try {
			await Promise.all([
				fs.promises.writeFile(CONFIG.QUEUE_FILE, JSON.stringify(this.queue, null, 2)),
				fs.promises.writeFile(CONFIG.FAILED_QUEUE_FILE, JSON.stringify(this.failedTasks, null, 2))
			]);
		} catch (err) {
			log(`Ошибка сохранения очереди: ${err.message}`, "ERROR");
		} finally {
			this.isSaving = false;
		}
	}

	async add(entity, data) {
		const id = data.id || data.barcode || data.orderId || data.email || "new";
		this.queue.push({ entity, data, attempts: 0 });
		await this.save();
		log(`Задача добавлена в очередь: ${entity} (${id})`);
		if (!this.isProcessing) this.process();
	}

	/**
	 * Добавление в очередь без немедленного запуска (для ошибок миграции)
	 */
	async addToQueueSilent(entity, data) {
		this.queue.push({ entity, data, attempts: 0 });
		await this.save();
	}
	async process() {
		if (this.queue.length === 0) {
			this.isProcessing = false;
			log("[QUEUE] Очередь пуста, обработка завершена.");
			return;
		}

		this.isProcessing = true;
		const task = this.queue[0];
		log(`[QUEUE] Обработка задачи из очереди (${this.queue.length} осталось): ${task.entity}`);

		try {
			await syncProcessor.handle(task);
			this.queue.shift(); // Удаление задачи при успешном выполнении
			log(`Задача успешно выполнена: ${task.entity}`);
		} catch (err) {
			task.attempts = (task.attempts || 0) + 1;
			log(`[QUEUE] Ошибка задачи ${task.entity} (попытка ${task.attempts}/3): ${err.message}`, "ERROR");
			
			if (task.attempts >= 3) {
				log(`[QUEUE] Задача ${task.entity} перемещена в failedTasks после 3 неудач`, "ERROR");
				this.failedTasks.push(this.queue.shift());
			} else {
				// Перемещение задачи в конец очереди для повторной попытки
				this.queue.push(this.queue.shift());
			}
		}
		await this.save();
		setTimeout(() => this.process(), CONFIG.SYNC_DELAY);
	}
}

module.exports = new SyncQueue();
