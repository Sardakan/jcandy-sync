const path = require("path");

const CONFIG = {
	PORT: process.env.PORT || 3000,
	SITE_API_BASE: process.env.SITE_API_BASE,
	SITE_TOKEN: process.env.SITE_TOKEN,	
	QUEUE_FILE: path.join(__dirname, "queue.json"),
	FAILED_QUEUE_FILE: path.join(__dirname, "failed_queue.json"),
	LOG_FILE: path.join(__dirname, "sync.log"),	MS_API_BASE: "https://api.moysklad.ru/api/remap/1.2",
	SYNC_DELAY: 3000,
	MS_API_Token: process.env.MS_API_TOKEN,
	ORDER_STATES: {		
		pending: "https://api.moysklad.ru/api/remap/1.2/entity/customerorder/metadata/states/c99deaaf-4619-11f1-0a80-1ba10025a79c",
		processing: "https://api.moysklad.ru/api/remap/1.2/entity/customerorder/metadata/states/c99debb6-4619-11f1-0a80-1ba10025a79d",
		shipped: "https://api.moysklad.ru/api/remap/1.2/entity/customerorder/metadata/states/c99dec5b-4619-11f1-0a80-1ba10025a79e",
		delivered: "https://api.moysklad.ru/api/remap/1.2/entity/customerorder/metadata/states/c99dece6-4619-11f1-0a80-1ba10025a79f",
		cancelled: "https://api.moysklad.ru/api/remap/1.2/entity/customerorder/metadata/states/c99dee1f-4619-11f1-0a80-1ba10025a7a1",
	},
	ORGANIZATION_HREF: "https://api.moysklad.ru/api/remap/1.2/entity/organization/c98a7ea4-4619-11f1-0a80-1ba10025a766",
	STORE_HREF: "https://api.moysklad.ru/api/remap/1.2/entity/store/c98c0884-4619-11f1-0a80-1ba10025a769",
	SERVICE_DELIVERY_HREF: "https://api.moysklad.ru/api/remap/1.2/entity/service/efd419d8-461d-11f1-0a80-1038002646af",
};

module.exports = CONFIG;
