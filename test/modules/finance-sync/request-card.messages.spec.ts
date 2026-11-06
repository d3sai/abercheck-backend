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
const ATTACH = { text: '📎 Прикріпити файли', callback_data: `ma:${ID}` };

describe('groupCard', () => {
  it('pending our_fop: both rows, total, FOP buttons that fit the sum + rate + refresh', () => {
    const reply = groupCard(view(), fops(), 'Іван');
    expect(reply.html).toContain('Наш ФОП');
    expect(reply.html).toContain('#42');
    expect(reply.html).toContain('Іван');
    expect(reply.html).toContain('№ <b>0000-1</b> — 3 000 грн');
    expect(reply.html).toContain('№ <b>0000-2</b> — 2 500 грн');
    expect(reply.html).toContain('5 500 грн');
    expect(reply.html).toContain('Курс: 41,5');
    expect(reply.html).toContain('Офіційні документи: так');
    const buttons = flat(reply);
    expect(buttons.map((b) => b.text)).toEqual(['ФОП А · 120 000 грн', 'ФОП Б · —', '🔄 Оновити']);
    expect(buttons[0]!.callback_data).toBe(`ff:${ID}:1`);
    expect(buttons[2]!.callback_data).toBe(`fu:${ID}`);
  });

  it('keeps every FOP when the limits are unavailable', () => {
    const reply = groupCard(view(), fops({ limitsStatus: 'unavailable' }));
    expect(flat(reply).map((b) => b.text)).toContain('ФОП В · 900,50 грн');
  });

  it('keeps a FOP whose limit equals the sum', () => {
    const exact = fops({ fops: [{ fopId: 4, label: 'ФОП Г', leftMonthWithReserve: '5500.00' }] });
    expect(flat(groupCard(view(), exact))).toHaveLength(2);
  });

  it('card kind: no FOP buttons, only refresh', () => {
    const reply = groupCard(view({ kind: 'card' }), fops());
    expect(reply.html).toContain('На картку');
    expect(flat(reply).map((b) => b.text)).toEqual(['🔄 Оновити']);
  });

  it('no FOP buttons when fops is null; minus keeps them', () => {
    expect(flat(groupCard(view(), null))).toHaveLength(1);
    const minus = groupCard(
      view({ kind: 'minus', orders: [], clientLabel: 'Клієнт', sheetUrl: 'https://x.y/?a=1&b=2' }),
      fops(),
    );
    expect(minus.html).toContain('Закриття мінусу');
    expect(minus.html).toContain('Клієнт');
    expect(minus.html).toContain('https://x.y/?a=1&amp;b=2');
    expect(flat(minus)).toHaveLength(3);
  });

  it('shows official documents only on «Наш ФОП» cards', () => {
    expect(groupCard(view(), null).html).toContain('Офіційні документи: так');
    expect(groupCard(view({ kind: 'card' }), null).html).not.toContain('Офіційні документи');
  });

  it('kind labels', () => {
    expect(groupCard(view({ kind: 'foreign_fop' }), null).html).toContain('Чужий ФОП');
    expect(groupCard(view({ kind: 'minus', orders: [] }), null).html).toContain('Закриття мінусу');
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
    );
    expect(reply.buttons ?? []).toEqual([]);
    expect(reply.html).toContain('✅ Прийняв(ла): Фін · ФОП: ФОП А');
    expect(reply.html).toContain('ТОВ &lt;Ромашка&gt;');
    expect(reply.html).toContain('UA12');
    expect(reply.html).toContain('5 500 грн');
  });

  it('paid and cancelled', () => {
    const paid = groupCard(view({ status: 'accepted', isPaid: true }), null);
    expect(paid.html).toContain('💰 Оплачено');
    expect(paid.buttons ?? []).toEqual([]);
    const cancelled = groupCard(view({ status: 'cancelled' }), fops());
    expect(cancelled.html).toContain('❌ Скасовано');
    expect(cancelled.buttons ?? []).toEqual([]);
  });

  it('unavailable limits warning', () => {
    const reply = groupCard(view(), fops({ limitsStatus: 'unavailable' }));
    expect(reply.html).toContain('⚠️ Залишки ФОП зараз недоступні');
  });

  it('escapes user text', () => {
    const reply = groupCard(view({ comment: '<b>hi</b> & co' }), null, '<i>M</i>');
    expect(reply.html).toContain('Коментар: &lt;b&gt;hi&lt;/b&gt; &amp; co');
    expect(reply.html).toContain('&lt;i&gt;M&lt;/i&gt;');
  });
});

