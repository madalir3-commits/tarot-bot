const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

// ==========================================
// ⚙️ НАЛАШТУВАННЯ
// ==========================================
// ВАЖЛИВО: На сервері Render токен і ID будуть братися зі змінних середовища (Environment).
// Для локального тесту ОБОВ'ЯЗКОВО заміни ці дані на свої:
const token = process.env.BOT_TOKEN || 'ТВІЙ_ТОКЕН_БОТА'; 
const adminId = process.env.ADMIN_ID || 'ТВІЙ_ID_АДМІНА'; 
const monoLink = 'https://send.monobank.ua/jar/ТВОЯ_БАНКА';

// Твоє посилання на Netlify вже тут!
const webAppUrl = 'https://delightful-choux-edcff2.netlify.app'; 

const bot = new TelegramBot(token, { polling: true });

// База даних у пам'яті (для MVP)
const usersDB = {};
let scheduledCards = [];

// Допоміжна функція для створення або отримання користувача
function getUser(msg) {
    const chatId = msg.chat ? msg.chat.id : msg.message.chat.id;
    if (!usersDB[chatId]) {
        usersDB[chatId] = {
            id: chatId,
            username: msg.chat ? msg.chat.username : (msg.message && msg.message.chat ? msg.message.chat.username : 'Без_ніка'),
            state: 'start',
            tariff: null,
            questionsLeft: 0,
            pendingTariff: null
        };
    }
    return usersDB[chatId];
}

// ==========================================
// 1. КОМАНДА /start (КЛІЄНТ)
// ==========================================
bot.onText(/\/start/, (msg) => {
    const user = getUser(msg);
    user.state = 'start';
    
    const text = `<b>Привіт. Я — Валерія.</b>\n\nЯкщо ти тут, значить, зараз тобі потрібні відповіді або просто опора. Я не буду обіцяти магічних таблеток чи того, що завтра твоє життя зміниться по клацанню пальців. Але я можу дати тобі інструмент, який підсвітить сліпі зони і покаже, куди рухатись далі.\n\nТисни на кнопку нижче, щоб відкрити <b>Кишеньковий Провідник</b> та обрати свій формат взаємодії.`;

    bot.sendMessage(user.id, text, {
        parse_mode: 'HTML',
        reply_markup: {
            keyboard: [
                [{ text: 'Відкрити Провідник 🔮', web_app: { url: webAppUrl } }]
            ],
            resize_keyboard: true
        }
    }).catch(err => console.error('Помилка відправки /start:', err.message));
});

