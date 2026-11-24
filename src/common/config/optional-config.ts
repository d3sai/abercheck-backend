interface ConfigReader {
  get(key: string): unknown;
}

// ConfigService.get falls back to process.env, where a blank var is still "", so read optional values through these.
export function optionalNonBlank(config: ConfigReader, key: string): string | undefined {
  const value = config.get(key);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function optionalPositiveInt(config: ConfigReader, key: string): number | undefined {
  const value = config.get(key);
  const number =
    typeof value === 'string' && /^\s*\d+\s*$/.test(value)
      ? Number(value)
      : typeof value === 'number'
        ? value
        : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}
