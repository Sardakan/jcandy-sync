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
		const isCancelled = order.status === "cancelled";

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
				const qty = item.quantity || 1;
				positions.push({
					quantity: qty,
					reserve: isCancelled ? 0 : qty,
					price: (item.price || 0) * 100,
					vat: 22,
					assortment: { meta: msProduct.meta },
				});
			}
		}
		// 3. Добавление платной доставки		
		if (order.deliveryPrice && order.deliveryPrice !== 0) {
			const deliveryServiceName = order.deliveryTariffName || "Доставка";
			const serviceMeta = await msClient.ensureService(deliveryServiceName, order.deliveryPrice);

			if (serviceMeta) {				
				positions.push({
					quantity: 1,
					price: order.deliveryPrice * 100,
					vat: 22,
					assortment: {
						meta: serviceMeta,
					},
				});
			} else {
				log(`[PROCESSOR] Не удалось получить услугу доставки "${deliveryServiceName}". Позиция доставки пропущена.`, "WARN");
			}
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
			salesChannel: {
				meta: {
					href: CONFIG.SALES_CHANNEL_HREF,
					type: "saleschannel",
					mediaType: "application/json",
				},
			},
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
					// Запрашиваем этикетку, подавляя вывод ошибок в консоль, если это просто отсутствие документа
					const barcodeResponse = await siteRequest("GET", `/orders/${order.id}/barcode`).catch(() => null);
					
					if (barcodeResponse && barcodeResponse.data && barcodeResponse.data.base64) {
						const barcodeData = barcodeResponse.data;
						log(`[PROCESSOR] Этикетка получена (Base64). Загружаю в МС как файл: ${barcodeData.fileName}`);
						
						await msClient.request("POST", `/entity/customerorder/${orderResult.id}/files`, {
							filename: barcodeData.fileName || `cdek-${order.id}.pdf`,
							content: barcodeData.base64
						});
						
						log(`[PROCESSOR] Этикетка СДЭК успешно прикреплена к заказу в МС`);
					} else {
						log(`[PROCESSOR] Этикетка СДЭК для заказа ${order.id} пока не доступна (пропуск)`, "WARN");
					}
				} catch (e) {
					// Здесь ловим только критические ошибки самой загрузки в МС
					log(`[PROCESSOR] Не удалось прикрепить этикетку СДЭК: ${e.message}`, "WARN");
				}
			}			return orderResult;		
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
		const barcode = data.barcode || "no-barcode";
		
		// 1. Страна
		let countryData = null;
		if (data.country) {
			// log(`[DEBUG-MAP] ${barcode}: поиск страны ${data.country}`);
			countryData = await msClient.getCountry(data.country);
		}

		// 2. Магазин
		let storeAttrValue = null;
		const storeName = data.store?.name;
		if (storeName) {
			// log(`[DEBUG-MAP] ${barcode}: поиск магазина ${storeName}`);
			storeAttrValue = await msClient.getCustomEntityValue("Магазин", storeName);
		}

		const attributesConfig = [
			{ name: "brand", type: "string", value: data.brand },
			{ name: "isPublished", type: "boolean", value: data.isPublished },
			{ name: "Магазин", type: "customentity", value: storeAttrValue },
		];

		// 3. ТН ВЭД
		if (Array.isArray(data.rawAttributes)) {
			const tnved = data.rawAttributes.find(a => a.name === "ТН ВЭД коды ЕАЭС");
			if (tnved) {
				attributesConfig.push({ name: "ТН ВЭД коды ЕАЭС", type: "string", value: tnved.value });
			}
		}

		// 4. Атрибуты (ensureAttribute)
		const msAttributes = [];
		for (const attr of attributesConfig) {
			if (attr.value === null || attr.value === undefined || attr.value === "") continue;
			const meta = await msClient.ensureAttribute(attr.name, attr.type);
			if (meta) {
				let finalValue;
				if (attr.type === "customentity") {
					finalValue = { meta: attr.value };
				} else {
					finalValue = attr.type === "double" || attr.type === "number" ? Number(attr.value) : attr.value;
				}
				msAttributes.push({ meta, value: finalValue });
			}
		}

		const msProduct = {
			name: data.title || data.name,
			description: data.description || "",
			attributes: msAttributes,
			externalCode: String(data.externalId || ""),
			article: data.slug || undefined,
		};

		if (data.barcode) msProduct.barcodes = [{ code128: data.barcode }];

		// 5. Цены
		const salePrices = [];
		const priceCurrent = data.priceCurrent ?? data.pricing?.priceCurrent;
		if (priceCurrent) {
			salePrices.push({
				value: Number(priceCurrent) * 100,
				priceType: {
					meta: {
						href: `${CONFIG.MS_API_BASE}/context/companysettings/pricetype/${CONFIG.PRICE_TYPE_REGULAR}`,
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
						href: `${CONFIG.MS_API_BASE}/context/companysettings/pricetype/${CONFIG.PRICE_TYPE_OLD}`,
						type: "pricetype",
						mediaType: "application/json",
					},
				},
			});
		}
		if (salePrices.length > 0) msProduct.salePrices = salePrices;
		if (countryData) msProduct.country = { meta: countryData.meta };

		// 6. Изображения (Самое вероятное место зависания)
		const imageUrls = data.imageUrls || (data.media && data.media.images ? data.media.images.map((img) => img.url) : []);
		
		if (imageUrls.length > 0) {
			try {
				log(`[DEBUG-MAP] ${barcode}: загрузка изображения...`);
				const imageData = await msClient.downloadImageAsBase64(imageUrls[0]);
				if (imageData) msProduct.images = [imageData];
				log(`[DEBUG-MAP] ${barcode}: изображение загружено`);
			} catch (imgErr) {
				log(`[DEBUG-MAP] ${barcode}: ошибка изображения: ${imgErr.message}`, "WARN");
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
				// Используем PUT для полной перезаписи полей
				await msClient.request("PUT", `/entity/product/${existingProduct.id}`, msProduct);
				log(`[PROCESSOR] Товар ПОЛНОСТЬЮ ОБНОВЛЕН (PUT) в МС: "${data.title || data.name}" (${data.barcode})`);
			} else {
				await msClient.request("POST", "/entity/product", msProduct);
				log(`[PROCESSOR] Товар СОЗДАН в МС: "${data.title || data.name}" (${data.barcode})`);
			}		
		} catch (err) {
			const errorDetail = err.response ? JSON.stringify(err.response.data, null, 2) : err.message;
			log(`[PROCESSOR] Ошибка синхронизации товара ${data.barcode}: ${errorDetail}`, "ERROR");
			throw err;
		}
	},
	/**
	 * Массовое создание/обновление товаров (для миграции)
	 */
	async massCreateProducts(items) {
		if (!items || items.length === 0) return;

		const barcodes = items.map((i) => i.barcode).filter(Boolean);
		const existingRows = await msClient.findProductsByBarcodes(barcodes);

		// Карта существующих товаров: barcode -> id
		const existingMap = new Map();
		existingRows.forEach((row) => {
			if (row.barcodes) {
				row.barcodes.forEach((b) => {
					const code = b.code128 || b.ean13;
					if (code) existingMap.set(code, row.id);
				});
			}
		});

		let createdCount = 0;
		let updatedCount = 0;
		let currentIdx = 0;

		for (const item of items) {
			currentIdx++;
			try {
				log(`[MASS-PROCESSOR] Обработка ${currentIdx}/${items.length}: ${item.barcode} (${item.title})`);
				const msObj = await this.mapToMsProduct(item);
				const existingId = existingMap.get(item.barcode);

				if (existingId) {
					// Полная перезапись существующего товара
					log(`[MASS-PROCESSOR] Обновление товара в МС: ${item.barcode}`);
					await msClient.request("PUT", `/entity/product/${existingId}`, msObj);
					updatedCount++;
				} else {
					// Создание нового
					log(`[MASS-PROCESSOR] Создание нового товара в МС: ${item.barcode}`);
					await msClient.request("POST", "/entity/product", msObj);
					createdCount++;
				}			
			} catch (e) {
				log(`[MASS-PROCESSOR] Ошибка обработки товара ${item.barcode}: ${e.message}`, "ERROR");
			}
		}
		log(`[MASS-PROCESSOR] Миграция завершена: Всего ${items.length}, Создано ${createdCount}, Обновлено (перезаписано) ${updatedCount}`);
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

		const updates = await Promise.all(msProducts.map(async (product) => {
			const barcode = product.barcodes ? product.barcodes[0].code128 || product.barcodes[0].ean13 : null;
			if (!barcode) return null;

			const getAttr = (name) => {
				const attr = product.attributes ? product.attributes.find((a) => a.name.toLowerCase() === name.toLowerCase()) : null;
				if (!attr) return null;
				return typeof attr.value === 'object' ? attr.value.name : attr.value;
			};

			// Собираем только ТН ВЭД коды ЕАЭС в rawAttributes
			const rawAttributes = [];
			if (product.attributes) {
				product.attributes.forEach((attr) => {
					if (attr.name === "ТН ВЭД коды ЕАЭС") {
						rawAttributes.push({ 
							group: "Импорт Ozon", 
							name: attr.name, 
							value: attr.value 
						});
					}
				});
			}			
			// Функция получения страны
			const fetchCountryName = async () => {
				if (product.country?.meta?.href) {
					const countryData = await msClient.getCountryByHref(product.country.meta.href);
					if (countryData?.name) return countryData.name;
				}
				return getAttr("Страна") || getAttr("country");
			};

			// Формируем объект только с разрешенными полями
			const payload = {
				title: product.name,
				barcode: barcode,
				description: product.description || "",
				brand: getAttr("brand") || getAttr("Брэнд"),
				isPublished: String(getAttr("isPublished") || getAttr("Опубликован")) === "true",
				country: await fetchCountryName(),
				priceCurrent: product.salePrices ? product.salePrices[0].value / 100 : null,
				priceOld: product.salePrices && product.salePrices[1] ? product.salePrices[1].value / 100 : null,
				rawAttributes: rawAttributes,
				updatedAt: new Date().toISOString()
			};
			return payload;
		}));

		const filteredUpdates = updates.filter(p => p !== null);

		log(`[PROCESSOR] Подготовлено полных обновлений: ${filteredUpdates.length} шт.`);
		if (filteredUpdates.length > 0) {
			await siteRequest("PATCH", "/products/bulk", filteredUpdates);
			log(`[TO SITE] Массовое обновление (полное) успешно отправлено`);
		}
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

		log(`[TO SITE] Обновление контрагента ${email}: ${JSON.stringify(updatePayload)}`);		try {
			await siteRequest("PATCH", `/customers/${encodeURIComponent(email)}`, updatePayload);
		} catch (e) {
			log(`[PROCESSOR] Ошибка отправки контрагента на сайт: ${e.message}`, "ERROR");
		}
	},
};

module.exports = syncProcessor;