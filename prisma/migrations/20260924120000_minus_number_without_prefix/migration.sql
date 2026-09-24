-- Minus closings are now numbered with plain digits; drop the old "МІНУС-" prefix from existing ones
-- so every closing is shown, and typed into /attach or /refund, the same way.
UPDATE "orders"
SET "order_number" = regexp_replace("order_number", '^МІНУС-', ''),
    "base_number"  = regexp_replace("base_number", '^МІНУС-', '')
WHERE "base_number" LIKE 'МІНУС-%';
