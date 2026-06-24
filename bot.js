const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

// ==========================================
// НАСТРОЙКИ (Вставь свои данные для локального теста)
// ==========================================
const token = process.env.BOT_TOKEN || 'ТВІЙ_ТОКЕН_БОТА'; // Замени на свой токен
const adminId = process.env.ADMIN_ID || 'ТВІЙ_ID'; // Замени на свой ID (только цифры)
const monoLink = 'https://send.monobank.ua/jar/ТВОЯ_БАНКА';

const bot = new TelegramBot(token, { polling: true });

// База данных в памяти
const usersDB = {};
let scheduledCards = []; // Очередь для Карт Дня

// Вспомогательная функция
function getUser(msg) {
    const chatId = msg.chat ? msg.chat.id : msg.message.chat.id;
    if (!usersDB[chatId]) {
        usersDB[chatId] = {
            id: chatId,
            username: msg.chat ? msg.chat.username : msg.message.chat.username,
            state: 'start',
            tariff: null,
            questionsLeft: 0,
            pendingTariff: null
        };
    }
    return usersDB[chatId];
}

// ==========================================
// 1. КОМАНДА /start (ОБЫЧНЫЙ ПОЛЬЗОВАТЕЛЬ)
// ==========================================
bot.onText(/\/start/, (msg) => {
    const user = getUser(msg);
    user.state = 'start';
    
    // Используем HTML для надежности (без звездочек Markdown)
    const text = `<b>Привіт. Я — Валерія.</b>\n\nЯкщо ти тут, значить, зараз тобі потрібні відповіді або просто опора. Я не буду обіцяти магічних таблеток чи того, що завтра твоє життя зміниться по клацанню пальців. Але я можу дати тобі інструмент, який підсвітить сліпі зони і покаже, куди рухатись далі.\n\nЯкщо відчуєш, що тобі потрібна моя підтримка на постійній основі, щоб не губити фокус щодня — тисни кнопку нижче.`;

    // Отправляем просто текст (без глючных картинок из интернета)
    bot.sendMessage(user.id, text, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Дізнатись про підписку 🔮', callback_data: 'offer_info' }]
            ]
        }
    }).catch(err => console.log('Ошибка отправки /start:', err.message));
});

