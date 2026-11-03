import { ORDER_NUMBER_SHAPE, parseExchangeRate } from './order-draft.parsers';
import { loneRate } from './requisites.parser';

export interface FinanceReply {
  fields: Record<string, string>;
  // The notice belongs to /requisites: a payouts block or several order numbers.
  requisites: boolean;
}

const HEAD_PATTERN =
  /^(?:✅\s*)?Ваш запит на (.+?\s*грн)(?:\s*·\s*замовлення\s+(\S+))?\s+прийнято\s*$/iu;
const FOP_PATTERN = /^(?:ФОП|ТОВ)\s*:\s*(.+)$/iu;
const REQUISITES_PATTERN = /^Реквізити для оплати|знайдено кілька номерів/iu;
const NOISE_PATTERN = /^(?:Прийняв:|⚠\uFE0F?|Офіційні документи)/iu;
const RATE_PREFIX = /^Курс\s*:\s*/iu;
const NUMBER_PREFIX = /^Номер\s*:\s*/iu;

export function parseFinanceReply(text: string): FinanceReply | null {
  const [head = '', ...lines] = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const match = HEAD_PATTERN.exec(head);
  if (!match) {
    return null;
  }

  const fields: Record<string, string> = { amountDue: match[1]! };
  if (match[2]) {
    fields.orderNumber = match[2];
  }

  let requisites = false;
  const rest: string[] = [];
  for (const line of lines) {
    if (REQUISITES_PATTERN.test(line)) {
      requisites = true;
      break;
    }
    const fop = FOP_PATTERN.exec(line);
    const number = line.replace(NUMBER_PREFIX, '');
    if (fop) {
      fields.clientName = fop[1]!.trim();
    } else if (!fields.orderNumber && ORDER_NUMBER_SHAPE.test(number)) {
      fields.orderNumber = number;
    } else if (!NOISE_PATTERN.test(line)) {
      rest.push(line);
    }
  }

  const rateIndex = rest.findIndex((line) =>
    RATE_PREFIX.test(line)
      ? parseExchangeRate(line.replace(RATE_PREFIX, '')).ok
      : loneRate(line) !== null,
  );
  if (rateIndex !== -1) {
    fields.exchangeRate = rest.splice(rateIndex, 1)[0]!.replace(RATE_PREFIX, '');
  }
  if (rest.length > 0) {
    fields.comment = rest.join('\n');
  }

  return { fields, requisites };
}
