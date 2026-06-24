const TelegramBot = require('node-telegram-bot-api');

// Встав сюди свій токен, який видасть @BotFather
const token = process.env.BOT_TOKEN || 'ТВІЙ_ТОКЕН_БОТА';

// ID Валерії, куди будуть падати скріншоти та питання
const adminId = process.env.ADMIN_ID || 'ТВІЙ_ТЕЛЕГРАМ_ID'; 
const monoLink = 'https://send.monobank.ua/jar/ТВОЯ_БАНКА';

// Ініціалізація бота
const bot = new TelegramBot(token, { polling: true });

// Тимчасова база даних у пам'яті (для MVP). 
const usersDB = {};

// Допоміжна функція для отримання/створення користувача
function getUser(msg) {
    const chatId = msg.chat.id.toString();
    if (!usersDB[chatId]) {
        usersDB[chatId] = {
            id: chatId,
            username: msg.chat.username,
            state: 'start', 
            tariff: null,
            questionsLeft: 0,
            broadcastMsgId: null
        };
    }
    return usersDB[chatId];
}

// Функція безпосередньої розсилки
function doBroadcast(fromChatId, messageId) {
    let count = 0;
    for (const id in usersDB) {
        const u = usersDB[id];
        // Розсилаємо тільки тим, хто має оплачений тариф
        if (u.tariff) {
            // copyMessage дозволяє пересилати повідомлення без плашки "Переслано від..."
            bot.copyMessage(u.id, fromChatId, messageId)
               .catch(err => console.error(`Помилка розсилки для ${u.id} (можливо, бот заблокований):`, err.message));
            count++;
        }
    }
    bot.sendMessage(adminId, `✅ Розсилку "Карти Дня" завершено. Отримали клієнтів: ${count}.`).catch(console.error);
}

// Функція планування розсилки на 09:00 ранку
function scheduleBroadcast(fromChatId, messageId) {
    const now = new Date();
    let targetTime = new Date(now);
    
    // Встановлюємо 09:00 ранку (ВАЖЛИВО: На сервері Render треба вказати змінну середовища TZ = Europe/Kiev)
    targetTime.setHours(9, 0, 0, 0); 

    // Якщо зараз вже після 9:00, плануємо на завтрашній ранок
    if (now.getTime() > targetTime.getTime()) {
        targetTime.setDate(targetTime.getDate() + 1);
    }

    const msUntilBroadcast = targetTime.getTime() - now.getTime();
    
    bot.sendMessage(adminId, `⏳ Розсилка запланована. Вона запуститься автоматично через ${Math.round(msUntilBroadcast / 1000 / 60 / 60)} годин.`).catch(console.error);

    setTimeout(() => {
        bot.sendMessage(adminId, '⏰ Запускаю автоматичну розсилку запланованої "Карти Дня"...').catch(console.error);
        doBroadcast(fromChatId, messageId);
    }, msUntilBroadcast);
}

// АДМІНКА: Головне меню для Валерії
bot.onText(/\/admin/, (msg) => {
    const chatId = msg.chat.id.toString();
    if (chatId !== adminId.toString()) return; // Доступ ТІЛЬКИ для адміна

    bot.sendMessage(adminId, '🎛 **Панель керування Провідника**', {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '📢 Створити Карту Дня', callback_data: 'admin_create_broadcast' }]
            ]
        }
    }).catch(console.error);
});

