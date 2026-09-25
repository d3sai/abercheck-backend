export class OrderNumberTakenError extends Error {
  constructor(readonly orderNumber: string) {
    super(`Order ${orderNumber} already exists`);
    this.name = 'OrderNumberTakenError';
  }
}

export class OrderNotFoundError extends Error {
  constructor(readonly orderNumber: string) {
    super(`Order ${orderNumber} not found`);
    this.name = 'OrderNotFoundError';
  }
}

export class OrderCancelledError extends Error {
  constructor(readonly orderNumber: string) {
    super(`Order ${orderNumber} is cancelled`);
    this.name = 'OrderCancelledError';
  }
}

// Orders of one number, and the payments applied to them, must all be in the same currency.
export class OrderCurrencyMismatchError extends Error {
  constructor(readonly orderNumber: string) {
    super(`Order ${orderNumber} is in another currency`);
    this.name = 'OrderCurrencyMismatchError';
  }
}
