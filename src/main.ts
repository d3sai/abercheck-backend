import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { type EnvironmentVariables, listenTarget } from './common/config/env.validation';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(helmet());
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableShutdownHooks();

  const config = app.get<ConfigService<EnvironmentVariables, true>>(ConfigService);
  const [port, host] = listenTarget({
    PORT: config.get('PORT', { infer: true }),
    HOST: config.get('HOST', { infer: true }),
  });
  await (host ? app.listen(port, host) : app.listen(port));
}
void bootstrap();
