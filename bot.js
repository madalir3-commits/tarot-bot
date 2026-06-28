const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const db = require('./db');
const { validateInitData } = require('./verifyTelegramWebApp');

// ==========================================
// ⚙️ НАЛАШТУВАННЯ
// ==========================================
// Усі секрети ОБОВ'ЯЗКОВО задаються через Environment Variables на Render.
// Локально — створи файл .env (дивись .env.example) і запускай через
// `node -r dotenv/config bot.js`, або експортуй змінні в shell.

const token = process.env.BOT_TOKEN;
const adminId = process.env.ADMIN_ID;
// MONO_LINK — посилання на сторінку оплати. Незважаючи на назву змінної,
// сюди можна вставити посилання БУДЬ-ЯКОГО банку чи платіжної системи
// (Monobank, ПриватБанк, Wayforpay тощо) — бот просто вставляє цей рядок
// у текст повідомлення клієнту, не перевіряючи, який саме банк це.
const monoLink = process.env.MONO_LINK || 'https://send.monobank.ua/jar/ТВОЯ_БАНКА';
const webAppUrl = process.env.WEBAPP_URL || 'https://delightful-choux-edcff2.netlify.app';
const cardsWebAppUrl = process.env.CARDS_WEBAPP_URL || `${webAppUrl}/cards.html`;
const cronSecret = process.env.CRON_SECRET;

// Fail-fast: без цих змінних бот не повинен навіть пробувати стартувати.
// Краще явна помилка зараз, ніж незрозумілий збій авторизації пізніше.
const REQUIRED_ENV = ['BOT_TOKEN', 'ADMIN_ID', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'CRON_SECRET'];
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length > 0) {
    console.error(`❌ Відсутні обов'язкові змінні середовища: ${missing.join(', ')}`);
    console.error('Бот зупинено. Задай ці змінні на Render (Settings → Environment) і перезапусти.');
    process.exit(1);
}

const ADMIN_ID_NUM = Number(adminId);

const bot = new TelegramBot(token, { polling: true });

// Тарифи описуємо на сервері — джерело правди для ціни/назви,
// а не довільні дані, що приходять з клієнта.
// ВАЖЛИВО: ці значення мають синхронно збігатись з кнопками в index.html
// (назва тарифу й ціна), інакше клієнт побачить одну ціну в Mini App,
// а бот попросить сплатити іншу.
const TARIFFS = {
    'Фокус': { price: 590, questions: 0 },
    'Провідник': { price: 2500, questions: 4 },
    'Катарсис': { price: 5000, questions: 4 },
    // 'Катарсис' додатково включає 1 годину Zoom-консультації —
    // це поза межами бота, узгоджується адміном вручну після оплати.
};

// Локальний кеш-черга карток дня в пам'яті процесу для швидкого доступу
// під час однієї адмін-сесії; персиститься в БД через db.pushScheduledCard.

function isAdmin(chatId) {
    return Number(chatId) === ADMIN_ID_NUM;
}

// ==========================================
// 1. КОМАНДА /start (КЛІЄНТ)
// ==========================================
bot.onText(/\/start/, async (msg) => {
    try {
        const chatId = msg.chat.id;
        const user = await db.getUser(chatId, { username: msg.chat.username });
        await db.saveUser(chatId, { state: 'start', username: msg.chat.username || user.username });

        const text = `<b>Привіт. Я — Валерія.</b>\n\nЯкщо ти тут, значить, зараз тобі потрібні відповіді або просто опора. Я не буду обіцяти магічних таблеток чи того, що завтра твоє життя зміниться по клацанню пальців. Але я можу дати тобі інструмент, який підсвітить сліпі зони і покаже, куди рухатись далі.\n\nТисни на кнопку нижче, щоб відкрити <b>Кишеньковий Провідник</b> та обрати свій формат взаємодії.`;

        await bot.sendMessage(chatId, text, {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [
                    [{ text: 'Відкрити Провідник 🔮', web_app: { url: webAppUrl } }],
                ],
                resize_keyboard: true,
            },
        });
    } catch (err) {
        console.error('Помилка обробки /start:', err.message);
    }
});

