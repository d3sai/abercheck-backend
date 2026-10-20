import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { EnvironmentVariables } from '../config/env.validation';
import { API_KEY_HEADER, digest } from './api-key.guard';

@Injectable()
export class AdminKeyGuard implements CanActivate {
  private readonly expected: Buffer | null;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    const key = config.get('ADMIN_API_KEY', { infer: true });
    this.expected = key ? digest(key) : null;
  }

  canActivate(context: ExecutionContext): boolean {
    const provided = context.switchToHttp().getRequest<Request>().header(API_KEY_HEADER);

    if (!this.expected || !provided || !timingSafeEqual(digest(provided), this.expected)) {
      throw new UnauthorizedException('Invalid API key');
    }
    return true;
  }
}
