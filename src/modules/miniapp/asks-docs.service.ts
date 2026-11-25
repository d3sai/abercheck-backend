import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { optionalNonBlank } from '../../common/config/optional-config';
import { FinanceClient } from '../finance-sync/finance.client';

const projectKey = (raw: string) => raw.trim().toLowerCase();

export function asksDocs(project: string | null, docsProject: string | undefined): boolean {
  if (docsProject === undefined || project === null) return true;
  return projectKey(project) === projectKey(docsProject);
}

@Injectable()
export class AsksDocsService {
  constructor(
    private readonly finance: FinanceClient,
    private readonly config: ConfigService,
  ) {}

  async forManager(telegramId: bigint): Promise<boolean> {
    const docsProject = optionalNonBlank(this.config, 'DOCS_PROJECT');
    if (docsProject === undefined) return true;
    try {
      const { project } = await this.finance.fops(Number(telegramId));
      return asksDocs(project, docsProject);
    } catch {
      return true;
    }
  }
}
