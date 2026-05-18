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
		const entityId = data.id || data.barcode || data.orderNumber || data.email || "no-id";
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
		if (addressStr && typeof addressStr === "object") {
			const parts = [addressStr.zip, addressStr.city, addressStr.street].filter(Boolean);
			addressStr = parts.join(", ");
		}

		// 3. Поиск существующего контрагента в МС
		const existing = await msClient.getCounterparty(email);
		// 4. Маппинг по стандарту
		const msCounterparty = {
			name: user.name || email,
			email: email,
			phone: user.phone || undefined,
			actualAddress: addressStr || undefined,
			code: user.id || undefined,
			externalCode: user.externalId || undefined,
		};

		// Удаляем пустые поля, чтобы не затирать данные в МС
		if (!msCounterparty.phone) delete msCounterparty.phone;
		if (!msCounterparty.actualAddress) delete msCounterparty.actualAddress;

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
			// Проверяем, существует ли заказ в МС
			const existingOrder = await msClient.findOrderByExternalCode(msOrder.externalCode);

			let orderResult;
			if (existingOrder) {
				// Если заказ есть — обновляем только статус
				const response = await msClient.request("PUT", `/entity/customerorder/${existingOrder.id}`, {
					state: msOrder.state
				});
				orderResult = response.data;
				log(`[PROCESSOR] Статус заказа ${msOrder.externalCode} обновлен в МС`);
			} else {
				// Если заказа нет — создаем новый
				const response = await msClient.request("POST", "/entity/customerorder", msOrder);
				orderResult = response.data;
				log(`[PROCESSOR] Заказ успешно создан. ID: ${orderResult.id}`);
			}

			// --- ЛОГИКА ЭТИКЕТКИ СДЭК ---
			if (order.deliveryProvider === "cdek") {
				log(`[PROCESSOR] Обнаружена доставка СДЭК для заказа ${order.id}. Запрашиваю этикетку...`);
				try {
					const barcodeData = await siteRequest("GET", `/orders/${order.id}/barcode`);
					if (barcodeData && barcodeData.url) {
						log(`[PROCESSOR] Этикетка получена: ${barcodeData.url}. Загружаю в МС...`);
						const imageData = await msClient.downloadImageAsBase64(barcodeData.url);
						if (imageData) {
							await msClient.request("POST", `/entity/customerorder/${orderResult.id}/files`, {
								filename: imageData.filename,
								content: imageData.content
							});
							log(`[PROCESSOR] Этикетка СДЭК успешно прикреплена к заказу в МС`);
						}
					}
				} catch (e) {
					log(`[PROCESSOR] Ошибка при получении/загрузке этикетки СДЭК: ${e.message}`, "WARN");
				}
			}

			return orderResult;		
		} catch (err) {
			const errorDetail = err.response ? JSON.stringify(err.response.data, null, 2) : err.message;
			log(`[PROCESSOR] Ошибка при создании заказа: ${errorDetail}`, "ERROR");
			throw err;
		}
	},

	/**
	 * Вспомогательный метод для маппинга данных сайта в формат МойСклад
	 */
	async mapToMsProduct(siteData) {
		const data = siteData.data || siteData.product || siteData;
		const countryData = data.country ? await msClient.getCountry(data.country) : null;

		const attributesConfig = [
			{ name: "brand", type: "string", value: data.brand },
			{ name: "isPublished", type: "boolean", value: data.isPublished },
			{ name: "packageWeightG", type: "double", value: data.weights?.packageWeightG || data.packageWeightG },
			{ name: "packWeightG", type: "double", value: data.weights?.packWeightG || data.packWeightG },
			{ name: "protein", type: "double", value: data.nutrition?.protein },
			{ name: "fat", type: "double", value: data.nutrition?.fat },
			{ name: "carbs", type: "double", value: data.nutrition?.carbs },
			{ name: "kcal", type: "double", value: data.nutrition?.kcal },
			{ name: "tags", type: "text", value: data.tags?.length > 0 ? data.tags.join(", ") : null },
			{ name: "badges", type: "text", value: data.badges?.length > 0 ? data.badges.join(", ") : null },
			{ name: "unitPriceText", type: "string", value: data.unitPriceText },
			{ name: "deliveryType", type: "string", value: data.deliveryType },
			{ name: "isDefault", type: "boolean", value: data.isDefault },
			{ name: "weightG", type: "double", value: data.weights?.weightG || data.weightG || undefined},
			{ name: "volumeMl", type: "double", value: data.weights?.volumeMl || undefined },
			{ name: "variantKey", type: "string", value: data.variantKey },
			{ name: "variantValue", type: "string", value: data.variantValue },

		];

		// Добавляем динамические атрибуты из rawAttributes
		if (Array.isArray(data.rawAttributes)) {
			data.rawAttributes.forEach(a => {
				if (a.value !== null && a.value !== undefined && a.value !== "") {
					attributesConfig.push({ name: a.name, type: "string", value: a.value });
				}
			});
		}

		const msAttributes = [];
		for (const attr of attributesConfig) {
			if (attr.value === null || attr.value === undefined || attr.value === "") continue;
			const meta = await msClient.ensureAttribute(attr.name, attr.type);
			if (meta) {
				const finalValue = attr.type === "double" || attr.type === "number" ? Number(attr.value) : attr.value;
				msAttributes.push({ meta, value: finalValue });
			}
		}

		const msProduct = {
			name: data.title || data.name,
			externalCode: String(data.externalId || ""),
			code: String(data.id|| ""),
			article: data.slug || undefined,
			description: data.description || "",
			attributes: msAttributes,
		};

		if (data.barcode) msProduct.barcodes = [{ code128: data.barcode }];

		const salePrices = [];
		const priceCurrent = data.priceCurrent ?? data.pricing?.priceCurrent;
		if (priceCurrent) {
			salePrices.push({
				value: Number(priceCurrent) * 100,
				priceType: {
					meta: {
						href: `${CONFIG.MS_API_BASE}/context/companysettings/pricetype/c98c9c6d-4619-11f1-0a80-1ba10025a76e`,
						type: "pricetype",
						mediaType: "application/json",
					},
				},
			});
		}
		if (data.priceOld || (data.pricing && data.pricing.priceOld)) {
			const priceOld = data.priceOld || data.pricing.priceOld;
			salePrices.push({
				value: priceOld * 100,
				priceType: {
					meta: {
						href: `${CONFIG.MS_API_BASE}/context/companysettings/pricetype/c25d77ef-46f0-11f1-0a80-143b0004ba6d`,
						type: "pricetype",
						mediaType: "application/json",
					},
				},
			});
		}
		if (salePrices.length > 0) msProduct.salePrices = salePrices;
		if (countryData) msProduct.country = { meta: countryData.meta };
		// Изображения
		const imageUrls = data.imageUrls || (data.media && data.media.images ? data.media.images.map((img) => img.url) : []);

		let shouldUpdateImage = true;

		if (imageUrls.length > 0 && shouldUpdateImage) {
			try {
				const imageData = await msClient.downloadImageAsBase64(imageUrls[0]);
				if (imageData) msProduct.images = [imageData];
			} catch (imgErr) {
				console.error(`Ошибка при загрузке изображения для товара ${data.barcode || data.title}:`, imgErr.message);
				log(`Ошибка при загрузке изображения для товара ${data.barcode || data.title}: ${imgErr.message}`, "WARN");
			}
		}

		return msProduct;
	},

	/**
	 * Синхронизация товара (одиночная)
	 */
	async syncProduct(siteData) {
		const data = siteData.product || siteData.data || siteData;

		if (!data || (!data.barcode && !data.title)) {
			log(`[PROCESSOR] Ошибка: Некорректные данные товара`, "ERROR");
			return;
		}

		log(`[PROCESSOR] Синхронизация товара: ${data.title || data.name} (${data.barcode})`);

		const existingProduct = await msClient.findProductByBarcode(data.barcode);

		try {
			const msProduct = await this.mapToMsProduct(data);
			
			if (existingProduct) {
				await msClient.request("PUT", `/entity/product/${existingProduct.id}`, msProduct);
				log(`[PROCESSOR] Товар ОБНОВЛЕН: "${data.title || data.name}" (${data.barcode})`);
			} else {
				await msClient.request("POST", "/entity/product", msProduct);
				log(`[PROCESSOR] Товар СОЗДАН: "${data.title || data.name}" (${data.barcode})`);
			}
		} catch (err) {
			const errorDetail = err.response ? JSON.stringify(err.response.data, null, 2) : err.message;
			log(`[PROCESSOR] Ошибка синхронизации товара ${data.barcode}: ${errorDetail}`, "ERROR");
			throw err;
		}
	},
	/**
	 * Массовое создание товаров (для миграции)
	 */
	async massCreateProducts(items) {
		if (!items || items.length === 0) return;

		const barcodes = items.map((i) => i.barcode).filter(Boolean);
		const existingRows = await msClient.findProductsByBarcodes(barcodes);

		const existingBarcodes = new Set();
		existingRows.forEach((row) => {
			if (row.barcodes) {
				row.barcodes.forEach((b) => existingBarcodes.add(b.code128 || b.ean13));
			}
		});

		const toCreate = [];
		let skippedCount = 0;

		for (const item of items) {
			if (existingBarcodes.has(item.barcode)) {
				skippedCount++;
				continue;
			}
			const msObj = await this.mapToMsProduct(item);
			toCreate.push(msObj);
		}

		log(`[MASS-PROCESSOR] Статистика пачки: Всего ${items.length}, Пропущено (уже есть) ${skippedCount}, К созданию ${toCreate.length}`);

		if (toCreate.length > 0) {
			try {
				await msClient.request("POST", "/entity/product", toCreate);
				log(`[MASS-PROCESSOR] Успешно создано товаров в МС: ${toCreate.length}`);
			} catch (e) {
				log(`[MASS-PROCESSOR] Ошибка при массовом создании: ${e.message}`, "ERROR");
			}
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
						stockQty: msClient.calculateAvailableStock(product),
					};
				})
				.filter(Boolean);

			// 5. Отправляем на сайт одним запросом
			if (stockUpdates.length > 0) {
				log(`[TO SITE] Массовое обновление остатков (${stockUpdates.length} поз.): ${JSON.stringify(stockUpdates)}`);
				await siteRequest("PATCH", "/products/bulk", stockUpdates);
			}
		} catch (e) {
			log(`[PROCESSOR] Ошибка при синхронизации остатков документа: ${e.message}`, "ERROR");
		}
	},	

	/**
	 * Массовая синхронизация полных данных товаров из МС на сайт
	 */
	async syncProductsToSiteBulk(msProducts, webhookUpdates = []) {
		if (!msProducts || msProducts.length === 0) return;

		const updates = msProducts.map((product) => {
			const barcode = product.barcodes ? product.barcodes[0].code128 || product.barcodes[0].ean13 : null;
			if (!barcode) return null;

			// Находим информацию о том, какие поля изменились для этого товара
			const updateInfo = webhookUpdates.find(u => u.id === product.id);
			const updatedFields = updateInfo ? updateInfo.updatedFields : [];

			const getAttr = (name) => {
				const attr = product.attributes ? product.attributes.find((a) => a.name === name) : null;
				return attr ? attr.value : null;
			};

			// Базовый объект с обязательным ключом
			const payload = { barcode: barcode };

			// Маппинг полей МС -> Поля сайта
			const fieldMap = {
				"name": () => payload.title = product.name,
				"article": () => payload.slug = product.article,
				"code": () => payload.sku = product.code,
				"description": () => payload.description = product.description,
				"weight": () => {
					if (!payload.weights) payload.weights = {};
					payload.weights.weightG = product.weight ? product.weight * 1000 : null;
				},
				"volume": () => {
					if (!payload.weights) payload.weights = {};
					payload.weights.volumeMl = product.volume || null;
				},
				"country": () => payload.country = product.country?.name || undefined,
				"salePrices": () => {
					payload.priceCurrent = product.salePrices ? product.salePrices[0].value / 100 : null;
					payload.priceOld = product.salePrices && product.salePrices[1] ? product.salePrices[1].value / 100 : null;
				}
			};

			// Маппинг дополнительных атрибутов
			const attrMap = {
				"brand": "brand",
				"isPublished": "isPublished",
				"unitPriceText": "unitPriceText",
				"deliveryType": "deliveryType",
				"isDefault": "isDefault",
				"variantKey": "variantKey",
				"variantValue": "variantValue",
				"packageWeightG": "packageWeightG",
				"packWeightG": "packWeightG",
				"protein": "protein",
				"fat": "fat",
				"carbs": "carbs",
				"kcal": "kcal",
				"tags": "tags",
				"badges": "badges"
			};

			// Если есть информация об измененных полях, берем только их
			if (updatedFields.length > 0) {
				updatedFields.forEach(f => {
					if (fieldMap[f]) fieldMap[f]();
					// Проверка атрибутов (в МС они приходят как "название_атрибута (тип)") или просто "название"
					Object.keys(attrMap).forEach(attrName => {
						if (f.startsWith(attrName)) {
							const val = getAttr(attrName);
							if (attrName === "isPublished" || attrName === "isDefault") {
								payload[attrMap[attrName]] = String(val) === "true";
							} else if (["packageWeightG", "packWeightG", "protein", "fat", "carbs", "kcal"].includes(attrName)) {
								if (!payload.weights) payload.weights = {};
								if (!payload.nutrition) payload.nutrition = {};
								
								const numVal = val ? Number(val) : null;
								if (attrName.includes("Weight")) payload.weights[attrMap[attrName]] = numVal;
								else payload.nutrition[attrMap[attrName]] = numVal;
							} else if (attrName === "tags" || attrName === "badges") {
								payload[attrMap[attrName]] = val ? val.split(",").map(t => t.trim()) : [];
							} else {
								payload[attrMap[attrName]] = val;
							}
						}
					});
				});
			} else {
				// Если инфы о полях нет (например, ручной запуск), собираем всё как раньше
				Object.values(fieldMap).forEach(fn => fn());
				Object.keys(attrMap).forEach(attrName => {
					const val = getAttr(attrName);
					if (attrName === "isPublished" || attrName === "isDefault") {
						payload[attrMap[attrName]] = String(val) === "true";
					} else if (["packageWeightG", "packWeightG", "protein", "fat", "carbs", "kcal"].includes(attrName)) {
						if (!payload.weights) payload.weights = {};
						if (!payload.nutrition) payload.nutrition = {};
						const numVal = val ? Number(val) : null;
						if (attrName.includes("Weight")) payload.weights[attrMap[attrName]] = numVal;
						else payload.nutrition[attrMap[attrName]] = numVal;
					} else if (attrName === "tags" || attrName === "badges") {
						payload[attrMap[attrName]] = val ? val.split(",").map(t => t.trim()) : [];
					} else {
						payload[attrMap[attrName]] = val;
					}
				});
				payload.stockQty = msClient.calculateAvailableStock(product);
			}

			// Всегда добавляем время обновления
			payload.updatedAt = new Date().toISOString();
			return payload;
		}).filter(p => p && Object.keys(p).length > 2); // barcode + updatedAt + хотя бы одно поле

		if (updates.length > 0) {
			log(`[TO SITE] Массовое обновление измененных полей (${updates.length} поз.): ${JSON.stringify(updates)}`);
			await siteRequest("PATCH", "/products/bulk", updates);
		}
	},
	/**
	 * Полная синхронизация данных товара из МС на сайт
	 */
	async syncProductToSite(data) {
		const barcode = data.barcodes ? data.barcodes[0].code128 || data.barcodes[0].ean13 : null;
		if (!barcode) return;

		const getAttr = (name) => {
			const attr = data.attributes ? data.attributes.find((a) => a.name === name) : null;
			return attr ? attr.value : null;
		};

		const handledAttrNames = [
			"brand",
			"isPublished",
			"packageWeightG",
			"packWeightG",
			"protein",
			"fat",
			"carbs",
			"kcal",
			"tags",
			"badges",
			"unitPriceText",
			"deliveryType",
			"isDefault",
			"weightG",
			"volumeMl",
			"variantKey",
			"variantValue"
		];

		const rawAttributes = [];
		if (data.attributes) {
			data.attributes.forEach((attr) => {
				if (!handledAttrNames.includes(attr.name)) {
					rawAttributes.push({ name: attr.name, value: attr.value });
				}
			});
		}

		const updatePayload = {
			title: data.name,
			barcode: barcode,
			externalId: data.externalId,
			sku: data.code,
			slug: data.article,
			country: data.country?.name || undefined,
			priceCurrent: data.salePrices ? data.salePrices[0].value / 100 : null,
			priceOld: data.salePrices && data.salePrices[1] ? data.salePrices[1].value / 100 : null,
			description: data.description || "",
			brand: getAttr("brand"),
			isPublished: String(getAttr("isPublished")) === "true",
			stockQty: msClient.calculateAvailableStock(data),
			unitPriceText: getAttr("unitPriceText"),
			deliveryType: getAttr("deliveryType"),
			isDefault: String(getAttr("isDefault")) === "true",
			variantKey: getAttr("variantKey"),
			variantValue: getAttr("variantValue"),

			weights: {
				weightG: data.weight || null,
				volumeMl: data.volume || null,
				packageWeightG: getAttr("packageWeightG") ? Number(getAttr("packageWeightG")) : null,
				packWeightG: getAttr("packWeightG") ? Number(getAttr("packWeightG")) : null,
			},
			nutrition: {
				protein: getAttr("protein") ? Number(getAttr("protein")) : null,
				fat: getAttr("fat") ? Number(getAttr("fat")) : null,
				carbs: getAttr("carbs") ? Number(getAttr("carbs")) : null,
				kcal: getAttr("kcal") ? Number(getAttr("kcal")) : null,
			},

			tags: getAttr("tags") ? getAttr("tags").split(",").map((t) => t.trim()) : [],
			badges: getAttr("badges") ? getAttr("badges").split(",").map((t) => t.trim()) : [],
			rawAttributes: rawAttributes,
			updatedAt: new Date().toISOString(),
		};
		log(`[TO SITE] Полное обновление товара ${barcode} (Страна: ${updatePayload.country}): ${JSON.stringify(updatePayload)}`);
		await siteRequest("PATCH", `/products/${barcode}`, updatePayload);
	},
	/**
	 * Синхронизация контрагента из МС на сайт
	 */
	async syncCounterpartyToSite(data) {
		const email = data.email;
		if (!email) {
			log(`[PROCESSOR] Пропуск контрагента ${data.id}: отсутствует email`, "WARN");
			return;
		}

		const updatePayload = {
			email: email,
			name: data.name,
			phone: data.phone,
			address: data.actualAddress,
			externalId: data.externalCode || data.code,
			notes: data.description,
			updatedAt: new Date().toISOString(),
		};

		log(`[TO SITE] Обновление контрагента ${email}`);
		try {
			await siteRequest("PATCH", `/customers/${encodeURIComponent(email)}`, updatePayload);
		} catch (e) {
			log(`[PROCESSOR] Ошибка отправки контрагента на сайт: ${e.message}`, "ERROR");
		}
	},
};
module.exports = syncProcessor;
