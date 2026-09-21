-- One 1C number can carry several orders (parts of a split payment): "0000-068711", "0000-068711(1)", ...
-- base_number is the number without the "(n)" suffix; payments and statuses are tracked per base_number.
ALTER TABLE "orders" ADD COLUMN "base_number" TEXT;

UPDATE "orders" SET "base_number" = regexp_replace("order_number", '\(\d+\)$', '');

ALTER TABLE "orders" ALTER COLUMN "base_number" SET NOT NULL;

CREATE INDEX "orders_base_number_idx" ON "orders"("base_number");
