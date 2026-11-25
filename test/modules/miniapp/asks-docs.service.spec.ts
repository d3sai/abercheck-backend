import type { ConfigService } from '@nestjs/config';
import type { FinanceClient } from '../../../src/modules/finance-sync/finance.client';
import { asksDocs, AsksDocsService } from '../../../src/modules/miniapp/asks-docs.service';

describe('asksDocs', () => {
  it.each([
    [' Абертайм ', 'абертайм', true],
    ['Авардер', 'Абертайм', false],
    [null, 'Абертайм', true],
    ['Авардер', undefined, true],
  ])('%p vs %p → %p', (project, docs, expected) => {
    expect(asksDocs(project, docs)).toBe(expected);
  });
});

describe('AsksDocsService', () => {
  const finance = { fops: jest.fn() };
  const service = (docsProject: string | undefined) =>
    new AsksDocsService(
      finance as unknown as FinanceClient,
      { get: () => docsProject } as unknown as ConfigService,
    );

  afterEach(() => jest.resetAllMocks());

  it('skips finance when DOCS_PROJECT is unset', async () => {
    await expect(service(' ').forManager(555n)).resolves.toBe(true);
    expect(finance.fops).not.toHaveBeenCalled();
  });

  it('finance rejects → true', async () => {
    finance.fops.mockRejectedValue(new Error('down'));
    await expect(service('Абертайм').forManager(555n)).resolves.toBe(true);
  });

  it('other project → false', async () => {
    finance.fops.mockResolvedValue({ project: 'Авардер' });
    await expect(service('Абертайм').forManager(555n)).resolves.toBe(false);
    expect(finance.fops).toHaveBeenCalledWith(555);
  });
});
