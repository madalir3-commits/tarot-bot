// ==========================================
// 💾 ШАР РОБОТИ З БАЗОЮ ДАНИХ (Supabase / PostgreSQL)
// ==========================================
// Замінює in-memory usersDB. Дані переживають рестарти Render.
//
// Перед запуском створи в Supabase таблиці (SQL Editor → виконай):
//
// create table if not exists users (
//   id            bigint primary key,
//   username      text,
//   state         text default 'start',
//   tariff        text,
//   questions_left integer default 0,
//   pending_tariff text,
//   reply_target  bigint,
//   updated_at    timestamptz default now()
// );
//
// create table if not exists scheduled_cards (
//   id          bigserial primary key,
//   message_id  bigint not null,
//   created_at  timestamptz default now()
// );
//
// create table if not exists daily_cards (
//   day            date primary key,
//   status         text default 'pending',  -- pending | ready | broadcasted
//   card_1_photo   text,
//   card_1_voice   text,
//   card_2_photo   text,
//   card_2_voice   text,
//   card_3_photo   text,
//   card_3_voice   text,
//   created_at     timestamptz default now()
// );
//
// alter table users add column if not exists last_pick_date date;

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error(
        '❌ Відсутні SUPABASE_URL або SUPABASE_SERVICE_KEY у змінних середовища. ' +
        'Бот не може стартувати без бази даних.'
    );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Локальний in-memory кеш для швидкого доступу в межах одного процесу.
// База залишається джерелом правди; кеш — лише оптимізація читання.
const cache = new Map();

/**
 * Повертає користувача за chatId. Якщо немає в кеші — читає з БД.
 * Якщо немає в БД — створює новий запис (і в БД, і в кеші).
 */
async function getUser(chatId, defaults = {}) {
    const id = Number(chatId);

    if (cache.has(id)) {
        return cache.get(id);
    }

    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('id', id)
        .maybeSingle();

    if (error) {
        console.error('DB error (getUser select):', error.message);
        throw error;
    }

    if (data) {
        const user = normalizeUser(data);
        cache.set(id, user);
        return user;
    }

    // Новий користувач
    const newUser = {
        id,
        username: defaults.username || 'Без_ніка',
        state: 'start',
        tariff: null,
        questionsLeft: 0,
        pendingTariff: null,
        replyTarget: null,
        lastPickDate: null,
    };

    const { error: insertError } = await supabase.from('users').insert({
        id: newUser.id,
        username: newUser.username,
        state: newUser.state,
        tariff: newUser.tariff,
        questions_left: newUser.questionsLeft,
        pending_tariff: newUser.pendingTariff,
        reply_target: newUser.replyTarget,
        last_pick_date: newUser.lastPickDate,
    });

    if (insertError) {
        // Race condition: рядок для цього id вже існує в БД (наприклад, інший
        // паралельний виклик getUser щойно його створив, або Telegram надіслав
        // те саме повідомлення двічі через нестабільний polling). Перш це
        // мовчки кешувало порожній newUser і ЗАТИРАЛО реальні дані з БД
        // (включно з активною підпискою!) при наступному saveUser — критичний
        // баг. Тепер натомість дійсно перечитуємо з БД, як і обіцяв коментар.
        console.error('DB error (getUser insert):', insertError.message);

        const { data: retryData, error: retryError } = await supabase
            .from('users')
            .select('*')
            .eq('id', id)
            .maybeSingle();

        if (!retryError && retryData) {
            const user = normalizeUser(retryData);
            cache.set(id, user);
            return user;
        }

        // Якщо навіть повторне читання не дало результату — це вже не race
        // condition, а реальна проблема з БД. Прокидаємо помилку нагору, щоб
        // викликаючий код не продовжував працювати з фантомними порожніми
        // даними користувача.
        console.error('DB error (getUser retry select):', retryError && retryError.message);
        throw insertError;
    }

    cache.set(id, newUser);
    return newUser;
}

/**
 * Зберігає (частково оновлює) користувача в БД і кеші.
 * patch — об'єкт з полями для оновлення (camelCase, як у JS-об'єкті користувача).
 */
async function saveUser(chatId, patch) {
    const id = Number(chatId);
    const current = cache.get(id) || (await getUser(id));
    const updated = { ...current, ...patch, id };
    cache.set(id, updated);

    const row = {
        username: updated.username,
        state: updated.state,
        tariff: updated.tariff,
        questions_left: updated.questionsLeft,
        pending_tariff: updated.pendingTariff,
        reply_target: updated.replyTarget,
        last_pick_date: updated.lastPickDate,
        updated_at: new Date().toISOString(),
    };

    const { error } = await supabase.from('users').update(row).eq('id', id);

    if (error) {
        console.error('DB error (saveUser update):', error.message);
        throw error;
    }

    return updated;
}

/**
 * Повертає всіх користувачів (потрібно для розсилки Карти Дня).
 * Для MVP-масштабу (сотні-тисячі юзерів) повний select прийнятний.
 */
async function getAllUsers() {
    const { data, error } = await supabase.from('users').select('*');

    if (error) {
        console.error('DB error (getAllUsers):', error.message);
        throw error;
    }

    return (data || []).map(normalizeUser);
}

