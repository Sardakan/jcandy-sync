const CONFIG = require("./config");
const log = require("./logger");
const msClient = require("./moysklad");
const { siteRequest } = require("./siteApi");

const syncProcessor = {
	/**
	 * Вспомогательная функция для "распаковки" данных из разных форматов API
	 */
	extractData(rawData) {
		if (!rawData) return null;
		if (rawData.data && !Array.isArray(rawData.data)) return rawData.data;
		if (rawData.rows && Array.isArray(rawData.rows)) return rawData.rows[0];
		if (Array.isArray(rawData)) return rawData[0];
		return rawData;
	},

	/**
	 * Главный входной пункт для обработки задачи из очереди
	 */
	async handle(task) {
		// 1. Универсальное извлечение данных
		const data = this.extractData(task.data);

		if (!data) {
			log(`[PROCESSOR] Ошибка: пустые данные в задаче ${task.entity}`, "ERROR");
			return;
		}
		const entityId = data.id || data.barcode || data.orderNumber || data.email || 'no-id';
		log(`[PROCESSOR] Обработка ${task.entity}: ${entityId}`);
		
		// 2. Распределение по методам
		switch (task.entity) {
			case "product":
				await this.syncProduct(data);
				break;
			case "order":
				await this.syncOrder(data);
				break;
			case "counterparty":
				await this.syncCounterparty(data);
				break;
			default:
				log(`[PROCESSOR] Неизвестная сущность: ${task.entity}`, "WARN");
		}
	},

	/**
	 * Синхронизация контрагента
	 */
	async syncCounterparty(siteData) {
		// 1. Определяем объект с данными пользователя
		const user = siteData.customer || siteData.user || siteData;
		const email = user.email || siteData.customerEmail;

		if (!email) {
			log("[PROCESSOR] Ошибка: у контрагента не указан email", "ERROR");
			return null;
		}

		// 2. Формируем строку адреса
		let addressStr = siteData.address || siteData.deliveryAddress || user.address;
		if (addressStr && typeof addressStr === 'object') {
			const parts = [addressStr.zip, addressStr.city, addressStr.street].filter(Boolean);
			addressStr = parts.join(", ");
		}

		// 3. Поиск существующего контрагента в МС
		const existing = await msClient.getCounterparty(email);
		// 4. Маппинг по стандарту
		const msCounterparty = {
			name: user.name || user.fullName || email,
			email: email,
			phone: user.phone || siteData.phone || siteData.customerPhone || undefined,
			actualAddress: addressStr || undefined,
			description: siteData.notes || siteData.comment || user.notes || undefined,
			code: user.id || user.externalId || undefined,
			externalId: user.externalId || user.id || undefined,
		};

		// Удаляем пустые поля, чтобы не затирать данные в МС
		if (!msCounterparty.phone) delete msCounterparty.phone;
		if (!msCounterparty.actualAddress) delete msCounterparty.actualAddress;
		if (!msCounterparty.description) delete msCounterparty.description;

		// 5. Сохранение
		if (existing) {
			await msClient.request("PUT", `/entity/counterparty/${existing.id}`, msCounterparty);
			log(`[PROCESSOR] Контрагент обновлен: ${email}`);
			return existing.meta;
		} else {
			const response = await msClient.request("POST", "/entity/counterparty", msCounterparty);
			log(`[PROCESSOR] Контрагент создан: ${email}`);
			return response.data.meta;
		}
	},

	/**
	 * Синхронизация заказа
	 */
	async syncOrder(siteData) {
		const order = siteData.order || siteData;
		log(`[PROCESSOR] Синхронизация заказа: ${order.id}`);

		// 1. Поиск или создание контрагента
		const agentMeta = await this.syncCounterparty(order);
		if (!agentMeta) {
			log("[PROCESSOR] Не удалось получить метаданные контрагента. Синхронизация заказа прервана.", "ERROR");
			return;
		}

		// 2. Формирование позиций заказа
		const positions = [];
		const items = order.items || (order.barcode ? [{ barcode: order.barcode, quantity: 1, price: order.price }] : []);

		for (const item of items) {
			let msProduct = await msClient.findProductByBarcode(item.barcode);

			// Если товара нет в МС — пытаемся создать его "на лету" из БД сайта
			if (!msProduct && item.barcode) {
				log(`[PROCESSOR] Товар ${item.barcode} не найден в МС. Пытаемся создать из БД сайта...`, "INFO");
				try {
					const siteProduct = await siteRequest("GET", `/products/${item.barcode}`);
					const productData = this.extractData(siteProduct);
					if (productData) {
						await this.syncProduct(productData);
						msProduct = await msClient.findProductByBarcode(item.barcode);
					}
				} catch (e) {
					log(`[PROCESSOR] Не удалось создать отсутствующий товар ${item.barcode}: ${e.message}`, "WARN");
				}
			}

			if (msProduct) {
				positions.push({
					quantity: item.quantity || 1,
					price: (item.price || 0) * 100,
					vat: 22,
					assortment: { meta: msProduct.meta },
				});
			}
		}
		// 3. Добавление платной доставки
		if (order.deliveryPrice && order.deliveryPrice !== 0) {
			positions.push({
				quantity: 1,
				price: order.deliveryPrice * 100,
				vat: 22,
				assortment: {
					meta: {
						href: CONFIG.SERVICE_DELIVERY_HREF,
						type: "service",
						mediaType: "application/json",
					},
				},
			});
		}

		// 4. Форматирование даты
		let formattedMoment = undefined;
		const rawDate = order.createdAt || order.date;
		if (rawDate) {
			try {
				const d = new Date(rawDate);
				if (!isNaN(d.getTime())) {
					formattedMoment = d.toISOString().replace("T", " ").split(".")[0];
				}
			} catch (e) {
				log(`[PROCESSOR] Ошибка форматирования даты "${rawDate}": ${e.message}`, "WARN");
			}
		}

		const msOrder = {
			name: order.orderId || order.id,
			externalCode: order.orderId || order.id,
			moment: formattedMoment,
			vat: 22,
			vatEnabled: true,
			vatIncluded: true,
			description: order.notes || "",
			shipmentAddress: (order.deliveryZip ? order.deliveryZip + ", " : "") + (order.deliveryAddress || order.address || ""),
			organization: { meta: { href: CONFIG.ORGANIZATION_HREF, type: "organization", mediaType: "application/json" } },
			agent: { meta: agentMeta },
			store: { meta: { href: CONFIG.STORE_HREF, type: "store", mediaType: "application/json" } },
			state: {
				meta: {
					href: CONFIG.ORDER_STATES[order.status] || CONFIG.ORDER_STATES["pending"],
					type: "state",
					mediaType: "application/json",
				},
			},
			positions: positions,
		};

		try {
			const response = await msClient.request("POST", "/entity/customerorder", msOrder);
			log(`[PROCESSOR] Заказ успешно создан. ID: ${response.data.id}`);
			return response.data;
		} catch (err) {
			const errorDetail = err.response ? JSON.stringify(err.response.data, null, 2) : err.message;
			log(`[PROCESSOR] Ошибка при создании заказа: ${errorDetail}`, "ERROR");
			throw err;
		}
	},

	/**
	 * Синхронизация товара
	 */
	async syncProduct(siteData) {
		const data = siteData.product || siteData.data || siteData;

		if (!data || (!data.barcode && !data.title)) {
			log(`[PROCESSOR] Ошибка: Некорректные данные товара`, "ERROR");
			return;
		}

		log(`[PROCESSOR] Синхронизация товара: ${data.title} (${data.barcode})`);

		const existingProduct = await msClient.findProductByBarcode(data.barcode);
		const countryData = data.country ? await msClient.getCountry(data.country) : null;

		// 1. Подготовка атрибутов
		const attributesConfig = [
			{ name: "Брэнд", type: "string", value: data.brand },
			{ name: "Опубликован", type: "boolean", value: data.isPublished },
			{ name: "packageWeight", type: "double", value: data.packWeightG },
			{ name: "packLengthMm", type: "double", value: data.attributes?.packLengthMm },
			{ name: "packWidthMm", type: "double", value: data.attributes?.packWidthMm },
			{ name: "packHeightMm", type: "double", value: data.attributes?.packHeightMm },
			{ name: "protein", type: "double", value: data.nutrition?.protein },
			{ name: "fat", type: "double", value: data.nutrition?.fat },
			{ name: "carbs", type: "double", value: data.nutrition?.carbs },
			{ name: "kcal", type: "double", value: data.nutrition?.kcal },
			{ name: "Тэги", type: "text", value: data.tags?.length > 0 ? data.tags.join(", ") : null },
			{ name: "Бейджи", type: "text", value: data.badges?.length > 0 ? data.badges.join(", ") : null },
		];

		// Добавляем динамические атрибуты
		if (Array.isArray(data.rawAttributes)) {
			data.rawAttributes.forEach(a => a.value && attributesConfig.push({ name: a.name, type: "string", value: a.value }));
		}

		const msAttributes = [];
		for (const attr of attributesConfig) {
			if (attr.value === null || attr.value === undefined || attr.value === "") continue;
			const meta = await msClient.ensureAttribute(attr.name, attr.type);
			if (meta) {
				const finalValue = (attr.type === "double" || attr.type === "number") ? Number(attr.value) : attr.value;
				if (typeof finalValue === "number" && isNaN(finalValue)) continue;
				msAttributes.push({ meta, value: finalValue });
			}
		}
		const msProduct = {
			name: data.title,
			externalId: String(data.externalId || data.id || ""),
			code: data.sku || undefined,
			article: data.slug || undefined,
			description: data.description || "",
			attributes: msAttributes,
			weight: data.weightG || undefined,
			volume: data.weights?.volumeMl || undefined,
		};
		if (data.barcode) msProduct.barcodes = [{ code128: data.barcode }];

		// Цены
		const salePrices = [];
		const priceCurrent = data.priceCurrent ?? data.pricing?.priceCurrent;
		const priceOld = data.priceOld ?? data.pricing?.priceOld;

		if (priceCurrent !== undefined && priceCurrent !== null) {
			salePrices.push({
				value: Number(priceCurrent) * 100,
				priceType: { meta: { href: `${CONFIG.MS_API_BASE}/context/companysettings/pricetype/c98c9c6d-4619-11f1-0a80-1ba10025a76e`, type: "pricetype", mediaType: "application/json" } }
			});
		}
		if (priceOld !== undefined && priceOld !== null) {
			salePrices.push({
				value: Number(priceOld) * 100,
				priceType: { meta: { href: `${CONFIG.MS_API_BASE}/context/companysettings/pricetype/c25d77ef-46f0-11f1-0a80-143b0004ba6d`, type: "pricetype", mediaType: "application/json" } }
			});
		}
		if (salePrices.length > 0) msProduct.salePrices = salePrices;
		// Изображения
		const imageUrls = data.imageUrls || (data.media?.images ? data.media.images.map(img => img.url) : []);
		if (imageUrls.length > 0 && data.imageUpdated !== false) {
			try {
				const imageData = await msClient.downloadImageAsBase64(imageUrls[0]);
				if (imageData) msProduct.images = [imageData];
			} catch (e) {
				log(`[PROCESSOR] Ошибка загрузки фото для ${data.barcode}: ${e.message}`, "WARN");
			}
		}

		if (countryData) msProduct.country = { meta: countryData.meta };

		try {
			if (existingProduct) {
				await msClient.request("PUT", `/entity/product/${existingProduct.id}`, msProduct);
				log(`[PROCESSOR] Товар обновлен: ${data.barcode}`);
			} else {
				await msClient.request("POST", "/entity/product", msProduct);
				log(`[PROCESSOR] Товар создан: ${data.barcode}`);
			}
		} catch (err) {
			const errorDetail = err.response ? JSON.stringify(err.response.data, null, 2) : err.message;
			log(`[PROCESSOR] Ошибка синхронизации товара ${data.barcode}: ${errorDetail}`, "ERROR");
			throw err;
		}
	},

	/**
	 * Синхронизация остатков на основе измененного документа МС
	 */
	async syncStocksFromDocument(document) {
		const positionsUrl = document.positions?.meta?.href;
		if (!positionsUrl) return;

		log(`[PROCESSOR] Обработка остатков из документа: ${document.name || document.id}`);

		try {
			// 1. Получаем все позиции документа
			const positions = await msClient.loadDocumentPositions(positionsUrl);

			// 2. Собираем уникальные ID товаров из позиций
			const productIds = positions.map((p) => p.assortment?.meta?.href.split("/").pop()).filter(Boolean);

			if (productIds.length === 0) return;

			// 3. Загружаем актуальные данные ассортимента (остатки/резервы)
			const msProducts = await msClient.loadProductsFromAssortment(productIds);

			// 4. Формируем массив для массового обновления на сайте
			const stockUpdates = msProducts
				.map((product) => {
					const barcode = product.barcodes ? product.barcodes[0].code128 || product.barcodes[0].ean13 : null;
					if (!barcode) return null;

					return {
						barcode: barcode,
						stock: msClient.calculateAvailableStock(product),
						country: product.country?.name || undefined,
					};				
				})
				.filter(Boolean);

			// 5. Отправляем на сайт одним запросом
			if (stockUpdates.length > 0) {
				log(`[TO SITE] Массовое обновление остатков (${stockUpdates.length} поз.)`);
				await siteRequest("PATCH", "/products/bulk", { stocks: stockUpdates });
			}
		} catch (e) {
			log(`[PROCESSOR] Ошибка при синхронизации остатков документа: ${e.message}`, "ERROR");
		}
	},
};
module.exports = syncProcessor;
