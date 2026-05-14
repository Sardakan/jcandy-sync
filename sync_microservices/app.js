const express = require("express");
const CONFIG = require("./config");
const log = require("./logger");
const queue = require("./queue");
const msClient = require("./moysklad");
const { siteRequest } = require("./siteApi");
const syncProcessor = require("./processor");

const app = express();
app.use(express.json());

// --- ТЕСТОВЫЕ ДАННЫЕ ДЛЯ МИГРАЦИИ ---
const TEST_DATA = {
	products: ["MS-TEST-0001", "MS-TEST-0002", "MS-TEST-0003", "MS-TEST-0004"],
	orders: ["TNJVUUBS", "LG7B6JX3", "QK9AHDTS", "SCWDVN6P"],
	customers: ["moysklad-customer-test+01@jcandy.local", "moysklad-customer-test+02@jcandy.local"]
};
// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---

/**
 * Универсальный обработчик для добавления в очередь (используется сайтом)
 */
const handleQueueRequest = (entity, idField) => async (req, res) => {
	const data = req.body;
	// Ищем ID во всех возможных местах (параметры URL, тело запроса, специфичные поля)
	const id = req.params[idField] || data[idField] || data.id || data.orderId || data.barcode;

	if (!id && req.method === "POST") {
		log(`[EXTERNAL API] Ошибка: отсутствует ID для сущности ${entity}`, "WARN");
		return res.status(400).json({ error: `Missing identifier (${idField})` });
	}

	log(`[EXTERNAL API] Получен запрос на ${req.method} для ${entity}: ${id}`);

	// Для PATCH объединяем ID с телом, для POST берем тело как есть
	const payload = req.method === "PATCH" ? { ...data, [idField]: id } : data;

	await queue.add(entity, payload);
	res.json({ status: "queued", entity, id });
};

/**
 * Универсальный обработчик для массового добавления в очередь
 */
const handleBulkQueueRequest = (entity) => async (req, res) => {
	const items = Array.isArray(req.body) ? req.body : req.body.items || [];
	if (items.length === 0) {
		return res.status(400).json({ error: "Empty items array" });
	}

	log(`[EXTERNAL API] Массовое добавление в очередь: ${entity} (${items.length} шт.)`);
	for (const item of items) {
		await queue.add(entity, item);
	}
	res.json({ status: "queued", entity, count: items.length });
};
/**
 * Универсальная функция для миграции данных (запрашивает данные с сайта по списку ID)
 */
const runMigration = async (entity, testIds, endpointBuilder, res) => {
	log(`[MIGRATION] Запуск для ${entity} (${testIds.length} шт.)`);
	const results = { success: [], failed: [] };

	for (const id of testIds) {
		try {
			const json = await siteRequest("GET", endpointBuilder(id));
			
			// Распаковка данных (аналог extract_data.js)
			const data = (json && json.data && !Array.isArray(json.data)) ? json.data :
			             (json && json.rows && Array.isArray(json.rows)) ? json.rows[0] :
			             (Array.isArray(json)) ? json[0] : json;
			
			// Проверка валидности полученного объекта
			const hasRequiredFields = data && (data.id || data.barcode || data.orderNumber || data.email || data.customerEmail);
			const isOk = json && json.ok !== false && !data?.error;

			if (isOk && hasRequiredFields) {
				await queue.add(entity, data);
				results.success.push(id);
			} else {
				const errorDetail = json?.message || json?.error || "Некорректная структура данных";
				throw new Error(errorDetail);
			}
		} catch (e) {
			log(`[MIGRATION] Ошибка для ${entity} (${id}): ${e.message}`, "WARN");
			results.failed.push(id);
		}
	}

	res.json({
		message: `Миграция ${entity} завершена`,
		stats: { total: testIds.length, success: results.success.length, failed: results.failed.length },
		details: { added: results.success, not_found: results.failed }
	});
};

/**
 * Обработчик вебхуков от МойСклад (обновление статусов на сайте)
 */