// ==========================================
// 2. ОБРОБКА ДАНИХ З MINI APP ТА ПОВІДОМЛЕНЬ
// ==========================================
bot.on('message', async (msg) => {
    try {
        const chatId = msg.chat.id;

        // Ігноруємо команди — вони мають власні onText-хендлери.
        if (msg.text && msg.text.startsWith('/')) return;

        const user = await db.getUser(chatId, { username: msg.chat.username });

        // --- СЦЕНАРІЙ 1: Отримуємо дані з Mini App (index.html) ---
        if (msg.web_app_data) {
            await handleWebAppData(chatId, msg.web_app_data.data);
            return;
        }

        // --- СЦЕНАРІЙ 2: Клієнт надсилає скріншот оплати ---
        if (user.state === 'awaiting_payment_screenshot') {
            await handlePaymentScreenshot(chatId, user, msg);
            return;
        }

        // --- СЦЕНАРІЙ 3: Клієнт ставить запитання експерту ---
        if (user.state === 'awaiting_question') {
            await handleClientQuestion(chatId, user, msg);
            return;
        }

        // --- СЦЕНАРІЙ 4: Адмін відповідає клієнту ---
        if (isAdmin(chatId) && user.state === 'replying_to_client') {
            await handleAdminReply(chatId, user, msg);
            return;
        }

        // --- СЦЕНАРІЙ 5: Адмін створює "Карту Дня" (стара довільна розсилка) ---
        if (isAdmin(chatId) && user.state === 'creating_card') {
            await handleAdminCreateCard(chatId, msg);
            return;
        }

        // --- СЦЕНАРІЙ 6: Адмін завантажує 3 карти дня (фото/голосові по черзі) ---
        if (isAdmin(chatId) && user.state && user.state.startsWith('awaiting_card_')) {
            await handleAdminCardUpload(chatId, user, msg);
            return;
        }
    } catch (err) {
        console.error('Помилка обробки message:', err.message);
    }
});

async function handleWebAppData(chatId, rawData) {
    let payload;
    try {
        payload = JSON.parse(rawData);
    } catch (e) {
        console.error('Помилка парсингу Web App Data:', e.message);
        return;
    }

    if (payload.action === 'buy_tariff') {
        await handleBuyTariff(chatId, payload);
    } else if (payload.action === 'pick_daily_card') {
        await handlePickDailyCard(chatId, payload);
    }
}

/**
 * Спільна верифікація initData для будь-якої дії з Mini App.
 * Повертає verification.data при успіху, або null (і сама надсилає
 * повідомлення про помилку клієнту) при невдачі.
 */
async function verifyWebAppRequest(chatId, payload) {
    if (!payload.initData) {
        console.error(`⚠️ web_app_data без initData від chatId=${chatId} — відхилено.`);
        await bot.sendMessage(
            chatId,
            'Виникла технічна помилка перевірки. Спробуй, будь ласка, ще раз або напиши /start.'
        ).catch(() => {});
        return null;
    }

    const verification = validateInitData(payload.initData, token);
    if (!verification.valid) {
        console.error(`⚠️ Невалідний initData від chatId=${chatId}: ${verification.reason}`);
        await bot.sendMessage(
            chatId,
            'Не вдалося підтвердити запит. Спробуй відкрити Провідник ще раз.'
        ).catch(() => {});
        return null;
    }

    const verifiedUserId = verification.data.user && verification.data.user.id;
    if (verifiedUserId && Number(verifiedUserId) !== Number(chatId)) {
        console.error(`⚠️ Розбіжність user.id у initData (${verifiedUserId}) та chatId (${chatId}).`);
        return null;
    }

    return verification.data;
}

