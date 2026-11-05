import type {
  FinanceFops,
  FinanceRequestView,
} from '../../../src/modules/finance-sync/finance.types';
import {
  FinanceAction,
  acceptRefusal,
  groupCard,
  managerCard,
  myRequestsReply,
} from '../../../src/modules/finance-sync/request-card.messages';

const ID = 'cmabcdefghij0123456789xyz';

const view = (patch: Partial<FinanceRequestView> = {}): FinanceRequestView => ({
  id: ID,
  number: '42',
  status: 'pending',
  kind: 'our_fop',
  sum: '5500',
  orderNumber: null,
  orders: [
    { orderNumber: '0000-1', amount: '3000', exchangeRate: null },
    { orderNumber: '0000-2', amount: '2500', exchangeRate: null },
  ],
  exchangeRate: '41.5',
  comment: null,
  officialDocs: true,
  clientLabel: null,
  sheetUrl: null,
  withPercent: null,
  isPaid: false,
  requestDate: '2026-11-03T10:00:00.000Z',
  responseDate: null,
  cancelledAt: null,
  fopLabel: null,
  responderName: null,
  payouts: [],
  warnings: [],
  managerChatId: 1,
  groupChatId: -100,
  groupMessageId: 5,
  ...patch,
});

const fops = (patch: Partial<FinanceFops> = {}): FinanceFops => ({
  limitsEnabled: true,
  limitsStatus: 'ok',
  project: 'P',
  fops: [
    { fopId: 1, label: 'ФОП А', leftMonthWithReserve: '120000' },
    { fopId: 2, label: 'ФОП Б', leftMonthWithReserve: null },
    { fopId: 3, label: 'ФОП В', leftMonthWithReserve: '900.5' },
  ],
  ...patch,
});

const rows = (r: { buttons?: unknown[][] }) =>
  (r.buttons ?? []) as { text: string; callback_data: string }[][];
const flat = (r: { buttons?: unknown[][] }) => rows(r).flat();

