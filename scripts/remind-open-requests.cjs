// Usage (on the server, from the backend folder):
//   node scripts/remind-open-requests.cjs --env .env                      dry run, prints what would be sent
//   node scripts/remind-open-requests.cjs --env .env --only 5184047336    dry run for one manager (telegram id)
//   node scripts/remind-open-requests.cjs --env .env --only 5184047336 --send
//   node scripts/remind-open-requests.cjs --env .env --send               every active manager
//   add --group to also post a summary of unconfirmed orders to the «Оплати» topic
// Options: --days N (cards newer than N days, default 60)
const { Client } = require('pg');
const path = require('path');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

require('dotenv').config({ path: path.resolve(opt('env') ?? '.env'), quiet: true });

const SEND = flag('send');
const ONLY = opt('only');
const DAYS = Number(opt('days') ?? 60);
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MINI_APP_URL = process.env.MINI_APP_URL;
const ADMIN_CHAT = process.env.TELEGRAM_ADMIN_CHAT_ID;
const PAYMENTS_TOPIC = process.env.TELEGRAM_TOPIC_PAYMENTS_ID;
const CHUNK = 8;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const webApp = (text, mode, id) => {
  const url = new URL(MINI_APP_URL);
  url.searchParams.set('mode', mode);
  url.searchParams.set('id', id);
  return { text, web_app: { url: url.toString() } };
};

async function tg(method, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (json.ok) return json.result;
    if (json.error_code === 429) {
      await sleep((json.parameters?.retry_after ?? 5) * 1000 + 500);
      continue;
    }
    throw new Error(`${json.error_code}: ${json.description}`);
  }
  throw new Error('rate limited');
}

function itemOf(card) {
  const label = `#${card.number}${card.client ? ` · ${esc(card.client)}` : ''}`;
  if (!card.completed_at) {
    if (card.notified_status === 'accepted' || card.notified_status === 'paid') {
      return { line: `✅ ${label}: фінансист прийняв, потрібно оформити`, button: webApp(`✅ Оформити #${card.number}`, 'complete', card.request_id) };
    }
    return { line: `⏳ ${label}: чекає відповіді фінансиста` };
  }
  const nums = card.nums.length ? ` (№ ${esc(card.nums.join(', '))})` : '';
  return { line: `💰 ${label}${nums}: оформлено, оплата не завершена`, button: webApp(`➕ Додати оплату #${card.number}`, 'paid', card.request_id) };
}

(async () => {
  if (!TOKEN || !MINI_APP_URL) throw new Error('TELEGRAM_BOT_TOKEN and MINI_APP_URL must be set in the env file');
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query('set default_transaction_read_only = on');
  console.log(`DB: ${new URL(process.env.DATABASE_URL).pathname.slice(1)} | mode: ${SEND ? 'SEND' : 'DRY RUN'}${ONLY ? ` | only ${ONLY}` : ''}`);

  const { rows } = await db.query(
    `select c.request_id, c.number, c.notified_status, c.completed_at, m.telegram_id::text tg, m.name mname,
            coalesce(array_agg(o.order_number order by o.id) filter (where o.id is not null), '{}') nums,
            min(o.client_name) client
       from finance_request_cards c
       join managers m on m.id = c.manager_id and m.status = 'ACTIVE'
       left join orders o on o.id = any(c.order_ids)
      where c.closed_at is null
        and coalesce(c.notified_status, '') <> 'cancelled'
        and c.created_at > now() - make_interval(days => $1)
      group by c.request_id, m.id
      order by m.id, c.created_at`,
    [DAYS],
  );

  const byManager = new Map();
  for (const row of rows) {
    if (ONLY && row.tg !== ONLY) continue;
    if (!byManager.has(row.tg)) byManager.set(row.tg, { name: row.mname, items: [] });
    byManager.get(row.tg).items.push(itemOf(row));
  }

  let sent = 0, failed = 0;
  for (const [chatId, { name, items }] of byManager) {
    console.log(`\n${name} (${chatId}): ${items.length} item(s)`);
    for (let i = 0; i < items.length; i += CHUNK) {
      const part = items.slice(i, i + CHUNK);
      const head = i === 0 ? `<b>Відкриті запити (${items.length})</b>\nНатисніть кнопку, щоб завершити:\n` : '<b>Продовження</b>\n';
      const text = `${head}\n${part.map((x) => x.line).join('\n')}`;
      const keyboard = part.filter((x) => x.button).map((x) => [x.button]);
      console.log(part.map((x) => `  ${x.line}`).join('\n'));
      if (!SEND) continue;
      try {
        await tg('sendMessage', { chat_id: Number(chatId), text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: keyboard.length ? { inline_keyboard: keyboard } : undefined });
        sent++;
      } catch (e) {
        failed++;
        console.log(`  FAILED: ${e.message}`);
      }
      await sleep(120);
    }
  }

  if (flag('group')) {
    const un = await db.query(
      `select order_number, client_name, status from orders
        where verified_at is null and status not in ('CANCELLED', 'AWAITING_PAYMENT')
          and created_at > now() - make_interval(days => $1) order by id`,
      [DAYS],
    );
    console.log(`\nUnconfirmed orders with payments: ${un.rowCount}`);
    if (un.rowCount && SEND) {
      const lines = un.rows.slice(0, 40).map((o) => `• ${esc(o.order_number)} · ${esc(o.client_name)}`);
      const more = un.rowCount > 40 ? `\n… і ще ${un.rowCount - 40}` : '';
      await tg('sendMessage', {
        chat_id: Number(ADMIN_CHAT),
        message_thread_id: PAYMENTS_TOPIC ? Number(PAYMENTS_TOPIC) : undefined,
        text: `<b>Не підтверджені замовлення (${un.rowCount})</b>\n${lines.join('\n')}${more}`,
        parse_mode: 'HTML',
      });
      sent++;
    }
  }

  console.log(`\n${SEND ? `Sent ${sent} message(s), ${failed} failed` : 'Dry run: nothing sent. Add --send to send.'}`);
  await db.end();
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