async function handleBuyTariff(chatId, payload) {
    // --- Верифікація підпису Telegram WebApp (захист від підробки тарифу/ціни) ---
    // Mini App повинна надсилати initData разом з payload:
    //   Telegram.WebApp.sendData(JSON.stringify({
    //     action: 'buy_tariff',
    //     tariff: 'Провідник',
    //     initData: Telegram.WebApp.initData
    //   }))
    const verified = await verifyWebAppRequest(chatId, payload);
    if (!verified) return;

    // --- Ціна й назва тарифу беруться ТІЛЬКИ з сервера, ніколи з клієнта ---
    const tariffKey = payload.tariff;
    const tariffDef = TARIFFS[tariffKey];

    if (!tariffDef) {
        console.error(`⚠️ Невідомий тариф "${tariffKey}" від chatId=${chatId}.`);
        await bot.sendMessage(chatId, 'Обраний тариф не знайдено. Спробуй ще раз через Провідник.');
        return;
    }

    await db.saveUser(chatId, {
        state: 'awaiting_payment_screenshot',
        pendingTariff: tariffKey,
    });

    const text = `Чудово. Тариф «${tariffKey}».\n\nОскільки це перший місяць запуску, ми приймаємо оплату прямим переказом.\n\n<b>Що треба зробити зараз:</b>\n1. Перейди за посиланням для оплати: ${monoLink}\n2. Сплати рівно <b>${tariffDef.price} грн</b>.\n3. Зроби скріншот успішної оплати (це важливо).\n4. Надішли цей скріншот прямо сюди, у цей діалог.\n\nЩойно мій помічник побачить скріншот, бот автоматично відкриє тобі доступ. Чекаю.`;

    await bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { remove_keyboard: true },
    });
}

/**
 * Клієнт обрав одну з 3 карт дня в Mini App.
 * payload: { action: 'pick_daily_card', cardIndex: 0|1|2, initData }
 */
async function handlePickDailyCard(chatId, payload) {
    const verified = await verifyWebAppRequest(chatId, payload);
    if (!verified) return;

    const cardIndex = Number(payload.cardIndex);
    if (![0, 1, 2].includes(cardIndex)) {
        console.error(`⚠️ Невірний cardIndex "${payload.cardIndex}" від chatId=${chatId}.`);
        return;
    }

    const user = await db.getUser(chatId);
    const today = db.todayKey();

    // Захист від повторного вибору тим самим клієнтом у той же день
    if (user.lastPickDate === today) {
        await bot.sendMessage(
            chatId,
            'Ти вже обрав(-ла) карту на сьогодні. Повертайся завтра за новим розкладом! 🔮'
        );
        return;
    }

    const todayCards = await db.getTodayCards();
    if (!todayCards || todayCards.status === 'pending') {
        await bot.sendMessage(chatId, 'Карти дня ще не готові. Спробуй трохи пізніше.');
        return;
    }

    const chosenCard = todayCards.cards[cardIndex];
    if (!chosenCard || !chosenCard.voice) {
        console.error(`⚠️ Відсутнє голосове для cardIndex=${cardIndex} на ${today}.`);
        await bot.sendMessage(chatId, 'Виникла технічна помилка. Напиши, будь ласка, в підтримку.');
        return;
    }

    await db.saveUser(chatId, { lastPickDate: today });

    if (chosenCard.photo) {
        await bot.sendPhoto(chatId, chosenCard.photo, { caption: '🔮 Твоя карта на сьогодні' });
    }

    // Голосове могло бути збережене як voice або video_note — пробуємо обидва варіанти,
    // оскільки бот не зберігав тип, лише file_id (Telegram сам розрізняє за змістом file_id).
    try {
        await bot.sendVoice(chatId, chosenCard.voice);
    } catch (e) {
        await bot.sendVideoNote(chatId, chosenCard.voice).catch((e2) => {
            console.error('Не вдалося надіслати голосове картки:', e2.message);
        });
    }
}

async function handlePaymentScreenshot(chatId, user, msg) {
    if (!msg.photo) {
        await bot.sendMessage(chatId, `Будь ласка, надішли саме <b>фото скріншоту</b>, а не текст.`, {
            parse_mode: 'HTML',
        });
        return;
    }

    await bot.sendMessage(chatId, `Скріншот отримано! Перевіряємо...⏳`);
    const photoId = msg.photo[msg.photo.length - 1].file_id;

    await bot.sendPhoto(adminId, photoId, {
        caption: `💸 <b>Нова оплата!</b>\nКористувач: @${escapeHtml(user.username)}\nID: <code>${chatId}</code>\nТариф: ${escapeHtml(user.pendingTariff || '—')}`,
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '✅ Підтвердити', callback_data: `approve_${chatId}` },
                    { text: '❌ Відхилити', callback_data: `reject_${chatId}` },
                ],
            ],
        },
    });

    await db.saveUser(chatId, { state: 'processing_payment' });
}

