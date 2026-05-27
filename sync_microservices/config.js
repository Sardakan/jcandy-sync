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
	PRICE_TYPE_REGULAR: "778f6b6f-59ce-11f1-0a80-169c0010c628", // Цена продажи (сайт)
	PRICE_TYPE_OLD: "778f6d67-59ce-11f1-0a80-169c0010c629",     // Старая цена (сайт)
	SALES_CHANNEL_HREF: "https://api.moysklad.ru/api/remap/1.2/entity/saleschannel/06a4973d-59cf-11f1-0a80-0e09000fd28c",
};
module.exports = CONFIG;
