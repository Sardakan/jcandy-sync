const path = require("path");

const CONFIG = {
	PORT: process.env.PORT || 3000,
	SITE_API_BASE: process.env.SITE_API_BASE,
	SITE_TOKEN: process.env.SITE_TOKEN,
	QUEUE_FILE: path.join(__dirname, "queue.json"),
	FAILED_QUEUE_FILE: path.join(__dirname, "failed_queue.json"),
	LOG_FILE: path.join(__dirname, "sync.log"),
	MS_API_BASE: "https://api.moysklad.ru/api/remap/1.2",
	SYNC_DELAY: 3000,
	MS_API_Token: process.env.MS_API_TOKEN,
	ORDER_STATES: {
		pending: "https://api.moysklad.ru/api/remap/1.2/entity/customerorder/metadata/states/99574bc9-58e1-11f1-0a80-1ca50045e5bb",
		processing: "https://api.moysklad.ru/api/remap/1.2/entity/customerorder/metadata/states/99574c18-58e1-11f1-0a80-1ca50045e5bc",
		shipped: "https://api.moysklad.ru/api/remap/1.2/entity/customerorder/metadata/states/99574c77-58e1-11f1-0a80-1ca50045e5bd",
		delivered: "https://api.moysklad.ru/api/remap/1.2/entity/customerorder/metadata/states/99574cc0-58e1-11f1-0a80-1ca50045e5be",
		cancelled: "https://api.moysklad.ru/api/remap/1.2/entity/customerorder/metadata/states/99574d50-58e1-11f1-0a80-1ca50045e5c0",
	},
	ORGANIZATION_HREF: "https://api.moysklad.ru/api/remap/1.2/entity/organization/99449ce2-58e1-11f1-0a80-1ca50045e57e",
	STORE_HREF: "https://api.moysklad.ru/api/remap/1.2/entity/store/99461001-58e1-11f1-0a80-1ca50045e586",
	// Ссылки на типы цен (МойСклад)
	PRICE_TYPE_REGULAR: "9946a728-58e1-11f1-0a80-1ca50045e58d", // Цена продажи (сайт)
	PRICE_TYPE_OLD: "a9b3389f-58e3-11f1-0a80-076a0045984b",     // Старая цена (сайт)
};

module.exports = CONFIG;