// Команда /start (Привітання + Лід-магніт)
bot.onText(/\/start/, (msg) => {
    // Працюємо тільки в приватних чатах
    if (msg.chat.type !== 'private') return;

    const user = getUser(msg);
    user.state = 'start';
    
    const text = `Привіт. Я — Валерія. \n\nЯкщо ти тут, значить, зараз тобі потрібні відповіді або просто опора. Я не буду обіцяти магічних таблеток чи того, що завтра твоє життя зміниться по клацанню пальців. Але я можу дати тобі інструмент, який підсвітить сліпі зони і покаже, куди рухатись далі.\n\nТримай свою Карту Тижня. \n\nПрочитай, видихни і подумай, як це відгукується саме в твоїй ситуації. Якщо відчуєш, що тобі потрібна моя підтримка на постійній основі, щоб не губити фокус щодня — тисни кнопку нижче.`;

    const photoUrl = 'https://images.unsplash.com/photo-1633519418659-1e3034fb81f3?auto=format&fit=crop&w=800&q=80';
    
    bot.sendPhoto(user.id, photoUrl, {
        caption: text,
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Дізнатись про підписку 🔮', callback_data: 'offer_info' }]
            ]
        }
    }).catch(console.error);
});

// Обробка натискань на кнопки (Inline клавіатура)
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id.toString();
    const data = query.data;
    const user = getUser(query.message);

    // ОБОВ'ЯЗКОВО: Зупиняємо "годинник" завантаження на кнопці
    try {
        await bot.answerCallbackQuery(query.id);
    } catch (e) { console.error('Помилка answerCallbackQuery:', e.message); }

    // АДМІНКА: Натискання "Створити Карту Дня"
    if (data === 'admin_create_broadcast') {
        user.state = 'awaiting_broadcast_content';
        bot.sendMessage(adminId, '📸 Надішли сюди контент для "Карти Дня" одним повідомленням (фото з текстом, аудіо, або відео-кружечок).').catch(console.error);
        return;
    }

    // АДМІНКА: Вибір часу розсилки
    if (data === 'broadcast_now' || data === 'broadcast_tomorrow') {
        const msgIdToBroadcast = user.broadcastMsgId;
        user.state = 'active'; // Скидаємо стан адміна
        
        // Прибираємо кнопки вибору часу
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: adminId, message_id: query.message.message_id }).catch(console.error);

        if (data === 'broadcast_now') {
            bot.sendMessage(adminId, '🚀 Розпочинаю розсилку прямо зараз...').catch(console.error);
            doBroadcast(adminId, msgIdToBroadcast);
        } else {
            scheduleBroadcast(adminId, msgIdToBroadcast);
        }
        return;
    }

    // Показуємо тарифи
    if (data === 'offer_info') {
        const text = `Одна карта — це добре, щоб трохи зняти тривожність тут і зараз. Але справжні зміни потребують системи.\n\nМоя разова консультація коштує 2000 грн. Тому я створила цей закритий простір — «Кишеньковий Провідник». Це формат підписки, де ти знаходишся в моєму полі цілий місяць.\n\nОбирай свій формат:`;
        
        bot.sendMessage(chatId, text, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Тариф «Фокус» (590 грн)', callback_data: 'buy_focus' }],
                    [{ text: 'Тариф «Провідник» (2500 грн)', callback_data: 'buy_guide' }],
                    [{ text: 'Тариф «Катарсис» (5000 грн)', callback_data: 'buy_vip' }]
                ]
            }
        }).catch(console.error);
        return;
    }

    // Реакція на вибір тарифу
    if (data.startsWith('buy_')) {
        let price = 0;
        let tariffName = '';
        let tariffId = '';
        
        if (data === 'buy_focus') { price = 590; tariffName = 'Фокус'; tariffId = 'focus'; }
        if (data === 'buy_guide') { price = 2500; tariffName = 'Провідник'; tariffId = 'guide'; }
        if (data === 'buy_vip') { price = 5000; tariffName = 'Катарсис'; tariffId = 'vip'; }

        user.state = 'awaiting_payment_screenshot';
        user.pendingTariff = tariffName;
        user.pendingTariffId = tariffId;

        const text = `Чудово. Тариф «${tariffName}».\n\nОскільки це перший місяць запуску, ми приймаємо оплату прямим переказом.\n\n**Що треба зробити зараз:**\n1. Перейди за посиланням на Банку Monobank: ${monoLink}\n2. Сплати рівно **${price} грн**.\n3. Зроби скріншот успішної оплати (це важливо).\n4. Надішли цей скріншот прямо сюди, у цей діалог.\n\nЩойно мій помічник побачить скріншот, бот автоматично відкриє тобі доступ. Чекаю.`;
        
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }).catch(console.error);
        return;
    }

    // АДМІНКА: Підтвердження оплати
    if (data.startsWith('approve_')) {
        const parts = data.split('_');
        const targetUserId = parts[1];
        const targetTariffId = parts[2];
        const targetUser = usersDB[targetUserId];

        if (targetUser) {
            targetUser.state = 'active';
            targetUser.tariff = targetTariffId;
            // Видаємо ліміт питань залежно від тарифу (Фокус = 0, інші = 4)
            targetUser.questionsLeft = (targetTariffId === 'focus') ? 0 : 4; 

            bot.sendMessage(adminId, `✅ Оплату користувача ${targetUserId} підтверджено. Доступ відкрито.`).catch(console.error);
            bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: adminId, message_id: query.message.message_id }).catch(console.error);

            // Повідомлення користувачу про успіх
            let successText = `Гроші прийшли, доступ відкрито. Вітаю тебе в полі.\n\nЗ завтрашнього ранку тобі почне приходити Карта Дня.`;
            
            let keyboard = [];
            if (targetUser.questionsLeft > 0) {
                successText += `\n\n**Як задати мені особисте питання:**\nВнизу екрана в тебе з'явилася кнопка «Задати питання». Натискай її, опиши ситуацію чесно і без води. Я зроблю розклад і повернусь до тебе з голосовим повідомленням (зазвичай до 24 годин).`;
                keyboard = [[{ text: `Задати питання (Залишилось: ${targetUser.questionsLeft}) 🔮`, callback_data: 'ask_question' }]];
            }

            bot.sendMessage(targetUserId, successText, { 
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            }).catch(console.error);
        }
        return;
    }

    // АДМІНКА: Відхилення оплати
    if (data.startsWith('reject_')) {
        const targetUserId = data.split('_')[1];
        bot.sendMessage(adminId, `❌ Оплату відхилено.`).catch(console.error);
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: adminId, message_id: query.message.message_id }).catch(console.error);
        bot.sendMessage(targetUserId, `На жаль, ми не змогли підтвердити твою оплату. Перевір скріншот або напиши в підтримку.`).catch(console.error);
        return;
    }

    // АДМІНКА: Натискання кнопки "Відповісти клієнту"
    if (data.startsWith('replyto_')) {
        const targetUserId = data.split('_')[1];
        const adminUser = getUser(query.message);
        
        adminUser.state = `replying_to_${targetUserId}`;
        bot.sendMessage(adminId, `🎤 Запиши голосове або напиши текст для відповіді. Наступне твоє повідомлення буде автоматично переслано клієнту.`).catch(console.error);
        return;
    }

    // Користувач натискає "Задати питання"
    if (data === 'ask_question') {
        if (user.questionsLeft > 0) {
            user.state = 'awaiting_question';
            bot.sendMessage(chatId, `Я слухаю тебе. Напиши своє питання одним повідомленням (можна текстом, можна аудіо) і надішли сюди.`).catch(console.error);
        } else {
            bot.sendMessage(chatId, `Ліміт питань на цей місяць вичерпано. Чекай на Карту Дня завтра!`).catch(console.error);
        }
        return;
    }
});

