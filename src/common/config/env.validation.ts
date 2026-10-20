import { plainToInstance, Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @Matches(/^([1-9]\d{0,4}|\/\S+)$/, {
    message: 'PORT must be a TCP port or an absolute path to a unix socket',
  })
  PORT = '3000';

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined,
  )
  @IsOptional()
  @IsString()
  HOST?: string;

  @Matches(/^postgres(ql)?:\/\//, {
    message: 'DATABASE_URL must be a PostgreSQL connection string',
  })
  DATABASE_URL!: string;

  @IsString()
  @MinLength(32)
  EXTERNAL_API_KEY!: string;

  // Optional on purpose: when unset the admin routes answer 401 and the app still boots.
  @IsOptional()
  @IsString()
  @MinLength(32)
  ADMIN_API_KEY?: string;

  @Matches(/^\d+:[\w-]{30,}$/, {
    message: 'TELEGRAM_BOT_TOKEN must be a token issued by @BotFather',
  })
  TELEGRAM_BOT_TOKEN!: string;

  @Type(() => Number)
  @IsInt()
  TELEGRAM_ADMIN_CHAT_ID!: number;

  @IsString()
  @MinLength(32)
  WEB_JWT_SECRET!: string;
}

export function listenTarget({
  PORT,
  HOST,
}: Pick<EnvironmentVariables, 'PORT' | 'HOST'>): [number | string, string?] {
  const port = /^\d+$/.test(PORT) ? Number(PORT) : PORT;
  return HOST ? [port, HOST] : [port];
}

export function validateEnv(config: Record<string, unknown>): EnvironmentVariables {
  const env = plainToInstance(EnvironmentVariables, config);
  const errors = validateSync(env, { skipMissingProperties: false });

  if (errors.length > 0) {
    const details = errors.flatMap((error) => Object.values(error.constraints ?? {}));
    throw new Error(`Invalid environment configuration:\n- ${details.join('\n- ')}`);
  }

  return env;
}
