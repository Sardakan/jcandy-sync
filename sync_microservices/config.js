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
		pending: "https://api.moysklad.ru/api/remap/1.2/entity/customerorder/metadata/states/ae47cd91-3152-11e5-90a2-8ecb00155929",
		processing: "https://api.moysklad.ru/api/remap/1.2/entity/customerorder/metadata/states/ae47ce5a-3152-11e5-90a2-8ecb0015592a",
		shipped: "https://api.moysklad.ru/api/remap/1.2/entity/customerorder/metadata/states/ae47cf3c-3152-11e5-90a2-8ecb0015592b",
		delivered: "https://api.moysklad.ru/api/remap/1.2/entity/customerorder/metadata/states/ae47cff6-3152-11e5-90a2-8ecb0015592c",
		cancelled: "https://api.moysklad.ru/api/remap/1.2/entity/customerorder/metadata/states/ae47d17c-3152-11e5-90a2-8ecb0015592e",
	},
	ORGANIZATION_HREF: "https://api.moysklad.ru/api/remap/1.2/entity/organization/ae3c04bc-3152-11e5-90a2-8ecb0015590d",
	STORE_HREF: "https://api.moysklad.ru/api/remap/1.2/entity/store/e4266724-59ce-11f1-0a80-05400010a17e",
	// Ссылки на типы цен (МойСклад)
	PRICE_TYPE_REGULAR: "4f0e4760-f1f1-4ce0-9b32-927e8eb1e4c4", // Цена продажи (сайт)
	PRICE_TYPE_OLD: "a97ef08e-7789-46ae-80ad-ffaa87182284",     // Старая цена (сайт)
	SALES_CHANNEL_HREF: "https://api.moysklad.ru/api/remap/1.2/entity/saleschannel/06a4973d-59cf-11f1-0a80-0e09000fd28c",
};
module.exports = CONFIG;
