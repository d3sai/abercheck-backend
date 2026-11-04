-- AlterTable
ALTER TABLE "finance_request_cards" ADD COLUMN     "completed_at" TIMESTAMPTZ(3),
ADD COLUMN     "order_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- CreateTable
CREATE TABLE "finance_request_files" (
    "id" SERIAL NOT NULL,
    "request_id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_request_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "finance_request_files_request_id_idx" ON "finance_request_files"("request_id");

-- AddForeignKey
ALTER TABLE "finance_request_files" ADD CONSTRAINT "finance_request_files_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "finance_request_cards"("request_id") ON DELETE CASCADE ON UPDATE CASCADE;