async function handleClientQuestion(chatId, user, msg) {
    const questionsLeft = Math.max(0, (user.questionsLeft || 0) - 1);
    await db.saveUser(chatId, { state: 'active', questionsLeft });

    await bot.sendMessage(
        chatId,
        `Твоє питання прийнято. Я зроблю розклад і повернусь з відповіддю протягом 24 годин. \n<i>(Залишилось питань: ${questionsLeft})</i>`,
        { parse_mode: 'HTML' }
    );

    await bot.sendMessage(adminId, `❓ <b>Питання від клієнта @${escapeHtml(user.username)}</b>:`, {
        parse_mode: 'HTML',
    });
    await bot.forwardMessage(adminId, chatId, msg.message_id);
    await bot.sendMessage(adminId, `Натисни кнопку нижче, щоб відповісти:`, {
        reply_markup: {
            inline_keyboard: [[{ text: '🎙 Відповісти клієнту', callback_data: `replyto_${chatId}` }]],
        },
    });
}

async function handleAdminReply(adminChatId, adminUser, msg) {
    const targetId = adminUser.replyTarget;

    if (!targetId) {
        await bot.sendMessage(adminChatId, '⚠️ Не вдалося визначити, кому адресована відповідь.');
        await db.saveUser(adminChatId, { state: 'active' });
        return;
    }

    try {
        await bot.sendMessage(targetId, `✨ <b>Відповідь від Валерії:</b>`, { parse_mode: 'HTML' });
        await bot.copyMessage(targetId, adminId, msg.message_id);
        await bot.sendMessage(adminChatId, `✅ Відповідь успішно надіслана клієнту.`);
    } catch (err) {
        await bot.sendMessage(adminChatId, `❌ Помилка: Клієнт заблокував бота або видалив чат.`);
    } finally {
        await db.saveUser(adminChatId, { state: 'active', replyTarget: null });
    }
}

async function handleAdminCreateCard(adminChatId, msg) {
    await db.pushScheduledCard(msg.message_id);
    await bot.sendMessage(adminChatId, `Карта збережена! Що робимо?`, {
        reply_markup: {
            inline_keyboard: [[{ text: '🚀 Розіслати прямо зараз', callback_data: 'schedule_card_now' }]],
        },
    });
    await db.saveUser(adminChatId, { state: 'active' });
}

// ==========================================
// 3. ОБРОБКА НАТИСКАНЬ КНОПОК
// ==========================================
bot.on('callback_query', async (query) => {
    try {
        const chatId = query.message.chat.id;
        const data = query.data;

        await bot.answerCallbackQuery(query.id).catch((e) => console.error(e.message));

        // --- Дії клієнта ---
        if (data === 'ask_question') {
            await handleAskQuestion(chatId);
            return;
        }

        // --- Дії, доступні ВИКЛЮЧНО адміну ---
        const adminOnlyPrefixes = ['approve_', 'reject_', 'replyto_'];
        const isAdminOnlyAction =
            adminOnlyPrefixes.some((p) => data.startsWith(p)) || data === 'schedule_card_now';

        if (isAdminOnlyAction && !isAdmin(chatId)) {
            console.error(`⚠️ Спроба виклику адмін-дії "${data}" від chatId=${chatId} (не адмін).`);
            return;
        }

        if (data.startsWith('approve_')) {
            await handleApprove(data);
        } else if (data.startsWith('reject_')) {
            await handleReject(data);
        } else if (data.startsWith('replyto_')) {
            await handleReplyTo(data);
        } else if (data === 'schedule_card_now') {
            await handleScheduleCardNow();
        }
    } catch (err) {
        console.error('Помилка обробки callback_query:', err.message);
    }
});

