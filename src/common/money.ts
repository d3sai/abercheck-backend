export const MONEY_PATTERN = /^(?!0+(\.0+)?$)\d{1,12}(\.\d{1,2})?$/;

export const UAH_UNIT_SRC = String.raw`грн\.?`;
export const USD_UNIT_SRC = String.raw`(?:\$|usd(?!\p{L})|дол(?:ар\p{L}*)?\.?(?!\p{L}))`;
export const MONEY_UNIT_SRC = `(?:${UAH_UNIT_SRC}|${USD_UNIT_SRC})`;
