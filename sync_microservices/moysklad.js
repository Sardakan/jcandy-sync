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
	customEntityCache: {}, // Кэш для справочников и их значений

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
		const validBarcodes = (barcodes || []).filter((b) => b && String(b).trim() !== "");
		if (validBarcodes.length === 0) return [];

		try {
			const filterParts = validBarcodes.map((b) => `barcode=${String(b).trim()}`);
			const filterString = filterParts.join(";");
			
			log(`[DEBUG] Фильтр для МС: ${filterString}`); // Раскомментируйте для глубокой отладки
			
			const response = await this.request("GET", `/entity/assortment?filter=${encodeURIComponent(filterString)}`);
			return response.data.rows || [];
		} catch (error) {
			log(`Ошибка массового поиска товаров: ${error.message}`, "ERROR");
			return [];
		}
	},	async getCountry(name) {
		if (!name) return null;
		const cacheKey = `country:${name}`;
		if (this.cache[cacheKey]) return this.cache[cacheKey];

		try {
			const response = await this.request("GET", `/entity/country?filter=name=${encodeURIComponent(name)}`);
			if (response.data.rows && response.data.rows.length > 0) {
				this.cache[cacheKey] = response.data.rows[0];
				return this.cache[cacheKey];
			}

			// Если страна не найдена — создаем её
			log(`Страна "${name}" не найдена в МС. Создаю...`, "INFO");
			const createResponse = await this.request("POST", "/entity/country", {
				name: name
			});
			
			this.cache[cacheKey] = createResponse.data;
			return this.cache[cacheKey];
		} catch (error) {
			log(`Ошибка при работе со страной ${name}: ${error.message}`, "ERROR");
			return null;
		}
	},
	async getCountryByHref(href) {		
		if (!href) return null;
		try {
			const apiPath = href.replace(CONFIG.MS_API_BASE, "");
			const response = await this.request("GET", apiPath);
			return response.data;
		} catch (error) {
			log(`Ошибка при получении страны по ссылке: ${error.message}`, "ERROR");
			return null;
		}
	},
	async getCustomEntityValue(entityName, valueName) {
		const cacheKey = `${entityName}:${valueName}`;
		if (this.customEntityCache[cacheKey]) return this.customEntityCache[cacheKey];

		try {
			// 1. Получаем список всех определений пользовательских справочников
			const response = await this.request("GET", "/context/companysettings/metadata");
			const entity = response.data.customEntities ? response.data.customEntities.find(e => e.name === entityName) : null;
			
			if (!entity) {
				log(`Справочник "${entityName}" не найден в МС. Проверьте название в Настройках.`, "WARN");
				return null;
			}

			const entityId = entity.id;
			// 2. Ищем конкретное значение в этом справочнике по имени
			const search = await this.request("GET", `/entity/customentity/${entityId}?filter=name=${encodeURIComponent(valueName)}`);
			
			if (search.data.rows && search.data.rows.length > 0) {
				this.customEntityCache[cacheKey] = search.data.rows[0].meta;
				return this.customEntityCache[cacheKey];
			}
			
			// 3. Если значение не найдено — создаем его
			log(`Значение "${valueName}" не найдено в справочнике "${entityName}". Создаю...`, "INFO");
			const createResponse = await this.request("POST", `/entity/customentity/${entityId}`, {
				name: valueName
			});
			
			this.customEntityCache[cacheKey] = createResponse.data.meta;
			return this.customEntityCache[cacheKey];
		} catch (error) {
			log(`Ошибка при работе со справочником ${entityName}: ${error.message}`, "ERROR");
			return null;
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
	async getCountryByHref(href) {
		if (!href) return null;
		try {
			const apiPath = href.replace(CONFIG.MS_API_BASE, "");
			const response = await this.request("GET", apiPath);
			return response.data;
		} catch (error) {
			log(`Ошибка при получении страны по ссылке: ${error.message}`, "ERROR");
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

	async ensureService(name, price = 0) {
		try {
			const search = await this.request("GET", `/entity/service?filter=name=${encodeURIComponent(name)}`);
			if (search.data.rows && search.data.rows.length > 0) {
				return search.data.rows[0].meta;
			}

			log(`Услуга "${name}" не найдена. Создаю с ценой ${price}...`, "INFO");
			const response = await this.request("POST", "/entity/service", {
				name: name,
				paymentItemType: "SERVICE",
				salePrices: [
					{
						value: price * 100,
						priceType: {
							meta: {
								href: `${CONFIG.MS_API_BASE}/context/companysettings/pricetype/9946a728-58e1-11f1-0a80-1ca50045e58d`,
								type: "pricetype",
								mediaType: "application/json",
							},
						},
					},
				],
			});
			return response.data.meta;
		} catch (error) {
			log(`Ошибка при обеспечении услуги ${name}: ${error.message}`, "ERROR");
			return null;
		}
	},	async downloadImageAsBase64(url) {
		if (!url) return null;

		// Если путь относительный, добавляем домен сайта
		let fullUrl = url;
		if (url.startsWith("/")) {
			fullUrl = `https://jcandy.ru${url}`;
		}

		try {
			const response = await axios.get(fullUrl, { 
				responseType: "arraybuffer",
				timeout: 10000 // Таймаут 10 секунд
			});

			// Проверка на SVG (МойСклад поддерживает только растровые форматы: JPG, PNG, GIF)			const contentStart = response.data.slice(0, 100).toString().toLowerCase();
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
		const idsFilter = uniqueProductIds.map(id => `id=${id}`).join(";");
		const response = await this.request("GET", `/entity/assortment?filter=${idsFilter}&expand=country,attributes`);
		return response.data.rows || [];
	},
	async getCurrentEmployee() {
		try {
			const response = await this.request("GET", "/context/employee");
			return response.data; // Содержит uid и name
		} catch (error) {
			log(`Ошибка при получении данных текущего сотрудника: ${error.message}`, "ERROR");
			return null;
		}
	},	calculateAvailableStock(product) {		// Доступный остаток = Остаток - Резерв
		return Math.max(0, (product.stock || 0) - (product.reserve || 0));
	},
};

module.exports = msClient;