async function handleAskQuestion(chatId) {
    const user = await db.getUser(chatId);

    if (user.questionsLeft > 0) {
        await db.saveUser(chatId, { state: 'awaiting_question' });
        await bot.sendMessage(
            chatId,
            `Я слухаю тебе. Напиши своє питання одним повідомленням (можна текстом, можна аудіо) і надішли сюди.`
        );
    } else {
        await bot.sendMessage(chatId, `Ліміт питань на цей місяць вичерпано. Чекай на Карту Дня завтра!`);
    }
}

async function handleApprove(data) {
    const targetUserId = data.split('_')[1];
    const targetUser = await db.getUser(targetUserId);

    if (!targetUser.pendingTariff) {
        await bot.sendMessage(adminId, `⚠️ У користувача ${targetUserId} немає тарифу в очікуванні.`);
        return;
    }

    const tariffDef = TARIFFS[targetUser.pendingTariff];
    const questionsLeft = tariffDef ? tariffDef.questions : 0;

    await db.saveUser(targetUserId, {
        state: 'active',
        tariff: targetUser.pendingTariff,
        questionsLeft,
        pendingTariff: null,
    });

    await bot.sendMessage(adminId, `✅ Оплату користувача ${targetUserId} підтверджено.`);

    let successText = `<b>Гроші прийшли, доступ відкрито.</b> Вітаю тебе в полі.\n\nЗ завтрашнього ранку тобі почне приходити Карта Дня.`;
    let keyboard = [];

    if (questionsLeft > 0) {
        successText += `\n\n<b>Як задати мені особисте питання:</b>\nВнизу екрана в тебе з'явилася кнопка «Задати питання». Натискай її та опиши ситуацію. Я зроблю розклад і повернусь до тебе з голосовим повідомленням.`;
        keyboard = [[{ text: `Задати питання (Залишилось: ${questionsLeft}) 🔮`, callback_data: 'ask_question' }]];
    }

    await bot.sendMessage(targetUserId, successText, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard },
    });
}

async function handleReject(data) {
    const targetUserId = data.split('_')[1];
    await db.saveUser(targetUserId, { pendingTariff: null, state: 'start' });
    await bot.sendMessage(adminId, `❌ Оплату відхилено.`);
    await bot.sendMessage(
        targetUserId,
        `На жаль, ми не змогли підтвердити твою оплату. Перевір скріншот або напиши в підтримку.`
    );
}

async function handleReplyTo(data) {
    const targetUserId = data.split('_')[1];
    await db.saveUser(adminId, { state: 'replying_to_client', replyTarget: Number(targetUserId) });
    await bot.sendMessage(adminId, `🎙 Запиши голосове або напиши текст для клієнта. Воно буде надіслане від імені бота.`);
}

async function handleScheduleCardNow() {
    const cards = await db.getScheduledCards();
    if (cards.length === 0) return;

    const msgId = cards[0].message_id;
    const allUsers = await db.getAllUsers();

    let sentCount = 0;
    for (const userData of allUsers) {
        if (userData.state === 'active' || isAdmin(userData.id)) {
            try {
                await bot.copyMessage(userData.id, adminId, msgId);
                sentCount++;
            } catch (e) {
                console.error(`Не вдалося надіслати картку дня: ${userData.id} — ${e.message}`);
            }
        }
    }

    await bot.sendMessage(adminId, `✅ Карту розіслано клієнтам (Успішно: ${sentCount}).`);
    await db.clearScheduledCards();
}

// ==========================================
// 4. КОМАНДА /admin (ТІЛЬКИ ДЛЯ АДМІНА)
// ==========================================
bot.onText(/\/admin/, async (msg) => {
    try {
        if (!isAdmin(msg.chat.id)) return;

        await db.saveUser(msg.chat.id, { state: 'creating_card' });
        await bot.sendMessage(
            adminId,
            `🔮 <b>Створення Карти Дня</b>\n\nНадішли сюди фото з текстом, кружечок або аудіо. Це повідомлення буде розіслано всім клієнтам з активною підпискою.`,
            { parse_mode: 'HTML' }
        );
    } catch (err) {
        console.error('Помилка обробки /admin:', err.message);
    }
});