describe('groupCard', () => {
  it('pending our_fop: both rows, total, FOP buttons that fit the sum + rate + refresh', () => {
    const reply = groupCard(view(), fops(), null, 'Іван');
    expect(reply.html).toContain('Наш ФОП');
    expect(reply.html).toContain('#42');
    expect(reply.html).toContain('Іван');
    expect(reply.html).toContain('№ <b>0000-1</b> — 3 000 грн');
    expect(reply.html).toContain('№ <b>0000-2</b> — 2 500 грн');
    expect(reply.html).toContain('5 500 грн');
    expect(reply.html).toContain('Курс: 41,5');
    expect(reply.html).toContain('Офіційні документи: так');
    const buttons = flat(reply);
    expect(buttons.map((b) => b.text)).toEqual([
      'ФОП А · 120 000 грн',
      'ФОП Б · —',
      '✏️ Інший курс',
      '🔄 Оновити',
    ]);
    expect(buttons[0]!.callback_data).toBe(`ff:${ID}:1`);
    expect(buttons[2]!.callback_data).toBe(`fr:${ID}`);
    expect(buttons[3]!.callback_data).toBe(`fu:${ID}`);
  });

  it('keeps every FOP when the limits are unavailable', () => {
    const reply = groupCard(view(), fops({ limitsStatus: 'unavailable' }), null);
    expect(flat(reply).map((b) => b.text)).toContain('ФОП В · 900,50 грн');
  });

  it('keeps a FOP whose limit equals the sum', () => {
    const exact = fops({ fops: [{ fopId: 4, label: 'ФОП Г', leftMonthWithReserve: '5500.00' }] });
    expect(flat(groupCard(view(), exact, null))).toHaveLength(3);
  });

  it('marks pending rate as new', () => {
    expect(groupCard(view(), fops(), '43').html).toContain('Курс: 43 (нова)');
  });

  it('card kind: no FOP buttons, only rate and refresh', () => {
    const reply = groupCard(view({ kind: 'card' }), fops(), null);
    expect(reply.html).toContain('На картку');
    expect(flat(reply).map((b) => b.text)).toEqual(['✏️ Інший курс', '🔄 Оновити']);
  });

  it('no FOP buttons when fops is null; minus keeps them', () => {
    expect(flat(groupCard(view(), null, null))).toHaveLength(2);
    const minus = groupCard(
      view({ kind: 'minus', orders: [], clientLabel: 'Клієнт', sheetUrl: 'https://x.y/?a=1&b=2' }),
      fops(),
      null,
    );
    expect(minus.html).toContain('Закриття мінусу');
    expect(minus.html).toContain('Клієнт');
    expect(minus.html).toContain('https://x.y/?a=1&amp;b=2');
    expect(flat(minus)).toHaveLength(4);
  });

  it('kind labels', () => {
    expect(groupCard(view({ kind: 'foreign_fop' }), null, null).html).toContain('Чужий ФОП');
    expect(groupCard(view({ kind: 'minus', orders: [] }), null, null).html).toContain(
      'Закриття мінусу',
    );
  });

  it('accepted: no buttons, responder, fop, payouts', () => {
    const reply = groupCard(
      view({
        status: 'accepted',
        responderName: 'Фін',
        fopLabel: 'ФОП А',
        payouts: [
          {
            method: 'iban',
            recipientName: 'ТОВ <Ромашка>',
            iban: 'UA12',
            taxId: '123',
            purpose: 'оплата',
            amount: '5500',
            warnings: [],
          },
        ],
      }),
      fops(),
      null,
    );
    expect(reply.buttons ?? []).toEqual([]);
    expect(reply.html).toContain('✅ Прийняв(ла): Фін · ФОП: ФОП А');
    expect(reply.html).toContain('ТОВ &lt;Ромашка&gt;');
    expect(reply.html).toContain('UA12');
    expect(reply.html).toContain('5 500 грн');
  });

  it('paid and cancelled', () => {
    const paid = groupCard(view({ status: 'accepted', isPaid: true }), null, null);
    expect(paid.html).toContain('💰 Оплачено');
    expect(paid.buttons ?? []).toEqual([]);
    const cancelled = groupCard(view({ status: 'cancelled' }), fops(), null);
    expect(cancelled.html).toContain('❌ Скасовано');
    expect(cancelled.buttons ?? []).toEqual([]);
  });

  it('unavailable limits warning', () => {
    const reply = groupCard(view(), fops({ limitsStatus: 'unavailable' }), null);
    expect(reply.html).toContain('⚠️ Залишки ФОП зараз недоступні');
  });

  it('escapes user text', () => {
    const reply = groupCard(view({ comment: '<b>hi</b> & co' }), null, null, '<i>M</i>');
    expect(reply.html).toContain('Коментар: &lt;b&gt;hi&lt;/b&gt; &amp; co');
    expect(reply.html).toContain('&lt;i&gt;M&lt;/i&gt;');
  });
});

describe('warnings', () => {
  const warned = (): FinanceRequestView =>
    view({
      status: 'accepted',
      responderName: 'Фін',
      fopLabel: 'А',
      warnings: ['sum_mismatch', 'multi_order'],
      payouts: [
        {
          method: 'iban',
          recipientName: 'Ромашка',
          iban: 'UA12',
          taxId: null,
          purpose: null,
          amount: '5500',
          warnings: ['iban_invalid', 'card_invalid'],
        },
        {
          method: 'card',
          recipientName: 'Інший',
          iban: null,
          taxId: null,
          purpose: null,
          amount: '1',
          warnings: [],
        },
      ],
    });

  it.each([
    ['groupCard', () => groupCard(warned(), null, null).html],
    ['managerCard', () => managerCard(warned()).html],
  ])('%s shows payout and request warnings, not multi_order', (_name, render) => {
    const lines = render().split('\n');
    const payout = lines.findIndex((l) => l.includes('Ромашка'));
    expect(lines[payout + 1]).toBe('⚠️ IBAN не проходить перевірку');
    expect(lines[payout + 2]).toBe('⚠️ номер картки не проходить перевірку');
    expect(lines[payout + 3]).toContain('Інший');
    expect(lines.at(-1)).toBe('⚠️ сума позицій не збігається із сумою запиту');
    expect(lines.join('\n')).not.toContain('multi_order');
    expect(lines.filter((l) => l.startsWith('⚠️'))).toHaveLength(3);
  });

  it('ignores unknown codes', () => {
    const html = managerCard(view({ warnings: ['future_thing' as never] })).html;
    expect(html).not.toContain('⚠️');
  });
});