// ==========================================
// 2. ОБРОБКА ДАНИХ З MINI APP ТА ПОВІДОМЛЕНЬ
// ==========================================
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const user = getUser(msg);

    // Ігноруємо звичайні команди (/start, /admin)
    if (msg.text && msg.text.startsWith('/')) return;

    // --- СЦЕНАРІЙ 1: Отримуємо дані з Mini App (index.html) ---
    if (msg.web_app_data) {
        try {
            const data = JSON.parse(msg.web_app_data.data);
            
            if (data.action === 'buy_tariff') {
                user.state = 'awaiting_payment_screenshot';
                user.pendingTariff = data.tariff;

                // Прибираємо нижню кнопку Mini App на час оплати
                const removeKeyboard = { remove_keyboard: true };

                const text = `Чудово. Тариф «${data.tariff}».\n\nОскільки це перший місяць запуску, ми приймаємо оплату прямим переказом.\n\n<b>Що треба зробити зараз:</b>\n1. Перейди за посиланням на Банку Monobank: ${monoLink}\n2. Сплати рівно <b>${data.price} грн</b>.\n3. Зроби скріншот успішної оплати (це важливо).\n4. Надішли цей скріншот прямо сюди, у цей діалог.\n\nЩойно мій помічник побачить скріншот, бот автоматично відкриє тобі доступ. Чекаю.`;
                
                bot.sendMessage(chatId, text, { 
                    parse_mode: 'HTML', 
                    disable_web_page_preview: true,
                    reply_markup: removeKeyboard
                }).catch(e => console.error(e));
            }
        } catch (e) {
            console.error('Помилка парсингу Web App Data:', e);
        }
        return;
    }

    // --- СЦЕНАРІЙ 2: Клієнт надсилає скріншот оплати ---
    if (user.state === 'awaiting_payment_screenshot') {
        if (!msg.photo) {
            bot.sendMessage(chatId, `Будь ласка, надішли саме <b>фото скріншоту</b>, а не текст.`, { parse_mode: 'HTML' });
            return;
        }
        
        bot.sendMessage(chatId, `Скріншот отримано! Перевіряємо...⏳`);
        const photoId = msg.photo[msg.photo.length - 1].file_id;
        
        bot.sendPhoto(adminId, photoId, {
            caption: `💸 <b>Нова оплата!</b>\nКористувач: @${user.username}\nID: <code>${chatId}</code>\nТариф: ${user.pendingTariff}`,
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✅ Підтвердити', callback_data: `approve_${chatId}` },
                        { text: '❌ Відхилити', callback_data: `reject_${chatId}` }
                    ]
                ]
            }
        }).catch(e => console.error(e));
        
        user.state = 'processing_payment'; 
        return;
    }

    // --- СЦЕНАРІЙ 3: Клієнт ставить запитання експерту ---
    if (user.state === 'awaiting_question') {
        user.questionsLeft -= 1;
        user.state = 'active'; 

        bot.sendMessage(chatId, `Твоє питання прийнято. Я зроблю розклад і повернусь з відповіддю протягом 24 годин. \n<i>(Залишилось питань: ${user.questionsLeft})</i>`, { parse_mode: 'HTML' });
        
        bot.sendMessage(adminId, `❓ <b>Питання від клієнта @${user.username}</b>:`, { parse_mode: 'HTML' });
        bot.forwardMessage(adminId, chatId, msg.message_id).then(() => {
            bot.sendMessage(adminId, `Натисни кнопку нижче, щоб відповісти:`, {
                reply_markup: {
                    inline_keyboard: [[{ text: '🎙 Відповісти клієнту', callback_data: `replyto_${chatId}` }]]
                }
            });
        }).catch(e => console.error(e));
        return;
    }

    // --- СЦЕНАРІЙ 4: Адмін відповідає клієнту ---
    if (chatId.toString() === adminId.toString() && user.state === 'replying_to_client') {
        const targetId = user.replyTarget;
        
        bot.sendMessage(targetId, `✨ <b>Відповідь від Валерії:</b>`, { parse_mode: 'HTML' }).catch(e => console.error(e));
        bot.copyMessage(targetId, adminId, msg.message_id).then(() => {
            bot.sendMessage(adminId, `✅ Відповідь успішно надіслана клієнту.`);
            user.state = 'active'; 
            delete user.replyTarget;
        }).catch(err => {
            bot.sendMessage(adminId, `❌ Помилка: Клієнт заблокував бота або видалив чат.`);
            user.state = 'active';
        });
        return;
    }

    // --- СЦЕНАРІЙ 5: Адмін створює "Карту Дня" ---
    if (chatId.toString() === adminId.toString() && user.state === 'creating_card') {
        scheduledCards.push(msg.message_id);
        bot.sendMessage(adminId, `Карта збережена! Що робимо?`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🚀 Розіслати прямо зараз', callback_data: 'schedule_card_now' }]
                ]
            }
        });
        user.state = 'active';
        return;
    }
});