// ==========================================
// 4b. КОМАНДА /cards — ПІДГОТОВКА 3 КАРТ ДНЯ (ТІЛЬКИ ДЛЯ АДМІНА)
// ==========================================
// Покроковий сценарій: фото карти 1 → голосове карти 1 → фото карти 2 → ...
// Стейти: awaiting_card_1_photo, awaiting_card_1_voice, awaiting_card_2_photo, ...
const CARD_STEPS = [
    { slot: 1, field: 'photo', state: 'awaiting_card_1_photo', next: 'awaiting_card_1_voice', prompt: 'Надішли <b>фото</b> першої карти дня (лицьова сторона).' },
    { slot: 1, field: 'voice', state: 'awaiting_card_1_voice', next: 'awaiting_card_2_photo', prompt: 'Тепер запиши <b>голосове</b> або кружечок з тлумаченням першої карти.' },
    { slot: 2, field: 'photo', state: 'awaiting_card_2_photo', next: 'awaiting_card_2_voice', prompt: 'Надішли <b>фото</b> другої карти дня.' },
    { slot: 2, field: 'voice', state: 'awaiting_card_2_voice', next: 'awaiting_card_3_photo', prompt: 'Тепер голосове для другої карти.' },
    { slot: 3, field: 'photo', state: 'awaiting_card_3_photo', next: 'awaiting_card_3_voice', prompt: 'Надішли <b>фото</b> третьої карти дня.' },
    { slot: 3, field: 'voice', state: 'awaiting_card_3_voice', next: null, prompt: 'І нарешті — голосове для третьої карти.' },
];

bot.onText(/\/cards/, async (msg) => {
    try {
        if (!isAdmin(msg.chat.id)) return;

        const existing = await db.getTodayCards();
        if (existing && existing.status !== 'pending') {
            await bot.sendMessage(
                adminId,
                `Карти на сьогодні вже ${existing.status === 'ready' ? 'готові' : 'розіслані'}. Завтра зможеш підготувати новий набір.`
            );
            return;
        }

        await db.ensureTodayCardsRow();
        await db.saveUser(adminId, { state: CARD_STEPS[0].state });
        await bot.sendMessage(adminId, `🔮 <b>Підготовка карт дня</b>\n\n${CARD_STEPS[0].prompt}`, {
            parse_mode: 'HTML',
        });
    } catch (err) {
        console.error('Помилка обробки /cards:', err.message);
    }
});

async function handleAdminCardUpload(adminChatId, adminUser, msg) {
    const step = CARD_STEPS.find((s) => s.state === adminUser.state);
    if (!step) return;

    let fileId = null;

    if (step.field === 'photo') {
        if (!msg.photo) {
            await bot.sendMessage(adminChatId, 'Будь ласка, надішли саме фото (не текст, не файл).');
            return;
        }
        fileId = msg.photo[msg.photo.length - 1].file_id;
    } else {
        // Приймаємо або voice (голосове), або video_note (кружечок)
        if (msg.voice) {
            fileId = msg.voice.file_id;
        } else if (msg.video_note) {
            fileId = msg.video_note.file_id;
        } else {
            await bot.sendMessage(adminChatId, 'Будь ласка, надішли голосове повідомлення або кружечок.');
            return;
        }
    }

    await db.saveCardSlot(step.slot, step.field, fileId);

    if (step.next) {
        const nextStep = CARD_STEPS.find((s) => s.state === step.next);
        await db.saveUser(adminChatId, { state: step.next });
        await bot.sendMessage(adminChatId, `✅ Збережено.\n\n${nextStep.prompt}`, { parse_mode: 'HTML' });
    } else {
        // Останній крок — позначаємо готовність і повертаємо адміна в активний стан
        await db.markTodayCardsReady();
        await db.saveUser(adminChatId, { state: 'active' });
        await bot.sendMessage(
            adminChatId,
            `🎉 <b>Усі 3 карти дня готові!</b>\n\nРозсилка клієнтам відбудеться автоматично в найближче вікно (9:00 / 9:15 / 9:30).`,
            { parse_mode: 'HTML' }
        );
    }
}

