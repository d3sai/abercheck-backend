-- The "one message" free-text flow often has no card/IBAN for a payer, only a name and amount.
ALTER TABLE "order_requisites" ALTER COLUMN "account" DROP NOT NULL;