// Обробка вхідних повідомлень (Скріншоти, Питання, Відповіді, Розсилка)
bot.on('message', (msg) => {
    // Ігноруємо технічні повідомлення
    if (!msg.text && !msg.photo && !msg.voice && !msg.video_note && !msg.video && !msg.document) return;

    const chatId = msg.chat.id.toString();
    const user = getUser(msg);

    // АДМІНКА: Отримання контенту для "Карти Дня"
    if (chatId === adminId.toString() && user.state === 'awaiting_broadcast_content') {
        user.broadcastMsgId = msg.message_id; // Запам'ятовуємо ID повідомлення
        user.state = 'awaiting_broadcast_schedule'; 
        
        bot.sendMessage(adminId, '✅ Контент отримано. Коли відправляємо клієнтам?', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🚀 Розіслати зараз', callback_data: 'broadcast_now' }],
                    [{ text: '⏳ Запланувати на ранок (09:00)', callback_data: 'broadcast_tomorrow' }]
                ]
            }
        }).catch(console.error);
        return;
    }

    // АДМІНКА: Відповідь експерта користувачу
    if (chatId === adminId.toString() && user.state && user.state.startsWith('replying_to_')) {
        const targetUserId = user.state.split('replying_to_')[1];
        
        bot.copyMessage(targetUserId, adminId, msg.message_id)
            .then(() => {
                bot.sendMessage(adminId, `✅ Відповідь успішно доставлена клієнту!`).catch(console.error);
                user.state = 'active'; // Скидаємо стан
                
                // Нагадуємо клієнту про залишок питань
                const targetUser = usersDB[targetUserId];
                if (targetUser && targetUser.questionsLeft > 0) {
                    bot.sendMessage(targetUserId, `*(У тебе залишилось питань на цей місяць: ${targetUser.questionsLeft})*`, {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: `Задати питання 🔮`, callback_data: 'ask_question' }]] }
                    }).catch(console.error);
                }
            })
            .catch((err) => {
                bot.sendMessage(adminId, `❌ Помилка відправки. Можливо, клієнт заблокував бота.`).catch(console.error);
            });
        return;
    }

    // КЛІЄНТ: Відправка скріншота оплати
    if (user.state === 'awaiting_payment_screenshot') {
        if (msg.photo || msg.document) { // Дозволяємо і фото, і файли (якщо PDF квитанція)
            const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
            
            bot.sendMessage(chatId, `Скріншот отримано! Перевіряємо...⏳`).catch(console.error);
            
            // Відправляємо адміну
            bot.sendPhoto(adminId, fileId, {
                caption: `💸 **Нова оплата!**\nКористувач: @${msg.chat.username || 'Без ніка'}\nТариф: ${user.pendingTariff}`,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✅ Підтвердити', callback_data: `approve_${chatId}_${user.pendingTariffId}` },
                            { text: '❌ Відхилити', callback_data: `reject_${chatId}` }
                        ]
                    ]
                }
            }).catch(console.error);
            
            user.state = 'processing_payment'; 
        } else {
            bot.sendMessage(chatId, `❌ Будь ласка, надішли саме фотографію (скріншот) квитанції про оплату.`).catch(console.error);
        }
        return;
    }

    // КЛІЄНТ: Відправка питання експерту
    if (user.state === 'awaiting_question') {
        user.questionsLeft -= 1; 
        user.state = 'active'; 

        bot.sendMessage(chatId, `Твоє питання прийнято. Я зроблю розклад і повернусь з відповіддю протягом 24 годин.`).catch(console.error);
        
        // Пересилаємо питання адміну
        bot.sendMessage(adminId, `❓ **Нове питання від @${msg.chat.username || 'Клієнта'}:**`, {parse_mode: 'Markdown'}).catch(console.error);
        bot.forwardMessage(adminId, chatId, msg.message_id).catch(console.error);
        
        bot.sendMessage(adminId, `Натисни кнопку нижче, щоб записати відповідь:`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🎙 Відповісти клієнту', callback_data: `replyto_${chatId}` }]
                ]
            }
        }).catch(console.error);
        return;
    }
});

// Перехоплення помилок мережі (щоб бот не відключався)
bot.on('polling_error', (error) => {
    console.error('Помилка підключення до Telegram:', error.message);
});

console.log('🔮 Бот "Кишеньковий Провідник" успішно запущений і готовий до роботи!');
const http = require('http');
http.createServer((req, res) => res.end('Bot is running')).listen(process.env.PORT || 3000);