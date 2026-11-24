-- AlterTable
ALTER TABLE "finance_request_cards" ADD COLUMN     "closed_at" TIMESTAMPTZ(3),
ADD COLUMN     "payments" JSONB;
