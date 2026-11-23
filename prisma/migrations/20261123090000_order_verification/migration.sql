-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "problem" TEXT,
ADD COLUMN     "problem_at" TIMESTAMPTZ(3),
ADD COLUMN     "problem_by_name" TEXT,
ADD COLUMN     "verified_at" TIMESTAMPTZ(3),
ADD COLUMN     "verified_by_name" TEXT,
ADD COLUMN     "verify_message_id" INTEGER;