describe('managerCard', () => {
  it('pending: cancel button; same body', () => {
    const reply = managerCard(view());
    expect(reply.html).toContain('#42');
    expect(reply.html).toContain('№ <b>0000-1</b>');
    expect(flat(reply)).toEqual([{ text: '✖ Скасувати запит', callback_data: `fc:${ID}` }]);
  });

  it('accepted: no buttons', () => {
    const reply = managerCard(view({ status: 'accepted', responderName: 'Фін', fopLabel: 'А' }));
    expect(reply.buttons ?? []).toEqual([]);
    expect(reply.html).toContain('✅ Прийняв(ла): Фін · ФОП: А');
  });
});

describe('managerCard with the Mini App', () => {
  const miniAppUrl = 'https://cab.example.ua/tg/request';
  const accepted = () => view({ status: 'accepted', responderName: 'Фін', fopLabel: 'А' });
  const all = (reply: { buttons?: unknown[][] }) => rows(reply);

  it('pending: «Змінити» opens the edit form next to «Скасувати запит»', () => {
    const reply = managerCard(view(), { miniAppUrl });

    expect(all(reply)).toEqual([
      [
        { text: '✏️ Змінити', web_app: { url: `${miniAppUrl}?mode=edit&id=${ID}` } },
        { text: '✖ Скасувати запит', callback_data: `fc:${ID}` },
      ],
    ]);
  });

  it('accepted and not completed: «Додати дату» opens the completion form', () => {
    const reply = managerCard(accepted(), { miniAppUrl, completed: false });

    expect(all(reply)).toEqual([
      [{ text: '📎 Додати дату', web_app: { url: `${miniAppUrl}?mode=complete&id=${ID}` } }],
    ]);
  });

  it('encodes the request id and keeps the query already on the URL', () => {
    const reply = managerCard(view({ id: 'a b&c' }), { miniAppUrl: `${miniAppUrl}?lang=uk` });

    const url = (flat(reply)[0] as unknown as { web_app: { url: string } }).web_app.url;
    expect(new URL(url).searchParams.get('id')).toBe('a b&c');
    expect(new URL(url).searchParams.get('lang')).toBe('uk');
    expect(new URL(url).searchParams.get('mode')).toBe('edit');
  });

  it('completed: the «Оформлено» line and none of the three buttons', () => {
    const reply = managerCard(accepted(), {
      miniAppUrl,
      completed: { orderNumbers: ['0000-1', '0000-2'] },
    });

    expect(reply.buttons ?? []).toEqual([]);
    expect(reply.html).toContain('✅ Оформлено: № 0000-1, 0000-2 (2 замовлення)');
  });

  it('completed: one order has no count; no orders has no number', () => {
    const one = managerCard(accepted(), { completed: { orderNumbers: ['0000-1'] } });
    const none = managerCard(accepted(), { completed: { orderNumbers: [] } });

    expect(one.html).toContain('✅ Оформлено: № 0000-1');
    expect(one.html).not.toContain('(1');
    expect(none.html.split('\n').at(-1)).toBe('✅ Оформлено');
  });

  it('completed never shows edit or cancel, even for a pending view', () => {
    const reply = managerCard(view(), { miniAppUrl, completed: { orderNumbers: [] } });

    expect(reply.buttons ?? []).toEqual([]);
  });

  it('cancelled: no buttons', () => {
    expect(managerCard(view({ status: 'cancelled' }), { miniAppUrl }).buttons ?? []).toEqual([]);
  });

  it('without the URL: the cancel button only and no «Додати дату»', () => {
    expect(flat(managerCard(view(), {}))).toEqual([
      { text: '✖ Скасувати запит', callback_data: `fc:${ID}` },
    ]);
    expect(managerCard(accepted(), { completed: false }).buttons ?? []).toEqual([]);
  });

  it('groupCard never carries a web_app button', () => {
    const json = JSON.stringify(groupCard(view(), fops(), null));
    expect(json).not.toContain('web_app');
  });
});