// ==========================================
// 2. ОБРАБОТКА НАЖАТИЙ КНОПОК
// ==========================================
bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const user = getUser(query);

    // ОБЯЗАТЕЛЬНО: Отвечаем Telegram, что кнопка нажата (чтобы не было вечной загрузки)
    bot.answerCallbackQuery(query.id).catch(err => console.log(err));

    // Меню тарифов
    if (data === 'offer_info') {
        const text = `Одна карта — це добре, щоб трохи зняти тривожність тут і зараз. Але справжні зміни потребують системи.\n\nМоя разова консультація коштує 2000 грн. Тому я створила цей закритий простір — <b>«Кишеньковий Провідник»</b>. Це формат підписки, де ти знаходишся в моєму полі цілий місяць.\n\nОбирай свій формат:`;
        
        bot.sendMessage(chatId, text, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Тариф «Фокус» (590 грн)', callback_data: 'buy_focus' }],
                    [{ text: 'Тариф «Провідник» (2500 грн)', callback_data: 'buy_guide' }],
                    [{ text: 'Тариф «Катарсис» (5000 грн)', callback_data: 'buy_vip' }]
                ]
            }
        });
    }

    // Выбор тарифа и генерация ссылки на оплату
    if (data.startsWith('buy_')) {
        let price = 0;
        let tariffName = '';
        
        if (data === 'buy_focus') { price = 590; tariffName = 'Фокус'; }
        if (data === 'buy_guide') { price = 2500; tariffName = 'Провідник'; }
        if (data === 'buy_vip') { price = 5000; tariffName = 'Катарсис'; }

        user.state = 'awaiting_payment_screenshot';
        user.pendingTariff = tariffName;

        const text = `Чудово. Тариф «${tariffName}».\n\nОскільки це перший місяць запуску, ми приймаємо оплату прямим переказом.\n\n<b>Що треба зробити зараз:</b>\n1. Перейди за посиланням на Банку Monobank: ${monoLink}\n2. Сплати рівно <b>${price} грн</b>.\n3. Зроби скріншот успішної оплати (це важливо).\n4. Надішли цей скріншот прямо сюди, у цей діалог.\n\nЩойно мій помічник побачить скріншот, бот автоматично відкриє тобі доступ. Чекаю.`;
        
        bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true });
    }

    // Кнопка: Задать вопрос
    if (data === 'ask_question') {
        if (user.questionsLeft > 0) {
            user.state = 'awaiting_question';
            bot.sendMessage(chatId, `Я слухаю тебе. Напиши своє питання одним повідомленням (можна текстом, можна аудіо) і надішли сюди.`);
        } else {
            bot.sendMessage(chatId, `Ліміт питань на цей місяць вичерпано. Чекай на Карту Дня завтра!`);
        }
    }

    // ==========================================
    // ЛОГИКА АДМИНА
    // ==========================================

    // Админ одобряет оплату
    if (data.startsWith('approve_')) {
        const parts = data.split('_');
        const targetUserId = parts[1];
        const targetTariff = parts[2];
        const targetUser = usersDB[targetUserId];

        if (targetUser) {
            targetUser.state = 'active';
            targetUser.tariff = targetTariff;
            targetUser.questionsLeft = (targetTariff === 'Фокус') ? 0 : 4; 

            // Пишем админу, что все ок
            bot.sendMessage(adminId, `✅ Оплату користувача ${targetUserId} підтверджено.`).catch(e=>console.log(e));
            
            // Пишем клиенту, что доступ открыт
            let successText = `<b>Гроші прийшли, доступ відкрито.</b> Вітаю тебе в полі.\n\nЗ завтрашнього ранку тобі почне приходити Карта Дня.`;
            let keyboard = [];
            
            if (targetUser.questionsLeft > 0) {
                successText += `\n\n<b>Як задати мені особисте питання:</b>\nВнизу екрана в тебе з'явилася кнопка «Задати питання». Натискай її, опиши ситуацію. Я зроблю розклад і повернусь до тебе з голосовим повідомленням.`;
                keyboard = [[{ text: `Задати питання (Залишилось: ${targetUser.questionsLeft}) 🔮`, callback_data: 'ask_question' }]];
            }

            bot.sendMessage(targetUserId, successText, { 
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: keyboard }
            }).catch(e=>console.log(e));
        }
    }

    // Админ отклоняет оплату
    if (data.startsWith('reject_')) {
        const targetUserId = data.split('_')[1];
        bot.sendMessage(adminId, `❌ Оплату відхилено.`);
        bot.sendMessage(targetUserId, `На жаль, ми не змогли підтвердити твою оплату. Перевір скріншот або напиши в підтримку.`);
    }

    // Админ нажимает "Ответить клиенту"
    if (data.startsWith('replyto_')) {
        const targetUserId = data.split('_')[1];
        // Включаем режим ответа для админа
        usersDB[adminId] = usersDB[adminId] || {};
        usersDB[adminId].state = 'replying_to_client';
        usersDB[adminId].replyTarget = targetUserId;
        bot.sendMessage(adminId, `🎙 Запиши голосове або напиши текст для клієнта. Воно буде надіслане від імені бота.`);
    }

    // Админ планирует Карту Дня
    if (data === 'schedule_card_now') {
        broadcastCard();
        bot.sendMessage(adminId, `✅ Карту розіслано всім активним клієнтам!`);
        scheduledCards = [];
    }
});

