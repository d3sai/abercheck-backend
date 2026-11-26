import { kyivDateTime } from '../../../../src/common/kyiv-time';
import { Currency, Prisma } from '../../../../src/generated/prisma/client';
import { button } from '../../../../src/modules/telegram/core/bot-reply';
import {
  type DigestItem,
  type VerifyState,
  codesOf,
  digestMessage,
  maskOf,
  problemNotice,
  problemsOf,
  reasonButtons,
  verifyButtons,
} from '../../../../src/modules/telegram/verification/verification.messages';

const state = (patch: Partial<VerifyState> = {}): VerifyState => ({
  id: 7,
  verifiedAt: null,
  verifiedByName: null,
  problem: null,
  problemAt: null,
  problemByName: null,
  ...patch,
});

const item = (patch: Partial<DigestItem> = {}): DigestItem => ({
  orderNumber: '0000-076384',
  clientName: 'Пеленський Андрій',
  amountDue: new Prisma.Decimal('328742.31'),
  currency: Currency.UAH,
  managerName: 'Христина',
  createdAt: kyivDateTime(2026, 11, 23, 16, 14),
  problems: [],
  verifyMessageId: 50,
  ...patch,
});

const CHAT = -1001234567890;

describe('verifyButtons', () => {
  it('should offer verify and problem on a new order', () => {
    expect(verifyButtons(state())).toEqual([
      [button('✅ Звірено', 'vf:ok:7'), button('⚠️ Проблема', 'vf:bad:7')],
    ]);
  });

  it('should show who verified, pressing it undoes', () => {
    expect(
      verifyButtons(
        state({ verifiedAt: kyivDateTime(2026, 11, 23, 18, 10), verifiedByName: 'Ірина' }),
      ),
    ).toEqual([[button('✅ Звірено · Ірина · 18:10 23.11.2026', 'vf:undo:7')]]);
  });

  it('should show the problem with a way to change it and to verify', () => {
    expect(
      verifyButtons(
        state({
          problem: 'processing',
          problemAt: kyivDateTime(2026, 11, 23, 18, 10),
          problemByName: 'Ірина',
        }),
      ),
    ).toEqual([
      [button('⚠️ Квитанція в обробці · Ірина · 18:10 23.11.2026', 'vf:bad:7')],
      [button('✅ Звірено', 'vf:ok:7')],
    ]);
  });
});

describe('reasonButtons', () => {
  it('should list the ten reasons two per row and a way back', () => {
    const rows = reasonButtons(7, 0);
    expect(rows.flat()).toHaveLength(11);
    expect(rows.slice(0, -1).every((row) => row.length <= 2)).toBe(true);
    expect(rows.at(-1)).toEqual([button('↩️ Назад', 'vf:back:7')]);
    expect(rows[0]).toEqual([button('Немає дати', 'vf:r:7:1'), button('Немає часу', 'vf:r:7:2')]);
  });

  it('should tick the chosen reasons, toggle them off and offer to send', () => {
    const rows = reasonButtons(7, 0b101);
    expect(rows[0]![0]).toEqual(button('✅ Немає дати', 'vf:r:7:4'));
    expect(rows[0]![1]).toEqual(button('Немає часу', 'vf:r:7:7'));
    expect(rows.at(-2)).toEqual([button('📨 Надіслати (2)', 'vf:s:7:5')]);
  });

  it('should keep callback data within 64 bytes for a large id', () => {
    const data = reasonButtons(2147483647, 1023)
      .flat()
      .map((b) => (b as { callback_data: string }).callback_data);
    expect(data.every((d) => Buffer.byteLength(d) <= 64)).toBe(true);
  });
});

describe('problem codes and masks', () => {
  it('should round-trip the stored codes through a mask, skipping unknown ones', () => {
    expect(problemsOf('sum,xyz,date')).toEqual(['date', 'sum']);
    expect(codesOf(maskOf(['sum', 'date']))).toEqual(['date', 'sum']);
    expect(problemsOf(null)).toEqual([]);
  });
});

describe('problemNotice', () => {
  it('should list several reasons', () => {
    expect(
      problemNotice(
        {
          orderNumber: '1',
          clientName: 'К',
          amountDue: new Prisma.Decimal('1'),
          currency: Currency.UAH,
        },
        ['date', 'sum'],
      ),
    ).toContain(': немає дати; сума не збігається');
  });

  it('should tell the manager the order, client, sum and reason', () => {
    expect(
      problemNotice(
        {
          orderNumber: '0000-076454',
          clientName: 'Берчатова Л.О.',
          amountDue: new Prisma.Decimal('13309'),
          currency: Currency.UAH,
        },
        ['processing'],
      ),
    ).toBe('⚠️ Фінансист: № 0000-076454 (Берчатова Л.О., 13 309 грн): квитанція в обробці');
  });

  it('should escape the client name', () => {
    expect(
      problemNotice(
        {
          orderNumber: '1',
          clientName: 'A <b>',
          amountDue: new Prisma.Decimal('1'),
          currency: Currency.UAH,
        },
        ['sum'],
      ),
    ).toContain('A &lt;b&gt;');
  });
});

describe('digestMessage', () => {
  it('should send no digest when nothing is open', () => {
    expect(digestMessage([], CHAT)).toBeNull();
  });

  it('should put problems first and link each number to its controls', () => {
    const text = digestMessage(
      [
        item({ orderNumber: '0000-000002' }),
        item({ orderNumber: '0000-000001', problems: ['sum'], verifyMessageId: 55 }),
      ],
      CHAT,
    )!;
    expect(text.startsWith('🔎 <b>Звірка</b>')).toBe(true);
    expect(text.indexOf('0000-000001')).toBeLessThan(text.indexOf('0000-000002'));
    expect(text).toContain('<a href="https://t.me/c/1234567890/55">№ 0000-000001</a>');
    expect(text).toContain('⚠️ Проблеми: 1');
    expect(text).toContain('сума не збігається');
    expect(text).toContain('🕓 Незвірені: 1');
  });

  it('should leave out an empty section', () => {
    const text = digestMessage([item()], CHAT)!;
    expect(text).not.toContain('Проблеми');
    expect(text).toContain('328 742,31 грн · Христина · 23.11.2026');
  });

  it('should stay within 4096 characters and count the rest', () => {
    const text = digestMessage(
      Array.from({ length: 200 }, (_, i) =>
        item({ orderNumber: `0000-${String(i).padStart(6, '0')}` }),
      ),
      CHAT,
    )!;
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toMatch(/…ще \d+$/);
  });
});
