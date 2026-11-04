-- CreateTable
CREATE TABLE "finance_request_cards" (
    "request_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "manager_id" INTEGER NOT NULL,
    "manager_chat_id" BIGINT NOT NULL,
    "manager_message_id" INTEGER,
    "group_chat_id" BIGINT NOT NULL,
    "group_message_id" INTEGER NOT NULL,
    "pending_rate" TEXT,
    "notified_status" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "finance_request_cards_pkey" PRIMARY KEY ("request_id")
);

-- CreateTable
CREATE TABLE "finance_messages_seen" (
    "message_id" TEXT NOT NULL,
    "seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_messages_seen_pkey" PRIMARY KEY ("message_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "finance_request_cards_group_chat_id_group_message_id_key" ON "finance_request_cards"("group_chat_id", "group_message_id");

-- CreateIndex
CREATE INDEX "finance_request_cards_manager_chat_id_manager_message_id_idx" ON "finance_request_cards"("manager_chat_id", "manager_message_id");

-- AddForeignKey
ALTER TABLE "finance_request_cards" ADD CONSTRAINT "finance_request_cards_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "managers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