async function handleWebhook(req, res) {
	log(`[MS WEBHOOK] Получены данные: ${JSON.stringify(req.body, null, 2)}`);

	try {
		const events = req.body.events || [];
		for (const event of events) {
			const type = event.meta.type;

			// 1. Обработка остатков (только документы)
			if (["customerorder", "supply", "demand"].includes(type)) {
				log(`[MS WEBHOOK] Изменение остатков в документе ${type}`);
				try {
					const response = await msClient.request("GET", event.meta.href.replace(CONFIG.MS_API_BASE, ""));
					const data = response.data;
					// Запускаем обновление остатков (не ждем завершения, чтобы быстрее ответить МС)
					syncProcessor.syncStocksFromDocument(data).catch((e) => log(`Ошибка обновления остатков: ${e.message}`, "ERROR"));
				} catch (e) {
					log(`Ошибка при получении данных документа для остатков: ${e.message}`, "ERROR");
				}
			}

			// 2. Обработка данных товара (страна, цены и т.д.)
			if (type === "product" && event.action === "UPDATE") {
				log(`[MS WEBHOOK] Обновление карточки товара`);
				try {
					const response = await msClient.request("GET", event.meta.href.replace(CONFIG.MS_API_BASE, "") + "?expand=country");
					syncProcessor.syncProductToSite(response.data).catch((e) => log(`Ошибка синхронизации товара: ${e.message}`, "ERROR"));
				} catch (e) {
					log(`Ошибка при получении данных товара: ${e.message}`, "ERROR");
				}
			}

			// 3. Обработка контрагентов (из МС на сайт)
			if (type === "counterparty" && event.action === "UPDATE") {
				log(`[MS WEBHOOK] Обновление контрагента`);
				try {
					const response = await msClient.request("GET", event.meta.href.replace(CONFIG.MS_API_BASE, ""));
					syncProcessor.syncCounterpartyToSite(response.data).catch((e) => log(`Ошибка синхронизации контрагента: ${e.message}`, "ERROR"));
				} catch (e) {
					log(`Ошибка при получении данных контрагента: ${e.message}`, "ERROR");
				}
			}

			// 4. Обработка статуса заказа (из МС на сайт)
			if (type === "customerorder" && event.action === "UPDATE") {
				try {
					const response = await msClient.request("GET", event.meta.href.replace(CONFIG.MS_API_BASE, ""));
					const data = response.data;

					if (data.state) {
						log(`[MS WEBHOOK] Статус в МС: "${data.state.name}"`);
					}

					const statusEntry = Object.entries(CONFIG.ORDER_STATES).find(([_, href]) => href === data.state?.meta?.href);
					const statusName = statusEntry ? statusEntry[0] : "pending";
				// Используем externalCode (ID сайта), так как именно по нему сайт ищет заказ
				const orderId = data.externalCode;
				if (!orderId) {
					log(`[MS WEBHOOK] Пропуск: в заказе МС отсутствует externalCode (ID сайта)`, "WARN");
					continue;
				}

				const updatePayload = {
					status: statusName,
					updatedAt: new Date().toISOString(),
				};

					log(`[TO SITE] Обновление статуса заказа ${orderId} -> ${statusName}`);
					await siteRequest("PATCH", `/orders/${orderId}`, updatePayload);
				} catch (e) {
					log(`Ошибка при обновлении статуса заказа: ${e.message}`, "ERROR");
				}
			}
		}		res.status(200).send("OK");
	} catch (err) {
		log(`Ошибка при обработке вебхука: ${err.message}`, "ERROR");
		res.status(500).send("Error");
	}
}

// --- РОУТЫ: EXTERNAL API (ДЛЯ БЭКЕНДА САЙТА) ---

app.post("/api/v1/external/products", handleQueueRequest("product", "barcode"));
app.patch("/api/v1/external/products/bulk", handleBulkQueueRequest("product"));
app.patch("/api/v1/external/products/:barcode", handleQueueRequest("product", "barcode"));
app.get("/api/v1/external/products/:barcode", async (req, res) => {
	try {
		const product = await msClient.findProductByBarcode(req.params.barcode);
		product ? res.json(product) : res.status(404).json({ error: "Product not found in MS" });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.post("/api/v1/external/orders", handleQueueRequest("order", "id"));
app.patch("/api/v1/external/orders/bulk", handleBulkQueueRequest("order"));
app.patch("/api/v1/external/orders/:id", handleQueueRequest("order", "id"));
app.get("/api/v1/external/orders/:id", async (req, res) => {
	try {
		const response = await msClient.request("GET", `/entity/customerorder?filter=name=${req.params.id}`);
		const order = response.data.rows?.[0];
		order ? res.json(order) : res.status(404).json({ error: "Order not found in MS" });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.post("/api/v1/external/counterparties", handleQueueRequest("counterparty", "email"));
app.patch("/api/v1/external/counterparties/bulk", handleBulkQueueRequest("counterparty"));
app.patch("/api/v1/external/counterparties/:email", handleQueueRequest("counterparty", "email"));
app.get("/api/v1/external/counterparties/:email", async (req, res) => {
	try {
		const cp = await msClient.getCounterparty(req.params.email);
		cp ? res.json(cp) : res.status(404).json({ error: "Counterparty not found in MS" });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

// --- РОУТЫ: ADMIN & MIGRATION ---

app.post("/api/v1/admin/migrate", (req, res) => 
	runMigration("product", TEST_DATA.products, (id) => `/products/${id}`, res));

app.post("/api/v1/admin/migrate-orders", (req, res) => 
	runMigration("order", TEST_DATA.orders, (id) => `/orders/${id}`, res));

app.post("/api/v1/admin/migrate-counterparties", (req, res) => 
	runMigration("counterparty", TEST_DATA.customers, (id) => `/customers/${id}`, res));

app.post("/api/v1/admin/clear-queue", async (req, res) => {
	queue.queue = [];
	await queue.save();
	log("Очередь задач очищена вручную");
	res.json({ message: "Очередь очищена" });
});

// --- РОУТЫ: WEBHOOKS ---

app.post("/api/v1/webhooks/ms", handleWebhook);
app.post("/", handleWebhook); // Резервный путь для корня

// --- ЗАПУСК СЕРВЕРА ---
app.listen(CONFIG.PORT, () => {
	log(`Сервер синхронизации запущен на порту ${CONFIG.PORT}`);
});