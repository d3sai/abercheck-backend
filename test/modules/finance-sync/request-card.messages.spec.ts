import type {
  FinanceFops,
  FinanceRequestView,
} from '../../../src/modules/finance-sync/finance.types';
import {
  FinanceAction,
  acceptRefusal,
  groupCard,
  managerCard,
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
  it('pending our_fop: both rows, total, 3 FOP buttons + rate + refresh', () => {
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
      'ФОП В · 900,50 грн',
      '✏️ Інший курс',
      '🔄 Оновити',
    ]);
    expect(buttons[0]!.callback_data).toBe(`ff:${ID}:1`);
    expect(buttons[3]!.callback_data).toBe(`fr:${ID}`);
    expect(buttons[4]!.callback_data).toBe(`fu:${ID}`);
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
    expect(flat(minus)).toHaveLength(5);
  });

  it('kind labels', () => {
    expect(groupCard(view({ kind: 'foreign_fop' }), null, null).html).toContain('Чужий ФОП');
    expect(groupCard(view({ kind: 'dropship', orders: [] }), null, null).html).toContain(
      'Дропшипінг',
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

describe('callback data', () => {
  it('every callback fits 64 bytes and matches its pattern', () => {
    const all = [...flat(groupCard(view(), fops(), null)), ...flat(managerCard(view()))].map(
      (b) => b.callback_data,
    );
    expect(all).toHaveLength(6);
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
