const axios = require("axios");
const path = require("path");
const CONFIG = require("./config");
const log = require("./logger");

const msApiClient = axios.create({
	baseURL: CONFIG.MS_API_BASE,
	headers: {
		Authorization: `Bearer ${CONFIG.MS_API_Token}`,
		"Content-Type": "application/json",
	},
});

const msClient = {
	cache: {}, // Кэширование метаданных

	async request(method, endpoint, data = null) {
		try {
			return await msApiClient({ method, url: endpoint, data });
		} catch (err) {
			const errorDetail =
				err.response && err.response.data && err.response.data.errors ? JSON.stringify(err.response.data.errors, null, 2) : err.message;
			log(`Ошибка API МоегоСклада (${method} ${endpoint}): ${errorDetail}`, "ERROR");
			throw err;
		}
	},
	// Поиск метаданных по наименованию (только чтение)
	async getMetaByName(entityPath, name) {
		const cacheKey = `${entityPath}:${name}`;
		if (this.cache[cacheKey]) return this.cache[cacheKey];

		try {
			const search = await this.request("GET", `${entityPath}?filter=name=${encodeURIComponent(name)}`);
			if (search.data.rows && search.data.rows.length > 0) {
				this.cache[cacheKey] = search.data.rows[0].meta;
				return this.cache[cacheKey];
			}
			return null;
		} catch (e) {
			log(`Ошибка при поиске метаданных для ${name}: ${e.message}`, "ERROR");
			return null;
		}
	},
	async findProductByBarcode(barcode) {
		if (!barcode) return null;
		try {
			const response = await this.request("GET", `/entity/assortment?filter=barcode=${barcode}`);
			return response.data.rows && response.data.rows.length > 0 ? response.data.rows[0] : null;
		} catch (error) {
			log(`Ошибка при поиске товара по штрихкоду ${barcode}: ${error.message}`, "ERROR");
			return null;
		}
	},
	async findProductsByBarcodes(barcodes) {
		if (!barcodes || barcodes.length === 0) return [];
		try {
			const filter = barcodes.map((b) => `barcode=${b}`).join(";");
			const response = await this.request("GET", `/entity/assortment?filter=${filter}`);
			return response.data.rows || [];
		} catch (error) {
			log(`Ошибка массового поиска товаров: ${error.message}`, "ERROR");
			return [];
		}
	},
	async getCountry(name) {
		if (!name) return null;
		try {
			const response = await this.request("GET", `/entity/country?filter=name=${encodeURIComponent(name)}`);
			return response.data.rows && response.data.rows.length > 0 ? response.data.rows[0] : null;
		} catch (error) {
			log(`Ошибка при поиске страны ${name}: ${error.message}`, "ERROR");
			return null;
		}
	},

	async getCounterparty(email) {
		if (!email) return null;
		try {
			const response = await this.request("GET", `/entity/counterparty?filter=email=${encodeURIComponent(email)}`);
			return response.data.rows && response.data.rows.length > 0 ? response.data.rows[0] : null;
		} catch (e) {
			log(`Ошибка при поиске контрагента ${email}: ${e.message}`, "ERROR");
			return null;
		}
	},
	async findOrderByExternalCode(externalCode) {
		if (!externalCode) return null;
		try {
			const response = await this.request("GET", `/entity/customerorder?filter=externalCode=${externalCode}`);
			return response.data.rows && response.data.rows.length > 0 ? response.data.rows[0] : null;
		} catch (error) {
			log(`Ошибка при поиске заказа по externalCode ${externalCode}: ${error.message}`, "ERROR");
			return null;
		}
	},
	async ensureAttribute(name, type) {		try {
			const metadata = await this.request("GET", "/entity/product/metadata/attributes");
			const existing = metadata.data.rows.find((attr) => attr.name === name);
			if (existing) return existing.meta;

			log(`Создание нового атрибута: ${name}`, "INFO");
			const response = await this.request("POST", "/entity/product/metadata/attributes", {
				name: name,
				type: type,
				required: false,
			});
			return response.data.meta;
		} catch (error) {
			log(`Ошибка при работе с атрибутом ${name}: ${error.message}`, "ERROR");
			return null;
		}
	},

	async downloadImageAsBase64(url) {
		if (!url) return null;

		// Если путь относительный, добавляем домен сайта
		let fullUrl = url;
		if (url.startsWith("/")) {
			fullUrl = `https://jcandy.ru${url}`;
		}

		try {
			const response = await axios.get(fullUrl, { responseType: "arraybuffer" });

			// Проверка на SVG (МойСклад поддерживает только растровые форматы: JPG, PNG, GIF)
			const contentStart = response.data.slice(0, 100).toString().toLowerCase();
			if (contentStart.includes("<svg") || fullUrl.toLowerCase().includes(".svg")) {
				log(`[WARN] Формат SVG не поддерживается МоимСкладом (пропуск): ${fullUrl}`, "WARN");
				return null;
			}

			const base64 = Buffer.from(response.data, "binary").toString("base64");
			const filename = path.basename(new URL(fullUrl).pathname.split("?")[0]) || "image.jpg";
			return { filename, content: base64 };
		} catch (e) {
			log(`Ошибка при загрузке изображения ${fullUrl}: ${e.message}`, "WARN");
			return null;
		}
	},
	// --- ФУНКЦИИ ДЛЯ РАБОТЫ С ОСТАТКАМИ ---
	async loadDocumentPositions(positionsUrl) {
		const apiPath = positionsUrl.replace(CONFIG.MS_API_BASE, "");
		const response = await this.request("GET", apiPath);
		return response.data.rows || [];
	},
	async loadProductsFromAssortment(productIds) {
		const uniqueProductIds = [...new Set(productIds)];
		const idsFilter = uniqueProductIds.join(";");
		const response = await this.request("GET", `/entity/assortment?filter=id=${idsFilter}&expand=country`);
		return response.data.rows || [];
	},
	calculateAvailableStock(product) {
		// Доступный остаток = Остаток - Резерв
		return Math.max(0, (product.stock || 0) - (product.reserve || 0));
	},
};

module.exports = msClient;
