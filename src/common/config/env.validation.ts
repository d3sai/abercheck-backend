import { plainToInstance, Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  IsUrl,
  Matches,
  MinLength,
  ValidateIf,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

// Blank values in .env mean "unset".
const blankToUndefined = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || undefined : value;
const topicId = ({ value }: { value: unknown }) => {
  const trimmed = blankToUndefined({ value });
  return trimmed === undefined || trimmed === null ? undefined : Number(trimmed);
};

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

  // Finance sync is off unless the URL is set; then both tokens are required.
  @Transform(blankToUndefined)
  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  FINANCE_API_URL?: string;

  @Transform(blankToUndefined)
  @ValidateIf((env: EnvironmentVariables) => env.FINANCE_API_URL !== undefined)
  @IsString()
  @MinLength(16)
  FINANCE_API_TOKEN?: string;

  @Transform(blankToUndefined)
  @ValidateIf((env: EnvironmentVariables) => env.FINANCE_API_URL !== undefined)
  @IsString()
  @MinLength(16)
  FINANCE_WEBHOOK_TOKEN?: string;

  // The Mini App request form (Telegram opens web apps over https only); unset hides its buttons.
  @Transform(blankToUndefined)
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['https'] })
  MINI_APP_URL?: string;

  // Forum topics (message_thread_id) of the admin group; unset means the plain chat.
  @Transform(topicId)
  @IsOptional()
  @IsInt()
  @IsPositive()
  TELEGRAM_TOPIC_REQUESTS_ID?: number;

  @Transform(topicId)
  @IsOptional()
  @IsInt()
  @IsPositive()
  TELEGRAM_TOPIC_PAYMENTS_ID?: number;

  @Transform(topicId)
  @IsOptional()
  @IsInt()
  @IsPositive()
  TELEGRAM_TOPIC_REPORTS_ID?: number;
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
