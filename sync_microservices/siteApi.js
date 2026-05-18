const axios = require("axios");
const CONFIG = require("./config");
const log = require("./logger");

const siteApiClient = axios.create({
	baseURL: CONFIG.SITE_API_BASE.replace(/\/$/, ""), // Убираем слеш в конце, если он есть
	headers: {
		Authorization: `Bearer ${CONFIG.SITE_TOKEN}`,
		"Content-Type": "application/json",
		"Accept": "application/json", // Явно просим JSON
	},
});

async function siteRequest(method, endpoint, data = null) {
	// Убеждаемся, что эндпоинт начинается со слеша
	const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
	const fullUrl = `${CONFIG.SITE_API_BASE.replace(/\/$/, "")}${path}`;
	
	log(`Запрос к API сайта: ${method} ${fullUrl}`);
	if (data) {
		log(`[API PAYLOAD]: ${JSON.stringify(data, null, 2)}`);
	}
	try {		
		const response = await siteApiClient({ method, url: path, data });
		return response.data;
	} catch (err) {
		let errorDetail;
		if (err.response && typeof err.response.data === 'string' && err.response.data.includes('<!DOCTYPE html>')) {
			errorDetail = "Сервер вернул HTML (404 или ошибка прокси) вместо JSON";
		} else {
			errorDetail = err.response ? JSON.stringify(err.response.data, null, 2) : err.message;
		}
		log(`Ошибка при выполнении siteRequest (${method} ${path}): ${errorDetail}`, "ERROR");
		throw new Error(errorDetail);
	}
}

module.exports = { siteRequest };
