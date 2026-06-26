// ==========================================
// 🔐 ВЕРИФІКАЦІЯ TELEGRAM WEBAPP INITDATA
// ==========================================
// Telegram підписує дані, які Mini App надсилає назад боту, хеш-кодом
// на основі BOT_TOKEN. Без цієї перевірки будь-хто може підробити
// запит (наприклад, надіслати фейкову ціну тарифу), якщо знає формат
// даних, які очікує бот.
//
// Документація: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

const crypto = require('crypto');

/**
 * Перевіряє підпис initData, що надійшов від Telegram Mini App.
 * @param {string} initDataRaw - рядок initData (querystring формат)
 * @param {string} botToken - токен бота
 * @returns {{ valid: boolean, data: Object|null, reason?: string }}
 */
function validateInitData(initDataRaw, botToken) {
    if (!initDataRaw || typeof initDataRaw !== 'string') {
        return { valid: false, data: null, reason: 'initData відсутній' };
    }

    const params = new URLSearchParams(initDataRaw);
    const hash = params.get('hash');

    if (!hash) {
        return { valid: false, data: null, reason: 'hash відсутній у initData' };
    }

    params.delete('hash');

    // Будуємо data-check-string: сортовані "key=value" через \n
    const dataCheckArr = [];
    for (const [key, value] of params.entries()) {
        dataCheckArr.push(`${key}=${value}`);
    }
    dataCheckArr.sort();
    const dataCheckString = dataCheckArr.join('\n');

    // secret_key = HMAC-SHA256(bot_token, "WebAppData")
    const secretKey = crypto
        .createHmac('sha256', 'WebAppData')
        .update(botToken)
        .digest();

    const computedHash = crypto
        .createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');

    if (computedHash !== hash) {
        return { valid: false, data: null, reason: 'Невірний підпис (hash mismatch)' };
    }

    // Перевірка свіжості (захист від replay-атак зі старими даними)
    const authDate = Number(params.get('auth_date'));
    const MAX_AGE_SECONDS = 24 * 60 * 60; // 24 години
    if (authDate && Date.now() / 1000 - authDate > MAX_AGE_SECONDS) {
        return { valid: false, data: null, reason: 'initData застарілий' };
    }

    const result = {};
    for (const [key, value] of params.entries()) {
        try {
            result[key] = JSON.parse(value);
        } catch {
            result[key] = value;
        }
    }

    return { valid: true, data: result };
}

module.exports = { validateInitData };
