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
    pending: "https://api.moysklad.ru/api/remap/1.2/entity/customerorder/metadata/states/b622e09e-6416-11f1-0a80-111c0014dd98",
    processing: "https://api.moysklad.ru/api/remap/1.2/entity/customerorder/metadata/states/b622e11c-6416-11f1-0a80-111c0014dd99",
    shipped: "https://api.moysklad.ru/api/remap/1.2/entity/customerorder/metadata/states/b622e19e-6416-11f1-0a80-111c0014dd9a",
    delivered: "https://api.moysklad.ru/api/remap/1.2/entity/customerorder/metadata/states/b622e231-6416-11f1-0a80-111c0014dd9b",
    cancelled: "https://api.moysklad.ru/api/remap/1.2/entity/customerorder/metadata/states/b622e3dd-6416-11f1-0a80-111c0014dd9d",
  },
  ORGANIZATION_HREF: "https://api.moysklad.ru/api/remap/1.2/entity/organization/b60d9fcd-6416-11f1-0a80-111c0014dd62",
  STORE_HREF: "https://api.moysklad.ru/api/remap/1.2/entity/store/e29d12fc-648b-11f1-0a80-0352000323cd",
  	// Ссылки на типы цен (МойСклад)
  	PRICE_TYPE_REGULAR: "b60fdab0-6416-11f1-0a80-111c0014dd6a", // Цена продажи (сайт)
  	PRICE_TYPE_OLD: "b9907e76-648b-11f1-0a80-17c300032f63",     // Старая цена (сайт)
  SALES_CHANNEL_HREF: "https://api.moysklad.ru/api/remap/1.2/entity/saleschannel/ef867a3e-648b-11f1-0a80-1d600003529f",
};
module.exports = CONFIG;
