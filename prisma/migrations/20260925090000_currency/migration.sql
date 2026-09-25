-- CreateEnum
CREATE TYPE "currency" AS ENUM ('UAH', 'USD');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN "currency" "currency" NOT NULL DEFAULT 'UAH';

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "currency" "currency" NOT NULL DEFAULT 'UAH';