/**
 * Додає message_id картки дня в черзі на розсилку.
 */
async function pushScheduledCard(messageId) {
    const { error } = await supabase
        .from('scheduled_cards')
        .insert({ message_id: messageId });

    if (error) {
        console.error('DB error (pushScheduledCard):', error.message);
        throw error;
    }
}

/**
 * Повертає всі картки в черзі (відсортовані за часом створення).
 */
async function getScheduledCards() {
    const { data, error } = await supabase
        .from('scheduled_cards')
        .select('*')
        .order('created_at', { ascending: true });

    if (error) {
        console.error('DB error (getScheduledCards):', error.message);
        throw error;
    }

    return data || [];
}

/**
 * Очищує черзу карток (після успішної розсилки).
 */
async function clearScheduledCards() {
    const { error } = await supabase
        .from('scheduled_cards')
        .delete()
        .neq('id', -1); // видалити всі рядки

    if (error) {
        console.error('DB error (clearScheduledCards):', error.message);
        throw error;
    }
}

function normalizeUser(row) {
    return {
        id: Number(row.id),
        username: row.username || 'Без_ніка',
        state: row.state || 'start',
        tariff: row.tariff || null,
        questionsLeft: row.questions_left ?? 0,
        pendingTariff: row.pending_tariff || null,
        replyTarget: row.reply_target ? Number(row.reply_target) : null,
        lastPickDate: row.last_pick_date || null,
    };
}

// ==========================================
// 🔮 КАРТИ ДНЯ (daily_cards)
// ==========================================

/**
 * Повертає сьогоднішню дату у форматі YYYY-MM-DD (UTC).
 * Узгоджено використовується і для cron, і для збереження вибору клієнта.
 */
function todayKey() {
    return new Date().toISOString().slice(0, 10);
}

/**
 * Повертає сьогоднішній набір карт дня, або null якщо ще не створений.
 */
async function getTodayCards() {
    const { data, error } = await supabase
        .from('daily_cards')
        .select('*')
        .eq('day', todayKey())
        .maybeSingle();

    if (error) {
        console.error('DB error (getTodayCards):', error.message);
        throw error;
    }

    return data ? normalizeDailyCards(data) : null;
}

/**
 * Створює (якщо не існує) порожній запис карт дня на сьогодні зі статусом 'pending'.
 * Викликається, коли адмін починає процес підготовки карт.
 */
async function ensureTodayCardsRow() {
    const existing = await getTodayCards();
    if (existing) return existing;

    const { data, error } = await supabase
        .from('daily_cards')
        .insert({ day: todayKey(), status: 'pending' })
        .select('*')
        .single();

    if (error) {
        console.error('DB error (ensureTodayCardsRow):', error.message);
        throw error;
    }

    return normalizeDailyCards(data);
}

/**
 * Зберігає фото або голосове для конкретної картки (1, 2 або 3) сьогоднішнього набору.
 * field: 'photo' | 'voice'
 */
async function saveCardSlot(slotIndex, field, fileId) {
    if (![1, 2, 3].includes(slotIndex) || !['photo', 'voice'].includes(field)) {
        throw new Error(`Невірні параметри saveCardSlot: slotIndex=${slotIndex}, field=${field}`);
    }

    const column = `card_${slotIndex}_${field}`;
    const { error } = await supabase
        .from('daily_cards')
        .update({ [column]: fileId })
        .eq('day', todayKey());

    if (error) {
        console.error('DB error (saveCardSlot):', error.message);
        throw error;
    }
}

/**
 * Позначає сьогоднішній набір карт як 'ready' (всі 3 фото+голосові завантажені).
 */
async function markTodayCardsReady() {
    const { error } = await supabase
        .from('daily_cards')
        .update({ status: 'ready' })
        .eq('day', todayKey());

    if (error) {
        console.error('DB error (markTodayCardsReady):', error.message);
        throw error;
    }
}

/**
 * Позначає сьогоднішній набір як 'broadcasted' (розсилку клієнтам уже виконано).
 * Викликається після успішної розсилки, щоб повторні cron-виклики нічого не дублювали.
 */
async function markTodayCardsBroadcasted() {
    const { error } = await supabase
        .from('daily_cards')
        .update({ status: 'broadcasted' })
        .eq('day', todayKey());

    if (error) {
        console.error('DB error (markTodayCardsBroadcasted):', error.message);
        throw error;
    }
}

function normalizeDailyCards(row) {
    return {
        day: row.day,
        status: row.status || 'pending',
        cards: [
            { photo: row.card_1_photo || null, voice: row.card_1_voice || null },
            { photo: row.card_2_photo || null, voice: row.card_2_voice || null },
            { photo: row.card_3_photo || null, voice: row.card_3_voice || null },
        ],
    };
}

module.exports = {
    getUser,
    saveUser,
    getAllUsers,
    pushScheduledCard,
    getScheduledCards,
    clearScheduledCards,
    todayKey,
    getTodayCards,
    ensureTodayCardsRow,
    saveCardSlot,
    markTodayCardsReady,
    markTodayCardsBroadcasted,
};
