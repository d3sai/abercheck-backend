-- Individual payment details (payer, card/IBAN/etc, amount, date) attached to an order, when it was
-- paid via other people's requisites. Replaces the free-text "requisites" idea from order_type
-- REQUISITES / orders.requisites (both retired, left in place, no longer written by the app).
CREATE TABLE "order_requisites" (
    "id" SERIAL NOT NULL,
    "order_id" INTEGER NOT NULL,
    "payer_name" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "paid_at" TIMESTAMPTZ(3) NOT NULL,
    "added_by_telegram_id" BIGINT NOT NULL,
    "added_by_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_requisites_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "order_requisites_order_id_idx" ON "order_requisites"("order_id");

ALTER TABLE "order_requisites" ADD CONSTRAINT "order_requisites_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
