-- CreateTable
CREATE TABLE "pending_orders" (
    "id" TEXT NOT NULL,
    "manager_id" INTEGER NOT NULL,
    "manager_chat_id" BIGINT NOT NULL,
    "manager_message_id" INTEGER,
    "plan" JSONB NOT NULL,
    "files" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pending_orders_manager_id_idx" ON "pending_orders"("manager_id");

-- CreateIndex
CREATE INDEX "pending_orders_manager_chat_id_manager_message_id_idx" ON "pending_orders"("manager_chat_id", "manager_message_id");

-- AddForeignKey
ALTER TABLE "pending_orders" ADD CONSTRAINT "pending_orders_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "managers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