describe('groupCard hints and length', () => {
  it('says no FOP fits when every FOP is filtered out by its limit', () => {
    const tight = fops({ fops: [{ fopId: 1, label: 'ФОП А', leftMonthWithReserve: '100' }] });
    const reply = groupCard(view(), tight);
    expect(reply.html).toContain('Жоден ФОП не вміщує суму — відповідайте «ФОП …»');
    expect(flat(reply).map((b) => b.text)).toEqual(['🔄 Оновити']);
  });

  it('says the balances are unavailable when fops is null on a pending FOP request', () => {
    expect(groupCard(view(), null).html).toContain('Залишки ФОП зараз недоступні');
    expect(groupCard(view(), null).html).not.toContain('Жоден ФОП');
  });

  it('has no FOP hint when a FOP button is shown, for card kind, or when accepted', () => {
    expect(groupCard(view(), fops()).html).not.toContain('ФОП …');
    expect(groupCard(view({ kind: 'card' }), null).html).not.toContain('недоступні');
    expect(groupCard(view({ status: 'accepted' }), null).html).not.toContain('недоступні');
  });

  const payout = (index: number) => ({
    method: 'iban' as const,
    recipientName: `Отримувач ${index} ${'Я'.repeat(30)}`,
    iban: `UA${String(index).padStart(27, '0')}`,
    taxId: '1234567890',
    purpose: 'оплата за послуги '.repeat(2),
    amount: '100',
    warnings: [],
  });

  it('keeps an accepted card with a 4000-char payouts set under 4096 and marks the cut', () => {
    const accepted = view({
      status: 'accepted',
      responderName: 'Фін',
      fopLabel: 'ФОП А',
      isPaid: true,
      comment: 'довгий коментар '.repeat(100),
      payouts: Array.from({ length: 40 }, (_, i) => payout(i)),
    });
    expect(accepted.payouts.map((p) => p.iban).join('').length).toBeGreaterThan(1000);

    for (const html of [
      groupCard(accepted, null, 'Іван').html,
      managerCard(accepted, { completed: { orderNumbers: ['0000-1', '0000-2'] } }).html,
    ]) {
      expect(html.length).toBeLessThan(4096);
      expect(html).toContain('…');
      expect(html).toContain('Отримувач 0');
      expect(html).toContain('💰 Оплачено');
    }
  });

  it('does not mark a cut when all payouts fit', () => {
    const html = groupCard(
      view({ status: 'accepted', payouts: [payout(1), payout(2)] }),
      null,
    ).html;
    expect(html).not.toContain('…');
    expect(html).toContain('Отримувач 2');
  });

  it('cuts a long comment', () => {
    const html = groupCard(view({ comment: 'ы'.repeat(1000) }), fops()).html;
    expect(html.length).toBeLessThan(1000);
    expect(html).toContain('ы…');
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
    ['groupCard', () => groupCard(warned(), null).html],
    ['managerCard', () => managerCard(warned()).html],
  ])('%s shows payout and request warnings, not multi_order', (_name, render) => {
    const lines = render()
      .split('\n')
      .filter((l) => l && !l.startsWith('📎')); // the receipt hint closes the manager card
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

  it('accepted: «Прийняти» without the Mini App, responder and fop', () => {
    const reply = managerCard(view({ status: 'accepted', responderName: 'Фін', fopLabel: 'А' }));
    expect(flat(reply)).toEqual([{ text: '✅ Прийняти', callback_data: `mo:${ID}` }, ATTACH]);
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

  it('accepted and not completed: «Прийняти» next to «Змінити», which opens the completion form', () => {
    const reply = managerCard(accepted(), { miniAppUrl, completed: false });

    expect(all(reply)).toEqual([
      [
        { text: '✅ Прийняти', callback_data: `mo:${ID}` },
        { text: '✏️ Змінити', web_app: { url: `${miniAppUrl}?mode=complete&id=${ID}` } },
      ],
      [ATTACH],
    ]);
  });

  it('encodes the request id and keeps the query already on the URL', () => {
    const reply = managerCard(view({ id: 'a b&c' }), { miniAppUrl: `${miniAppUrl}?lang=uk` });

    const url = (flat(reply)[0] as unknown as { web_app: { url: string } }).web_app.url;
    expect(new URL(url).searchParams.get('id')).toBe('a b&c');
    expect(new URL(url).searchParams.get('lang')).toBe('uk');
    expect(new URL(url).searchParams.get('mode')).toBe('edit');
  });

  it('completed: the «Оформлено» line and no button for a kind that closes with the completion', () => {
    const reply = managerCard(view({ ...accepted(), kind: 'card' }), {
      miniAppUrl,
      completed: { orderNumbers: ['0000-1', '0000-2'], closed: true },
    });

    expect(all(reply)).toEqual([[ATTACH]]);
    expect(reply.html).toContain('✅ Оформлено: № 0000-1, 0000-2 (2 замовлення)');
    expect(reply.html).toContain('📎 Квитанція: просто надішліть фото чи файл у цей чат.');
  });

  it('completed our_fop: «Оплачено» opens the paid form', () => {
    const reply = managerCard(accepted(), {
      miniAppUrl,
      completed: { orderNumbers: ['0000-1'], closed: false },
    });

    expect(all(reply)).toEqual([
      [{ text: '💰 Оплачено', web_app: { url: `${miniAppUrl}?mode=paid&id=${ID}` } }, ATTACH],
    ]);
    expect(reply.html).not.toContain('закрито');
  });

  it('completed our_fop without the URL: no button', () => {
    const reply = managerCard(accepted(), { completed: { orderNumbers: ['0000-1'] } });

    expect(all(reply)).toEqual([[ATTACH]]);
  });

  it('closed our_fop: the payment time in Kyiv time and no button', () => {
    const reply = managerCard(accepted(), {
      miniAppUrl,
      completed: {
        orderNumbers: ['0000-1'],
        closed: true,
        paidAt: new Date('2026-11-04T12:30:00.000Z'),
      },
    });

    expect(all(reply)).toEqual([[ATTACH]]);
    expect(reply.html.split('\n').at(-1)).toBe('✅ Оплачено 04.11.2026 14:30 · закрито');
  });

  it('closed our_fop without a payment time: just closed', () => {
    const reply = managerCard(accepted(), { completed: { orderNumbers: [], closed: true } });

    expect(reply.html.split('\n').at(-1)).toBe('✅ Закрито');
  });

  it('completed: one order has no count; no orders has no number', () => {
    const one = managerCard(accepted(), { completed: { orderNumbers: ['0000-1'] } });
    const none = managerCard(accepted(), { completed: { orderNumbers: [] } });

    expect(one.html).toContain('✅ Оформлено: № 0000-1');
    expect(one.html).not.toContain('(1');
    expect(none.html.split('\n')).toContain('✅ Оформлено');
  });

  it('completed never shows edit or cancel, even for a pending view', () => {
    const reply = managerCard(view({ kind: 'card' }), {
      miniAppUrl,
      completed: { orderNumbers: [] },
    });

    expect(all(reply)).toEqual([[ATTACH]]);
  });

  it('cancelled: no buttons', () => {
    expect(managerCard(view({ status: 'cancelled' }), { miniAppUrl }).buttons ?? []).toEqual([]);
  });

  it('without the URL: the cancel button only, and «Прийняти» without «Змінити»', () => {
    expect(flat(managerCard(view(), {}))).toEqual([
      { text: '✖ Скасувати запит', callback_data: `fc:${ID}` },
    ]);
    expect(flat(managerCard(accepted(), { completed: false }))).toEqual([
      { text: '✅ Прийняти', callback_data: `mo:${ID}` },
      ATTACH,
    ]);
  });

  describe('the ready text of an accepted card', () => {
    const payment = (patch: Record<string, unknown> = {}) => ({
      payerName: 'Петренко Іван',
      account: '4441111069645962',
      amount: '700',
      paidAt: '2026-11-04T08:15:00.000Z',
      ...patch,
    });
    const card = () => ({ ...accepted(), kind: 'card' as const });
    const ready = (payments: ReturnType<typeof payment>[], patch = {}) =>
      managerCard(view({ ...card(), ...patch }), { miniAppUrl, payments });

    it('shows every order with its own rate, even one equal to the request rate', () => {
      const reply = ready([payment()], {
        orders: [
          { orderNumber: '0000-1', amount: '3000', exchangeRate: '41.5' },
          { orderNumber: '0000-2', amount: '2500', exchangeRate: '45' },
        ],
      });

      expect(reply.html).toContain('№ <b>0000-1</b> — 3 000 грн · курс 41,5');
      expect(reply.html).toContain('№ <b>0000-2</b> — 2 500 грн · курс 45');
    });

    it('lists the stored payments with the Kyiv date and time, after the FOP line', () => {
      const lines = ready([
        payment(),
        payment({ payerName: 'Петренко Ірина', account: null, amount: '300.5' }),
      ]).html.split('\n');

      const fop = lines.findIndex((l) => l.includes('ФОП: А'));
      expect(lines[fop + 2]).toBe('<b>Платежі:</b>');
      expect(lines[fop + 3]).toBe(
        '• Петренко Іван · 4441111069645962 · 700 грн · 04.11.2026 10:15',
      );
      expect(lines[fop + 4]).toBe('• Петренко Ірина · 300,50 грн · 04.11.2026 10:15');
    });

    it('shows a minus payment without a payer', () => {
      const reply = ready([payment({ payerName: null, account: null })], { kind: 'minus' });

      expect(reply.html).toContain('• 700 грн · 04.11.2026 10:15');
    });

    it('shows the comment of the request', () => {
      expect(ready([payment()], { comment: 'терміново' }).html).toContain('Коментар: терміново');
    });

    it('escapes what the manager typed', () => {
      const html = ready([payment({ payerName: '<b>&Co', account: 'a<b' })]).html;

      expect(html).toContain('• &lt;b&gt;&amp;Co · a&lt;b · 700 грн');
      expect(html).not.toContain('<b>&Co');
    });

    it('says our_fop has no payment yet, and offers «Прийняти» without any', () => {
      const reply = managerCard(accepted(), { miniAppUrl, payments: [] });

      expect(reply.html).toContain('Платіж: клієнт ще не оплатив');
      expect(flat(reply).map((b) => b.text)).toEqual([
        '✅ Прийняти',
        '✏️ Змінити',
        '📎 Прикріпити файли',
      ]);
    });

    it('offers only «Додати дату» for a card without stored payments', () => {
      const reply = managerCard(card(), { miniAppUrl, payments: [] });

      expect(reply.html).not.toContain('Платіж');
      expect(all(reply)).toEqual([
        [{ text: '📎 Додати дату', web_app: { url: `${miniAppUrl}?mode=complete&id=${ID}` } }],
        [ATTACH],
      ]);
    });

    it('cuts a long list at a whole line with «…» and stays under 4096 with many payouts', () => {
      const many = Array.from({ length: 10 }, (_, i) =>
        payment({ payerName: 'Ю'.repeat(255), account: `${i}`.repeat(64) }),
      );
      const payout = (n: number) => ({
        method: 'iban' as const,
        recipientName: 'Р'.repeat(200),
        iban: `UA${n}`.padEnd(29, '0'),
        taxId: '1234567890',
        purpose: 'П'.repeat(300),
        amount: '100',
        warnings: [],
      });
      const reply = ready(many, {
        comment: 'ы'.repeat(1000),
        payouts: Array.from({ length: 30 }, (_, i) => payout(i)),
      });

      expect(reply.html.length).toBeLessThan(4096);
      expect(reply.html).toContain('…');
      expect(reply.html.split('\n').filter((l) => l.startsWith('• Ю')).length).toBeLessThan(10);
    });
  });

  it('groupCard never carries a web_app button', () => {
    const json = JSON.stringify(groupCard(view(), fops()));
    expect(json).not.toContain('web_app');
  });
});

describe('callback data', () => {
  it('every callback fits 64 bytes and matches its pattern', () => {
    const accepted = view({ status: 'accepted' });
    const all = [
      ...flat(groupCard(view(), fops())),
      ...flat(managerCard(view())),
      ...flat(managerCard(accepted)),
    ].map((b) => b.callback_data);
    expect(all).toHaveLength(6);
    for (const data of all) {
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
    }
    expect(all.some((d) => FinanceAction.Fop.test(d))).toBe(true);
    expect(FinanceAction.Fop.exec(`ff:${ID}:12`)?.slice(1)).toEqual([ID, '12']);
    expect(FinanceAction.Cancel.exec(`fc:${ID}`)?.[1]).toBe(ID);
    expect(FinanceAction.Refresh.exec(`fu:${ID}`)?.[1]).toBe(ID);
    expect(FinanceAction.Accept.exec(`mo:${ID}`)?.[1]).toBe(ID);
    expect(all).toContain(`mo:${ID}`);
    expect(FinanceAction.Attach.exec(`ma:${ID}`)?.[1]).toBe(ID);
    expect(all).toContain(`ma:${ID}`);
  });
});

describe('rate button', () => {
  it('the group card has no «Інший курс» button', () => {
    const reply = groupCard(view(), fops());
    expect(flat(reply).map((b) => b.text)).not.toContain('✏️ Інший курс');
    expect(flat(reply).some((b) => b.callback_data.startsWith('fr:'))).toBe(false);
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
