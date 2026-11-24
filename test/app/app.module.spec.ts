import { ApplicationConfig } from '@nestjs/core';
import { DependenciesScanner } from '@nestjs/core/scanner';
import { NestContainer } from '@nestjs/core/injector/container';
import { GraphInspector } from '@nestjs/core/inspector/graph-inspector';
import { MetadataScanner } from '@nestjs/core/metadata-scanner';
import { FinanceSyncModule } from '../../src/modules/finance-sync/finance-sync.module';
import { TelegramModule } from '../../src/modules/telegram/telegram.module';

describe('AppModule', () => {
  // BotUpdate.text swallows every private text without next(), so FinanceSyncUpdate.text must run first.
  // nestjs-telegraf registers handlers in the container's module order, which comes from the scan of AppModule.
  it('should register FinanceSyncModule before TelegramModule in the module container', async () => {
    const { AppModule } = await import('../../src/app.module');
    const container = new NestContainer();
    const inspector = new GraphInspector(container);
    await new DependenciesScanner(
      container,
      new MetadataScanner(),
      inspector,
      new ApplicationConfig(),
    ).scan(AppModule);

    const order = [...container.getModules().values()].map(({ metatype }) => metatype);

    expect(order.indexOf(FinanceSyncModule)).toBeGreaterThan(-1);
    expect(order.indexOf(FinanceSyncModule)).toBeLessThan(order.indexOf(TelegramModule));
  });
});