// ==========================================
// 3. ОБРОБКА НАТИСКАНЬ КНОПОК
// ==========================================
bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const user = getUser(query);

    // Знімаємо "вічне завантаження" з кнопок
    bot.answerCallbackQuery(query.id).catch(e => console.error(e));

    // Клієнт тисне "Задати питання"
    if (data === 'ask_question') {
        if (user.questionsLeft > 0) {
            user.state = 'awaiting_question';
            bot.sendMessage(chatId, `Я слухаю тебе. Напиши своє питання одним повідомленням (можна текстом, можна аудіо) і надішли сюди.`);
        } else {
            bot.sendMessage(chatId, `Ліміт питань на цей місяць вичерпано. Чекай на Карту Дня завтра!`);
        }
    }

    // Адмін підтверджує оплату
    if (data.startsWith('approve_')) {
        const targetUserId = data.split('_')[1];
        const targetUser = usersDB[targetUserId];

        if (targetUser && targetUser.pendingTariff) {
            targetUser.state = 'active';
            targetUser.tariff = targetUser.pendingTariff;
            targetUser.questionsLeft = (targetUser.tariff === 'Фокус') ? 0 : 4; 

            bot.sendMessage(adminId, `✅ Оплату користувача ${targetUserId} підтверджено.`).catch(e => console.error(e));
            
            let successText = `<b>Гроші прийшли, доступ відкрито.</b> Вітаю тебе в полі.\n\nЗ завтрашнього ранку тобі почне приходити Карта Дня.`;
            let keyboard = [];
            
            if (targetUser.questionsLeft > 0) {
                successText += `\n\n<b>Як задати мені особисте питання:</b>\nВнизу екрана в тебе з'явилася кнопка «Задати питання». Натискай її та опиши ситуацію. Я зроблю розклад і повернусь до тебе з голосовим повідомленням.`;
                keyboard = [[{ text: `Задати питання (Залишилось: ${targetUser.questionsLeft}) 🔮`, callback_data: 'ask_question' }]];
            }

            bot.sendMessage(targetUserId, successText, { 
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: keyboard }
            }).catch(e => console.error(e));
            
            targetUser.pendingTariff = null; // Очищуємо кеш
        }
    }

    // Адмін відхиляє оплату
    if (data.startsWith('reject_')) {
        const targetUserId = data.split('_')[1];
        bot.sendMessage(adminId, `❌ Оплату відхилено.`);
        bot.sendMessage(targetUserId, `На жаль, ми не змогли підтвердити твою оплату. Перевір скріншот або напиши в підтримку.`);
    }

    // Адмін тисне "Відповісти клієнту"
    if (data.startsWith('replyto_')) {
        const targetUserId = data.split('_')[1];
        usersDB[adminId] = usersDB[adminId] || {};
        usersDB[adminId].state = 'replying_to_client';
        usersDB[adminId].replyTarget = targetUserId;
        bot.sendMessage(adminId, `🎙 Запиши голосове або напиши текст для клієнта. Воно буде надіслане від імені бота.`);
    }

    // Адмін розсилає Карту Дня
    if (data === 'schedule_card_now') {
        if (scheduledCards.length === 0) return;
        const msgId = scheduledCards[0];
        
        let sentCount = 0;
        for (const [userId, userData] of Object.entries(usersDB)) {
            // Розсилаємо тільки тим, хто оплатив (state === 'active') або тестувальникам
            if (userData.state === 'active' || userId.toString() === adminId.toString()) {
                bot.copyMessage(userId, adminId, msgId).catch(e => console.error(`Не вдалося надіслати: ${userId}`));
                sentCount++;
            }
        }
        bot.sendMessage(adminId, `✅ Карту розіслано клієнтам (Успішно: ${sentCount}).`);
        scheduledCards = [];
    }
});

// ==========================================
// 4. КОМАНДА /admin (ТІЛЬКИ ДЛЯ АДМІНА)
// ==========================================
bot.onText(/\/admin/, (msg) => {
    if (msg.chat.id.toString() !== adminId.toString()) return;
    
    const user = getUser(msg);
    user.state = 'creating_card';
    bot.sendMessage(adminId, `🔮 <b>Створення Карти Дня</b>\n\nНадішли сюди фото з текстом, кружечок або аудіо. Це повідомлення буде розіслано всім клієнтам з активною підпискою.`, { parse_mode: 'HTML' });
});

// ==========================================
// 5. HTTP СЕРВЕР (Щоб Render не вимикав бота)
// ==========================================
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Mini App Bot is running online!');
}).listen(process.env.PORT || 3000);

console.log('🔮 Бот "Кишеньковий Провідник" + Web App успішно запущені!');