// ==========================================
// 3. ОБРАБОТКА ТЕКСТОВ И ФОТО
// ==========================================
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const user = getUser(msg);

    // Игнорируем команды
    if (msg.text && msg.text.startsWith('/')) return;

    // СЦЕНАРИЙ 1: Клиент присылает скриншот оплаты
    if (user.state === 'awaiting_payment_screenshot') {
        if (!msg.photo) {
            bot.sendMessage(chatId, `Будь ласка, надішли саме <b>фото скріншоту</b>, а не текст.`, { parse_mode: 'HTML' });
            return;
        }
        
        bot.sendMessage(chatId, `Скріншот отримано! Перевіряємо...⏳`);
        const photoId = msg.photo[msg.photo.length - 1].file_id;
        
        // Отправляем админу
        bot.sendPhoto(adminId, photoId, {
            caption: `💸 <b>Нова оплата!</b>\nКористувач: @${user.username || 'Без ніка'} (ID: ${chatId})\nТариф: ${user.pendingTariff}`,
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✅ Підтвердити', callback_data: `approve_${chatId}_${user.pendingTariff}` },
                        { text: '❌ Відхилити', callback_data: `reject_${chatId}` }
                    ]
                ]
            }
        }).catch(e=>console.log(e));
        
        user.state = 'processing_payment'; 
        return;
    }

    // СЦЕНАРИЙ 2: Клиент задает вопрос эксперту
    if (user.state === 'awaiting_question') {
        user.questionsLeft -= 1;
        user.state = 'active'; 

        bot.sendMessage(chatId, `Твоє питання прийнято. Я зроблю розклад і повернусь з відповіддю протягом 24 годин. \n<i>(Залишилось питань: ${user.questionsLeft})</i>`, { parse_mode: 'HTML' });
        
        // Пересылаем вопрос админу
        bot.sendMessage(adminId, `❓ <b>Питання від клієнта @${user.username || chatId}</b>:`, { parse_mode: 'HTML' });
        bot.forwardMessage(adminId, chatId, msg.message_id).then(() => {
            bot.sendMessage(adminId, `Натисни кнопку нижче, щоб відповісти:`, {
                reply_markup: {
                    inline_keyboard: [[{ text: '🎙 Відповісти клієнту', callback_data: `replyto_${chatId}` }]]
                }
            });
        });
        return;
    }

    // СЦЕНАРИЙ 3: Админ отвечает клиенту
    if (chatId.toString() === adminId.toString() && user.state === 'replying_to_client') {
        const targetId = user.replyTarget;
        
        bot.sendMessage(targetId, `✨ <b>Відповідь від Валерії:</b>`, { parse_mode: 'HTML' });
        bot.copyMessage(targetId, adminId, msg.message_id).then(() => {
            bot.sendMessage(adminId, `✅ Відповідь успішно надіслана клієнту.`);
            user.state = 'active'; // Сбрасываем статус админа
            delete user.replyTarget;
        }).catch(err => {
            bot.sendMessage(adminId, `❌ Помилка: Клієнт заблокував бота.`);
            user.state = 'active';
        });
        return;
    }

    // СЦЕНАРИЙ 4: Админ создает "Карту Дня"
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
// 4. КОМАНДА /admin (ТОЛЬКО ДЛЯ АДМИНА)
// ==========================================
bot.onText(/\/admin/, (msg) => {
    if (msg.chat.id.toString() !== adminId.toString()) return;
    
    const user = getUser(msg);
    user.state = 'creating_card';
    bot.sendMessage(adminId, `🔮 <b>Створення Карти Дня</b>\n\nНадішли сюди фото з текстом, кружечок або аудіо. Це повідомлення буде розіслано всім клієнтам.`, { parse_mode: 'HTML' });
});

// ==========================================
// 5. РАССЫЛКА (BROADCAST)
// ==========================================
function broadcastCard() {
    if (scheduledCards.length === 0) return;
    const msgId = scheduledCards[0];
    
    // Рассылаем всем, у кого есть подписка (state === 'active')
    for (const [userId, userData] of Object.entries(usersDB)) {
        if (userData.state === 'active') {
            bot.copyMessage(userId, adminId, msgId).catch(e => console.log(`Не удалось отправить пользователю ${userId}`));
        }
    }
}

// ==========================================
// 6. ЗАГЛУШКА ДЛЯ СЕРВЕРА (Render.com)
// ==========================================
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot is running online!');
}).listen(process.env.PORT || 3000);

console.log('🔮 Бот "Кишеньковий Провідник" успішно запущений і готовий до роботи!');