// ==========================================
// 5. ГЛОБАЛЬНА ОБРОБКА ПОМИЛОК POLLING
// ==========================================
bot.on('polling_error', (err) => {
    console.error('Polling error:', err.message);
});

// ==========================================
// 6. ЕКРАНУВАННЯ HTML ДЛЯ TELEGRAM (захист від зламу розмітки)
// ==========================================
function escapeHtml(str) {
    if (typeof str !== 'string') return str;
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ==========================================
// 7. CRON ENDPOINTS (нагадування адміну + розсилка карт дня)
// ==========================================
// Викликаються зовнішнім cron-job.org за розкладом:
//   /cron/remind?key=...    — о 7:00, нагадування адміну підготувати карти
//   /cron/broadcast?key=... — о 9:00, 9:15, 9:30, розсилка готових карт клієнтам
//
// Авторизація — простий секретний токен у query-параметрі ?key=,
// який порівнюється з CRON_SECRET зі змінних середовища.

async function handleCronRemind() {
    const today = await db.getTodayCards();

    // Якщо карти вже готові або вже розіслані — нагадування не потрібне.
    if (today && today.status !== 'pending') {
        return { ok: true, skipped: true, reason: `status=${today.status}` };
    }

    await bot.sendMessage(
        adminId,
        `⏰ <b>Доброго ранку!</b>\n\nЧас підготувати 3 карти дня для клієнтів. Напиши /cards, щоб почати завантаження фото й голосових.`,
        { parse_mode: 'HTML' }
    ).catch((e) => console.error('Помилка надсилання нагадування:', e.message));

    return { ok: true, skipped: false };
}

async function handleCronBroadcast() {
    const today = await db.getTodayCards();

    if (!today || today.status !== 'ready') {
        // Карти або ще не готові, або вже розіслані (idempotent — повторний
        // виклик cron-job.org у те саме вікно нічого не зламає).
        return { ok: true, skipped: true, reason: today ? `status=${today.status}` : 'no row' };
    }

    const allUsers = await db.getAllUsers();
    let sentCount = 0;

    for (const userData of allUsers) {
        if (userData.state !== 'active') continue;
        try {
            await bot.sendMessage(
                userData.id,
                `🔮 <b>Карти дня готові!</b>\n\nВідкрий Провідник і обери одну з трьох карт — я розповім, що вона означає для тебе сьогодні.`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        keyboard: [[{ text: 'Відкрити Провідник 🔮', web_app: { url: cardsWebAppUrl } }]],
                        resize_keyboard: true,
                    },
                }
            );
            sentCount++;
        } catch (e) {
            console.error(`Не вдалося розіслати карти дня: ${userData.id} — ${e.message}`);
        }
    }

    await db.markTodayCardsBroadcasted();

    await bot.sendMessage(adminId, `✅ Карти дня розіслані клієнтам (Успішно: ${sentCount}).`).catch(() => {});

    return { ok: true, skipped: false, sentCount };
}

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

http
    .createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);

        // Легкий ендпоінт спеціально для keep-alive пінгів (cron-job.org тощо).
        // Мінімальна відповідь без заголовків/тексту, щоб точно не впиратись
        // у будь-які ліміти розміру відповіді на стороні пінгувального сервісу.
        if (url.pathname === '/ping') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('ok');
            return;
        }

        if (url.pathname === '/cron/remind' || url.pathname === '/cron/broadcast') {
            const key = url.searchParams.get('key');
            if (key !== cronSecret) {
                console.error(`⚠️ Спроба викликати ${url.pathname} з невірним key.`);
                sendJson(res, 401, { ok: false, error: 'unauthorized' });
                return;
            }

            const handler = url.pathname === '/cron/remind' ? handleCronRemind : handleCronBroadcast;
            handler()
                .then((result) => sendJson(res, 200, result))
                .catch((err) => {
                    console.error(`Помилка ${url.pathname}:`, err.message);
                    sendJson(res, 500, { ok: false, error: err.message });
                });
            return;
        }

        res.writeHead(200);
        res.end('Mini App Bot is running online!');
    })
    .listen(process.env.PORT || 3000);

console.log('🔮 Бот "Кишеньковий Провідник" + Web App успішно запущені!');
