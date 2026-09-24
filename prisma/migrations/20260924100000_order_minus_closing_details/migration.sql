-- Minus closing ("Закриття заборгованості клієнта") details.
ALTER TABLE "orders"
  ADD COLUMN "paid_at" TIMESTAMPTZ(3),
  ADD COLUMN "our_fop" TEXT,
  ADD COLUMN "period" TEXT,
  ADD COLUMN "sheet_url" TEXT;
