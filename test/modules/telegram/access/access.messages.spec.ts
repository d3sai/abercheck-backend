import { type Manager, ManagerStatus } from '../../../../src/generated/prisma/client';
import {
  decisionNotice,
  HELP,
  newManagerNotice,
  startReply,
} from '../../../../src/modules/telegram/access/access.messages';

const manager = (overrides: Partial<Manager> = {}): Manager => ({
  id: 1,
  telegramId: 5000000000n,
  name: 'Христина',
  username: 'khrystyna',
  status: ManagerStatus.ACTIVE,
  role: 'MANAGER',
  login: null,
  passwordHash: null,
  sessionVersion: 0,
  createdAt: new Date(),
  ...overrides,
});

describe('newManagerNotice', () => {
  it('should include the name, username and telegram id', () => {
    const notice = newManagerNotice(manager());

    expect(notice).toContain("Ім'я: Христина");
    expect(notice).toContain('Username: @khrystyna');
    expect(notice).toContain('Telegram ID: <code>5000000000</code>');
  });

  it('should show a dash when there is no username', () => {
    const notice = newManagerNotice(manager({ username: null }));

    expect(notice).toContain('Username: —');
  });

  it('should escape HTML in the name', () => {
    const notice = newManagerNotice(manager({ name: '<b>x</b>' }));

    expect(notice).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('startReply', () => {
  it('should greet an active manager with the menu and the help text', () => {
    const reply = startReply(manager({ status: ManagerStatus.ACTIVE }));

    expect(reply.html).toContain('Вітаю, Христина!');
    expect(reply.html).toContain(HELP);
    expect(reply.menu).toBe(true);
  });

  it('should tell a pending manager their request is still under review', () => {
    const reply = startReply(manager({ status: ManagerStatus.PENDING }));

    expect(reply.html).toContain('ще на розгляді');
    expect(reply.menu).toBeUndefined();
  });

  it('should tell a rejected manager access was not granted', () => {
    const reply = startReply(manager({ status: ManagerStatus.REJECTED }));

    expect(reply.html).toContain('Доступ не надано');
  });
});

describe('decisionNotice', () => {
  it('should welcome an approved manager with the help text', () => {
    const notice = decisionNotice(manager({ status: ManagerStatus.ACTIVE }));

    expect(notice).toContain('Доступ надано!');
    expect(notice).toContain(HELP);
  });

  it('should tell a rejected manager the request was declined', () => {
    const notice = decisionNotice(manager({ status: ManagerStatus.REJECTED }));

    expect(notice).toContain('відхилено');
  });
});