describe('callback data', () => {
  it('every callback fits 64 bytes and matches its pattern', () => {
    const all = [...flat(groupCard(view(), fops(), null)), ...flat(managerCard(view()))].map(
      (b) => b.callback_data,
    );
    expect(all).toHaveLength(5);
    for (const data of all) {
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
    }
    expect(all.some((d) => FinanceAction.Fop.test(d))).toBe(true);
    expect(FinanceAction.Fop.exec(`ff:${ID}:12`)?.slice(1)).toEqual([ID, '12']);
    expect(FinanceAction.Rate.exec(`fr:${ID}`)?.[1]).toBe(ID);
    expect(FinanceAction.Cancel.exec(`fc:${ID}`)?.[1]).toBe(ID);
    expect(FinanceAction.Refresh.exec(`fu:${ID}`)?.[1]).toBe(ID);
  });
});

describe('pending rate on a closed card', () => {
  it('should not show a leftover pending rate once the request is accepted', () => {
    const html = groupCard(view({ status: 'accepted', exchangeRate: '44' }), null, '43').html;

    expect(html).not.toContain('(нова)');
    expect(html).toContain('Курс: 44');
  });
});

describe('acceptRefusal', () => {
  it.each([
    ['fop-limit-exceeded', undefined, 'Сума перевищує залишок цього ФОП'],
    ['fop-foreign-project', { project: 'Alpha' }, 'ФОП іншого проєкту (Alpha)'],
    ['manager-project-unassigned', undefined, 'Менеджеру не призначено проєкт'],
    ['fop-limits-unavailable', undefined, 'Не вдалося перевірити ліміти, спробуйте ще раз'],
    ['already-accepted', undefined, 'Цей запит уже прийнято'],
    ['http-403', undefined, 'Відповідати може лише фінансист'],
    ['payouts-unrecognized', undefined, 'Не розпізнав реквізити'],
    ['whatever', undefined, 'Фінанси не відповіли, спробуйте ще раз'],
  ])('%s', (code, details, text) => {
    expect(acceptRefusal(code, details)).toBe(text);
  });

  it.each([[400], [404], [409], [422]])(
    'should name the code of an unmapped %i refusal instead of saying finance is silent',
    (status) => {
      expect(acceptRefusal('already-closed', undefined, status)).toBe(
        'Фінанси відхилили запит (already-closed)',
      );
    },
  );

  it.each([[0], [500], [502]])('should keep «не відповіли» for status %i', (status) => {
    expect(acceptRefusal('whatever', undefined, status)).toBe(
      'Фінанси не відповіли, спробуйте ще раз',
    );
  });

  it('403 maps via status, and text is capped at 200 chars', () => {
    expect(acceptRefusal('x', undefined, 403)).toBe('Відповідати може лише фінансист');
    expect(
      acceptRefusal('fop-foreign-project', { project: 'я'.repeat(500) }).length,
    ).toBeLessThanOrEqual(200);
  });
});

describe('myRequestsReply', () => {
  const at = new Date('2026-11-05T10:00:00.000Z');
  const listed = (
    number: string,
    notifiedStatus: string | null,
    completedAt: Date | null = null,
  ) => ({
    requestId: `id${number}`,
    number,
    notifiedStatus,
    completedAt,
    createdAt: at,
  });
  const URL = 'https://check.example/tg/request';

  it('puts the accepted, not completed requests first, each with a completion button', () => {
    const reply = myRequestsReply(
      [
        listed('5', null),
        listed('4', 'accepted'),
        listed('3', 'cancelled'),
        listed('2', 'paid', at),
        listed('1', 'paid'),
      ],
      URL,
    );

    expect(reply.html.split('\n')).toEqual([
      '<b>Мої запити</b>',
      '#4 · 05.11.2026 · 📎 прийнято, додайте дату',
      '#1 · 05.11.2026 · 📎 прийнято, додайте дату',
      '#5 · 05.11.2026 · 🕓 чекає фінансиста',
      '#3 · 05.11.2026 · ❌ скасовано',
      '#2 · 05.11.2026 · ✅ оформлено',
    ]);
    const buttons = (reply.buttons ?? []).flat() as { text: string; web_app: { url: string } }[];
    expect(buttons.map((b) => b.text)).toEqual(['📎 Додати дату · #4', '📎 Додати дату · #1']);
    expect(buttons[0]!.web_app.url).toBe(`${URL}?mode=complete&id=id4`);
  });

  it('has no buttons without the Mini App and a hint when there are no requests', () => {
    expect(myRequestsReply([listed('4', 'accepted')]).buttons).toBeUndefined();
    expect(myRequestsReply([]).html).toContain('📝 Новий запит');
  });
});
